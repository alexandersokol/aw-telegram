"""Shared cases catch divergent validation, UTC arithmetic and accidental wire changes."""
import importlib
import importlib.util
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / 'contracts' / 'fixtures'


def test_shared_endtime_strict_settings_and_confirmed_receipts():
    models, _ = api()
    data = json.loads((FIXTURES / 'endtime.json').read_text(encoding='utf-8'))
    assert models.Settings().to_wire() == data['defaults']
    for case in data['wire']:
        if case['valid']:
            assert models.validate_contract(case['contract'], case['value']) == case['value'], case['name']
            if case['contract'] == 'ack':
                assert models.EndtimeAck.from_wire(case['value']).to_wire() == case['value']
        else:
            with pytest.raises(ValueError, match='.+'):
                models.validate_contract(case['contract'], case['value'])


def test_endtime_resolves_each_kyiv_date_with_earlier_overlap_and_forward_gap():
    _, clock = api()
    assert hasattr(clock, 'endtime_at'), 'endtime wall-time resolution is not implemented'
    data = json.loads((FIXTURES / 'endtime.json').read_text(encoding='utf-8'))
    for case in data['resolutions']:
        assert clock.format_instant(clock.endtime_at(case['date'], case['localTime'])) == case['instant']
    for value in data['invalidTimes']:
        with pytest.raises(ValueError):
            clock.endtime_at('2026-10-29', value)
    for value in ['2026-02-30', '1969-12-31', '2100-01-01', '2026-1-01', None]:
        with pytest.raises(ValueError):
            clock.endtime_at(value, '21:00')


def test_endtime_receipt_matches_known_settings_revision_and_generation():
    models, _ = api()
    assert hasattr(models, 'validate_endtime_receipt'), 'endtime receipt context validation is not implemented'
    data = json.loads((FIXTURES / 'endtime.json').read_text(encoding='utf-8'))
    for case in data['context']:
        if case['valid']:
            models.validate_endtime_receipt(case['settings'], case['receipt'])
        else:
            with pytest.raises(ValueError):
                models.validate_endtime_receipt(case['settings'], case['receipt'])
    with pytest.raises(ValueError):
        models.validate_endtime_receipt(data['context'][0]['settings'],
            dict(id=data['context'][0]['receipt']['id'], kind='settings', revision=7,
                 appliedAt='2026-10-29T19:00:00.000Z'))


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
    assert models.selected_total(data['leaves'], data['selectedPaths'], False) == 33
    assert models.selected_total(data['leaves'], data['selectedPaths'], True) == 38
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


def app_day(apps=1, pairs=1):
    rows = [{'app':f'a{i % apps}', 'categoryId':f'["c{i // apps}"]', 'totalMs':1} for i in range(pairs)]
    leaves = []
    for i in range((pairs+apps-1)//apps):
        leaves.append({'category':{'id':f'["c{i}"]','path':[f'c{i}']},'totalMs':min(apps,pairs-i*apps)})
    return dict(date='2026-10-27',leafTotalsMs=leaves,appLeafTotalsMs=rows,totalActiveMs=pairs,
                selectedTotalMs=pairs,settingsRevision=3,rulesRevision='rules',availableFrom='2026-10-27T08:00:00.000Z',
                availableThrough='2026-10-27T09:00:00.000Z',partial=True,sequence=17)


def test_shared_application_projection_recalculates_unfiltered_rows_and_scalar_ties():
    models, _ = api()
    data = json.loads((FIXTURES / 'selection.json').read_text(encoding='utf-8'))
    for c in data['projections']:
        rows = models.selected_app_totals(data['leaves'], data['appLeafTotalsMs'], c['paths'], c['uncategorized'])
        assert rows == c['apps']
        assert sum(r['totalMs'] for r in rows) == models.selected_total(data['leaves'], c['paths'], c['uncategorized']) == c['total']
    day = {**app_day(), 'leafTotalsMs':data['leaves'], 'appLeafTotalsMs':data['appLeafTotalsMs'],
           'totalActiveMs':78, 'selectedTotalMs':33}
    current = {**models.Settings().to_wire(), 'revision':4, 'selectedPaths':[['GamesPlus']]}
    projected = models.project_day(day, current)
    assert projected == dict(sourceSettingsRevision=3,settingsRevision=4,selectedTotalMs=40,appTotalsMs=[{'app':'Browser','totalMs':40}])
    assert day['settingsRevision']==3 and day['selectedTotalMs']==33
    with pytest.raises(ValueError): models.project_day(day, {**current,'revision':3})
    assert models.project_day(day,{**current,'revision':3,'selectedPaths':data['selectedPaths']})['selectedTotalMs']==33


def test_application_cardinality_and_atomic_day_capacity_are_separate_bounds():
    models, _ = api()
    for apps, pairs, valid in [(256,256,True),(257,257,False),(256,4096,True),(256,4097,False)]:
        day = app_day(apps,pairs)
        if valid: models.validate_contract('day', day)
        else:
            with pytest.raises(ValueError): models.validate_contract('day', day)
            with pytest.raises(models.ReportCapacityExceeded,match='report_capacity_exceeded'): models.ensure_report_capacity(day)
    models.ensure_report_capacity(app_day(256,256))
    # Allowed row cardinality can still be unsendable as one atomic date.
    with pytest.raises(models.ReportCapacityExceeded,match='report_capacity_exceeded'):
        models.ensure_report_capacity(app_day(256,4096))
    day=app_day(9,9); path=['😀"\\'*80]*16
    category={'id':models.category_key(path),'path':path}
    day['leafTotalsMs']=[{'category':category,'totalMs':9}]
    for row in day['appLeafTotalsMs']: row['categoryId']=category['id']; row['app']='😀"\\'*80
    # Preserve distinct exact identities rather than duplicate pairs.
    for i,row in enumerate(day['appLeafTotalsMs']): row['app']+=str(i)
    models.validate_contract('day',day)
    with pytest.raises(models.ReportCapacityExceeded): models.ensure_report_capacity(day)
    assert models.parse_json(b'{}'+b' '*131070)=={}
    with pytest.raises(ValueError): models.parse_json(b'{}'+b' '*131071)


def test_archived_v1_stays_immutable_and_rejects_app_fields_after_generation():
    import hashlib
    import subprocess
    import sys
    from jsonschema import Draft7Validator
    from referencing import Registry, Resource
    root=FIXTURES.parent.parent
    expected=json.loads((FIXTURES/'v1-sha256.json').read_text())
    before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'contracts/v1').glob('*.json')}
    assert before==expected
    subprocess.run([sys.executable,str(root/'contracts/generate_schemas.py')],check=True)
    assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'contracts/v1').glob('*.json')}==expected
    schemas=[json.loads(p.read_text()) for p in (root/'contracts/v1').glob('*.json')]
    registry=Registry().with_resources((s['$id'],Resource.from_contents(s)) for s in schemas)
    archived=Draft7Validator(next(s for s in schemas if s['$id'].endswith('/day.schema.json')),registry=registry)
    day=app_day(); assert not archived.is_valid(day)
    del day['appLeafTotalsMs']; assert archived.is_valid(day)
    endtime=json.loads((FIXTURES/'endtime.json').read_text(encoding='utf-8'))
    for name,value in [('settings',endtime['defaults']),('ack',endtime['context'][0]['receipt'])]:
        schema=next(s for s in schemas if s['$id'].endswith('/'+name+'.schema.json'))
        assert not Draft7Validator(schema,registry=registry).is_valid(value)
    packaged=Path(importlib.import_module('aw_telegram').__file__).parent/'schemas'
    for p in (root/'contracts/v2').glob('*.json'):
        assert p.read_bytes()==(packaged/p.name).read_bytes()
