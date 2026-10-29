"""Strict shared v2 wire validation and small domain value objects.

Shape validation does not authenticate a sender or prove a local clock honest.
Context helpers are pure invariants for later authenticated transaction handlers.
"""
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from importlib.resources import files
import json
from typing import Any, ClassVar, Literal, Self

from jsonschema import Draft7Validator, FormatChecker
from referencing import Registry, Resource
from .clock import parse_date, parse_instant, local_day_bounds, retained_dates, kyiv_date, endtime_at
from .windows.foreground import PresentationResult  # shared existing domain type

MAX_SAFE_INTEGER = 9007199254740991
MAX_BODY_BYTES = 131072
_BASE = 'https://aw-telegram.invalid/contracts/v2/'
_SCHEMAS = {p.name.removesuffix('.schema.json'): json.loads(p.read_text(encoding='utf-8'))
            for p in files('aw_telegram').joinpath('schemas').iterdir() if p.name.endswith('.schema.json')}
_REGISTRY = Registry().with_resources((s['$id'], Resource.from_contents(s)) for s in _SCHEMAS.values())
_FORMATS = FormatChecker()


@_FORMATS.checks('local-date', raises=(ValueError, TypeError, OverflowError))
def _valid_date(value):
    if not isinstance(value, str):
        return True  # schema's type validation reports this
    parse_date(value)
    return True


@_FORMATS.checks('utc-instant', raises=(ValueError, TypeError, OverflowError))
def _valid_instant(value):
    if not isinstance(value, str):
        return True
    parse_instant(value)
    return True


_VALIDATORS = {name: Draft7Validator(schema, registry=_REGISTRY, format_checker=_FORMATS)
               for name, schema in _SCHEMAS.items() if name != 'shared'}


def _primitives(value: Any, depth=0) -> None:
    if depth > 64:
        raise ValueError('JSON nesting exceeds transport bound')
    if isinstance(value, str):
        if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise ValueError('strings must contain Unicode scalar values')
    elif type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError('integer exceeds safe wire range')
    elif value is None or type(value) is bool:
        pass
    elif isinstance(value, list):
        for item in value:
            _primitives(item, depth+1)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError('object keys must be strings')
            _primitives(key, depth+1)
            _primitives(item, depth+1)
    else:
        raise ValueError('only strict JSON primitives and integer numbers are accepted')


def parse_json(raw: str | bytes) -> Any:
    if not isinstance(raw, (str, bytes)):
        raise ValueError('expected UTF-8 JSON text')
    try:
        encoded = raw.encode('utf-8') if isinstance(raw, str) else raw
        if len(encoded) > MAX_BODY_BYTES:
            raise ValueError('body exceeds 128 KiB')
        text = encoded.decode('utf-8')
        def pairs(entries):
            result = {}
            for key, value in entries:
                if key in result:
                    raise ValueError('duplicate object key')
                result[key] = value
            return result
        def reject_number(value):
            raise ValueError('wire numbers must use integer notation')
        value = json.loads(text, object_pairs_hook=pairs, parse_float=reject_number, parse_constant=reject_number)
        _primitives(value)
        return value
    except (UnicodeError, RecursionError, json.JSONDecodeError) as exc:
        raise ValueError('invalid UTF-8 JSON') from exc


def category_key(path: list[str]) -> str:
    _primitives(path)
    # Reuse the exact path schema for callers outside envelope validation.
    validator = Draft7Validator({'$ref': _BASE+'shared.schema.json#/$defs/CategoryPath'}, registry=_REGISTRY)
    if not validator.is_valid(path):
        raise ValueError('invalid category path')
    return json.dumps(path, ensure_ascii=False, separators=(',', ':'))


def _category(category):
    expected = 'uncategorized' if category['path'] is None else category_key(category['path'])
    if category['id'] != expected:
        raise ValueError('category ID must be the canonical exact path or uncategorized')


def _unique(values, label):
    if len(values) != len(set(values)):
        raise ValueError('duplicate ' + label)


def selected_total(leaves: list[dict], selected_paths: list[list[str]], selected_uncategorized: bool) -> int:
    _unique([leaf['category']['id'] for leaf in leaves], 'leaf category')
    total = 0
    for leaf in leaves:
        _category(leaf['category'])
        path = leaf['category']['path']
        selected = selected_uncategorized if path is None else any(path[:len(p)] == p for p in selected_paths)
        if selected:
            total += leaf['totalMs']
    if not 0 <= total <= MAX_SAFE_INTEGER:
        raise ValueError('selected total overflow')
    return total


def _reconcile_apps(leaves: list[dict], rows: list[dict]) -> None:
    expected = {leaf['category']['id']: leaf['totalMs'] for leaf in leaves}
    sums = dict.fromkeys(expected, 0)
    pairs = set()
    apps = set()
    for row in rows:
        app, category_id = row['app'], row['categoryId']
        pair = (app, category_id)
        if category_id not in expected or pair in pairs:
            raise ValueError('orphan or duplicate app/category row')
        pairs.add(pair)
        apps.add(app)
        sums[category_id] += row['totalMs']
    if len(apps) > 256 or sums != expected:
        raise ValueError('invalid application reconciliation or cardinality')


def selected_app_totals(leaves: list[dict], rows: list[dict], selected_paths: list[list[str]],
                        selected_uncategorized: bool) -> list[dict]:
    """Project exact applications from unfiltered, reconciled disjoint evidence."""
    _primitives([leaves, rows])
    for values, name, maximum in [(leaves, 'LeafTotal', 1024), (rows, 'AppLeafTotal', 4096)]:
        schema = {'type':'array', 'maxItems':maximum, 'items':{'$ref':_BASE+'shared.schema.json#/$defs/'+name}}
        if not Draft7Validator(schema, registry=_REGISTRY).is_valid(values):
            raise ValueError('invalid aggregate shape')
    # Validate leaf identities, duplicates and the same selection predicate.
    selected_total(leaves, selected_paths, selected_uncategorized)
    for path in selected_paths:
        category_key(path)
    _reconcile_apps(leaves, rows)
    chosen = {leaf['category']['id'] for leaf in leaves
              if selected_total([leaf], selected_paths, selected_uncategorized) > 0}
    totals = {}
    for row in rows:
        if row['categoryId'] in chosen:
            totals[row['app']] = totals.get(row['app'], 0) + row['totalMs']
    # Python str comparison is lexicographic Unicode scalar ordering.
    return [{'app':app, 'totalMs':total} for app,total in sorted(totals.items(), key=lambda x:(-x[1], x[0]))]


def project_day(day: dict, settings: dict) -> dict:
    """Keep source revision/evidence intact while deriving current selected usage."""
    day, settings = validate_contract('day', day), validate_contract('settings', settings)
    total = selected_total(day['leafTotalsMs'], settings['selectedPaths'], settings['selectedUncategorized'])
    if day['settingsRevision'] == settings['revision'] and day['selectedTotalMs'] != total:
        raise ValueError('selected total disagrees with known settings')
    apps = selected_app_totals(day['leafTotalsMs'], day['appLeafTotalsMs'], settings['selectedPaths'], settings['selectedUncategorized'])
    return {'sourceSettingsRevision':day['settingsRevision'], 'settingsRevision':settings['revision'],
            'selectedTotalMs':total, 'appTotalsMs':apps}


class ReportCapacityExceeded(ValueError):
    def __init__(self):
        super().__init__('report_capacity_exceeded')


def minimal_health(observed_at: str = '1970-01-01T00:00:00.000Z') -> dict:
    return dict(observedAt=observed_at, awState='unknown', lastSuccessAt=None, reportError=None)


def capacity_health() -> dict:
    """Largest mandatory health representation; reserve future success/error overhead."""
    return dict(observedAt='1970-01-01T00:00:00.000Z', awState='unavailable',
                lastSuccessAt='1970-01-01T00:00:00.000Z', reportError='report_capacity_exceeded')


def wire_bytes(value: dict) -> bytes:
    _primitives(value)
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def ensure_report_capacity(day: dict, sequence: int = MAX_SAFE_INTEGER) -> None:
    """Preflight an atomic day with maximum mandatory health overhead, never truncate it.

    Task5 must still pack and bound the actual UTF-8 envelope, acks and live data.
    The default reserves the largest possible request sequence's encoded width.
    """
    _primitives(day)
    rows = day.get('appLeafTotalsMs', [])
    if (len(day.get('leafTotalsMs', [])) > 1024 or len(rows) > 4096
            or len({r['app'] for r in rows if isinstance(r, dict) and isinstance(r.get('app'), str)}) > 256):
        raise ReportCapacityExceeded()
    request = validate_contract('sync-request', {'schemaVersion':2, 'sequence':sequence, 'acks':[], 'summaries':[day], 'health':capacity_health()})
    if len(wire_bytes(request)) > MAX_BODY_BYTES:
        raise ReportCapacityExceeded()


def _semantics(name: str, v: dict) -> None:
    if name == 'settings':
        _unique([category_key(p) for p in v['selectedPaths']], 'selected path')
    elif name == 'day':
        for leaf in v['leafTotalsMs']:
            _category(leaf['category'])
        _unique([x['category']['id'] for x in v['leafTotalsMs']], 'leaf category')
        _reconcile_apps(v['leafTotalsMs'], v['appLeafTotalsMs'])
        total = sum(x['totalMs'] for x in v['leafTotalsMs'])
        if total != v['totalActiveMs'] or not 0 <= v['selectedTotalMs'] <= total:
            raise ValueError('invalid disjoint totals')
        start, end = local_day_bounds(v['date'])
        lo, hi = v['availableFrom'], v['availableThrough']
        if lo is None or hi is None:
            if lo != hi or not v['partial'] or v['leafTotalsMs'] or total or v['selectedTotalMs']:
                raise ValueError('unavailable coverage must be null/null, partial and empty')
        else:
            lo, hi = parse_instant(lo), parse_instant(hi)
            if not start <= lo <= hi <= end or total > (hi-lo) // timedelta(milliseconds=1):
                raise ValueError('totals or coverage outside actual Kyiv day')
    elif name == 'live':
        if v['category'] is not None:
            _category(v['category'])
        for category in v['categoryCatalog']:
            _category(category)
        _unique([x['id'] for x in v['categoryCatalog']], 'catalog category')
        if v['state'] == 'unknown' and any(v[k] is not None for k in ('app','title','category','rulesRevision')):
            raise ValueError('unknown foreground must clear identity')
    elif name == 'action':
        created, target, expires = [parse_instant(v[k]) for k in ('createdAt','targetAt','expiresAt')]
        delay = (target-created) // timedelta(milliseconds=1)
        if delay == 0:
            valid = expires-created == timedelta(seconds=60)
        else:
            valid = 60000 <= delay <= 1439*60000 and delay % 60000 == 0 and expires-target == timedelta(seconds=5)
        if not valid:
            raise ValueError('invalid original action delivery/execution window')
    elif name == 'ack' and v['kind'] == 'endtime':
        shown = parse_instant(v['presentedAt'])
        if not endtime_at(v['date'], v['endtimeLocalTime']) <= shown < local_day_bounds(v['date'])[1]:
            raise ValueError('endtime presentation outside due time and Kyiv date')
    elif name == 'ack' and v['kind'] == 'action':
        accepted = None if v['acceptedAt'] is None else parse_instant(v['acceptedAt'])
        at = parse_instant(v['at'])
        presented = None if v['presentedAt'] is None else parse_instant(v['presentedAt'])
        if accepted is None:
            if v['status'] not in ('expired','skipped','canceled','failed') or presented is not None or v['occurrence'] != 0:
                raise ValueError('status/occurrence requires durable acceptance')
        elif at < accepted or presented is not None and not accepted <= presented <= at:
            raise ValueError('inconsistent receipt timestamps')
        status, reason = v['status'], v['reason']
        allowed = {
            'accepted': {None}, 'presenting': {None}, 'presented': {None}, 'dismissed': {None}, 'completed': {None},
            'replaced': {'replaced'}, 'expired': {'display_busy','missed_deadline'}, 'skipped': {'free_use'},
            'canceled': {'canceled'}, 'failed': {'presentation_failed'},
            'unconfirmed': {'presentation_blocked','crash_during_presentation'},
        }
        if reason not in allowed[status]:
            raise ValueError('reason is incompatible with receipt status')
        if status == 'presented' and presented is None:
            raise ValueError('status requires confirmed presentation evidence')
        if status in ('accepted','presenting','expired','skipped','unconfirmed') and presented is not None:
            raise ValueError('status cannot claim confirmed visibility')
    elif name == 'cancellations':
        _unique(v['canceledIds'], 'canceled ID')
    elif name == 'sync-request':
        health = v['health']
        if health['lastSuccessAt'] is not None and health['lastSuccessAt'] > health['observedAt']:
            raise ValueError('health success after observation')
        summaries = v.get('summaries', [])
        _unique([x['date'] for x in summaries], 'summary date')
        for day in summaries:
            _semantics('day', day)
        if 'live' in v:
            _semantics('live', v['live'])
        _unique([x['id'] for x in v['acks']], 'receipt ID')
        for ack in v['acks']:
            _semantics('ack', ack)
    elif name == 'sync-response':
        _unique([r['date'] for r in v['summaryReceipts']], 'summary receipt date')
        _semantics('settings', v['settings'])
        _semantics('cancellations', v['cancellations'])
        _unique([x['id'] for x in v['deliveryOffers']], 'offered action ID')
        _unique(v['acknowledgedAckIds'], 'acknowledged receipt ID')
        for action in v['deliveryOffers']:
            _semantics('action', action)
        if v['collectionStartedAt'] is not None and v['collectionStartedAt'] > v['serverNow']:
            raise ValueError('collection cannot begin in the future')


def validate_contract(name: str, value: Any) -> dict:
    if name not in _VALIDATORS:
        raise ValueError('unknown contract')
    _primitives(value)
    if name in ('sync-request', 'sync-response') and isinstance(value, dict) and type(value.get('schemaVersion')) is int and value['schemaVersion'] != 2:
        raise ValueError('unsupported sync schema version')
    errors = _VALIDATORS[name].iter_errors(value)
    first = next(errors, None)
    if first is not None:
        # Deliberately exclude payload values/messages/titles from error text.
        raise ValueError(f'invalid {name} shape at {list(first.absolute_path)}')
    _semantics(name, value)
    return deepcopy(value)  # no coercion, defaults, trimming or normalization


def collection_start(cached: str | None, received: str | None) -> str | None:
    for value in (cached, received):
        if value is not None:
            parse_instant(value)
    if cached is not None and received != cached:
        raise ValueError('immutable collection start changed or disappeared')
    return received


def validate_activity_context(request: dict, started_at: str | None, now: str) -> None:
    request = validate_contract('sync-request', request)
    current = parse_instant(now)
    if parse_instant(request['health']['observedAt']) > current:
        raise ValueError('health observation is in the future')
    if started_at is None and (request['health']['awState'] != 'unknown' or request['health']['lastSuccessAt'] is not None):
        raise ValueError('activity health is prohibited before pairing')
    if started_at is None:
        if request.get('summaries') or 'live' in request:
            raise ValueError('activity is prohibited before first pairing')
        return
    start = parse_instant(started_at)
    if start > current:
        raise ValueError('collection start is in the future')
    dates = retained_dates(current)
    for day in request.get('summaries', []):
        _, end = local_day_bounds(day['date'])
        if day['date'] not in dates or end <= start:
            raise ValueError('summary outside retained collection dates')
        if day['availableFrom'] is not None:
            if parse_instant(day['availableFrom']) < start or parse_instant(day['availableThrough']) > current:
                raise ValueError('coverage outside collection/current time')
    if 'live' in request and not start <= parse_instant(request['live']['observedAt']) <= current:
        raise ValueError('live observation outside collection/current time')


def action_canceled(action: dict, cancellations: dict) -> bool:
    action = validate_contract('action', action)
    fence = validate_contract('cancellations', cancellations)
    return action['sequence'] <= fence['throughActionSequence'] or action['id'] in fence['canceledIds']


def validate_endtime_receipt(settings: dict, receipt: dict) -> None:
    """Match proof against the known historical settings, not today's policy.

    Authentication, trusted revision lookup, suppression, arrival freshness and
    device/date/generation deduplication belong to the later delivery handler.
    """
    settings, receipt = validate_contract('settings', settings), validate_contract('ack', receipt)
    if (receipt['kind'] != 'endtime' or not settings['endtimeEnabled']
            or receipt['settingsRevision'] != settings['revision']
            or receipt['endtimeLocalTime'] != settings['endtimeLocalTime']
            or receipt['endtimeGeneration'] != settings['endtimeGeneration']):
        raise ValueError('endtime receipt does not match known settings')


def validate_action_receipt(action: dict, receipt: dict) -> None:
    action, receipt = validate_contract('action', action), validate_contract('ack', receipt)
    if receipt['kind'] != 'action' or receipt['actionId'] != action['id']:
        raise ValueError('receipt does not refer to this action')
    created, target, expiry = [parse_instant(action[k]) for k in ('createdAt','targetAt','expiresAt')]
    accepted = None if receipt['acceptedAt'] is None else parse_instant(receipt['acceptedAt'])
    if parse_instant(receipt['at']) < created:
        raise ValueError('receipt event precedes action creation')
    if accepted is not None and not created <= accepted < expiry:
        raise ValueError('acceptance must be within original action window')
    if receipt['occurrence'] > 0:
        options = action['options']
        if action['kind'] != 'overlay' or not options['dismissible'] or options['repeatEveryMinutes'] is None:
            raise ValueError('only repeating dismissible overlays have later occurrences')
    if receipt['presentedAt'] is not None:
        presented = parse_instant(receipt['presentedAt'])
        if receipt['occurrence'] == 0:
            if presented < target or (presented >= expiry if target == created else presented > expiry):
                raise ValueError('initial presentation missed original window')
        elif not target <= presented < local_day_bounds(kyiv_date(target))[1]:
            raise ValueError('repetition outside original Kyiv date')


class WireModel:
    contract: ClassVar[str]

    def __post_init__(self):
        validate_contract(self.contract, asdict(self))

    def to_wire(self) -> dict:
        return validate_contract(self.contract, asdict(self))

    @classmethod
    def from_wire(cls, value: dict) -> Self:
        return cls(**validate_contract(cls.contract, value))


@dataclass(frozen=True)
class Settings(WireModel):
    contract: ClassVar[str] = 'settings'
    revision: int = 0
    selectedPaths: list[list[str]] = field(default_factory=list)
    selectedUncategorized: bool = False
    defaultLimitMs: int = 14400000
    todayOverride: dict | None = None
    freeUseDate: str | None = None
    suppressedDate: str | None = None
    endtimeEnabled: bool = False
    endtimeLocalTime: str = '21:00'
    endtimeGeneration: int = 0


@dataclass(frozen=True)
class DaySummary(WireModel):
    contract: ClassVar[str] = 'day'
    date: str
    leafTotalsMs: list[dict]
    appLeafTotalsMs: list[dict]
    totalActiveMs: int
    selectedTotalMs: int
    settingsRevision: int
    rulesRevision: str
    availableFrom: str | None
    availableThrough: str | None
    partial: bool
    sequence: int


@dataclass(frozen=True)
class Action(WireModel):
    contract: ClassVar[str] = 'action'
    id: str
    actorId: str
    kind: Literal['notify', 'overlay']
    createdAt: str
    targetAt: str
    expiresAt: str
    options: dict
    sequence: int
    settingsRevision: int


@dataclass(frozen=True)
class LiveState(WireModel):
    contract: ClassVar[str] = 'live'
    observedAt: str
    state: Literal['active', 'afk', 'unknown']
    app: str | None
    title: str | None
    category: dict | None
    rulesRevision: str | None
    categoryCatalog: list[dict]


@dataclass(frozen=True)
class Cancellations(WireModel):
    contract: ClassVar[str] = 'cancellations'
    revision: int
    throughActionSequence: int
    canceledIds: list[str]


@dataclass(frozen=True)
class ActionAck(WireModel):
    contract: ClassVar[str] = 'ack'
    id: str
    kind: Literal['action']
    actionId: str
    eventSequence: int
    occurrence: int
    status: Literal['accepted','presenting','presented','dismissed','completed','replaced','expired','skipped','canceled','failed','unconfirmed']
    at: str
    acceptedAt: str | None
    presentedAt: str | None
    reason: str | None


@dataclass(frozen=True)
class SettingsAck(WireModel):
    contract: ClassVar[str] = 'ack'
    id: str
    kind: Literal['settings']
    revision: int
    appliedAt: str


@dataclass(frozen=True)
class CancellationAck(WireModel):
    contract: ClassVar[str] = 'ack'
    id: str
    kind: Literal['cancellation']
    revision: int
    throughActionSequence: int
    appliedAt: str


@dataclass(frozen=True)
class EndtimeAck(WireModel):
    contract: ClassVar[str] = 'ack'
    id: str
    kind: Literal['endtime']
    date: str
    settingsRevision: int
    endtimeLocalTime: str
    endtimeGeneration: int
    presentedAt: str


Ack = ActionAck | SettingsAck | CancellationAck | EndtimeAck


@dataclass(frozen=True)
class SyncRequest(WireModel):
    contract: ClassVar[str] = 'sync-request'
    schemaVersion: int
    sequence: int
    acks: list[dict]
    health: dict
    summaries: list[dict] | None = None
    live: dict | None = None

    def __post_init__(self):
        self.to_wire()

    def to_wire(self):
        return validate_contract(self.contract, {k:v for k,v in asdict(self).items() if v is not None})


@dataclass(frozen=True)
class SyncResponse(WireModel):
    contract: ClassVar[str] = 'sync-response'
    schemaVersion: int
    requestSequence: int
    serverNow: str
    collectionStartedAt: str | None
    activeCaregivers: int
    settings: dict
    cancellations: dict
    deliveryOffers: list[dict]
    acknowledgedAckIds: list[str]
    summaryReceipts: list[dict]


@dataclass(frozen=True)
class Evaluation:
    """Policy output type only; no policy implementation or new HTTP payload."""
    date: str
    effectiveLimitMs: int
    remainingMs: int
    freeUse: bool
    suppressed: bool
    automaticEligible: bool
    warning: Literal['15m', '10m', '5m', 'expired'] | None
    dayReset: bool
