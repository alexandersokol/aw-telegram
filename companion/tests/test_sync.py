"""Durable sync uses only synthetic aggregates, a fake clock and injected IO."""
from copy import deepcopy
import importlib
import importlib.util
import json
import sqlite3
from pathlib import Path
import pytest
from aw_telegram import models
from aw_telegram.clock import parse_instant

NOW = "2026-10-28T12:00:00.000Z"
START = "2026-10-28T10:00:00.000Z"
HEALTH = dict(observedAt=NOW, awState="unknown", lastSuccessAt=None, reportError=None)

def storage():
    assert importlib.util.find_spec("aw_telegram.storage"), "Durable LocalStore is not implemented"
    return importlib.import_module("aw_telegram.storage")

def day(date="2026-10-28", total=1000, revision=0):
    lo = START if date == "2026-10-28" else date + "T10:00:00.000Z"
    hi = NOW if date == "2026-10-28" else date + "T12:00:00.000Z"
    return dict(date=date,leafTotalsMs=[dict(category=dict(id='["Study"]',path=["Study"]),totalMs=total)],
        appLeafTotalsMs=[dict(app="Editor 😀",categoryId='["Study"]',totalMs=total)], totalActiveMs=total,
        selectedTotalMs=0,settingsRevision=revision,rulesRevision="r1",availableFrom=lo,availableThrough=hi,
        partial=False,sequence=0)

def response(request, *, revision=0, receipts=None, started=START, canceled=None):
    return dict(schemaVersion=2,requestSequence=request.sequence,serverNow=NOW,collectionStartedAt=started,
        settings={**models.Settings().to_wire(),"revision":revision},
        cancellations=canceled or dict(revision=0,throughActionSequence=0,canceledIds=[]), deliveryOffers=[],
        acknowledgedAckIds=[a["id"] for a in request.acks],summaryReceipts=receipts or [])

def store(tmp_path):
    return storage().LocalStore(tmp_path / "sync.sqlite", now=lambda:NOW)

def pair(s):
    r=s.prepare_request(HEALTH)
    s.apply_sync(response(r))
    return r


ENDTIME_DEFAULTS = dict(endtimeEnabled=False, endtimeLocalTime="21:00", endtimeGeneration=0)


def test_legacy_settings_migrate_durably_without_changing_other_cached_state(tmp_path):
    s = store(tmp_path); pair(s); s.commit_day(day(), NOW); s.prepare_request(HEALTH)
    state = s._state()
    state["settings"].update(revision=7, selectedPaths=[["Study", "Editor"]], selectedUncategorized=True,
        defaultLimitMs=12345, todayOverride=dict(date="2026-10-28", limitMs=6789),
        freeUseDate="2026-10-27", suppressedDate="2026-10-26")
    for field in ENDTIME_DEFAULTS: del state["settings"][field]
    s._save(state)
    other_tables = {table:list(s.connection.execute(f"select * from {table}"))
        for table in ["days", "acks", "canceled_ids", "requests"]}
    s.close()
    s = store(tmp_path)
    expected = {**state, "settings":{**state["settings"], **ENDTIME_DEFAULTS}}
    assert s._state() == expected
    assert s.settings.to_wire() == expected["settings"]
    assert {table:list(s.connection.execute(f"select * from {table}")) for table in other_tables} == other_tables
    s.close()
    s = store(tmp_path)
    assert s._state() == expected
    s.close()


@pytest.mark.parametrize("mask", range(1, 7))
@pytest.mark.parametrize("version", [1, 2])
def test_partial_legacy_settings_fail_closed_and_roll_back_migration(tmp_path, mask, version):
    s = store(tmp_path); pair(s); s.commit_day(day(), NOW); s.prepare_request(HEALTH)
    state = s._state()
    for index, field in enumerate(ENDTIME_DEFAULTS):
        if not mask & (1 << index): del state["settings"][field]
    s._save(state)
    s.connection.execute("PRAGMA user_version=" + str(version))
    s.connection.execute("update days set schema_version=1")
    before = list(s.connection.iterdump()); s.close()
    with pytest.raises(ValueError): store(tmp_path)
    with sqlite3.connect(tmp_path / "sync.sqlite") as connection:
        assert list(connection.iterdump()) == before
        assert connection.execute("PRAGMA user_version").fetchone()[0] == version


def test_legacy_settings_are_rejected_on_sync_wire_without_altering_storage(tmp_path):
    s = store(tmp_path); pair(s); request = s.prepare_request(HEALTH)
    answer = response(request)
    for field in ENDTIME_DEFAULTS: del answer["settings"][field]
    before = list(s.connection.iterdump())
    with pytest.raises(ValueError): s.apply_sync(answer)
    assert list(s.connection.iterdump()) == before
    s.close()

def test_required_health_and_receipts_are_strict():
    request=dict(schemaVersion=2,sequence=1,acks=[],health=HEALTH)
    assert models.validate_contract("sync-request",request)==request
    for health in [{**HEALTH,"reason":"private title"},{**HEALTH,"lastSuccessAt":"2026-10-29T00:00:00.000Z"}]:
        with pytest.raises(ValueError): models.validate_contract("sync-request",{**request,"health":health})
    with pytest.raises(ValueError): models.validate_activity_context({**request,"health":{**HEALTH,"observedAt":"2026-10-29T00:00:00.000Z"}},None,NOW)

def test_restart_latest_only_counter_and_late_receipt(tmp_path):
    s=store(tmp_path); pair(s)
    first=s.commit_day(day(),NOW); old=s.prepare_request(HEALTH)
    second=s.commit_day(day(total=2000),NOW)
    s.apply_sync(response(old,receipts=[dict(date=first.date,sequence=first.sequence)]))
    assert s.day(first.date).sequence==second.sequence
    assert s.prepare_request(HEALTH).summaries[0]["sequence"]==second.sequence
    sequence=s.prepare_request(HEALTH).sequence; s.close()
    s=store(tmp_path)
    assert s.prepare_request(HEALTH).sequence>sequence
    assert s.commit_day(day(total=3000),NOW).sequence>second.sequence
    assert s.connection.execute("PRAGMA journal_mode").fetchone()[0]=="wal"

def test_pair_gate_and_invalid_response_are_atomic(tmp_path):
    s=store(tmp_path)
    with pytest.raises(ValueError): s.commit_day(day(),NOW)
    pre=s.prepare_request(HEALTH); pair(s)
    with pytest.raises(ValueError): s.apply_sync(response(pre,started=None))
    assert s.collection_started_at==START
    r=s.prepare_request(HEALTH)
    with pytest.raises(ValueError): s.apply_sync(response(r,revision=4,receipts=[dict(date="2026-10-27",sequence=9)]))
    assert s.settings.revision==0

def test_reordered_settings_and_fences_never_regress_stable_ack_ids(tmp_path):
    s=store(tmp_path); pair(s); a=s.prepare_request(HEALTH); b=s.prepare_request(HEALTH)
    canceled=dict(revision=4,throughActionSequence=20,canceledIds=["00000000-0000-4000-8000-000000000001"])
    s.apply_sync(response(b,revision=2,canceled=canceled))
    ids=[x.id for x in s.pending_acks()]
    s.apply_sync(response(a,revision=1))
    assert s.settings.revision==2 and s.cancellations["throughActionSequence"]==20
    assert set(ids).issubset({x.id for x in s.pending_acks()})
    r=s.prepare_request(HEALTH)
    assert {x["id"] for x in r.acks}=={x.id for x in s.pending_acks()}
    s.apply_sync(response(r,revision=2,canceled=canceled))
    assert s.pending_acks()==[]


def test_reordered_endtime_generations_and_restart_preserve_latest_shared_setting(tmp_path):
    s=store(tmp_path); pair(s)
    older=s.prepare_request(HEALTH); newer=s.prepare_request(HEALTH)
    first=response(older,revision=1)
    first["settings"].update(endtimeEnabled=True,endtimeLocalTime="21:00",endtimeGeneration=1)
    latest=response(newer,revision=3)
    latest["settings"].update(endtimeEnabled=True,endtimeLocalTime="23:00",endtimeGeneration=2)
    s.apply_sync(latest)
    acks=[ack.to_wire() for ack in s.pending_acks()]
    s.apply_sync(first)
    assert s.settings.to_wire()==latest["settings"]
    assert [ack.to_wire() for ack in s.pending_acks()]==acks
    # An unrelated higher settings revision remains in the same endtime generation.
    request=s.prepare_request(HEALTH)
    unrelated=response(request,revision=4)
    unrelated["settings"].update(endtimeEnabled=True,endtimeLocalTime="23:00",endtimeGeneration=2,defaultLimitMs=1234)
    s.apply_sync(unrelated); s.close()
    s=store(tmp_path)
    assert s.settings.to_wire()==unrelated["settings"]
    assert any(ack.kind=="settings" and ack.revision==4 for ack in s.pending_acks())
    s.close()

def test_current_projection_and_failed_transaction_preserve_source(tmp_path):
    s=store(tmp_path); pair(s); saved=s.commit_day(day(),NOW)
    r=s.prepare_request(HEALTH); answer=response(r,revision=1); answer["settings"]["selectedPaths"]=[["Study"]]
    s.apply_sync(answer)
    assert s.projection(saved.date)["appTotalsMs"]==[dict(app="Editor 😀",totalMs=1000)]
    assert s.day(saved.date).settingsRevision==0
    invalid=day(); invalid["appLeafTotalsMs"][0]["totalMs"]=2
    with pytest.raises(ValueError): s.commit_day(invalid,NOW)
    assert s.day(saved.date)==saved

def test_manifest_and_sqlite_wal_never_contain_title(tmp_path):
    s=store(tmp_path); pair(s)
    for title in ["PRIVATE-TITLE-A", "PRIVATE-TITLE-B"]:
        live=dict(observedAt=NOW,state="active",app="Editor",title=title,category=None,rulesRevision="r",categoryCatalog=[])
        request=s.prepare_request(HEALTH,live)
        assert request.live["title"]==title
        assert all(title not in str(row) for row in s.connection.iterdump())
        for path in tmp_path.glob("sync.sqlite*"):
            assert title.encode() not in path.read_bytes()

def test_ack_conflict_and_malformed_offer_fail_closed_while_valid_offers_are_recorded(tmp_path):
    s=store(tmp_path); pair(s)
    ack=dict(id="00000000-0000-4000-8000-000000000004",kind="settings",revision=0,appliedAt=NOW)
    s.queue_ack(ack); s.queue_ack(ack)
    with pytest.raises(ValueError): s.queue_ack({**ack,"revision":1})
    from json import loads
    fixtures=loads((Path(__file__).parents[2]/"contracts/fixtures/wire.json").read_text(encoding="utf8"))
    offer=next(x["value"] for x in fixtures if x["contract"]=="action" and x["valid"])
    request=s.prepare_request(HEALTH); answer=response(request)
    answer["deliveryOffers"]=[{**offer,"options":{**offer["options"],"script":"x"}}]
    before=list(s.connection.iterdump())
    with pytest.raises(ValueError): s.apply_sync(answer)
    assert list(s.connection.iterdump())==before
    answer["deliveryOffers"]=[offer]; s.apply_sync(answer)
    receipts=[a for a in s.pending_acks() if a.kind=="action"]
    assert [(a.actionId,a.eventSequence) for a in receipts]==[(offer["id"],1)]
    assert receipts[0].status in ("accepted","expired")
    assert ack["id"] not in {x.id for x in s.pending_acks()}  # acknowledged by the successful response

def test_retention_keeps_counters_controls_and_unknown_canceled_ids(tmp_path):
    s=store(tmp_path); pair(s); old=s.commit_day(day(),NOW)
    s.prune("2026-11-05T12:00:00.000Z")
    assert s.day(old.date) is None and s.settings.revision==0
    assert s.connection.execute("select sequence from days where date=?",(old.date,)).fetchone()[0]==old.sequence
    assert s.pending_acks()

def test_legacy_cache_invalidates_without_fabricating_apps(tmp_path):
    s=store(tmp_path); pair(s); saved=s.commit_day(day(),NOW)
    s.connection.execute("update days set schema_version=1"); s.connection.execute("PRAGMA user_version=1"); s.close()
    s=store(tmp_path)
    assert s.day(saved.date) is None and s.collection_started_at==START
    assert s.commit_day(day(),NOW).sequence>saved.sequence
    assert s.pending_acks()


def test_transport_uses_exact_utf8_sync_bytes_and_vault_per_exchange():
    from aw_telegram.transport import Transport,DeviceIdentity
    assert hasattr(Transport,"sync"), "v2 transport is not implemented"
    identity=DeviceIdentity("00000000-0000-4000-8000-000000000001","https://backend.example")
    class Vault:
        loads=0
        def load(self,*args): self.loads+=1; return "A"*43
    vault=Vault(); captured=[]
    def network(method,url,body,headers):
        captured.append((method,url,body))
        r=models.SyncRequest.from_wire(json.loads(body))
        return 200,models.wire_bytes(response(r))
    t=Transport(vault,request=network,identity=identity)
    request=models.SyncRequest(2,1,[],HEALTH,live=dict(observedAt=NOW,state="active",app="Едітор 😀",title="SENSITIVE",category=None,rulesRevision="r",categoryCatalog=[]))
    assert t.sync(request).requestSequence==1
    assert captured[0]==("POST","https://backend.example/v2/sync",models.wire_bytes(request.to_wire()))
    assert vault.loads==1

def test_transport_credential_failures_and_bounds_are_typed():
    from aw_telegram import transport
    assert hasattr(transport,"CredentialError"), "credential stop signal is absent"
    identity=transport.DeviceIdentity("00000000-0000-4000-8000-000000000001","https://backend.example")
    class Vault:
        def load(self,*args): return "A"*43
    request=models.SyncRequest(2,1,[],HEALTH)
    for status in [401,403]:
        t=transport.Transport(Vault(),identity=identity,request=lambda *a:(status,b"PRIVATE ERROR"))
        with pytest.raises(transport.CredentialError,match="Backend request failed"):t.sync(request)
    t=transport.Transport(Vault(),identity=identity,request=lambda *a:(429,b"PRIVATE ERROR",{"Retry-After":"25"}))
    with pytest.raises(transport.SyncError) as error:t.sync(request)
    assert error.value.retryable and error.value.retry_after==25
    t=transport.Transport(Vault(),identity=identity,request=lambda *a:(200,b" "*131073))
    with pytest.raises(transport.SyncError):t.sync(request)

def test_exact_whole_date_packing_and_ack_fairness(tmp_path):
    s=store(tmp_path);pair(s)
    large=day(); path=["😀"*120+str(i) for i in range(8)];leaves=[];rows=[]
    for i in range(7):
        p=path+[str(i)];key=json.dumps(p,ensure_ascii=False,separators=(",",":"))
        leaves.append(dict(category=dict(id=key,path=p),totalMs=1));rows.append(dict(app="App"+str(i),categoryId=key,totalMs=1))
    large.update(leafTotalsMs=leaves,appLeafTotalsMs=rows,totalActiveMs=7)
    s.commit_day(large,NOW);bodies=[]
    for i in range(105):
        s.queue_ack(dict(id=f"00000000-0000-4000-8000-{i:012d}",kind="settings",revision=0,appliedAt=NOW))
    for _ in range(5):
        req=s.prepare_request(HEALTH);bodies.append(req)
        assert len(models.wire_bytes(req.to_wire()))<=131072 and len(req.acks)<=100
        s.apply_sync(response(req,receipts=[dict(date=d["date"],sequence=d["sequence"]) for d in req.summaries or []]))
    assert any(r.summaries for r in bodies) and s.pending_acks()==[]

def test_oversized_candidate_preserves_valid_source(tmp_path):
    s=store(tmp_path);pair(s);saved=s.commit_day(day(),NOW)
    huge=day(); path=["😀"*256 for _ in range(16)];key=json.dumps(path,ensure_ascii=False,separators=(",",":"))
    huge.update(leafTotalsMs=[dict(category=dict(id=key,path=path),totalMs=30)],
        appLeafTotalsMs=[dict(app="app"+str(i),categoryId=key,totalMs=1) for i in range(30)],totalActiveMs=30)
    with pytest.raises(models.ReportCapacityExceeded):s.commit_day(huge,NOW)
    assert s.day(saved.date)==saved
    assert s.prepare_request({**HEALTH,"reportError":"report_capacity_exceeded"}).health["reportError"]=="report_capacity_exceeded"

def test_coordinator_pair_gate_cadence_backfill_and_auth_stop(tmp_path):
    assert importlib.util.find_spec("aw_telegram.sync"), "IO coordinator is absent"
    from aw_telegram.sync import SyncCoordinator,Observation
    from aw_telegram.transport import CredentialError
    s=store(tmp_path);calls=[]
    def observe(now,settings,started):calls.append(("aw",started));return Observation(None,{**HEALTH,"awState":"ready","lastSuccessAt":NOW})
    def summarize(date,lo,hi,settings,started):calls.append(("summary",date));return day(date)
    class Network:
        fail=False
        def sync(self,request):
            calls.append(("sync",request.sequence))
            if self.fail:raise CredentialError()
            return models.SyncResponse.from_wire(response(request,receipts=[dict(date=d["date"],sequence=d["sequence"]) for d in request.summaries or []]))
    network=Network();coordinator=SyncCoordinator(s,network,observe,summarize)
    coordinator.step(NOW,0)
    assert calls[0][0]=="sync" and s.collection_started_at==START
    coordinator.step(NOW,10);coordinator.step(NOW,15);coordinator.step(NOW,30)
    assert len([c for c in calls if c[0]=="aw"])==3
    assert len([c for c in calls if c[0]=="sync"])==3
    network.fail=True;coordinator.step(NOW,45)
    count=len([c for c in calls if c[0]=="sync"])
    coordinator.step(NOW,100)
    assert len([c for c in calls if c[0]=="sync"])==count and coordinator.auth_blocked

def test_reader_probe_does_not_claim_successful_activity_query():
    from aw_telegram.aw_reader import AWReader
    class Metadata:
        def get_info(self):return dict(hostname="synthetic",version="test")
        def get_buckets(self):return {}
        def get_setting(self):return {}
    reader=AWReader(client=Metadata(),now=lambda:parse_instant(NOW))
    reader._health("ready")
    assert reader.health.last_success_at is None



def test_packer_prioritizes_oldest_ack_before_big_day_on_even_requests():
    from aw_telegram.storage import pack_request
    # Exact body sizes are measured after UTF-8 escaping, never character count.
    base=day();base["sequence"]=1
    huge=[];leaves=[]
    for i in range(60):
        path=["😀"*100+str(i)];key=json.dumps(path,ensure_ascii=False,separators=(",",":"))
        leaves.append(dict(category=dict(id=key,path=path),totalMs=1));huge.append(dict(app="Е"*200+str(i),categoryId=key,totalMs=1))
    base.update(leafTotalsMs=leaves,appLeafTotalsMs=huge,totalActiveMs=60)
    ack=dict(id="00000000-0000-4000-8000-000000000999",kind="settings",revision=0,appliedAt=NOW)
    # Even bodies must reserve oldest receipt before trying an indivisible date.
    req=pack_request(2,HEALTH,[base],[ack])
    assert req.acks==[ack]
    assert len(models.wire_bytes(req.to_wire()))<=131072

def test_remote_ahead_receipt_forces_recollection_and_counter_highwater(tmp_path):
    s=store(tmp_path);pair(s);saved=s.commit_day(day(),NOW);r=s.prepare_request(HEALTH)
    s.apply_sync(response(r,receipts=[dict(date=saved.date,sequence=500)]))
    assert s.needs_recollection(saved.date)
    assert s.commit_day(day(),NOW).sequence==501

def test_coordinator_transient_reconnect_recollects_and_backfill_is_bounded(tmp_path):
    from aw_telegram.sync import SyncCoordinator,Observation
    from aw_telegram.transport import SyncError
    s=storage().LocalStore(tmp_path/"sync.sqlite",now=lambda:NOW)
    start="2026-10-22T10:00:00.000Z";work=[]
    class Network:
        failed=False
        def sync(self,r):
            work.append("sync")
            if self.failed:raise SyncError(retryable=True)
            return models.SyncResponse.from_wire(response(r,started=start))
    network=Network()
    def observe(*args):return Observation(None,HEALTH)
    def summarize(date,lo,hi,settings,started):
        work.append(date)
        d=day(date);d.update(availableFrom=lo,availableThrough=hi,partial=True);return d
    c=SyncCoordinator(s,network,observe,summarize,jitter=lambda:1)
    c.step(NOW,0)
    assert work[0]=="sync" and len(work)==2
    c.step(NOW,0.25)
    assert len(work)==2, "backfill must not busy-loop between control ticks"
    for mono in [10,15,20,30,40,45,50,60,70,80]:c.step(NOW,mono)
    assert set(d for d in work if d!="sync")==set(["2026-10-28","2026-10-27","2026-10-26","2026-10-25","2026-10-24","2026-10-23","2026-10-22"])
    network.failed=True;c.step(NOW,90);c.step(NOW,95)
    before=len(work);c.step(NOW,96)
    assert work[before:] == []
    network.failed=False;c.step(NOW,110);c.step(NOW,120);c.step(NOW,130)
    assert work.count("2026-10-27")>=2, "reconnect must rescan retained historical reports"

def test_adapter_omits_failed_synthetic_unknown_and_preserves_query_success():
    from aw_telegram.sync import ReaderAdapter
    from aw_telegram.aw_reader import AWHealth
    class Reader:
        health=AWHealth("unavailable","PRIVATE",START)
        def now(self):return parse_instant(NOW)
        def live(self):return models.LiveState(NOW,"unknown",None,None,None,None,[])
    observation=ReaderAdapter(Reader()).observe(NOW,models.Settings(),START)
    assert observation.live is None and observation.health["lastSuccessAt"]==START
    assert "PRIVATE" not in str(observation)

def test_local_clock_context_and_unknown_manifest_cannot_mutate_state(tmp_path):
    s=store(tmp_path);r=s.prepare_request(HEALTH)
    answer=response(r);answer["requestSequence"]=100
    s.apply_sync(answer)
    assert s.collection_started_at is None
    with pytest.raises(ValueError):s.prepare_request({**HEALTH,"awState":"ready","lastSuccessAt":NOW})
    pair(s)
    future=day();future["settingsRevision"]=2
    with pytest.raises(ValueError):s.commit_day(future,NOW)



# Independent review regression cases: real completion clocks, day rollover, envelope size.
def test_r1_adapter_stamps_completion_and_coordinator_contains_invalid_observation(tmp_path):
    from aw_telegram.sync import ReaderAdapter,SyncCoordinator,Observation
    from aw_telegram.aw_reader import AWHealth,AWUnavailable
    from datetime import timedelta
    clock=[parse_instant(NOW)]
    class Reader:
        health=AWHealth()
        def now(self):return clock[0]
        def live(self):
            clock[0]+=timedelta(milliseconds=5)
            at=models.minimal_health()["observedAt"]
            from aw_telegram.clock import format_instant
            at=format_instant(clock[0]);self.health=AWHealth("ready",None,at)
            return models.LiveState(at,"afk",None,None,None,"r",[])
    observation=ReaderAdapter(Reader()).observe(NOW,models.Settings(),START)
    assert observation.health["observedAt"]==observation.health["lastSuccessAt"]
    models.validate_contract("sync-request",dict(schemaVersion=2,sequence=1,acks=[],health=observation.health))
    s=store(tmp_path);pair(s)
    def bad(*args):return Observation(None,{**HEALTH,"lastSuccessAt":"2026-10-29T00:00:00.000Z"})
    def unavailable(*args):raise AWUnavailable("PRIVATE")
    class Network:
        def sync(self,r):return models.SyncResponse.from_wire(response(r))
    c=SyncCoordinator(s,Network(),bad,unavailable)
    c.step(NOW,0);c.step(NOW,10)
    assert c.last_error=="observation_context_error" and c.health["awState"]=="unsupported"

def test_r2_midnight_and_multiday_wake_finalize_retained_closed_dates(tmp_path):
    from aw_telegram.sync import SyncCoordinator,Observation
    from aw_telegram.clock import format_instant
    from datetime import timedelta
    clock=[parse_instant("2026-10-28T21:58:00.000Z")]
    now=lambda:format_instant(clock[0]);s=storage().LocalStore(tmp_path/"sync.sqlite",now=now)
    calls=[]
    class Network:
        def sync(self,r):return models.SyncResponse.from_wire({**response(r),"serverNow":now()})
    def observe(*args):return Observation(None,models.minimal_health(now()))
    def summarize(date,lo,hi,*args):
        calls.append((date,hi))
        return dict(date=date,leafTotalsMs=[],appLeafTotalsMs=[],totalActiveMs=0,selectedTotalMs=0,
            settingsRevision=0,rulesRevision="r",availableFrom=lo,availableThrough=hi,partial=False,sequence=0)
    c=SyncCoordinator(s,Network(),observe,summarize)
    for mono in range(0,245,5):
        clock[0]=parse_instant("2026-10-28T21:58:00.000Z")+timedelta(seconds=mono);c.step(now(),mono)
    assert [hi for date,hi in calls if date=="2026-10-28"][-1]=="2026-10-28T22:00:00.000Z"
    clock[0]=parse_instant("2026-11-01T12:00:00.000Z")
    for mono in range(300,421,10):c.step(now(),mono)
    for date,hi in [("2026-10-29","2026-10-29T22:00:00.000Z"),("2026-10-30","2026-10-30T22:00:00.000Z"),("2026-10-31","2026-10-31T22:00:00.000Z")]:
        assert (date,hi) in calls

def test_r3_near_limit_day_cannot_replace_last_valid_source(tmp_path):
    s=store(tmp_path);pair(s);saved=s.commit_day(day(),NOW)
    near=day(total=256)
    near["appLeafTotalsMs"]=[dict(app=f"{i:04d}"+"a"*252,categoryId='["Study"]',totalMs=1) for i in range(256)]
    envelope=dict(schemaVersion=2,sequence=models.MAX_SAFE_INTEGER,health=models.minimal_health(),acks=[],summaries=[near])
    extra=131070-len(models.wire_bytes(envelope))
    assert 0<extra<256*252
    for row in near["appLeafTotalsMs"]:
        count=min(extra,252);row["app"]=row["app"][:4]+"é"*count+"a"*(252-count);extra-=count
    assert len(models.wire_bytes(envelope))==131070
    with pytest.raises(models.ReportCapacityExceeded):s.commit_day(near,NOW)
    assert s.day(saved.date)==saved
    from aw_telegram.storage import pack_request
    health={**HEALTH,"awState":"unavailable","lastSuccessAt":NOW,"reportError":"report_capacity_exceeded"}
    req=s.prepare_request(health)
    assert len(models.wire_bytes(req.to_wire()))<=131072
    assert req.acks, "capacity rejection must not stop control receipts"

def test_r4_query_success_survives_restart_and_failure(tmp_path):
    from aw_telegram.sync import SyncCoordinator,Observation
    from aw_telegram.aw_reader import AWUnavailable,AWUnsupported
    s=store(tmp_path);pair(s)
    class Network:
        requests=[]
        def sync(self,r):self.requests.append(r);return models.SyncResponse.from_wire(response(r))
    network=Network()
    def good(*args):return Observation(None,{**HEALTH,"awState":"ready","lastSuccessAt":NOW})
    def unavailable(*args):raise AWUnavailable("PRIVATE")
    c=SyncCoordinator(s,network,good,unavailable);c.step(NOW,0);s.close()
    s=store(tmp_path);c=SyncCoordinator(s,network,unavailable,unavailable);c.step(NOW,20)
    assert network.requests[-1].health["lastSuccessAt"]==NOW
    assert c.health["lastSuccessAt"]==NOW and c.health["awState"]=="unavailable"
    def unsupported(*args):raise AWUnsupported("PRIVATE")
    c.summarize=unsupported;c.step(NOW,50)
    assert c.health["awState"]=="unsupported" and c.health["lastSuccessAt"]==NOW


def test_r1_network_poll_and_summary_completion_clocks_never_regress(tmp_path):
    from aw_telegram.sync import ReaderAdapter,SyncCoordinator
    from aw_telegram.aw_reader import AWHealth
    from aw_telegram.clock import format_instant
    from datetime import timedelta
    clock=[parse_instant(NOW)]
    now=lambda:format_instant(clock[0]);s=storage().LocalStore(tmp_path/"sync.sqlite",now=now)
    completions=[]
    class Reader:
        health=AWHealth()
        def now(self):return clock[0]
        def live(self):
            clock[0]+=timedelta(milliseconds=10)
            self.health=AWHealth("ready",None,now());completions.append(now())
            return models.LiveState(now(),"afk",None,None,None,"r",[])
        def summarize(self,lo,hi,started):
            clock[0]+=timedelta(milliseconds=10);completions.append(now())
            return models.DaySummary.from_wire(day())
    class Network:
        calls=0
        def sync(self,r):
            self.calls+=1;clock[0]+=timedelta(milliseconds=10)
            return models.SyncResponse.from_wire({**response(r),"serverNow":now()})
    reader=Reader();adapter=ReaderAdapter(reader);network=Network()
    c=SyncCoordinator(s,network,adapter.observe,adapter.summarize)
    c.step(now(),0)
    assert c.health["lastSuccessAt"]==completions[-1]==c.health["observedAt"]
    clock[0]+=timedelta(seconds=15);c.step(now(),15)
    assert network.calls==2 and c.health["lastSuccessAt"]==completions[-1]
    assert s.last_activity_success_at==completions[-1]


def test_endtime_receipt_is_sent_once_per_date_generation_and_cleared_by_acknowledgement(tmp_path):
    s = store(tmp_path); pair(s)
    receipt = models.EndtimeAck(id="00000000-0000-4000-8000-0000000000e1", kind="endtime", date="2026-10-28",
        settingsRevision=1, endtimeLocalTime="13:00", endtimeGeneration=1, presentedAt="2026-10-28T11:00:05.000Z")
    assert s.commit_overlay_state({"visible": None}, receipt)
    duplicate = models.EndtimeAck(**{**receipt.to_wire(), "id": "00000000-0000-4000-8000-0000000000e2"})
    assert not s.commit_overlay_state({"visible": None}, duplicate)
    request = s.prepare_request(HEALTH)
    assert [a for a in request.acks if a["kind"] == "endtime"] == [receipt.to_wire()]
    s.apply_sync(response(request, revision=1))
    assert [a for a in s.pending_acks() if a.kind == "endtime"] == []
    s.close(); s = store(tmp_path)
    assert not s.commit_overlay_state({"visible": None}, duplicate) and s.overlay_state() == {"visible": None}
    s.close()
