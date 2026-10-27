"""Shared cases catch divergent validation, UTC arithmetic and accidental wire changes."""
import importlib
import importlib.util
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / 'contracts' / 'fixtures'


def api():
    assert importlib.util.find_spec('aw_telegram.models'), 'Shared contract validator is not implemented'
    assert importlib.util.find_spec('aw_telegram.clock'), 'Kyiv calendar helpers are not implemented'
    return importlib.import_module('aw_telegram.models'), importlib.import_module('aw_telegram.clock')


def test_shared_wire_cases():
    models, _ = api()
    for case in json.loads((FIXTURES / 'wire.json').read_text(encoding='utf-8')):
        raw = json.dumps(case['value'], ensure_ascii=True)
        if case['valid']:
            assert models.validate_contract(case['contract'], models.parse_json(raw)) == case['value'], case['name']
        else:
            with pytest.raises(ValueError, match='.+'):
                models.validate_contract(case['contract'], models.parse_json(raw))


def test_kyiv_calendar_fixtures():
    _, clock = api()
    data = json.loads((FIXTURES / 'time.json').read_text(encoding='utf-8'))
    for case in data['bounds']:
        start, end = clock.local_day_bounds(case['date'])
        assert [clock.format_instant(start), clock.format_instant(end)] == case['bounds']
        assert int((end-start).total_seconds()*1000) == case['durationMs']
    for case in data['retention']:
        now = clock.parse_instant(case['now'])
        assert clock.retained_dates(now) == case['dates']
        assert clock.kyiv_date(now) == case['dates'][0]
        assert clock.format_instant(clock.retention_start(now)) == case['start']
    for value in data['invalidDates']:
        with pytest.raises(ValueError):
            clock.local_day_bounds(value)
    for value in data['invalidInstants']:
        with pytest.raises(ValueError):
            clock.parse_instant(value)


def test_selection_exact_paths_and_disjoint_descendants():
    models, _ = api()
    data = json.loads((FIXTURES / 'selection.json').read_text(encoding='utf-8'))
    assert models.category_key(data['escapedPath']) == data['key']
    assert models.selected_total(data['leaves'], data['selectedPaths'], False) == 30
    assert models.selected_total(data['leaves'], data['selectedPaths'], True) == 35
    assert models.selected_total(data['leaves'], [], False) == 0


def test_strict_json_boundary_and_python_integer_types():
    models, _ = api()
    for raw in ['{"sequence":1,"sequence":2}', '{"x":{"a":1,"\\u0061":2}}', '{"x":NaN}', '{"x":1.0}', '{"x":1e2}', ' ' * 131073, b'"\xff"', b'\xef\xbb\xbf{}', '{"x":"'+'😀'*32768+'"}']:
        with pytest.raises(ValueError):
            models.parse_json(raw)
    assert models.parse_json('{"x":"😀"}') == {'x': '😀'}
    value = json.loads((FIXTURES / 'wire.json').read_text(encoding='utf-8'))[0]['value']
    for revision in (True, 1.0):
        with pytest.raises(ValueError):
            models.validate_contract('settings', {**value, 'revision': revision})


def test_dataclass_defaults_validate_and_preserve_paths():
    models, _ = api()
    settings = models.Settings()
    assert settings.defaultLimitMs == 14400000
    assert settings.selectedPaths == [] and settings.selectedUncategorized is False
    value = json.loads((FIXTURES / 'wire.json').read_text(encoding='utf-8'))[0]['value']
    assert models.Settings.from_wire(value).to_wire() == value
    with pytest.raises(ValueError):
        models.Settings(defaultLimitMs=-1)
    class_for = {'settings':models.Settings,'day':models.DaySummary,'live':models.LiveState,'action':models.Action,
                 'sync-request':models.SyncRequest,'sync-response':models.SyncResponse,'cancellations':models.Cancellations}
    for case in json.loads((FIXTURES / 'wire.json').read_text(encoding='utf-8')):
        if case['valid'] and case['contract'] in class_for:
            assert class_for[case['contract']].from_wire(case['value']).to_wire() == case['value']


def test_receipt_evidence_and_context_are_separate():
    models, _ = api()
    data = json.loads((FIXTURES / 'evidence.json').read_text(encoding='utf-8'))
    for case in data['receipts']:
        if case['valid']:
            models.validate_action_receipt(case['action'], case['receipt'])
        else:
            with pytest.raises(ValueError):
                models.validate_action_receipt(case['action'], case['receipt'])
    # Arrival time is deliberately not a parameter: late timely evidence remains valid.
    assert data['receipts'][0]['arrivedAt'] > data['receipts'][0]['action']['expiresAt']
    for case in data['collectionTransitions']:
        if case['valid']:
            assert models.collection_start(case['cached'], case['received']) == case['result']
        else:
            with pytest.raises(ValueError):
                models.collection_start(case['cached'], case['received'])
    for case in data['gates']:
        if case['valid']:
            models.validate_activity_context(case['request'], case['startedAt'], case['now'])
        else:
            with pytest.raises(ValueError):
                models.validate_activity_context(case['request'], case['startedAt'], case['now'])
    for case in data['fences']:
        assert models.action_canceled(case['action'], case['cancellations']) == case['canceled']


def test_calendar_boundaries_keep_utc_representable_and_seven_dates():
    _, clock = api()
    for value in ('0001-12-31T21:57:56.000Z', '9999-01-01T00:00:00.000Z'):
        assert clock.format_instant(clock.parse_instant(value)) == value
    assert clock.format_instant(clock.local_day_bounds('1970-01-01')[0]) == '1969-12-31T21:00:00.000Z'
    assert clock.retained_dates(clock.parse_instant('1970-01-07T12:00:00.000Z'))[-1] == '1970-01-01'
    with pytest.raises(ValueError):
        clock.retained_dates(clock.parse_instant('1970-01-06T12:00:00.000Z'))
    with pytest.raises(ValueError):
        clock.format_instant(clock.parse_instant('2026-10-27T09:00:00.000Z').replace(microsecond=1))
    with pytest.raises(ValueError):
        clock.kyiv_date(clock.parse_instant('0001-01-01T12:00:00.000Z'))
