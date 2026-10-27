import importlib
from datetime import datetime, timedelta, timezone
import pytest

BASE = datetime(2026, 10, 27, 8, tzinfo=timezone.utc)
def event(start, duration, **data):
    return {'timestamp': (BASE + timedelta(seconds=start)).isoformat(), 'duration': duration, 'data': data}

def test_intersection_clips_pairing_and_deduplicates_overlaps():
    m = importlib.import_module('aw_telegram.counting')
    result = m.aggregate(
        [event(0, 40, app='game', **{'$category': ['awtg:Fun','awtg:Games']}), event(20, 40, app='game', **{'$category': ['awtg:Fun','awtg:Games']})],
        [event(0, 60, app='game')], [event(5, 40, status='not-afk'), event(15, 30, status='not-afk')],
        BASE+timedelta(seconds=10), BASE+timedelta(seconds=60), {('awtg:Fun','awtg:Games'): ('Fun','Games')})
    assert result.totals == {('Fun','Games'):35000}
    assert result.coverage == [(BASE+timedelta(seconds=10), BASE+timedelta(seconds=45))]
    assert m.selected_total(result.totals, [('Fun',),('Fun','Games')]) == 35000

def test_conflicting_later_afk_and_window_win_and_no_audible_exception():
    m = importlib.import_module('aw_telegram.counting')
    canonical = [event(0, 60, app='browser', audible=True, **{'$category':['awtg:A']}), event(20, 10, app='other', **{'$category':['awtg:B']})]
    result=m.aggregate(canonical,[event(0,60,app='browser'),event(20,10,app='other')], [event(0,60,status='not-afk'),event(30,30,status='afk')], BASE,BASE+timedelta(seconds=60),{('awtg:A',):('A',),('awtg:B',):('B',)})
    assert result.totals == {('A',):20000,('B',):10000}
    assert m.selected_total({None:7,('Uncategorized',):11},[('Uncategorized',)]) == 11
    assert m.selected_total({None:7},[],True) == 7

@pytest.mark.parametrize('bad',[event(0,-1,app='x'),event(0,float('inf'),app='x'),event(0,True,app='x'),{'timestamp':'bad','duration':1,'data':{}},event(0,1,app=7)])
def test_malformed_window_does_not_invent_evidence(bad):
    m=importlib.import_module('aw_telegram.counting')
    result=m.aggregate([], [bad], [event(0,10,status='afk')], BASE,BASE+timedelta(seconds=10),{})
    assert result.coverage == []
    assert result.invalid_events > 0

def test_sleep_gaps_and_owned_spans_remain_unallocated_but_python_is_counted():
    m=importlib.import_module('aw_telegram.counting')
    windows=[event(0,10,app='python.exe',title='IDE'),event(10,10,app='python.exe',title='AW Telegram'),event(100,10,app='game')]
    canonical=[dict(e,data={**e['data'],'$category':['Uncategorized']}) for e in windows]
    result=m.aggregate(canonical, windows,[event(0,20,status='not-afk'),event(100,10,status='not-afk')],BASE,BASE+timedelta(seconds=200),{},owned=lambda data:data.get('title')=='AW Telegram')
    assert result.totals == {None:20000}
    assert result.coverage == [(BASE,BASE+timedelta(seconds=20)),(BASE+timedelta(seconds=100),BASE+timedelta(seconds=110))]

def test_integer_ms_and_no_gap_filling():
    m=importlib.import_module('aw_telegram.counting')
    raw=[event(0,0.0019,app='x'),event(2,1,app='x')]
    canonical=[event(0,3,app='x',**{'$category':['Uncategorized']})]
    result=m.aggregate(canonical,raw,[event(0,3,status='not-afk')],BASE,BASE+timedelta(seconds=3),{})
    assert result.totals == {None:1001}

def test_active_without_canonical_evidence_is_unknown_not_a_measured_zero():
    m=importlib.import_module('aw_telegram.counting')
    result=m.aggregate([], [event(0,60,app='game')], [event(0,60,status='not-afk')], BASE,BASE+timedelta(seconds=60),{})
    assert result.coverage==[]


def test_real_aw_submillisecond_timestamps_quantize_inwards_to_wire_precision():
    m=importlib.import_module('aw_telegram.counting')
    raw=[{'timestamp':'2026-10-27T08:00:00.000600+00:00','duration':1.9999,'data':{'app':'x'}}]
    canonical=[dict(raw[0],data={'app':'x','$category':['Uncategorized']})]
    result=m.aggregate(canonical,raw,[event(0,10,status='not-afk')],BASE,BASE+timedelta(seconds=10),{})
    assert result.coverage==[(BASE+timedelta(milliseconds=1),BASE+timedelta(seconds=2))]
    assert result.totals=={None:1999}

def test_overlap_priority_preserves_original_timestamps_when_pairing_clips_both():
    m=importlib.import_module('aw_telegram.counting')
    canonical=[event(20,40,app='new',**{'$category':['awtg:B']}),event(0,60,app='old',**{'$category':['awtg:A']})]
    raw=[event(20,40,app='new'),event(0,60,app='old')]
    r=m.aggregate(canonical,raw,[event(0,60,status='not-afk')],BASE+timedelta(seconds=30),BASE+timedelta(seconds=60),{('awtg:A',):('A',),('awtg:B',):('B',)})
    assert r.totals=={('B',):30000}


def test_canonical_identity_must_match_raw_foreground_to_claim_coverage():
    m=importlib.import_module('aw_telegram.counting')
    r=m.aggregate([event(0,60,app='wrong',**{'$category':['Uncategorized']})],[event(0,60,app='actual')],[event(0,60,status='not-afk')],BASE,BASE+timedelta(seconds=60),{})
    assert r.totals=={} and r.coverage==[]

def test_invalid_selection_and_unselected_duration_overflow_are_rejected():
    m=importlib.import_module('aw_telegram.counting')
    with pytest.raises(ValueError):m.selected_total({('A',):10},[()])
    with pytest.raises(ValueError):m.selected_total({('A',):9007199254740992},[])
