"""Explicit Kyiv calendar policy; UTC instants are canonical millisecond strings."""
from datetime import date, datetime, time, timedelta, timezone
from importlib.resources import files
import re
from zoneinfo import ZoneInfo

# Use the pinned package even on hosts with their own, potentially different, tzdb.
with files('tzdata.zoneinfo.Europe').joinpath('Kyiv').open('rb') as _zone_file:
    KYIV = ZoneInfo.from_file(_zone_file, key='Europe/Kyiv')
UTC = timezone.utc
_DATE = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
_INSTANT = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')


def parse_date(value: str) -> date:
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise ValueError('expected a calendar date')
    parsed = date.fromisoformat(value)
    if not 1970 <= parsed.year <= 2099:
        raise ValueError('supported calendar years are 1970..2099')
    return parsed


def parse_instant(value: str) -> datetime:
    if not isinstance(value, str) or not _INSTANT.fullmatch(value):
        raise ValueError('expected canonical UTC milliseconds')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed


def format_instant(value: datetime) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('expected aware datetime')
    utc = value.astimezone(UTC)
    if utc.microsecond % 1000:
        raise ValueError('instant must have millisecond precision')
    return utc.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def local_day_bounds(value: str) -> tuple[datetime, datetime]:
    day = parse_date(value)
    # Construct consecutive local midnights separately; DST days are not 24 hours.
    return (datetime.combine(day, time(), KYIV).astimezone(UTC),
            datetime.combine(day + timedelta(days=1), time(), KYIV).astimezone(UTC))


def kyiv_date(now: datetime) -> str:
    format_instant(now)  # reject naive/submillisecond inputs, never use host timezone
    try:
        value = now.astimezone(KYIV).date().isoformat()
        parse_date(value)
        return value
    except OverflowError as exc:
        raise ValueError('Kyiv date outside supported calendar range') from exc


def retained_dates(now: datetime) -> list[str]:
    today = parse_date(kyiv_date(now))
    days = [(today - timedelta(days=n)).isoformat() for n in range(7)]
    for day in days:
        parse_date(day)
    return days


def retention_start(now: datetime) -> datetime:
    return local_day_bounds(retained_dates(now)[-1])[0]
