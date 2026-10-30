"""The «Стан» / Status text for the companion window, in the chosen language. Pure: no Qt, IO or clock reads.

Wording follows the bot's /status so caregivers and the laptop describe the same facts the same way.
Missing data is never shown as zero usage.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

from .clock import KYIV, kyiv_date, parse_instant
from .models import Settings
from .policy import effective_limit_ms
from .texts import t

ONLINE = timedelta(seconds=60)  # sync runs every 15 s
AW_STATES = ("ready", "partial", "stale", "unavailable", "unsupported", "unknown")


@dataclass(frozen=True)
class StatusInput:
    now: datetime
    enrolled: bool
    paired: bool               # a caregiver has paired at least once, so collection has started
    settings: Settings
    used_ms: int | None        # today's measured selected total; None when nothing was measured
    partial: bool
    last_sync_at: str | None
    sync: dict | None          # IO worker snapshot: health, auth_blocked
    caregivers: int | None = None  # paired now, per the newest sync


def duration(ms: int) -> str:
    if 0 < ms < 60_000:
        return t("status.duration.under_minute")
    minutes = ms // 60_000
    hours = minutes // 60
    return t("status.duration.hours", hours=hours, minutes=minutes % 60) if hours else t("status.duration.minutes", minutes=minutes)


def _when(instant: str, now: datetime) -> str:
    local, today = parse_instant(instant).astimezone(KYIV), now.astimezone(KYIV)
    clock = local.strftime("%H:%M")
    return (t("status.when.today", clock=clock) if local.date() == today.date()
            else t("status.when.date", date=local.strftime("%d.%m"), clock=clock))


def status_lines(s: StatusInput) -> list[str]:
    if not s.enrolled:
        return [t("status.server.not_enrolled")]
    lines = []
    if s.sync is not None and s.sync["auth_blocked"]:
        lines.append(t("status.server.rejected"))
    elif s.sync is not None and s.sync.get("last_error") == "startup_failed":
        lines.append(t("status.server.startup_failed"))
    elif s.sync is not None and s.sync.get("last_error") == "credential_vault_unavailable":
        lines.append(t("status.server.vault_unavailable"))
    elif s.last_sync_at is None:
        lines.append(t("status.server.never"))
    elif s.now - parse_instant(s.last_sync_at) <= ONLINE:
        lines.append(t("status.server.online", when=_when(s.last_sync_at, s.now)))
    else:
        lines.append(t("status.server.offline", when=_when(s.last_sync_at, s.now)))
    if not s.paired:
        lines.append(t("status.caregivers.none_yet"))
        lines.append(t("status.aw.after_pairing"))
    else:
        if s.caregivers == 0:
            lines.append(t("status.caregivers.none_now"))
        health = (s.sync or {}).get("health") or {}
        state = health.get("awState")
        aw = t(f"status.aw.{state if state in AW_STATES else 'unknown'}")
        if health.get("reportError"):
            aw += t("status.aw.report_error")
        lines.append(t("status.aw.line", state=aw))

    date, settings = kyiv_date(s.now), s.settings
    if not settings.selectedPaths and not settings.selectedUncategorized:
        lines.append(t("status.today.no_categories"))
    elif s.used_ms is None:
        lines.append(t("status.today.no_data"))
    else:
        partial = t("status.today.partial") if s.partial else ""
        if settings.freeUseDate == date:
            lines.append(t("status.today.free_use", used=duration(s.used_ms), partial=partial))
        else:
            limit = effective_limit_ms(settings, date)
            left = limit - s.used_ms
            rest = t("status.today.left", left=duration(left)) if left >= 0 else t("status.today.over", over=duration(-left))
            lines.append(t("status.today.limit", used=duration(s.used_ms), limit=duration(limit), rest=rest, partial=partial))
    lines.append(t("status.endtime.on", time=settings.endtimeLocalTime) if settings.endtimeEnabled
                 else t("status.endtime.off"))
    lines.append(t("status.free_use.on" if settings.freeUseDate == date else "status.free_use.off"))
    lines.append(t("status.reminders.off" if settings.suppressedDate == date else "status.reminders.on"))
    return lines


def read_status(store, sync: dict | None, now: datetime) -> StatusInput:
    """Collect status inputs from the GUI thread's own store connection."""
    date = kyiv_date(now)
    day = store.day(date)
    return StatusInput(now=now, enrolled=store.binding is not None, paired=store.collection_started_at is not None,
                       settings=store.settings, used_ms=store.selected_usage(date), partial=bool(day and day.partial),
                       last_sync_at=store.last_successful_sync_at, sync=sync, caregivers=store.active_caregivers)
