"""Isolated source-AW compatibility check; NOT an installed-history probe.

Run from companion with --source-root path/to/activity-watch. Dependencies go in
.tmp/aw-fixture-deps, never a source checkout. The parent process launches a child
with redirected APPDATA/LOCALAPPDATA/XDG roots before importing any AW modules.
The child seeds only an ephemeral loopback MemoryStorage server and stops it.
"""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--child', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if not args.child:
        isolated = root/'.tmp'/'aw-fixture-data'
        isolated.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        for key in ('APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'):
            env[key] = str(isolated/key)
        env['AW_PROFILE'] = 'task3-fixture'
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        env['PYTHONPATH'] = os.pathsep.join(str(p) for p in [root/'src',args.source_root/'aw-server',args.source_root/'aw-core',args.source_root/'aw-client',root/'.tmp'/'aw-fixture-deps'])
        return subprocess.run([sys.executable,str(Path(__file__).resolve()),'--source-root',str(args.source_root),'--child'],env=env,cwd=root,timeout=40).returncode
    from datetime import timedelta
    from threading import Thread
    import socket
    from werkzeug.serving import make_server
    from aw_server.server import AWFlask
    from aw_datastore.storages.memory import MemoryStorage
    from aw_core import Event
    from aw_client.queries import DesktopQueryParams, canonicalEvents
    from aw_telegram.aw_reader import AWReader, LocalAWClient, AWUnavailable
    from aw_telegram.clock import parse_instant
    from aw_telegram.models import Settings

    fixture=json.loads((root/'tests/fixtures/aw-desktop.json').read_text(encoding='utf-8'))
    start=parse_instant(fixture['start']);end=start+timedelta(seconds=fixture['seconds'])
    host=socket.gethostname()
    app=AWFlask(host='127.0.0.1',testing=True,storage_method=MemoryStorage,api_key='fixture-key',query_cache=False)
    # Direct in-memory seeding is restricted to this child fixture instance.
    app.api.settings.data={'classes':fixture['categories']}
    for bid,kind,client,key in [('fixture-window','currentwindow','aw-watcher-window','windows'),('fixture-afk','afkstatus','aw-watcher-afk','afk'),('aw-watcher-web-chrome_fixture','web.tab.current','aw-watcher-web','browser')]:
        app.api.db.create_bucket(bid,type=kind,client=client,hostname=host)
        events=[]
        for raw in fixture[key]:
            data={k:v for k,v in raw.items() if k not in ('start','duration')}
            events.append(Event(timestamp=start+timedelta(seconds=raw['start']),duration=timedelta(seconds=raw['duration']),data=data))
        app.api.db[bid].insert(events)
    server=make_server('127.0.0.1',0,app,threaded=True)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        client=LocalAWClient(host='127.0.0.1',port=server.server_port,timeout=3,api_key='fixture-key')
        reader=AWReader(client=client,collection_started_at=start,now=lambda:end,settings=Settings(selectedPaths=[['Fun'],['Fun','Games']]),sequence_provider=lambda:7)
        capabilities=reader.probe()
        assert capabilities.reachable and capabilities.window_bucket_id=='fixture-window'
        day=reader.summarize(start,end,start)
        assert day.totalActiveMs==fixture['expected']['strictTotalMs'],day
        assert day.selectedTotalMs==fixture['expected']['selectedGamesMs'],day
        assert reader.live().state=='afk'
        paired=start+timedelta(seconds=20)
        clipped=AWReader(client=client,collection_started_at=paired,now=lambda:end).summarize(start,end,paired)
        assert clipped.totalActiveMs==fixture['expected']['pairedAt20TotalMs'],clipped
        rules=[(cat['name'],cat['rule']) for cat in fixture['categories']]
        totals={}
        for audible in (False,True):
            params=DesktopQueryParams(bid_window='fixture-window',bid_afk='fixture-afk',bid_browsers=['aw-watcher-web-chrome_fixture'],classes=rules,filter_classes=[],filter_afk=True,include_audible=audible,always_active_pattern=None)
            query=canonicalEvents(params,exact_bucket_ids=True)+'\nRETURN = sum_durations(events);'
            totals['uiDefaultAudibleMs' if audible else 'uiStrictCanonicalMs']=round(client.query(query,[(start,end)])[0]*1000)
        assert all(fixture['expected'][key]==value for key,value in totals.items()),totals
        # Verify empty taxonomy and explicit legitimate Uncategorized identity
        # through the actual server parser/categorizer, not the fake test client.
        app.api.settings.data={'classes':[]}
        empty=reader.summarize(start,end,start)
        assert empty.leafTotalsMs==[{'category':{'id':'uncategorized','path':None},'totalMs':88000}],empty
        app.api.settings.data={'classes':[{'name':['Uncategorized'],'rule':{'type':'regex','regex':'.*'}}]}
        literal=reader.summarize(start,end,start)
        assert literal.leafTotalsMs[0]['category']['path']==['Uncategorized']
        app.api.settings.data={'category_sets':[{'id':'primary','categories':fixture['categories'],'tombstones':['["Hidden"]']},{'id':'secondary','categories':[{'name':['Fun','Games'],'rule':{'type':'regex','regex':'never'}},{'name':['Hidden'],'rule':{'type':'regex','regex':'.*','priority':999}}]}],'active_set_ids':['primary','secondary']}
        modern=reader.summarize(start,end,start)
        assert modern.totalActiveMs==88000 and modern.selectedTotalMs==58000,modern
        app.api.settings.data={'classes':[{'name':['a;\"b','Ігри\\test'],'rule':{'type':'regex','regex':'game\\.exe'}}]}
        escaped=reader.summarize(start,end,start)
        assert any(leaf['category']['path']==['a;\"b','Ігри\\test'] and leaf['totalMs']==58000 for leaf in escaped.leafTotalsMs),escaped
        print(json.dumps({'sourceServerVersion':capabilities.server_version,'port':server.server_port,'strictTotalMs':day.totalActiveMs,'selectedGamesMs':day.selectedTotalMs,'pairedAt20TotalMs':clipped.totalActiveMs,**totals,'emptyTaxonomy':'verified','literalUncategorized':'verified','modernActiveSets':'verified','escapedPaths':'verified','liveAtEnd':'afk','auth':'explicit_fixture_key','storage':'MemoryStorage','installedWindowsCompatibility':'not_established'},ensure_ascii=False))
    finally:
        server.shutdown();server.server_close();thread.join(2)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
