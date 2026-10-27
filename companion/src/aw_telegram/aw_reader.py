"""Read-only ActivityWatch adapter, with no implicit endpoint or settings clients.

The local fragment mirrors AW canonical desktop flood/filter/categorize machinery.
It deliberately does not import aw-client: published 0.5.15 lacks exact IDs, auth,
and bounded transport, while a newer checkout advertises the same version.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import http.client
import json
import math
import re
from typing import Callable, Protocol

from .category_settings import CategorySettingsUnsupported, EffectiveCategories, resolve_categories
from .clock import format_instant, kyiv_date, local_day_bounds, retained_dates
from .counting import aggregate, category_record, leaf_records, normalize, selected_total
from .models import DaySummary, LiveState, Settings, collection_start


class AWUnavailable(RuntimeError):
    """Transport/server failure; previous successful summary remains available."""


class AWUnsupported(RuntimeError):
    """Explicit configuration/query compatibility failure, never stock defaults."""


class CollectionNotStarted(RuntimeError):
    pass


class AWClient(Protocol):
    def get_info(self) -> dict: ...
    def get_buckets(self) -> dict: ...
    def get_setting(self) -> dict: ...
    def query(self, query: str, timeperiods: list[tuple[datetime, datetime]]) -> list: ...


class LocalAWClient:
    """Only explicit loopback HTTP; no proxies, redirect following, or config IO.

    timeout bounds each socket operation; response size bounds memory. No retries.
    Authentication is supplied explicitly and never included in diagnostic strings.
    """
    def __init__(self, *, host: str, port: int, timeout: float = 3.0, api_key: str | None = None):
        if host not in ('127.0.0.1', 'localhost', '::1') or type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('explicit loopback host and port required')
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 30:
            raise ValueError('timeout must be finite and bounded')
        if api_key is not None and (not isinstance(api_key, str) or not api_key or any(ord(c) < 33 or ord(c) > 126 for c in api_key)):
            raise ValueError('invalid API key')
        self.host = '127.0.0.1' if host == 'localhost' else host
        self.port, self.timeout, self._api_key = port, timeout, api_key

    def _request(self, method: str, endpoint: str, body=None):
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
        if self._api_key:
            headers['Authorization'] = 'Bearer ' + self._api_key
        connection = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        try:
            payload = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
            connection.request(method, '/api/0/' + endpoint, payload, headers)
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                # Do not follow even local redirects or log a response body/secret.
                raise AWUnavailable('http_status_' + str(response.status))
            raw = response.read(16*1024*1024 + 1)
            if len(raw) > 16*1024*1024:
                raise AWUnavailable('response_too_large')
            def reject_constant(value):
                raise ValueError('nonfinite JSON')
            return json.loads(raw, parse_constant=reject_constant)
        except AWUnavailable:
            raise
        except (OSError, http.client.HTTPException, ValueError, UnicodeError):
            raise AWUnavailable('transport_or_json_failure') from None
        finally:
            connection.close()

    def get_info(self):
        return self._request('GET', 'info')

    def get_buckets(self):
        return self._request('GET', 'buckets/')

    def get_setting(self):
        return self._request('GET', 'settings')

    def query(self, query, timeperiods):
        periods = []
        for start, end in timeperiods:
            periods.append(format_instant(start) + '/' + format_instant(end))
        # One array element preserves semicolons inside regex strings; the AW
        # server joins the array then parses statements respecting quoted text.
        return self._request('POST', 'query/', {'query': [query], 'timeperiods': periods, 'cache': False})


@dataclass(frozen=True)
class AWCapabilities:
    reachable: bool
    hostname: str | None
    server_version: str | None
    window_bucket_id: str | None
    afk_bucket_id: str | None
    category_settings_supported: bool
    category_source: str | None
    browser_enrichment_supported: bool
    issues: tuple[str, ...]


@dataclass(frozen=True)
class AWHealth:
    state: str = 'unknown'
    reason: str | None = None
    last_success_at: str | None = None


def _safe_bucket_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:@ -]{1,512}', value):
        raise AWUnsupported('unsafe_bucket_id')
    return value


def _choose(buckets, hostname, kind, explicit):
    expected_type, expected_client = ('currentwindow', 'aw-watcher-window') if kind == 'window' else ('afkstatus', 'aw-watcher-afk')
    candidates = []
    for key, bucket in buckets.items():
        if not isinstance(key, str) or not isinstance(bucket, dict):
            continue
        identity = bucket.get('id', key)
        if identity != key or not isinstance(identity, str):
            continue
        if not isinstance(bucket.get('data', {}), dict):
            continue
        if (bucket.get('type') != expected_type or bucket.get('client') != expected_client
                or bucket.get('hostname') != hostname
                or any(marker in identity.casefold() for marker in ('-synced-from-', 'import', 'android', 'screentime'))
                or bucket.get('data', {}).get('imported') is True):
            continue
        try:
            candidates.append(_safe_bucket_id(identity))
        except AWUnsupported:
            continue
    if explicit is not None:
        return (explicit, None) if explicit in candidates else (None, 'invalid_' + kind + '_selection')
    if len(candidates) == 1:
        return candidates[0], None
    return None, ('ambiguous_' if candidates else 'missing_') + kind


def _marker(segment):
    # Keep safe plain paths legible; encode all other scalars to avoid depending
    # on the AW query parser's non-JSON handling of escaped path characters.
    safe = re.fullmatch(r'[A-Za-z0-9 _.-]+', segment)
    return 'awtg:' + (segment if safe else '!' + segment.encode('utf-8').hex())


def build_query(window_bucket_id: str, afk_bucket_id: str, categories: EffectiveCategories):
    window, afk = _safe_bucket_id(window_bucket_id), _safe_bucket_id(afk_bucket_id)
    mapping, rules = {}, []
    for path, rule in categories.rules:
        encoded = tuple(_marker(x) for x in path)
        mapping[encoded] = path
        rules.append([list(encoded), rule])
    # Same canonical server transforms, explicit IDs and no browser/audible/
    # always-active/implicit category lookup branches. Preserve raw evidence.
    query = f'''window_raw = query_bucket("{window}");
afk_raw = query_bucket("{afk}");
events = flood(window_raw);
not_afk = flood(afk_raw);
not_afk = filter_keyvals(not_afk, "status", ["not-afk"]);
events = filter_period_intersect(events, not_afk);
'''
    if rules:
        # AW's query parser keeps regex backslashes literal, as canonicalEvents
        # does. Do not apply this convention to the surrounding HTTP JSON body.
        literal = json.dumps(rules, ensure_ascii=False).replace('\\\\', '\\')
        query += f'events = categorize(events, {literal});\n'
    query += '''sample = limit_events(window_raw, 1);
check_priority = categorize(sample, [[["high"], {"type":"regex", "regex":".*", "priority":100}], [["low","deeper"], {"type":"regex", "regex":".*", "priority":1}]]);
check_keys = categorize(sample, [[["wrong"], {"type":"regex", "regex":".*", "select_keys":["__awtg_missing__"]}]]);
check_tie = categorize(sample, [[["earlier"], {"type":"regex", "regex":".*", "priority":10}], [["later"], {"type":"regex", "regex":".*", "priority":10}]]);
RETURN = {"events":events, "window_raw":window_raw, "afk_raw":afk_raw, "checks":{"priority":check_priority,"keys":check_keys,"tie":check_tie}};
'''
    return query, mapping


_OWN_TITLES = {'Нагадування AW Telegram', 'Сповіщення AW Telegram', 'Таймер AW Telegram'}


def companion_foreground(data: dict) -> bool:
    app = data.get('app', '').casefold()
    return app in {'aw-telegram-companion.exe', 'aw-telegram.exe'} or app in {'python.exe', 'pythonw.exe'} and data.get('title') in _OWN_TITLES


def _utc_now():
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=value.microsecond//1000*1000)


class AWReader:
    def __init__(self, *, client: AWClient, collection_started_at: datetime | None = None,
                 settings: Settings | None = None, now: Callable[[], datetime] | None = None,
                 window_bucket_id: str | None = None, afk_bucket_id: str | None = None,
                 sequence_provider: Callable[[], int] | None = None,
                 owned_foreground: Callable[[dict], bool] = companion_foreground,
                 freshness: timedelta = timedelta(seconds=30)):
        if collection_started_at is not None:
            format_instant(collection_started_at)
        if freshness <= timedelta(0) or freshness > timedelta(minutes=1):
            raise ValueError('freshness must be positive and at most one minute')
        self.client, self.collection_started_at = client, collection_started_at
        self.settings = settings or Settings()
        self.now = now or _utc_now
        self.window_bucket_id, self.afk_bucket_id = window_bucket_id, afk_bucket_id
        # Zero is an unsequenced candidate. Task5 must inject durable allocation.
        self.sequence_provider = sequence_provider or (lambda: 0)
        self.owned_foreground, self.freshness = owned_foreground, freshness
        self.health, self.last_summary = AWHealth(), None
        self.capabilities = None
        self._categories = None

    def _health(self, state, reason=None):
        previous = self.health.last_success_at
        self.health = AWHealth(state, reason, format_instant(self.now()) if state == 'ready' else previous)

    def probe(self) -> AWCapabilities:
        try:
            info = self.client.get_info()
            buckets = self.client.get_buckets()
            settings_issue = None
            try:
                settings = self.client.get_setting()
            except AWUnavailable:
                settings, settings_issue = None, 'category_settings_unavailable'
            if not isinstance(info, dict) or not isinstance(info.get('hostname'), str) or not info['hostname'] or not isinstance(buckets, dict):
                raise AWUnavailable('invalid_metadata')
            window, window_issue = _choose(buckets, info['hostname'], 'window', self.window_bucket_id)
            afk, afk_issue = _choose(buckets, info['hostname'], 'afk', self.afk_bucket_id)
            issues = [x for x in (window_issue, afk_issue, settings_issue) if x]
            try:
                self._categories = resolve_categories(settings)
            except CategorySettingsUnsupported as exc:
                self._categories = None
                issues.append(str(exc))
            result = AWCapabilities(True, info['hostname'], str(info['version']) if info.get('version') is not None else None,
                                    window, afk, self._categories is not None,
                                    self._categories.source if self._categories else None, False,
                                    tuple(issues + ['browser_enrichment_unavailable', 'browser_local_settings_unavailable', 'ui_build_presets_unverified']))
            self.capabilities = result
            self._health('unsupported' if issues else 'ready', issues[0] if issues else None)
            return result
        except AWUnavailable as exc:
            self._health('unavailable', str(exc))
            result = AWCapabilities(False, None, None, None, None, False, None, False, (str(exc),))
            self.capabilities = result
            return result

    def _gate(self, received):
        cached = None if self.collection_started_at is None else format_instant(self.collection_started_at)
        incoming = None if received is None else format_instant(received)
        value = collection_start(cached, incoming)
        if value is None:
            raise CollectionNotStarted('first_parent_pairing_required')
        if received > self.now():
            raise ValueError('collection start is in the future')
        self.collection_started_at = received
        return received

    def _read(self, start, end):
        capabilities = self.probe()
        if not capabilities.reachable:
            raise AWUnavailable(self.health.reason)
        if not capabilities.window_bucket_id or not capabilities.afk_bucket_id or not self._categories:
            raise AWUnsupported(self.health.reason or 'setup_required')
        query, mapping = build_query(capabilities.window_bucket_id, capabilities.afk_bucket_id, self._categories)
        try:
            result = self.client.query(query, [(start, end)])
            if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
                raise AWUnsupported('invalid_query_result')
            result = result[0]
            if any(not isinstance(result.get(key), list) for key in ('events', 'window_raw', 'afk_raw')):
                raise AWUnsupported('invalid_query_events')
            if result['window_raw']:
                checks = result.get('checks', {})
                if not isinstance(checks, dict):
                    raise AWUnsupported('invalid_query_checks')
                for key, expected in [('priority', ['high']), ('keys', ['Uncategorized']), ('tie', ['later'])]:
                    values = checks.get(key)
                    if not isinstance(values, list) or len(values) != 1:
                        raise AWUnsupported('server_rule_semantics_unsupported')
                    sample = values[0]
                    if isinstance(sample, dict):
                        data = sample.get('data')
                        if not isinstance(data, dict):
                            raise AWUnsupported('invalid_query_check_event')
                        category = data.get('$category')
                    else:
                        category = sample
                    if category != expected:
                        raise AWUnsupported('server_rule_semantics_unsupported')
            self._health('ready')
            return result, mapping
        except AWUnavailable as exc:
            self._health('unavailable', str(exc))
            raise
        except AWUnsupported as exc:
            self._health('unsupported', str(exc))
            raise

    def summarize(self, start: datetime, end: datetime, collection_started_at: datetime | None) -> DaySummary:
        paired = self._gate(collection_started_at)
        format_instant(start), format_instant(end)
        current = self.now()
        day = kyiv_date(start)
        day_start, day_end = local_day_bounds(day)
        if not start < end <= day_end or day not in retained_dates(current):
            raise ValueError('summary must be inside one retained Kyiv day')
        lo, hi = max(start, paired), min(end, current)
        if lo >= hi:
            raise ValueError('no paired collection interval')
        result, mapping = self._read(lo, hi)
        try:
            counted = aggregate(result['events'], result['window_raw'], result['afk_raw'], lo, hi, mapping, self.owned_foreground)
        except ValueError:
            self._health('unsupported', 'invalid_server_categories')
            raise AWUnsupported('invalid_server_categories') from None
        coverage = counted.coverage
        first, last = (coverage[0][0], coverage[-1][1]) if coverage else (None, None)
        partial = bool(counted.invalid_events or len(coverage) != 1 or first != day_start or last != min(day_end, current))
        day_summary = DaySummary(day, leaf_records(counted.totals), sum(counted.totals.values()),
                                 selected_total(counted.totals, [tuple(p) for p in self.settings.selectedPaths], self.settings.selectedUncategorized),
                                 self.settings.revision, self._categories.revision,
                                 format_instant(first) if first else None, format_instant(last) if last else None,
                                 partial, self.sequence_provider())
        self._health('partial' if partial else 'ready')
        self.last_summary = day_summary
        return day_summary

    def live(self) -> LiveState:
        paired = self._gate(self.collection_started_at)
        now = self.now()
        def unknown():
            if self.health.state not in ('unavailable', 'unsupported'):
                self._health('stale', 'fresh_foreground_evidence_unavailable')
            return LiveState(format_instant(now), 'unknown', None, None, None, None, [])
        start = max(paired, now - self.freshness)
        if start >= now:
            return unknown()
        try:
            result, mapping = self._read(start, now)
            windows, bad_window = normalize(result['window_raw'], start, now, 'window')
            statuses, bad_afk = normalize(result['afk_raw'], start, now, 'afk')
            if bad_window or bad_afk or not windows or not statuses:
                return unknown()
            window, status = windows[-1], statuses[-1]
            if min(window.end, status.end) < now - self.freshness or window.start >= status.end or status.start >= window.end:
                return unknown()
            if self.owned_foreground(window.data):
                return unknown()
            observed = format_instant(min(now, window.end, status.end).replace(microsecond=min(now, window.end, status.end).microsecond//1000*1000))
            if status.data['status'] == 'afk':
                return LiveState(observed, 'afk', None, None, None, self._categories.revision, self._categories.catalog)
            canonical, invalid = normalize(result['events'], start, now, 'window')
            matching = [s for s in canonical if s.start < min(window.end, status.end) <= s.end and s.data.get('app') == window.data['app'] and s.data.get('title', '') == window.data.get('title', '')]
            if invalid or not matching:
                return unknown()
            category = matching[-1].data.get('$category')
            if category is None and mapping or category is not None and (not isinstance(category, list) or any(not isinstance(x, str) for x in category)):
                raise AWUnsupported('invalid_server_categories')
            path = None if category is None or category == ['Uncategorized'] else mapping.get(tuple(category))
            if category not in (None, ['Uncategorized']) and path is None:
                raise AWUnsupported('invalid_server_categories')
            # Unicode scalar wire limits; AW input surrogates are replaced locally.
            clean = lambda text, limit: ''.join(c if not 0xD800 <= ord(c) <= 0xDFFF else '\ufffd' for c in text)[:limit]
            return LiveState(observed, 'active', clean(window.data['app'], 256), clean(window.data.get('title', ''), 1000), category_record(path), self._categories.revision, self._categories.catalog)
        except AWUnsupported as exc:
            self._health('unsupported', str(exc))
            return unknown()
        except AWUnavailable:
            return unknown()
