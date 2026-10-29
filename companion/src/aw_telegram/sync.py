"""Injectable, nonoverlapping IO steps. Importing this module starts no IO or threads."""
from dataclasses import dataclass
import random
import threading
import time
from .aw_reader import AWUnavailable, AWUnsupported
from .clock import format_instant, parse_instant, retained_dates, local_day_bounds
from .models import ReportCapacityExceeded, minimal_health, validate_activity_context
from .transport import CredentialError, EnrollmentError, SyncError


@dataclass(frozen=True)
class Observation:
    live: dict | None
    health: dict
    owned_at: str | None = None  # our own window was in the foreground; overlay gating keeps prior evidence


class ReaderAdapter:
    """Failure provenance prevents synthetic unknown from overwriting remote live.

    The reader timestamps only a successful activity query, never its metadata probe.
    A valid explicit unknown from another observation source remains a real update.
    """
    def __init__(self, reader):
        self.reader = reader

    def observe(self, now, settings, started):
        self.reader.settings = settings
        self.reader.collection_started_at = parse_instant(started)
        live = self.reader.live()
        health = self.reader.health
        completed = format_instant(self.reader.now())
        failure = health.state in ('stale', 'unavailable', 'unsupported')
        return Observation(None if failure else live.to_wire(), dict(observedAt=completed, awState=health.state,
            lastSuccessAt=health.last_success_at, reportError='report_capacity_exceeded' if health.reason == 'report_capacity_exceeded' else None),
            completed if getattr(self.reader, 'live_owned', False) else None)

    def summarize(self, date, start, end, settings, started):
        self.reader.settings = settings
        return self.reader.summarize(parse_instant(start), parse_instant(end), parse_instant(started))


class SyncCoordinator:
    """One step handles due controls, one poll and at most one complete date query.

    The caller owns the store on this thread. Monotonic deadlines coalesce missed
    ticks; UTC/Kyiv boundaries determine retention and collection, never 24h sums.
    """
    def __init__(self, store, transport, observe, summarize, *, jitter=lambda: random.uniform(0.8, 1.2), on_update=None):
        self.store, self.transport = store, transport
        self.observe, self.summarize = observe, summarize
        self.jitter, self.on_update = jitter, on_update
        self.health = minimal_health(store.now())
        self.health["lastSuccessAt"] = store.last_activity_success_at
        self.live = None
        self.auth_blocked = False
        self.last_error = None
        self._poll_due = self._sync_due = self._summary_due = self._backfill_due = 0
        self._failures = 0
        self._gate = None
        self._last_date = None
        self._backfill = []
        self._running = threading.Lock()

    def snapshot(self):
        """Title-free status for the companion window, read from the GUI thread."""
        return dict(health=dict(self.health), auth_blocked=self.auth_blocked, last_error=self.last_error)

    def _send_revocations(self):
        """Removals saved while offline; the server answers 204 even for stale or unknown entries."""
        identity = getattr(self.transport, "identity", None)
        for item in self.store.pending_revocations()[:5] if identity is not None else []:
            try:
                self.transport.revoke_access(identity, item["id"])
            except EnrollmentError:
                return  # retried after the next successful sync
            self.store.revocation_done(item["id"])

    def recover_credentials(self):
        self.auth_blocked = False
        self._failures = 0
        self._sync_due = 0
        self._gate = None

    def _unavailable(self, now, state='unavailable'):
        self.live = None
        self.health = dict(observedAt=now, awState=state,
            lastSuccessAt=self.store.last_activity_success_at,
            reportError=self.health['reportError'])

    def _calendar(self, now, started):
        current = parse_instant(now)
        dates = retained_dates(current)
        eligible = [d for d in dates if local_day_bounds(d)[1] > parse_instant(started)]
        if self._gate != started:
            self._gate = started
            self._backfill = eligible
        elif self._last_date is not None and dates[0] > self._last_date:
            # Finalize every newly closed retained date after midnight or a long sleep.
            closed = [d for d in eligible if self._last_date <= d < dates[0]]
            self._backfill = list(dict.fromkeys(closed + self._backfill))
        self._last_date = dates[0]
        self._backfill = [d for d in self._backfill if d in eligible]
        return dates

    def _install_observation(self, observation, completed, started):
        request = dict(schemaVersion=2, sequence=0, health=observation.health, acks=[],
            **({'live': observation.live} if observation.live is not None else {}))
        validate_activity_context(request, started, completed)
        success = observation.health['lastSuccessAt']
        if success is not None:
            self.store.record_activity_success(success)
        health = {**observation.health, 'lastSuccessAt': self.store.last_activity_success_at}
        # A successful live poll does not prove that a previously oversized day fits.
        health['reportError'] = health['reportError'] or self.health['reportError']
        validate_activity_context({**request, 'health': health}, started, completed)
        self.health, self.live = health, observation.live
        self.store.record_activity(observation.live, owned_at=observation.owned_at)

    def step(self, now_utc, now_monotonic):
        if not self._running.acquire(blocking=False):
            raise RuntimeError('IO step is already running')
        try:
            self._step(now_utc, now_monotonic)
        finally:
            self._running.release()

    def _step(self, now, mono):
        parse_instant(now)
        self.store.prune(now)
        if self.store.collection_started_at is None:
            self.health, self.live = minimal_health(now), None
        # Controls always precede activity/backfill work that is due at this tick.
        if mono >= self._sync_due and not self.auth_blocked:
            self._sync_due = mono + 15
            old_revision = self.store.settings.revision
            try:
                request = self.store.prepare_request(self.health, self.live)
                self.store.apply_sync(self.transport.sync(request))
                if self._failures:
                    self._gate = None
                self._failures = 0
                self.last_error = None
                if self.store.settings.revision != old_revision:
                    self._summary_due = mono
                self._send_revocations()
                if self.on_update:
                    self.on_update(self.store.settings, self.store.cancellations)
            except CredentialError:
                self.auth_blocked, self.live, self.last_error = True, None, 'credential_error'
            except SyncError as error:
                self.live = None
                self._failures += 1
                delay = min(300, 15 * 2 ** min(self._failures - 1, 5)) * self.jitter()
                self._sync_due = mono + max(15, min(300, max(delay, error.retry_after or 0)))
                self.last_error = 'transient_sync_error' if error.retryable else 'invalid_sync_response'
            except ValueError:
                self.live, self.last_error, self._sync_due = None, 'sync_context_error', mono + 60
        started = self.store.collection_started_at
        if started is None:
            return
        # Earlier network calls may have taken time or crossed a calendar boundary.
        now = self.store.now()
        current = parse_instant(now)
        self.store.prune(now)
        if parse_instant(started) > current:
            self._unavailable(now, 'unsupported')
            self.last_error = 'clock_context_error'
            return
        dates = self._calendar(now, started)
        if mono >= self._poll_due:
            self._poll_due = mono + 10
            try:
                observation = self.observe(now, self.store.settings, started)
                completed = self.store.now()
                self._install_observation(observation, completed, started)
            except AWUnavailable:
                self._unavailable(self.store.now())
            except AWUnsupported:
                self._unavailable(self.store.now(), 'unsupported')
            except (ValueError, TypeError):
                self._unavailable(self.store.now(), 'unsupported')
                self.last_error = 'observation_context_error'
        now = self.store.now()
        current = parse_instant(now)
        dates = self._calendar(now, started)
        target = None
        if mono >= self._summary_due:
            target = dates[0]
            self._summary_due = mono + 30
        elif self._backfill and mono >= self._backfill_due:
            target = self._backfill[0]
        if target is not None:
            self._backfill_due = mono + 10
            if target in self._backfill:
                self._backfill.remove(target)
            lo, hi = local_day_bounds(target)
            lo, hi = max(lo, parse_instant(started)), min(hi, current)
            if lo >= hi:
                return
            try:
                candidate = self.summarize(target, format_instant(lo), format_instant(hi), self.store.settings, started)
                completed = self.store.now()
                self.store.commit_day(candidate, completed)
                self.store.record_activity_success(completed)
                source = candidate.to_wire() if hasattr(candidate, 'to_wire') else candidate
                self.health = dict(observedAt=completed, awState='partial' if source['partial'] else 'ready',
                    lastSuccessAt=self.store.last_activity_success_at,
                    reportError=None if target == dates[0] else self.health['reportError'])
            except ReportCapacityExceeded:
                self.health = {**self.health, 'observedAt': self.store.now(), 'reportError': 'report_capacity_exceeded'}
                self.last_error = 'report_capacity_exceeded'
            except AWUnavailable:
                self._unavailable(self.store.now())
                if target != dates[0]:
                    self._backfill.append(target)
            except AWUnsupported:
                self._unavailable(self.store.now(), 'unsupported')
                if target != dates[0]:
                    self._backfill.append(target)
            except (ValueError, TypeError):
                self.last_error = 'summary_context_error'


class IOWorker:
    """Explicit lifecycle. Factory runs inside the worker so SQLite keeps ownership.

    No Qt dependency; runtime.CompanionRuntime queues on_update to the GUI thread.
    An unexpected step failure (e.g. a locked database) is counted and retried after
    retry_delay; it never ends background sync for the session.
    """
    def __init__(self, factory, *, utc_clock, monotonic=time.monotonic, retry_delay=5.0):
        self.factory, self.utc_clock, self.monotonic = factory, utc_clock, monotonic
        self.retry_delay = retry_delay
        self.failures = 0
        self.startup_failed = False
        self.status = None  # the coordinator's latest snapshot; replaced whole, so other threads read it safely
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None:
            raise RuntimeError('worker has already started')
        self._thread = threading.Thread(target=self._run, name='aw-telegram-io', daemon=True)
        self._thread.start()

    def _run(self):
        try:
            coordinator = self.factory()
        except Exception:
            self.startup_failed = True
            return
        try:
            while not self._stop.is_set():
                delay = 0.25
                try:
                    coordinator.step(self.utc_clock(), self.monotonic())
                    if hasattr(coordinator, "snapshot"):
                        self.status = coordinator.snapshot()
                except Exception:
                    self.failures += 1
                    delay = self.retry_delay
                self._stop.wait(delay)
        finally:
            coordinator.store.close()

    def stop(self, timeout=15):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            return not self._thread.is_alive()
        return True
