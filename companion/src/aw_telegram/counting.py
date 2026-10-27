"""Conservative disjoint foreground/AFK evidence, in integer milliseconds.

Canonical flooding may estimate short gaps; final raw-evidence intersection here
removes those estimates and never extends a heartbeat tail or a sleep gap.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
from .models import MAX_SAFE_INTEGER, category_key, selected_total as contract_selected_total

Path = tuple[str, ...] | None
MILLISECOND = timedelta(milliseconds=1)


@dataclass(frozen=True)
class Span:
    start: datetime
    end: datetime
    data: dict


@dataclass(frozen=True)
class Aggregation:
    totals: dict[Path, int]
    coverage: list[tuple[datetime, datetime]]
    invalid_events: int


def selected_total(leaf_totals: dict[Path, int], paths: list[tuple[str, ...]], selected_uncategorized: bool = False) -> int:
    leaves = leaf_records(leaf_totals)
    for path in paths:
        category_key(list(path))
    if any(type(n) is not int or not 0 <= n <= MAX_SAFE_INTEGER for n in leaf_totals.values()):
        raise ValueError('invalid leaf duration')
    return contract_selected_total(leaves, [list(p) for p in paths], selected_uncategorized)


def category_record(path: Path) -> dict:
    return {'id': 'uncategorized' if path is None else category_key(list(path)), 'path': None if path is None else list(path)}


def leaf_records(totals: dict[Path, int]) -> list[dict]:
    return [{'category': category_record(p), 'totalMs': n} for p, n in totals.items()]


def normalize(events: list, start: datetime, end: datetime, kind: str) -> tuple[list[Span], int]:
    if not isinstance(events, list):
        raise ValueError('invalid event list')
    spans, invalid = [], 0
    for index, event in enumerate(events):
        try:
            if not isinstance(event, dict) or not isinstance(event.get('data'), dict):
                raise ValueError()
            stamp = event['timestamp']
            if not isinstance(stamp, str):
                raise ValueError()
            lo = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if lo.tzinfo is None or lo.utcoffset() is None:
                raise ValueError()
            lo = lo.astimezone(timezone.utc)
            original_start = lo
            duration = event['duration']
            if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
                raise ValueError()
            hi = lo + timedelta(seconds=duration)
            data = event['data']
            if kind == 'window' and (not isinstance(data.get('app'), str) or not data['app'] or not isinstance(data.get('title', ''), str)):
                raise ValueError()
            if kind == 'afk' and data.get('status') not in ('not-afk', 'afk'):
                raise ValueError()
            lo, hi = max(lo, start), min(hi, end)
            # AW records arbitrary microseconds; wire evidence is conservative
            # whole milliseconds, never rounded out into unobserved time.
            if lo.microsecond % 1000:
                lo += timedelta(microseconds=1000-lo.microsecond % 1000)
            hi = hi.replace(microsecond=hi.microsecond//1000*1000)
            if lo < hi:
                spans.append((lo, hi, index, data, original_start))
        except (KeyError, TypeError, ValueError, OverflowError):
            invalid += 1
    # Sweep boundaries; later timestamp wins (stable input position breaks ties).
    # Active heap avoids quadratic work on full-day event streams.
    import heapq
    boundaries = sorted({x for lo, hi, _, _, _ in spans for x in (lo, hi)})
    entries = sorted(spans, key=lambda item: (item[0], item[2]))
    heap, position, result = [], 0, []
    for lo, hi in zip(boundaries, boundaries[1:]):
        while position < len(entries) and entries[position][0] <= lo:
            a, b, order, data, original = entries[position]
            heapq.heappush(heap, (-original.timestamp(), -order, b, order, data))
            position += 1
        while heap and heap[0][2] <= lo:
            heapq.heappop(heap)
        if heap:
            data = heap[0][4]
            if result and result[-1].end == lo and result[-1].data == data:
                result[-1] = Span(result[-1].start, hi, data)
            else:
                result.append(Span(lo, hi, data))
    return result, invalid


def intersect(first: list[Span], second: list[Span], *, matching_identity: bool = False) -> list[Span]:
    result, i, j = [], 0, 0
    while i < len(first) and j < len(second):
        a, b = first[i], second[j]
        lo, hi = max(a.start, b.start), min(a.end, b.end)
        same_identity = a.data.get('app') == b.data.get('app') and a.data.get('title', '') == b.data.get('title', '')
        if lo < hi and (not matching_identity or same_identity):
            result.append(Span(lo, hi, a.data))
        if a.end <= b.end:
            i += 1
        else:
            j += 1
    return result


def aggregate(canonical: list, windows: list, afk: list, start: datetime, end: datetime,
              category_map: dict[tuple[str, ...], tuple[str, ...]], owned=lambda data: False) -> Aggregation:
    foreground, bad_window = normalize(windows, start, end, 'window')
    statuses, bad_afk = normalize(afk, start, end, 'afk')
    categorized, bad_canonical = normalize(canonical, start, end, 'window')
    active = [s for s in statuses if s.data['status'] == 'not-afk']
    external = [s for s in foreground if not owned(s.data)]
    evidence = intersect(external, active)
    counted_spans = intersect(categorized, evidence, matching_identity=True)
    # AFK and companion focus are known exclusions. Active external intervals
    # require categorized evidence; a missing canonical result is unknown.
    known = intersect(foreground, [s for s in statuses if s.data['status'] == 'afk'])
    known += intersect([s for s in foreground if owned(s.data)], statuses)
    known += counted_spans
    coverage = []
    for span in sorted(known, key=lambda s: s.start):
        if coverage and coverage[-1][1] >= span.start:
            coverage[-1] = (coverage[-1][0], max(coverage[-1][1], span.end))
        else:
            coverage.append((span.start, span.end))
    totals = {}
    for span in counted_spans:
        if owned(span.data):
            continue
        category = span.data.get('$category')
        if category is None and category_map:
            raise ValueError('server omitted category')
        if category is None or category == ['Uncategorized']:
            path = None
        elif not isinstance(category, list) or any(not isinstance(x, str) for x in category) or tuple(category) not in category_map:
            raise ValueError('server returned unknown category')
        else:
            path = category_map[tuple(category)]
        totals[path] = totals.get(path, 0) + (span.end-span.start)//MILLISECOND
    return Aggregation({p:n for p,n in totals.items() if n}, coverage, bad_window+bad_afk+bad_canonical)
