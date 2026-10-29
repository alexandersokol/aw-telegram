"""Pure Kyiv endtime policy. No Qt, storage, clock reads or network.

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
                     resumed: bool = False) -> tuple[EndtimeState, EndtimeDecision]:
    date = kyiv_date(now)
    midnight = local_day_bounds(date)[1]
    fresh = state.date != date or state.generation != settings.endtimeGeneration
    # Midnight, a time edit, disabling and suppression all remove the current instance.
    hide = state.visible and (fresh or not eligible(settings, date))
    if fresh:
        state = EndtimeState(date=date, generation=settings.endtimeGeneration)
    if not eligible(settings, date):
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
