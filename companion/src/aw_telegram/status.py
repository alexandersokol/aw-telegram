"""Ukrainian «Стан» text for the companion window. Pure: no Qt, IO or clock reads.

Wording follows the bot's /status so caregivers and the laptop describe the same facts the same way.
Missing data is never shown as zero usage.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

from .clock import KYIV, kyiv_date, parse_instant
from .models import Settings
from .policy import effective_limit_ms

ONLINE = timedelta(seconds=60)  # sync runs every 15 s
AW_STATE = dict(ready="працює", partial="неповні дані", stale="дані застаріли", unavailable="недоступний",
                unsupported="категорії не налаштовано", unknown="невідомо")


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


def duration(ms: int) -> str:
    if 0 < ms < 60_000:
        return "менше 1 хв"
    minutes = ms // 60_000
    hours = minutes // 60
    return f"{hours} год {minutes % 60:02d} хв" if hours else f"{minutes} хв"


def _when(instant: str, now: datetime) -> str:
    local, today = parse_instant(instant).astimezone(KYIV), now.astimezone(KYIV)
    clock = local.strftime("%H:%M")
    return f"о {clock}" if local.date() == today.date() else f"{local.strftime('%d.%m')} о {clock}"


def status_lines(s: StatusInput) -> list[str]:
    if not s.enrolled:
        return ["Сервер: ноутбук не підключено. Введіть код підключення в «Налаштування»."]
    lines = []
    if s.sync is not None and s.sync["auth_blocked"]:
        lines.append("Сервер: доступ ноутбука відхилено. Попросіть власника видати новий код підключення.")
    elif s.last_sync_at is None:
        lines.append("Сервер: ще не синхронізувався")
    elif s.now - parse_instant(s.last_sync_at) <= ONLINE:
        lines.append(f"Сервер: на зв’язку, остання синхронізація {_when(s.last_sync_at, s.now)}")
    else:
        lines.append(f"Сервер: немає зв’язку, остання синхронізація {_when(s.last_sync_at, s.now)}")
    if not s.paired:
        lines.append("Батьки: ще ніхто не під’єднався. Створіть ключ у «Доступ батьків».")
        lines.append("ActivityWatch: облік почнеться після першого під’єднання батьків")
    else:
        health = (s.sync or {}).get("health") or {}
        aw = AW_STATE.get(health.get("awState"), "невідомо")
        if health.get("reportError"):
            aw += " (звіт завеликий, надіслано останні дані)"
        lines.append(f"ActivityWatch: {aw}")

    date, settings = kyiv_date(s.now), s.settings
    if not settings.selectedPaths and not settings.selectedUncategorized:
        lines.append("Сьогодні: для обліку не вибрано жодної категорії. Оберіть їх у Telegram: /categories.")
    elif s.used_ms is None:
        lines.append("Сьогодні: даних немає")
    else:
        partial = " (неповні дані)" if s.partial else ""
        if settings.freeUseDate == date:
            lines.append(f"Сьогодні: {duration(s.used_ms)}{partial}, вільний режим")
        else:
            limit = effective_limit_ms(settings, date)
            left = limit - s.used_ms
            rest = f"залишилось {duration(left)}" if left >= 0 else f"перевищено на {duration(-left)}"
            lines.append(f"Сьогодні: {duration(s.used_ms)} з {duration(limit)}, {rest}{partial}")
    lines.append(f"Час завершення: увімкнено, о {settings.endtimeLocalTime}" if settings.endtimeEnabled
                 else "Час завершення: вимкнено")
    lines.append(f"Вільний режим: {'увімкнено до опівночі' if settings.freeUseDate == date else 'вимкнено'}")
    lines.append(f"Автоматичні нагадування: {'вимкнено до опівночі' if settings.suppressedDate == date else 'активні'}")
    return lines


def read_status(store, sync: dict | None, now: datetime) -> StatusInput:
    """Collect status inputs from the GUI thread's own store connection."""
    date = kyiv_date(now)
    day = store.day(date)
    return StatusInput(now=now, enrolled=store.binding is not None, paired=store.collection_started_at is not None,
                       settings=store.settings, used_ms=store.selected_usage(date), partial=bool(day and day.partial),
                       last_sync_at=store._state()["lastSuccessfulSyncAt"], sync=sync)
