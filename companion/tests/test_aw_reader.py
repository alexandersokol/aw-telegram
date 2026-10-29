import importlib
from datetime import timedelta
import json
import pytest
from test_counting import BASE, event
from aw_telegram.models import Settings


def module():
    return importlib.import_module('aw_telegram.aw_reader')

def category(name,regex='game',**rule):
    return {'name':name,'rule':{'type':'regex','regex':regex,**rule}}

class Client:
    def __init__(self,settings=None,buckets=None):
        self.settings={'classes':[category(['Fun','Games'])]} if settings is None else settings
        self.buckets=buckets or {'window':{'id':'window','type':'currentwindow','client':'aw-watcher-window','hostname':'test'},'afk':{'id':'afk','type':'afkstatus','client':'aw-watcher-afk','hostname':'test'}}
        self.calls=[]
        self.windows=[event(0,60,app='game',title='Game')]
        self.afk=[event(0,60,status='not-afk')]
        self.canonical=[event(0,60,app='game',title='Game',**{'$category':['awtg:Fun','awtg:Games']})]
        self.fail=False
    def get_info(self):
        self.calls.append('info')
        if self.fail: raise module().AWUnavailable('unreachable')
        return {'hostname':'test','version':'fixture'}
    def get_buckets(self): self.calls.append('buckets'); return self.buckets
    def get_setting(self): self.calls.append('settings'); return self.settings
    def query(self,query,timeperiods):
        self.calls.append((query,timeperiods))
        if self.fail: raise module().AWUnavailable('unreachable')
        return [{'events':self.canonical,'window_raw':self.windows,'afk_raw':self.afk,'checks':{'priority':[['high']], 'keys':[['Uncategorized']], 'tie':[['later']]}}]

def reader(client=None,**kwargs):
    return module().AWReader(client=client or Client(), now=lambda:BASE+timedelta(seconds=60), **kwargs)

def test_no_activity_before_pairing_even_when_enrolled():
    c=Client(); r=reader(c)
    r.probe()
    assert set(c.calls)=={'info','buckets','settings'}
    with pytest.raises(module().CollectionNotStarted): r.live()
    with pytest.raises(module().CollectionNotStarted): r.summarize(BASE,BASE+timedelta(seconds=60),None)
    assert all(isinstance(x,str) for x in c.calls)

def test_summary_clips_first_pairing_and_uses_contract_and_provider_sequence():
    c=Client(); paired=BASE+timedelta(seconds=20)
    r=reader(c,collection_started_at=paired,settings=Settings(revision=4,selectedPaths=[['Fun'],['Fun','Games']]),sequence_provider=lambda:17)
    d=r.summarize(BASE,BASE+timedelta(seconds=60),paired)
    assert d.totalActiveMs==d.selectedTotalMs==40000
    assert d.sequence==17 and d.settingsRevision==4 and d.partial
    assert d.availableFrom=='2026-10-27T08:00:20.000Z'
    assert d.appLeafTotalsMs==[{'app':'game','categoryId':'["Fun","Games"]','totalMs':40000}]
    query=next(call[0] for call in c.calls if isinstance(call,tuple))
    assert 'find_bucket' not in query and 'audible' not in query and 'get_classes' not in query
    assert 'query_bucket("window")' in query and 'query_bucket("afk")' in query
    with pytest.raises(ValueError):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)


def test_summary_captures_settings_and_rules_used_by_query_and_rejects_rule_race():
    c=Client(); selected=[['Fun']]
    r=reader(c,collection_started_at=BASE,settings=Settings(revision=4,selectedPaths=selected))
    query=c.query
    def change_settings(q,t):
        result=query(q,t)
        selected.clear()
        r.settings=Settings(revision=5)
        return result
    c.query=change_settings
    before=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert before.settingsRevision==4 and before.selectedTotalMs==60000
    assert before.rulesRevision==module().resolve_categories(c.settings).revision
    def race(q,t):
        result=query(q,t)
        c.settings={'classes':[category(['Changed'])]}
        r.probe()  # A later call must not relabel the earlier query's result.
        return result
    c.query=race
    with pytest.raises(module().AWUnsupported,match='rules_revision_changed'):
        r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert r.last_summary is before and r.health.reason=='rules_revision_changed'


@pytest.mark.parametrize('side',['raw','canonical','both'])
def test_missing_identity_preserves_only_measured_subtotal_and_all_unknown(side):
    c=Client(); r=reader(c,collection_started_at=BASE)
    c.windows=[event(0,30,app='Unknown'),event(30,30,app='game')]
    c.canonical=[dict(e,data={**e['data'],'$category':['awtg:Fun','awtg:Games']}) for e in c.windows]
    targets=([c.windows] if side=='raw' else [c.canonical] if side=='canonical' else [c.windows,c.canonical])
    for events in targets: del events[0]['data']['app']
    day=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert day.totalActiveMs==30000 and day.partial
    assert day.appLeafTotalsMs==[{'app':'game','categoryId':'["Fun","Games"]','totalMs':30000}]
    for events in targets: del events[1]['data']['app']
    day=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert day.totalActiveMs==0 and day.appLeafTotalsMs==[] and day.leafTotalsMs==[]
    assert day.availableFrom is None and day.availableThrough is None and day.partial


@pytest.mark.parametrize('oversize',['apps','bytes'])
def test_report_capacity_failure_keeps_last_valid_summary(oversize):
    c=Client(); r=reader(c,collection_started_at=BASE)
    previous=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    names=[f'app{i}' for i in range(257)] if oversize=='apps' else ['😀'*255+chr(0x1000+i) for i in range(256)]
    c.windows=[event(i/10,.1,app=name) for i,name in enumerate(names)]
    c.canonical=[dict(e,data={**e['data'],'$category':['awtg:Fun','awtg:Games']}) for e in c.windows]
    with pytest.raises(ValueError,match='report_capacity_exceeded'):
        r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert r.last_summary is previous and r.health.state=='unsupported' and r.health.reason=='report_capacity_exceeded'

def test_metadata_ignores_remote_synced_imported_and_requires_explicit_ambiguity():
    c=Client(); c.buckets.update({'synced':{'id':'synced-synced-from-other','type':'currentwindow','client':'aw-watcher-window','hostname':'test'},'import':{'id':'import','type':'currentwindow','client':'importer','hostname':'test'},'remote':{'id':'remote','type':'currentwindow','client':'aw-watcher-window','hostname':'other'}})
    assert reader(c).probe().window_bucket_id=='window'
    c.buckets['second']={**c.buckets['window'],'id':'second'}
    p=reader(c).probe()
    assert p.window_bucket_id is None and 'ambiguous_window' in p.issues
    assert reader(c,window_bucket_id='second').probe().window_bucket_id=='second'
    assert reader(c,window_bucket_id='remote').probe().window_bucket_id is None

@pytest.mark.parametrize('settings',[{}, {'classes':None},{'active_set_ids':['preset-only']}, {'classes':[category(['URL'],select_keys=['url'])]}, {'classes':[{'name':['x'],'rule':{'type':'expression'}}]}])
def test_unsupported_categories_are_explicit_and_do_not_query_history(settings):
    c=Client(settings); r=reader(c,collection_started_at=BASE)
    assert not r.probe().category_settings_supported
    with pytest.raises(module().AWUnsupported):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert all(isinstance(x,str) for x in c.calls)

def test_modern_active_order_tombstones_duplicates_parents_and_legacy_empty():
    resolve=importlib.import_module('aw_telegram.category_settings').resolve_categories
    data={'category_sets':[{'id':'a','categories':[category(['A'],'first'), category(['Hide'])]}, {'id':'b','tombstones':['["Hide"]'],'categories':[category(['A'],'second'),category(['Deep','Leaf']),category(['Hide'],'own')]}], 'active_set_ids':['b','a'],'classes':[category(['Legacy'])]}
    e=resolve(data)
    assert e.rules[0][1]['regex']=='second'
    assert [p for p,r in e.rules]==[('A',),('Deep','Leaf'),('Hide',)]
    assert {'id':'["Deep"]','path':['Deep']} in e.catalog
    assert resolve({'classes':[]}).rules==[]
    assert resolve({'category_sets':[{'id':'empty','categories':[]}],'active_set_ids':[]}).rules==[]
    with pytest.raises(ValueError, match='unresolved_active_set_or_preset'):
        resolve({'category_sets':[{'id':'a','categories':[category(['A'])]}],'active_set_ids':['dangling']})

def test_empty_categories_query_has_no_fallback_and_legitimate_uncategorized_is_distinct():
    c=Client({'classes':[]}); c.canonical=[event(0,60,app='game',title='Game')]
    d=reader(c,collection_started_at=BASE).summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert d.leafTotalsMs[0]['category']=={'id':'uncategorized','path':None}
    assert 'categorize(events' not in next(call[0] for call in c.calls if isinstance(call,tuple))
    c=Client({'classes':[category(['Uncategorized'])]});c.canonical=[event(0,60,app='game',title='Game',**{'$category':['awtg:Uncategorized']})]
    assert reader(c,collection_started_at=BASE).summarize(BASE,BASE+timedelta(seconds=60),BASE).leafTotalsMs[0]['category']['path']==['Uncategorized']

def test_missing_evidence_unknown_differs_from_measured_zero_and_failure_preserves_last_summary():
    c=Client();c.afk=[event(0,60,status='afk')];c.canonical=[]
    r=reader(c,collection_started_at=BASE)
    measured=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert measured.totalActiveMs==0 and measured.availableFrom is not None
    c.windows=[]
    unknown=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert unknown.availableFrom is None and unknown.partial
    c.fail=True
    with pytest.raises(module().AWUnavailable):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert r.last_summary==unknown and r.health.state=='unavailable'

def test_live_freshness_uses_end_not_merged_start_and_stale_clears_title():
    c=Client();r=reader(c,collection_started_at=BASE)
    live=r.live()
    assert live.state=='active' and live.title=='Game' and live.category['path']==['Fun','Games']
    c.windows=[event(0,5,app='game',title='Old')];c.afk=[event(0,5,status='not-afk')]
    stale=r.live()
    assert stale.state=='unknown' and stale.title is None and stale.app is None
    c.windows=[event(0,60,app='game',title='Game')];c.afk=[event(0,60,status='afk')];c.canonical=[]
    assert r.live().state=='afk'

def test_client_requires_explicit_endpoint_bounds_auth_and_never_defaults():
    m=module()
    with pytest.raises(TypeError):m.LocalAWClient()
    for host,port,timeout in [('other',5600,3),('127.0.0.1',True,3),('127.0.0.1',0,3),('127.0.0.1',5600,0)]:
        with pytest.raises(ValueError):m.LocalAWClient(host=host,port=port,timeout=timeout)
    c=m.LocalAWClient(host='127.0.0.1',port=15678,timeout=0.1,api_key='secret')
    assert c.port==15678 and c.timeout==0.1
    assert 'secret' not in repr(c)

def test_rule_capability_failure_is_explicit():
    c=Client();query=c.query
    def incompatible(q,t):
        out=query(q,t);out[0]['checks']['keys']=[['high']];return out
    c.query=incompatible
    r=reader(c,collection_started_at=BASE)
    with pytest.raises(module().AWUnsupported):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert r.health.state=='unsupported'

def test_default_owned_focus_excludes_own_python_titles_without_excluding_ide():
    c=Client();c.windows=[event(0,30,app='python.exe',title='IDE'),event(30,30,app='python.exe',title='Нагадування AW Telegram')]
    c.canonical=[dict(e,data={**e['data'],'$category':['Uncategorized']}) for e in c.windows]
    r=reader(c,collection_started_at=BASE)
    assert r.summarize(BASE,BASE+timedelta(seconds=60),BASE).totalActiveMs==30000
    assert r.live().state=='unknown'


def test_afk_wins_over_own_foreground_and_own_focus_is_flagged_for_overlay_gating():
    c=Client();c.windows=[event(0,60,app='python.exe',title='Нагадування AW Telegram')]
    c.canonical=[dict(e,data={**e['data'],'$category':['Uncategorized']}) for e in c.windows]
    r=reader(c,collection_started_at=BASE)
    assert r.live().state=='unknown' and r.live_owned
    c.afk=[event(0,60,status='afk')]
    assert r.live().state=='afk' and not r.live_owned
    c.windows=[event(0,60,app='game',title='Game')];c.afk=[event(0,60,status='not-afk')]
    c.canonical=[event(0,60,app='game',title='Game',**{'$category':['awtg:Fun','awtg:Games']})]
    assert r.live().state=='active' and not r.live_owned


def test_summary_accepts_real_aw_microseconds_and_stale_health_is_explicit():
    c=Client();c.windows=[{'timestamp':'2026-10-27T08:00:00.000600+00:00','duration':20.0012,'data':{'app':'game','title':'Game'}}]
    c.canonical=[dict(c.windows[0],data={**c.windows[0]['data'],'$category':['awtg:Fun','awtg:Games']})]
    r=reader(c,collection_started_at=BASE)
    d=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert d.availableFrom=='2026-10-27T08:00:00.001Z'
    assert d.availableThrough=='2026-10-27T08:00:20.001Z'
    assert r.live().state=='unknown' and r.health.state=='stale'


def test_nondefault_http_server_uses_auth_no_proxies_and_rejects_redirects(monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    m=module(); received=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            received.append((self.path,self.headers.get('Authorization')))
            if self.path=='/api/0/info':
                self.send_response(200);self.end_headers();self.wfile.write(b'{"hostname":"local"}')
            elif self.path=='/api/0/settings':
                self.send_response(307);self.send_header('Location','http://127.0.0.1:5600/secret');self.end_headers()
            else:
                self.send_response(200);self.end_headers();self.wfile.write(b'NaN')
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append((self.path,body))
            self.send_response(200);self.end_headers();self.wfile.write(b'[[]]')
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        monkeypatch.setenv('HTTP_PROXY','http://127.0.0.1:1')
        c=m.LocalAWClient(host='localhost',port=server.server_port,api_key='local-key',timeout=.2)
        assert c.get_info()=={'hostname':'local'}
        with pytest.raises(m.AWUnavailable,match='http_status_307'):c.get_setting()
        assert received[:2]==[('/api/0/info','Bearer local-key'),('/api/0/settings','Bearer local-key')]
        assert c.query('RETURN = [];',[(BASE,BASE+timedelta(seconds=60))])==[[]]
        assert received[-1][1]['timeperiods']==['2026-10-27T08:00:00.000Z/2026-10-27T08:01:00.000Z']
        with pytest.raises(m.AWUnavailable,match='transport_or_json_failure'):c.get_buckets()
    finally:
        server.shutdown();server.server_close();thread.join(1)

def test_settings_endpoint_failure_preserves_reachable_vs_category_unsupported():
    c=Client()
    def missing(): raise module().AWUnavailable('http_status_404')
    c.get_setting=missing
    r=reader(c)
    caps=r.probe()
    assert caps.reachable and not caps.category_settings_supported
    assert 'category_settings_unavailable' in caps.issues


def test_invalid_bucket_data_is_ignored_instead_of_crashing():
    c=Client();c.buckets['broken']={'id':'broken','type':'currentwindow','client':'aw-watcher-window','hostname':'test','data':None}
    assert reader(c).probe().window_bucket_id=='window'


def stock_legacy_classes():
    # Literal source fixture: classes.ts defaultCategories, not resolver output.
    from pathlib import Path
    return json.loads((Path(__file__).parent/'fixtures'/'aw-legacy-install-classes.json').read_text(encoding='utf-8'))


def test_builtin_legacy_install_defaults_remain_unsupported_without_guessing_presets():
    classes=stock_legacy_classes()
    for cat in classes:
        cat.pop('data',None)  # Missing colors/scores also look unconfigured upstream.
    c=Client({'classes':classes});r=reader(c,collection_started_at=BASE)
    assert not r.probe().category_settings_supported
    with pytest.raises(module().AWUnsupported):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert all(isinstance(call,str) for call in c.calls)


@pytest.mark.parametrize('customization',['regex','ignore_case','select_keys','priority','weight','color','score'])
def test_customized_legacy_stock_paths_keep_persisted_rules_and_allow_collection(customization):
    classes=stock_legacy_classes()
    games=next(cat for cat in classes if cat['name']==['Media','Games'])
    if customization=='regex': games['rule']['regex']=r'^custom-game[.]exe$'
    elif customization in ('priority','weight'): games['rule'][customization]=100
    elif customization=='select_keys': games['rule']['select_keys']=['app']
    elif customization=='ignore_case': games['rule']['ignore_case']=True
    else: games['data'][customization]='#123456' if customization=='color' else 42
    c=Client({'classes':classes})
    app='custom-game.exe' if customization=='regex' else 'Minecraft'
    c.windows=[event(0,60,app=app,title='Game')]
    c.canonical=[event(0,60,app=app,title='Game',**{'$category':['awtg:Media','awtg:Games']})]
    r=reader(c,collection_started_at=BASE)
    assert r.probe().category_settings_supported
    d=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert d.totalActiveMs==60000 and d.leafTotalsMs[0]['category']['path']==['Media','Games']
    assert r.live().category['path']==['Media','Games']
    from aw_telegram.category_settings import resolve_categories
    rules=dict(resolve_categories(c.settings).rules)
    assert rules[('Media','Games')]==games['rule']


@pytest.mark.parametrize('legacy_colors',[False,True])
def test_builtin_legacy_rule_equivalents_and_palette_are_still_unconfigured(legacy_colors):
    classes=stock_legacy_classes()
    colors={('Work',):'#0f0',('Media',):'#f33',('Media','Games'):'#f80',('Media','Video'):'#f33',('Media','Social Media'):'#fcc400',('Media','Music'):'#a8fc00',('Comms',):'#9ff'}
    for cat in classes:
        cat['rule'].setdefault('ignore_case',False)
        if cat['rule']['type'] is None: cat['rule']['type']='none'
        if legacy_colors and tuple(cat['name']) in colors: cat['data']['color']=colors[tuple(cat['name'])]
    assert not reader(Client({'classes':list(reversed(classes))})).probe().category_settings_supported


def test_category_backslashes_quotes_semicolons_and_unicode_remap_safely():
    from aw_telegram.category_settings import resolve_categories
    m=module();cats=resolve_categories({'classes':[category(['a;"b','Ігри\\test'],r'game\w+;x')]})
    q,mapping=m.build_query('window','afk',cats)
    assert list(mapping.values())==[('a;"b','Ігри\\test')]
    assert all(';' not in segment and '"' not in segment and '\\' not in segment for p in mapping for segment in p)
    assert r'game\w+;x' in q
    with pytest.raises(m.AWUnsupported):m.build_query('bad";RETURN = [];','afk',cats)


def test_server_missing_category_with_nonempty_rules_is_unsupported():
    c=Client();c.canonical=[event(0,60,app='game',title='Game')]
    with pytest.raises(module().AWUnsupported):reader(c,collection_started_at=BASE).summarize(BASE,BASE+timedelta(seconds=60),BASE)

@pytest.mark.parametrize('settings',[{'category_sets':[{'id':'a','categories':[],'tombstones':None}]},{'category_sets':[{'id':'a','categories':[]}],'active_set_ids':False}])
def test_malformed_modern_settings_are_explicitly_unsupported(settings):
    assert not reader(Client(settings)).probe().category_settings_supported


def test_query_checks_malformed_shape_is_explicitly_unsupported():
    c=Client();query=c.query
    def malformed(q,t):
        output=query(q,t);output[0]['checks']=[];return output
    c.query=malformed
    r=reader(c,collection_started_at=BASE)
    with pytest.raises(module().AWUnsupported):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)


@pytest.mark.parametrize('check',['priority','keys','tie'])
@pytest.mark.parametrize('data',[None,[], 'invalid',42])
def test_nested_semantic_check_data_failure_preserves_summary(check,data):
    c=Client();r=reader(c,collection_started_at=BASE)
    previous=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    query=c.query
    def malformed(q,t):
        output=query(q,t);output[0]['checks'][check]=[{'data':data}];return output
    c.query=malformed
    with pytest.raises(module().AWUnsupported):r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    assert r.last_summary==previous and r.health.state=='unsupported'


@pytest.mark.parametrize('check',['priority','keys','tie'])
@pytest.mark.parametrize('data',[None,[], 'invalid',42])
def test_nested_semantic_check_data_failure_clears_live_identity(check,data):
    c=Client();r=reader(c,collection_started_at=BASE)
    assert r.live().state=='active'
    previous=r.summarize(BASE,BASE+timedelta(seconds=60),BASE)
    query=c.query
    def malformed(q,t):
        output=query(q,t);output[0]['checks'][check]=[{'data':data}];return output
    c.query=malformed
    live=r.live()
    assert live.state=='unknown' and live.app is None and live.title is None and live.category is None
    assert live.rulesRevision is None and live.categoryCatalog==[]
    assert r.last_summary==previous and r.health.state=='unsupported'


def test_nested_semantic_check_event_categories_allow_valid_source_results():
    c=Client();query=c.query
    def source_shape(q,t):
        output=query(q,t)
        for key,path in [('priority',['high']),('keys',['Uncategorized']),('tie',['later'])]:
            output[0]['checks'][key]=[event(0,60,app='game',title='Game',**{'$category':path})]
        return output
    c.query=source_shape
    r=reader(c,collection_started_at=BASE)
    assert r.summarize(BASE,BASE+timedelta(seconds=60),BASE).totalActiveMs==60000
    assert r.live().state=='active'


def test_live_invalid_category_sets_unsupported_health_without_leaking_identity():
    c=Client();c.canonical=[event(0,60,app='game',title='Game',**{'$category':['unknown']})]
    r=reader(c,collection_started_at=BASE)
    assert r.live().state=='unknown' and r.health.state=='unsupported'
