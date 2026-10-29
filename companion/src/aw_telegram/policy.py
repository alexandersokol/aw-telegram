"""Pure Kyiv endtime and daily allowance policy. No Qt, storage, clock reads or network.

A first eligible evaluation (start, resume, clock change, enabling, a new generation
or suppression ending) strictly after endtime skips the date; equality is due. Warning
thresholds share one rule: show the most urgent crossed threshold not yet shown, so
continuous operation warns at each and catch-up shows at most one.
"""
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta

from .clock import endtime_at, format_instant, kyiv_date, local_day_bounds, parse_instant
from .models import Settings

WARNINGS = (("5m", 5), ("10m", 10), ("15m", 15))  # most urgent first
_RANK = {None: 0, "15m": 1, "10m": 2, "5m": 3}
REPEAT = timedelta(minutes=1)


@dataclass(frozen=True)
class EndtimeState:
    """Per Kyiv date and endtime generation; a new date or generation starts afresh."""
    date: str | None = None
    generation: int | None = None
    active: bool = False        # the previous evaluation was eligible and continuous
    warned: str | None = None   # most urgent warning already shown
    skipped: bool = False
    started: bool = False       # the first occurrence became due
    next_due: str | None = None # next occurrence after dismissal/replacement/failure
    visible: bool = False

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, value: dict) -> "EndtimeState":
        state = cls(**value)
        if state.warned not in _RANK or (state.next_due is not None and parse_instant(state.next_due) is None):
            raise ValueError("invalid endtime state")
        return state


@dataclass(frozen=True)
class EndtimeDecision:
    warning: str | None = None
    show: bool = False
    hide: bool = False
    due_at: datetime | None = None
    wake_at: datetime | None = None


def eligible(settings: Settings, date: str) -> bool:
    return settings.endtimeEnabled and settings.freeUseDate != date and settings.suppressedDate != date


def evaluate_endtime(settings: Settings, state: EndtimeState, now: datetime,
                     resumed: bool = False, paused: bool = False) -> tuple[EndtimeState, EndtimeDecision]:
    """paused: no caregiver is paired (ACCESS-08); handled like suppression, so pairing again re-runs the
    first-evaluation rule."""
    date = kyiv_date(now)
    midnight = local_day_bounds(date)[1]
    fresh = state.date != date or state.generation != settings.endtimeGeneration
    # Midnight, a time edit, disabling and suppression all remove the current instance.
    hide = state.visible and (fresh or not eligible(settings, date))
    if fresh:
        state = EndtimeState(date=date, generation=settings.endtimeGeneration)
    if paused or not eligible(settings, date):
        # Recurrence is canceled; becoming eligible again re-runs the first-evaluation rule.
        state = replace(state, active=False, started=False, next_due=None, visible=False)
        return state, EndtimeDecision(hide=hide, wake_at=midnight)
    first = resumed or not state.active
    state = replace(state, active=True)
    end = endtime_at(date, settings.endtimeLocalTime)
    if state.skipped or (first and now > end and not state.started):
        return replace(state, skipped=True), EndtimeDecision(hide=hide, wake_at=midnight)

    warning = None
    if now < end:
        crossed = next((level for level, minutes in WARNINGS if now >= end - timedelta(minutes=minutes)), None)
        if _RANK[crossed] > _RANK[state.warned]:
            warning = crossed
            state = replace(state, warned=crossed)

    show, due_at = False, None
    if now >= end and not state.visible:
        if not state.started:
            show, due_at = True, end
        elif state.next_due is not None and now >= parse_instant(state.next_due):
            show, due_at = True, parse_instant(state.next_due)
    if show:
        state = replace(state, started=True, next_due=None)

    upcoming = [end - timedelta(minutes=minutes) for _, minutes in WARNINGS] + [end]
    if state.next_due is not None:
        upcoming.append(parse_instant(state.next_due))
    wake_at = min([t for t in upcoming if t > now] + [midnight])
    return state, EndtimeDecision(warning=warning, show=show, hide=hide, due_at=due_at, wake_at=wake_at)


def endtime_shown(state: EndtimeState) -> EndtimeState:
    return replace(state, visible=True, next_due=None)


def endtime_finished(state: EndtimeState, now: datetime) -> EndtimeState:
    """Dismissed, replaced or failed: the policy owns the next occurrence one minute later."""
    if not state.started:
        return replace(state, visible=False)
    return replace(state, visible=False, next_due=format_instant(now + REPEAT))


# Daily allowance. Usage is the measured selected-category total for today, so it only lags,
# never runs ahead. The expiry overlay shows only during fresh evidence of active counted use.

ALLOWANCE_LEVELS = (("expired", 0), ("5m", 5), ("10m", 10), ("15m", 15))  # most urgent first
_ALLOWANCE_RANK = {None: 0, "15m": 1, "10m": 2, "5m": 3, "expired": 4}
ACTIVITY_FRESH = timedelta(seconds=30)
HIDE_SETTLE = timedelta(seconds=5)  # our own focus change when the overlay appears is not the child's switch


@dataclass(frozen=True)
class AllowanceState:
    """Per Kyiv date; a new date starts afresh."""
    date: str | None = None
    warned: str | None = None    # most urgent level already reached (a warning or the overlay)
    visible: bool = False
    shown_at: str | None = None
    next_due: str | None = None  # one minute after dismissal, replacement or failure

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, value: dict) -> "AllowanceState":
        state = cls(**value)
        if state.warned not in _ALLOWANCE_RANK or any(
                instant is not None and parse_instant(instant) is None for instant in (state.shown_at, state.next_due)):
            raise ValueError("invalid allowance state")
        return state


@dataclass(frozen=True)
class AllowanceDecision:
    warning: str | None = None
    show: bool = False
    hide: bool = False
    due_at: datetime | None = None
    remaining_ms: int | None = None


def effective_limit_ms(settings: Settings, date: str) -> int:
    """A today-only override applies on its own Kyiv date; otherwise the recurring default."""
    override = settings.todayOverride
    return override["limitMs"] if override is not None and override["date"] == date else settings.defaultLimitMs


def counted_path(settings: Settings, path: list[str] | None) -> bool:
    if path is None:
        return settings.selectedUncategorized
    return any(path[:len(selected)] == selected for selected in settings.selectedPaths)


def activity_gate(settings: Settings, activity: dict | None, now: datetime) -> tuple[bool, datetime | None]:
    """(counted, observed): whether fresh evidence shows active counted use, and when the last outside
    observation was made; observed is None without fresh evidence. Companion-owned foreground refreshes
    the last outside observation instead of replacing it."""
    if activity is None or activity["state"] is None:
        return False, None
    observed = parse_instant(activity["observedAt"])
    latest = max(observed, parse_instant(activity["ownedAt"])) if activity["ownedAt"] else observed
    if latest < now - ACTIVITY_FRESH:
        return False, None
    return activity["state"] == "active" and counted_path(settings, activity["path"]), observed


def evaluate_allowance(settings: Settings, state: AllowanceState, used_ms: int | None, activity: dict | None,
                       now: datetime, paused: bool = False) -> tuple[AllowanceState, AllowanceDecision]:
    """paused: no caregiver is paired (ACCESS-08); like free use, pairing again resumes from today's usage."""
    date = kyiv_date(now)
    hide = False
    if state.date != date:
        hide = state.visible
        state = AllowanceState(date=date)
    if used_ms is None:
        return state, AllowanceDecision(hide=hide)
    remaining = effective_limit_ms(settings, date) - used_ms
    level = next((name for name, minutes in ALLOWANCE_LEVELS if remaining <= minutes * 60_000), None)
    if _ALLOWANCE_RANK[level] < _ALLOWANCE_RANK[state.warned]:
        state = replace(state, warned=level)  # more time was granted; later thresholds warn again
    exhausted = level == "expired"
    if not exhausted:
        state = replace(state, next_due=None)
    eligible = not paused and settings.freeUseDate != date and settings.suppressedDate != date
    counted, observed = activity_gate(settings, activity, now)
    if state.visible:
        shown = parse_instant(state.shown_at)
        away = not counted and (now >= shown + ACTIVITY_FRESH if observed is None else observed >= shown + HIDE_SETTLE)
        if not exhausted or not eligible or away:
            # Pausing for AFK or schoolwork: an active return shows it again at once.
            hide = True
            state = replace(state, visible=False, shown_at=None)
    if not eligible:
        return replace(state, next_due=None), AllowanceDecision(hide=hide, remaining_ms=remaining)

    warning = None
    if _ALLOWANCE_RANK[level] > _ALLOWANCE_RANK[state.warned]:
        warning = None if exhausted else level  # running out goes straight to the overlay
        state = replace(state, warned=level)
    show = exhausted and counted and not state.visible and (
        state.next_due is None or now >= parse_instant(state.next_due))
    due_at = (parse_instant(state.next_due) if state.next_due else now) if show else None
    return state, AllowanceDecision(warning=warning, show=show, hide=hide, due_at=due_at, remaining_ms=remaining)


def allowance_shown(state: AllowanceState, now: datetime) -> AllowanceState:
    return replace(state, visible=True, shown_at=format_instant(now), next_due=None)


def allowance_finished(state: AllowanceState, now: datetime) -> AllowanceState:
    """Dismissed, replaced, failed or interrupted by a restart: the next occurrence is one minute later."""
    return replace(state, visible=False, shown_at=None, next_due=format_instant(now + REPEAT))
