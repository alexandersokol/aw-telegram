"""IO-thread-owned SQLite aggregate cache. No titles, wire bodies or credentials persist."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import sqlite3
from uuid import uuid4

from .clock import format_instant, kyiv_date, local_day_bounds, parse_instant, retained_dates
from .models import (Ack, ActionAck, CancellationAck, DaySummary, EndtimeAck, Settings, SettingsAck, SyncRequest, SyncResponse,
    validate_action_receipt,
    MAX_BODY_BYTES, MAX_SAFE_INTEGER, collection_start, ensure_report_capacity, project_day, selected_total,
    validate_activity_context, validate_contract, wire_bytes)


APP_DEFAULTS = {"awHost": "127.0.0.1", "awPort": 5600}
_OCCURRENCE_ENDED ={"dismissed", "completed", "replaced", "failed", "expired", "canceled", "skipped"}


def utc_now():
    now = datetime.now(timezone.utc)
    return format_instant(now.replace(microsecond=now.microsecond // 1000 * 1000))


def _wire(value):
    return value.to_wire() if hasattr(value, "to_wire") else deepcopy(value)


def _json(value):
    return wire_bytes(value).decode("utf8")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf8")).hexdigest()


def _next(value):
    if type(value) is not int or not 0 <= value < MAX_SAFE_INTEGER:
        raise ValueError("counter exhausted")
    return value + 1


def pack_request(sequence, health, days, acks, live=None):
    """Use the transport serializer; dates and receipts are indivisible, never truncated.

    Alternating first priority reserves an opportunity for both today and oldest Ack.
    Dirty backfill order is supplied by durable least-recently-sent metadata.
    """
    body = dict(schemaVersion=2, sequence=sequence, health=_wire(health), acks=[])
    def fits(candidate):
        return len(wire_bytes(candidate)) <= MAX_BODY_BYTES
    if not fits(body):
        raise ValueError("heartbeat exceeds transport bound")
    remaining_days, remaining_acks = list(days), list(acks[:100])
    def add_day(day):
        candidate = {**body, "summaries": body.get("summaries", []) + [day]}
        if fits(candidate):
            body.update(candidate)
    def add_ack(ack):
        candidate = {**body, "acks": body["acks"] + [ack]}
        if fits(candidate):
            body.update(candidate)
    if sequence % 2 and remaining_days:
        add_day(remaining_days.pop(0))
    if remaining_acks:
        add_ack(remaining_acks.pop(0))
    for day in remaining_days[:7]:
        add_day(day)
    for ack in remaining_acks:
        add_ack(ack)
    if live is not None:
        candidate = {**body, "live": _wire(live)}
        if fits(candidate):
            body.update(candidate)
    return SyncRequest.from_wire(body)


class LocalStore:
    """Create/use/close on one owning IO thread. Construction starts no worker.

    Schema 1 denotes the known pre-release table layout with incompatible reports;
    schema 2 invalidates those report bodies while preserving all control state.
    Unknown layouts fail closed rather than guessing a migration.
    """
    def __init__(self, path, *, now=utc_now, identity=None):
        self.now = now
        self.connection = sqlite3.connect(path, isolation_level=None, timeout=5)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=5000")
        try:
            self._migrate()
            if identity is not None:
                self.bind(identity)
        except BaseException:
            self.connection.close()
            raise

    @contextmanager
    def _transaction(self):
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.connection.execute("COMMIT")
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise

    def _migrate(self):
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2, 3, 4, 5):
            raise ValueError("unsupported local schema")
        with self._transaction():
            if version == 0:
                tables = self.connection.execute("select name from sqlite_master where type='table'").fetchall()
                if tables:
                    raise ValueError("unknown local schema")
                statements = [
                    "CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
                    "CREATE TABLE days (date TEXT PRIMARY KEY, sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL, source TEXT, digest TEXT, dirty INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, collected_at TEXT, last_sent INTEGER NOT NULL DEFAULT 0, recollect INTEGER NOT NULL DEFAULT 0)",
                    "CREATE TABLE acks (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)",
                    "CREATE TABLE canceled_ids (id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL)",
                    "CREATE TABLE requests (sequence INTEGER PRIMARY KEY, created_at TEXT NOT NULL, days TEXT NOT NULL, ack_ids TEXT NOT NULL)",
                ]
                for statement in statements:
                    self.connection.execute(statement)
                state = dict(binding=None, collectionStartedAt=None, nextSyncSequence=0,
                    lastAppliedResponseSequence=0, settings=Settings().to_wire(), cancellationRevision=0,
                    throughActionSequence=0, lastServerNow=None, lastSuccessfulSyncAt=None, lastActivitySuccessAt=None)
                self.connection.execute("insert into state values(1,?)", (_json(state),))
            if version == 1:
                # No conversion of category-only data into fabricated application rows.
                self.connection.execute("update days set source=NULL,digest=NULL,dirty=0,recollect=1 where schema_version<>2")
                self.connection.execute("delete from requests")
            if version < 3:
                # Schema 3 adds offline overlay policy state and one endtime receipt per date/generation.
                self.connection.execute("CREATE TABLE IF NOT EXISTS overlay_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
                self.connection.execute("CREATE TABLE IF NOT EXISTS endtime_receipts (date TEXT NOT NULL, generation INTEGER NOT NULL, ack_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(date, generation))")
            if version < 4:
                # Schema 4 adds accepted delivery offers; receipts for them live in the acks table.
                self.connection.execute("CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, body TEXT NOT NULL, sequence INTEGER NOT NULL, target TEXT NOT NULL, accepted_at TEXT, event_sequence INTEGER NOT NULL, occurrence INTEGER NOT NULL, terminal INTEGER NOT NULL, received_at TEXT NOT NULL)")
            if version < 5:
                # Schema 5 keeps each action's latest receipt status and time, so event times never go
                # backwards and a clear between repeats can tell that the occurrence already ended.
                columns = {r[1] for r in self.connection.execute("PRAGMA table_info(actions)")}
                for column in ("last_status", "last_at"):
                    if column not in columns:
                        self.connection.execute(f"ALTER TABLE actions ADD COLUMN {column} TEXT")
            # Compatibility is confined to persisted state. Wire Settings stay strict.
            state = self._state()
            settings = state["settings"]
            defaults = dict(endtimeEnabled=False, endtimeLocalTime="21:00", endtimeGeneration=0)
            legacy = isinstance(settings, dict) and not defaults.keys() & settings.keys()
            migrated = {**settings, **defaults} if legacy else settings
            validate_contract("settings", migrated)
            if legacy:
                state["settings"] = migrated
                self._save(state)
            self.connection.execute("PRAGMA user_version=5")

    def _state(self):
        return json.loads(self.connection.execute("select value from state where id=1").fetchone()[0])

    def _save(self, state):
        self.connection.execute("update state set value=? where id=1", (_json(state),))

    def bind(self, identity) -> None:
        """Record the public enrollment identity once; the secret stays in the vault."""
        binding = {"deviceId": identity.deviceId, "backendUrl": identity.backendUrl}
        with self._transaction():
            state = self._state()
            if state["binding"] is not None and state["binding"] != binding:
                raise ValueError("device binding cannot change")
            state["binding"] = binding
            self._save(state)

    @property
    def app_config(self) -> dict:
        """Local companion settings; ActivityWatch's own default address unless changed in «Налаштування»."""
        return {**APP_DEFAULTS, **self._state().get("app", {})}

    def set_app_config(self, *, awHost: str, awPort: int) -> None:
        if awHost not in ("127.0.0.1", "::1") or type(awPort) is not int or not 1 <= awPort <= 65535:
            raise ValueError("ActivityWatch needs a loopback host and a port 1-65535")
        with self._transaction():
            state = self._state()
            state["app"] = {**state.get("app", {}), "awHost": awHost, "awPort": awPort}
            self._save(state)

    @property
    def binding(self) -> dict | None:
        """Public enrollment identity {deviceId, backendUrl}; the secret stays in the vault."""
        return self._state()["binding"]

    @property
    def collection_started_at(self):
        return self._state()["collectionStartedAt"]

    @property
    def settings(self):
        return Settings.from_wire(self._state()["settings"])

    @property
    def cancellations(self):
        state = self._state()
        return dict(revision=state["cancellationRevision"], throughActionSequence=state["throughActionSequence"],
                    canceledIds=[r[0] for r in self.connection.execute("select id from canceled_ids order by id")])

    @property
    def last_activity_success_at(self):
        return self._state().get("lastActivitySuccessAt")

    def record_activity_success(self, instant):
        """Title-free query-success watermark; metadata/contact must never call this."""
        parse_instant(instant)
        if instant > self.now():
            raise ValueError("future activity success")
        with self._transaction():
            state = self._state()
            if state["collectionStartedAt"] is None or instant < state["collectionStartedAt"]:
                raise ValueError("activity success outside pairing context")
            previous = state.get("lastActivitySuccessAt")
            if previous is None or instant > previous:
                state["lastActivitySuccessAt"] = instant
                self._save(state)

    @property
    def activity(self) -> dict | None:
        """Latest outside foreground evidence for overlay gating: {observedAt, state, path, ownedAt}."""
        return self._state().get("activity")

    def record_activity(self, live: dict | None, *, owned_at: str | None = None) -> None:
        """Title- and app-free: an active/AFK observation replaces the record; companion-owned foreground
        only refreshes it (ownedAt); an unknown observation is no evidence and changes nothing."""
        if live is not None:
            live = validate_contract("live", live)
        stamp = owned_at if live is None else live["observedAt"]
        if stamp is None or live is not None and live["state"] == "unknown":
            return
        parse_instant(stamp)
        if stamp > self.now():
            raise ValueError("future activity observation")
        with self._transaction():
            state = self._state()
            if live is not None:
                category = live["category"]
                state["activity"] = dict(observedAt=stamp, state=live["state"], ownedAt=None,
                                         path=None if category is None else category["path"])
            elif state.get("activity") is not None:
                state["activity"] = {**state["activity"], "ownedAt": stamp}
            else:
                state["activity"] = dict(observedAt=None, state=None, path=None, ownedAt=stamp)
            self._save(state)

    def day(self, date):
        row = self.connection.execute("select source from days where date=?", (date,)).fetchone()
        return DaySummary.from_wire(json.loads(row[0])) if row and row[0] is not None else None

    def projection(self, date):
        day = self.day(date)
        return None if day is None else project_day(day.to_wire(), self.settings.to_wire())

    def selected_usage(self, date) -> int | None:
        """Measured selected-category total under current settings; the body was validated when committed."""
        row = self.connection.execute("select source from days where date=?", (date,)).fetchone()
        if row is None or row[0] is None:
            return None
        settings = self.settings
        return selected_total(json.loads(row[0])["leafTotalsMs"], settings.selectedPaths, settings.selectedUncategorized)

    def needs_recollection(self, date):
        row = self.connection.execute("select source,recollect from days where date=?", (date,)).fetchone()
        return row is None or row[0] is None or bool(row[1])

    def commit_day(self, candidate: DaySummary, collected_at: str) -> DaySummary:
        candidate = validate_contract("day", _wire(candidate))
        parse_instant(collected_at)
        with self._transaction():
            state = self._state()
            if candidate["settingsRevision"] > state["settings"]["revision"]:
                raise ValueError("future settings revision")
            project_day(candidate, state["settings"])
            row = self.connection.execute("select sequence,acknowledged from days where date=?", (candidate["date"],)).fetchone()
            sequence = _next(max(row[0], row[1]) if row else 0)
            candidate["sequence"] = sequence
            ensure_report_capacity(candidate)
            from .models import minimal_health
            context = dict(schemaVersion=2, sequence=MAX_SAFE_INTEGER, health=minimal_health(self.now()), acks=[], summaries=[candidate])
            validate_activity_context(context, state["collectionStartedAt"], self.now())
            if collected_at > self.now():
                raise ValueError("future collection timestamp")
            self.connection.execute("""insert into days(date,sequence,schema_version,source,digest,dirty,collected_at)
                values(?,?,2,?,?,1,?) on conflict(date) do update set sequence=excluded.sequence,schema_version=2,
                source=excluded.source,digest=excluded.digest,dirty=1,collected_at=excluded.collected_at,recollect=0""",
                (candidate["date"], sequence, _json(candidate), _digest(candidate), collected_at))
        return DaySummary.from_wire(candidate)

    def _queue_ack(self, ack, created_at):
        ack = validate_contract("ack", _wire(ack))
        row = self.connection.execute("select body from acks where id=?", (ack["id"],)).fetchone()
        if row is not None and json.loads(row[0]) != ack:
            raise ValueError("receipt identity conflict")
        self.connection.execute("insert or ignore into acks values(?,?,?)", (ack["id"], _json(ack), created_at))

    def queue_ack(self, ack):
        with self._transaction():
            self._queue_ack(ack, self.now())

    def overlay_state(self) -> dict | None:
        row = self.connection.execute("select value from overlay_state where id=1").fetchone()
        return None if row is None else json.loads(row[0])

    def commit_overlay_state(self, value: dict, receipt: EndtimeAck | None = None, events=()) -> bool:
        """Persist scheduler state with its action receipts; queue at most one endtime receipt per date/generation.

        Everything commits in one transaction, so a crash cannot separate a shown or dismissed
        presentation from its receipt.
        """
        with self._transaction():
            for event in events:
                self._action_event(**event)
            queued = False
            if receipt is not None:
                ack = validate_contract("ack", _wire(receipt))
                if ack["kind"] != "endtime":
                    raise ValueError("expected an endtime receipt")
                cursor = self.connection.execute("insert or ignore into endtime_receipts values(?,?,?,?)",
                    (ack["date"], ack["endtimeGeneration"], ack["id"], self.now()))
                if cursor.rowcount:
                    self._queue_ack(ack, self.now())
                    queued = True
            self.connection.execute("insert into overlay_state values(1,?) on conflict(id) do update set value=excluded.value",
                (json.dumps(value, sort_keys=True, ensure_ascii=False),))
        return queued

    # Delivery offers. Acceptance is persisted before it is acknowledged; an offer is never re-run.
    def receive_offers(self, offers, server_now=None):
        """apply_sync calls the same logic inside its own transaction."""
        with self._transaction():
            self._receive_offers(offers, self.now(), server_now)

    def _covered(self, action, state):
        return (action["sequence"] <= state["throughActionSequence"] or
                self.connection.execute("select 1 from canceled_ids where id=?", (action["id"],)).fetchone() is not None)

    def _receive_offers(self, offers, now, server_now=None):
        state = self._state()
        for offer in offers:
            action = validate_contract("action", _wire(offer))
            if self.connection.execute("select 1 from actions where id=?", (action["id"],)).fetchone():
                continue  # repeated offer of a known action
            # The backend requires acceptance no earlier than its first offer: a laptop clock behind the
            # server accepts at the delivering response's serverNow (never before creation either).
            instant = max(now, action["createdAt"], server_now or "")
            expires, immediate = parse_instant(action["expiresAt"]), action["targetAt"] == action["createdAt"]
            # Immediate presentation must begin strictly before expiry; a timer may begin through target+5s.
            current = parse_instant(instant)
            late = current >= expires if immediate else current > expires
            if self._covered(action, state):
                status, reason, accepted = "canceled", "canceled", None
            elif late:
                status, reason, accepted = "expired", "missed_deadline", None
            else:
                status, reason, accepted = "accepted", None, instant
            self.connection.execute("""insert into actions(id,body,sequence,target,accepted_at,event_sequence,occurrence,
                terminal,received_at) values(?,?,?,?,?,0,0,?,?)""", (action["id"], _json(action),
                action["sequence"], action["targetAt"], accepted, int(status != "accepted"), now))
            self._action_event(action["id"], status, now, 0, None, reason, status != "accepted")

    def _cancel_covered(self, now):
        state = self._state()
        for row in self.connection.execute("select id,body,occurrence,last_status from actions where terminal=0").fetchall():
            if not self._covered(json.loads(row["body"]), state):
                continue
            if row["last_status"] in _OCCURRENCE_ENDED:
                # Between repeats the latest occurrence already ended (dismissed); the backend applies the
                # fence itself and rejects a second terminal status, so the family ends locally only.
                self.connection.execute("update actions set terminal=1 where id=?", (row["id"],))
            else:
                self._action_event(row["id"], "canceled", now, row["occurrence"], None, "canceled", True)

    def open_actions(self) -> list[dict]:
        """Accepted actions that are not yet terminal, with their current occurrence."""
        return [dict(action=json.loads(r["body"]), occurrence=r["occurrence"], acceptedAt=r["accepted_at"])
                for r in self.connection.execute("select * from actions where terminal=0 order by sequence")]

    def _action_event(self, action_id, status, at, occurrence, presented_at, reason, terminal):
        """Queue one receipt with the next event sequence; a terminal action takes no further events."""
        at = at if isinstance(at, str) else format_instant(at)
        presented_at = presented_at if presented_at is None or isinstance(presented_at, str) else format_instant(presented_at)
        row = self.connection.execute("select * from actions where id=?", (action_id,)).fetchone()
        if row is None or (row["terminal"] and row["event_sequence"]):
            return False
        body = json.loads(row["body"])
        # Canonical instants order lexically. Event time never precedes creation, acceptance or this
        # action's previous receipt, so a clock stepped back cannot reorder the backend's evidence.
        if presented_at is not None:
            # Skew correction like `at`: presentation is no earlier than acceptance, and a repeat no
            # earlier than the recorded dismissal plus its interval (the backend checks both).
            floor = row["accepted_at"] or ""
            if occurrence and row["last_status"] == "dismissed":
                floor = max(floor, format_instant(parse_instant(row["last_at"]) +
                                                  timedelta(minutes=body["options"]["repeatEveryMinutes"])))
            presented_at = max(presented_at, floor)
        at = max(at, body["createdAt"], row["accepted_at"] or "", row["last_at"] or "", presented_at or "")
        if occurrence and at >= format_instant(local_day_bounds(kyiv_date(parse_instant(body["targetAt"])))[1]):
            # The backend ends a repeat family at its Kyiv midnight and rejects later-occurrence evidence.
            if terminal:
                self.connection.execute("update actions set terminal=1 where id=?", (action_id,))
            return False
        sequence = _next(row["event_sequence"])
        ack = ActionAck(id=str(uuid4()), kind="action", actionId=action_id, eventSequence=sequence, occurrence=occurrence,
            status=status, at=at, acceptedAt=row["accepted_at"], presentedAt=presented_at, reason=reason).to_wire()
        validate_action_receipt(json.loads(row["body"]), ack)
        self._queue_ack(ack, at)
        self.connection.execute("update actions set event_sequence=?,occurrence=?,terminal=?,last_status=?,last_at=? where id=?",
            (sequence, occurrence, int(terminal), status, at, action_id))
        return True

    def pending_acks(self) -> list[Ack]:
        kinds = {"settings": SettingsAck, "cancellation": CancellationAck, "endtime": EndtimeAck}
        from .models import ActionAck
        kinds["action"] = ActionAck
        return [kinds[a["kind"]].from_wire(a) for a in
                (json.loads(r[0]) for r in self.connection.execute("select body from acks order by created_at,rowid"))]

    def prepare_request(self, health, live=None) -> SyncRequest:
        now = self.now()
        dates = retained_dates(parse_instant(now))
        with self._transaction():
            state = self._state()
            sequence = _next(state["nextSyncSequence"])
            days = [json.loads(r["source"]) for r in self.connection.execute(
                "select * from days where source is not null and dirty=1 order by (date=?) desc,last_sent,date", (dates[0],)) if r["date"] in dates]
            acks = [json.loads(r[0]) for r in self.connection.execute("select body from acks order by created_at,rowid limit 100")]
            request = pack_request(sequence, health, days, acks, live)
            validate_activity_context(request.to_wire(), state["collectionStartedAt"], now)
            manifest = [dict(date=d["date"], sequence=d["sequence"], digest=_digest(d)) for d in request.summaries or []]
            self.connection.execute("insert into requests values(?,?,?,?)", (sequence, now, _json(manifest), _json([a["id"] for a in request.acks])))
            for item in manifest:
                self.connection.execute("update days set last_sent=? where date=?", (sequence, item["date"]))
            state["nextSyncSequence"] = sequence
            self._save(state)
            # Bounded delayed-response window; never retains request bodies/live/health.
            self.connection.execute("delete from requests where sequence not in (select sequence from requests order by sequence desc limit 256)")
        return request

    def apply_sync(self, response: SyncResponse) -> None:
        response = validate_contract("sync-response", _wire(response))
        with self._transaction():
            manifest = self.connection.execute("select * from requests where sequence=?", (response["requestSequence"],)).fetchone()
            if manifest is None:
                return
            submitted = {d["date"]: d for d in json.loads(manifest["days"])}
            ack_ids = set(json.loads(manifest["ack_ids"]))
            for receipt in response["summaryReceipts"]:
                if receipt["date"] not in submitted or receipt["sequence"] < submitted[receipt["date"]]["sequence"]:
                    raise ValueError("summary receipt does not match manifest")
            if not set(response["acknowledgedAckIds"]).issubset(ack_ids):
                raise ValueError("receipt acknowledgement does not match manifest")
            state = self._state()
            state["collectionStartedAt"] = collection_start(state["collectionStartedAt"], response["collectionStartedAt"])
            received = response["settings"]
            current = state["settings"]
            if received["revision"] == current["revision"] and received != current:
                raise ValueError("settings revision conflict")
            # Installing the initial revision is also acknowledged exactly once.
            initial = state["lastSuccessfulSyncAt"] is None
            if received["revision"] > current["revision"] or initial:
                state["settings"] = received
                self._queue_ack(dict(id=str(uuid4()), kind="settings", revision=received["revision"], appliedAt=self.now()), self.now())
            fence = response["cancellations"]
            changed = fence["revision"] > state["cancellationRevision"] or fence["throughActionSequence"] > state["throughActionSequence"]
            for action_id in fence["canceledIds"]:
                cursor = self.connection.execute("insert or ignore into canceled_ids values(?,?)", (action_id, self.now()))
                changed = changed or cursor.rowcount > 0
            state["cancellationRevision"] = max(state["cancellationRevision"], fence["revision"])
            state["throughActionSequence"] = max(state["throughActionSequence"], fence["throughActionSequence"])
            if changed:
                # Covered actions become terminal in this transaction; the scheduler removes any visible
                # instance on its next tick, about a second later.
                self._save(state)
                self._cancel_covered(self.now())
                self._queue_ack(dict(id=str(uuid4()), kind="cancellation", revision=state["cancellationRevision"],
                    throughActionSequence=state["throughActionSequence"], appliedAt=self.now()), self.now())
            for receipt in response["summaryReceipts"]:
                row = self.connection.execute("select * from days where date=?", (receipt["date"],)).fetchone()
                if row is not None:
                    watermark = max(row["acknowledged"], receipt["sequence"])
                    source_sequence = json.loads(row["source"])["sequence"] if row["source"] is not None else 0
                    self.connection.execute("update days set acknowledged=?,sequence=max(sequence,?),dirty=?,recollect=max(recollect,?) where date=?",
                        (watermark, watermark, int(source_sequence > watermark), int(watermark > source_sequence), receipt["date"]))
            self._save(state)
            self._receive_offers(response["deliveryOffers"], self.now(), response["serverNow"])
            state = self._state()
            for ack_id in response["acknowledgedAckIds"]:
                self.connection.execute("delete from acks where id=?", (ack_id,))
            if response["requestSequence"] > state["lastAppliedResponseSequence"]:
                state["lastAppliedResponseSequence"] = response["requestSequence"]
                state["lastServerNow"] = response["serverNow"]
                state["lastSuccessfulSyncAt"] = self.now()
            self._save(state)

    def prune(self, now=None):
        now = now or self.now()
        cutoff = retained_dates(parse_instant(now))[-1]
        with self._transaction():
            self.connection.execute("update days set source=NULL,digest=NULL,dirty=0,collected_at=NULL,recollect=1 where date<?", (cutoff,))
            self.connection.execute("delete from endtime_receipts where date<?", (cutoff,))
            self.connection.execute("delete from actions where target<?", (format_instant(local_day_bounds(cutoff)[0]),))
            # The backend rejects receipts timed outside its retained dates; one would stop all sync for good.
            self.connection.execute("""delete from acks where (json_extract(body,'$.kind')='action' and json_extract(body,'$.at')<?)
                or (json_extract(body,'$.kind')='endtime' and json_extract(body,'$.presentedAt')<?)""",
                (format_instant(local_day_bounds(cutoff)[0]),) * 2)
            # Keep counters, settings, receipts and unknown cancellation IDs across midnight.
            self.connection.execute("delete from requests where created_at<?", (format_instant(local_day_bounds(cutoff)[0]),))

    def close(self):
        self.connection.close()
