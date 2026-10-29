/** Real transactions against the exact local demo emulator only. No production fallback. */
import {beforeEach,afterAll,describe,test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureDb,resetFixture} from './emulator-fixture.js';
import {FirestoreRepository,digest,type DeviceIdentity,type ParentIdentity} from '../src/repository.js';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {defaultSettings,minimalHealth,type SyncRequest} from '../src/contracts.js';
import {encodeSettings} from '../src/settingsCodec.js';
import {operationRef,ActionService} from '../src/actions.js';
import {createRouter} from '../src/index.js';
const db=fixtureDb();
const START='2026-10-28T10:00:00.000Z',NOW='2026-10-28T12:00:00.000Z';
let now:number,repo:FirestoreRepository,api:DeviceApi,settings:SettingsService;
let identity:DeviceIdentity,p1:ParentIdentity,p2:ParentIdentity,deviceSecret:string;
const request=(sequence=1):SyncRequest=>({schemaVersion:2,sequence,acks:[],health:minimalHealth(NOW)});
const day=(sequence=1,totalMs=1000)=>({date:'2026-10-28',sequence,settingsRevision:0,rulesRevision:'r1',
  leafTotalsMs:[{category:{id:'["Study"]',path:['Study']},totalMs}],appLeafTotalsMs:[{app:'Editor 😀',categoryId:'["Study"]',totalMs}],
  totalActiveMs:totalMs,selectedTotalMs:0,availableFrom:START,availableThrough:NOW,partial:false});
const path=(suffix:string)=>`devices/${identity.deviceId}/${suffix}`;
beforeEach(async()=>{
  await resetFixture();now=Date.parse(START);repo=new FirestoreRepository(db,()=>now);
  const code=randomBytes(32).toString('base64url');await repo.issueEnrollment(code);
  const enrolled=await repo.consumeEnrollment(code,'127.0.0.1');deviceSecret=enrolled.deviceSecret;
  identity=await repo.resolveDevice(digest(deviceSecret));
  const k1=await repo.createPairKey(identity,'Parent 1'),k2=await repo.createPairKey(identity,'Parent 2');
  p1=await repo.pairParent(k1.secret,'1','1');p2=await repo.pairParent(k2.secret,'2','2');
  now=Date.parse(NOW);api=new DeviceApi(repo,()=>new Date(now).toISOString());settings=new SettingsService(repo,()=>new Date(now).toISOString());
});
afterAll(async()=>{await db.terminate();});
describe('sync Firestore transactions',()=>{
  test('concurrent endtime edits serialize generations and identical intents have no extra effects',async()=>{
    const change={kind:'setEndtime' as const,localTime:'21:00'};
    const identical=await Promise.all([
      settings.updateSettings(p1,change,'endtime:same-1'),settings.updateSettings(p2,change,'endtime:same-2'),
      settings.updateSettings(p1,change,'endtime:same-1'),
    ]);
    expect(identical.map(x=>x.settings.revision)).toEqual([1,1,1]);
    expect((await db.collection('events').get()).size).toBe(1);
    const edits=await Promise.all([
      settings.updateSettings(p1,{kind:'setEndtime',localTime:'22:00'},'endtime:22'),
      settings.updateSettings(p2,{kind:'setEndtime',localTime:'23:00'},'endtime:23'),
      settings.updateSettings(p1,{kind:'setTodayLimit',ms:1234},'endtime:limit'),
      api.syncDevice(identity,request()),
    ]);
    const current=(await settings.status(p1)).settings;
    expect(current).toMatchObject({revision:4,endtimeGeneration:3,todayOverride:{date:'2026-10-28',limitMs:1234}});
    const history=(await db.doc(path('policy/current')).get()).data()!.endtimeGenerations;
    expect(history.map((g:any)=>g.generation)).toEqual([1,2,3]);
    for(const result of edits.slice(0,2) as Awaited<ReturnType<SettingsService['updateSettings']>>[]) {
      expect(history).toContainEqual({generation:result.settings.endtimeGeneration,settingsRevision:result.settings.revision,
        enabled:true,localTime:result.settings.endtimeLocalTime,changedAt:NOW});
    }
    expect(history[2].localTime).toBe(current.endtimeLocalTime);
  });
  test('free-use and clear policy writes preserve generations during concurrent edits',async()=>{
    await settings.updateSettings(p1,{kind:'setEndtime',localTime:'21:00'},'endtime:first');
    await Promise.all([
      settings.updateSettings(p1,{kind:'setEndtime',localTime:'22:00'},'endtime:edit'),
      settings.updateSettings(p2,{kind:'setFreeUse',enabled:true},'endtime:free'),
    ]);
    const history=(await db.doc(path('policy/current')).get()).data()!.endtimeGenerations;
    expect(history).toHaveLength(2);
    const actions=new ActionService(repo,()=>new Date(now).toISOString());
    await actions.clearActions(p1,'manual','endtime:manual');
    await actions.clearActions(p2,'all','endtime:all');
    const policy=(await db.doc(path('policy/current')).get()).data()!;
    expect(policy.endtimeGenerations).toEqual(history);
    expect(policy.transitions).toHaveLength(1);expect(policy.fences).toHaveLength(3);
    expect((await settings.status(p1)).settings).toMatchObject({endtimeGeneration:2,endtimeLocalTime:'22:00',suppressedDate:'2026-10-28'});
  });
  test('history overflow atomically rejects settings and side effects while no-ops remain available',async()=>{
    await db.doc(path('settings/current')).set(encodeSettings({...defaultSettings(),revision:256,endtimeGeneration:256,endtimeEnabled:true}));
    const policy={transitions:[],endtimeGenerations:Array.from({length:256},(_,i)=>({generation:i+1,settingsRevision:i+1,enabled:true,localTime:'21:00',changedAt:NOW}))};
    await db.doc(path('policy/current')).set(policy);
    const before=(await db.doc(path('settings/current')).get()).data();
    await expect(settings.updateSettings(p1,{kind:'setEndtime',localTime:'22:00'},'endtime:overflow')).rejects.toThrow('Policy transition capacity exceeded');
    expect((await db.doc(path('settings/current')).get()).data()).toEqual(before);
    expect((await db.doc(path('policy/current')).get()).data()).toEqual(policy);
    expect((await db.collection('events').get()).empty).toBe(true);
    expect((await db.collection('outbox').get()).empty).toBe(true);
    expect((await db.collection(path('operations')).get()).empty).toBe(true);
    const noop=await settings.updateSettings(p1,{kind:'setEndtime',localTime:'21:00'},'endtime:noop');
    expect(noop.settings.revision).toBe(256);
    expect((await db.collection('events').get()).empty).toBe(true);
    now=Date.parse('2026-11-05T12:00:00.000Z');
    await settings.updateSettings(p1,{kind:'setEndtimeEnabled',enabled:false},'endtime:room');
    expect((await db.doc(path('policy/current')).get()).data()!.endtimeGenerations).toEqual([
      policy.endtimeGenerations[255],{generation:257,settingsRevision:257,changedAt:'2026-11-05T12:00:00.000Z',enabled:false,localTime:'21:00'},
    ]);
  });
  test('old sync acknowledgements and historical operation replay preserve current endtime and history',async()=>{
    const change={kind:'setEndtime' as const,localTime:'21:00'};
    await settings.updateSettings(p1,change,'endtime:old');
    await settings.updateSettings(p2,{kind:'setTodayLimit',ms:1234},'endtime:limit');
    const sameGeneration=await api.syncDevice(identity,request(2));
    expect(sameGeneration.settings).toMatchObject({revision:2,endtimeGeneration:1});
    await settings.updateSettings(p2,{kind:'setEndtime',localTime:'23:00'},'endtime:new');
    await api.syncDevice(identity,{...request(3),acks:[{id:randomUUID(),kind:'settings',revision:3,appliedAt:NOW}]});
    await api.syncDevice(identity,{...request(1),acks:[{id:randomUUID(),kind:'settings',revision:1,appliedAt:NOW}]});
    expect((await settings.updateSettings(p1,change,'endtime:old')).settings.revision).toBe(1);
    expect(await settings.status(p1)).toMatchObject({settings:{revision:3,endtimeGeneration:2,endtimeLocalTime:'23:00'},acknowledgedRevision:3});
    expect((await db.doc(path('policy/current')).get()).data()!.endtimeGenerations).toEqual([
      {generation:1,settingsRevision:1,changedAt:NOW,enabled:true,localTime:'21:00'},
      {generation:2,settingsRevision:3,changedAt:NOW,enabled:true,localTime:'23:00'},
    ]);
  });
  test('concurrent legacy settings reads durably migrate without resetting state',async()=>{
    const legacy:any=encodeSettings({...defaultSettings(),revision:7,selectedPaths:[['Study','Editor']],
      defaultLimitMs:12345,freeUseDate:'2026-10-27'});
    for(const field of ['endtimeEnabled','endtimeLocalTime','endtimeGeneration'])delete legacy[field];
    await db.doc(path('settings/current')).set(legacy);
    const [status,response]=await Promise.all([settings.status(p1),api.syncDevice(identity,request())]);
    expect(status.settings).toEqual(response.settings);
    expect((await db.doc(path('settings/current')).get()).data()).toEqual({...legacy,
      endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0});
    expect((await settings.status(p2)).settings.revision).toBe(7);
  });
  test('failed sync and partial stored settings leave migration and receipts uncommitted',async()=>{
    const legacy:any=encodeSettings({...defaultSettings(),revision:7});
    for(const field of ['endtimeEnabled','endtimeLocalTime','endtimeGeneration'])delete legacy[field];
    await db.doc(path('settings/current')).set(legacy);
    await expect(api.syncDevice(identity,{...request(),acks:[{id:randomUUID(),kind:'settings',revision:8,appliedAt:NOW}]})).rejects.toThrow('Unknown settings revision');
    expect((await db.doc(path('settings/current')).get()).data()).toEqual(legacy);
    expect((await db.collection(path('receipts')).get()).empty).toBe(true);
    const partial={...legacy,endtimeEnabled:false};await db.doc(path('settings/current')).set(partial);
    await expect(settings.updateSettings(p1,{kind:'setTodayLimit',ms:1000},'migration:invalid')).rejects.toThrow();
    expect((await db.doc(path('settings/current')).get()).data()).toEqual(partial);
    expect((await db.collection(path('operations')).get()).empty).toBe(true);
  });
  test('idempotent replay durably migrates its historical settings without repeating mutation',async()=>{
    const change={kind:'setDefaultLimit' as const,ms:12345};
    await settings.updateSettings(p1,change,'migration:replay');
    const ref=operationRef(repo,p1,'migration:replay'),stored=(await ref.get()).data()!;
    for(const field of ['endtimeEnabled','endtimeLocalTime','endtimeGeneration'])delete stored.result.settings[field];
    await ref.set(stored);
    await settings.updateSettings(p2,{kind:'setTodayLimit',ms:1000},'migration:newer');
    const before=(await db.doc(path('settings/current')).get()).data();
    const replay=await settings.updateSettings(p1,change,'migration:replay');
    expect(replay.settings.revision).toBe(1);
    expect((await ref.get()).data()).toEqual({...stored,result:{...stored.result,
      settings:{...stored.result.settings,endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0}}});
    expect((await db.doc(path('settings/current')).get()).data()).toEqual(before);
  });
  test('concurrent replacements retain highest source and exact idempotent receipts',async()=>{
    await Promise.all([api.syncDevice(identity,{...request(1),summaries:[day(1)]}),api.syncDevice(identity,{...request(2),summaries:[day(2,2000)]})]);
    const doc=(await db.doc(path('days/2026-10-28')).get()).data()!;
    expect(doc.sequence).toBe(2);expect(doc.source.totalActiveMs).toBe(2000);
    const before=doc.serverReceivedAt;now+=1000;
    expect((await api.syncDevice(identity,{...request(3),summaries:[day(1)]})).summaryReceipts).toEqual([{date:'2026-10-28',sequence:2}]);
    expect((await db.doc(path('days/2026-10-28')).get()).data()!.serverReceivedAt).toBe(before);
    await expect(api.syncDevice(identity,{...request(4),summaries:[day(2,999)]})).rejects.toThrow('conflict');
  });
  test('concurrent parent edits and sync preserve latest selected projection and accurate pending state',async()=>{
    await api.syncDevice(identity,{...request(),summaries:[day()]});
    await Promise.all([
      settings.updateSettings(p1,{kind:'selectCategories',paths:[['Study']],uncategorized:false},'legacy-test:1'),
      settings.updateSettings(p2,{kind:'setFreeUse',enabled:true},'legacy-test:2'),
      api.syncDevice(identity,{...request(2),summaries:[day(2,2000)]})]);
    const status=await settings.status(p1),doc=(await db.doc(path('days/2026-10-28')).get()).data()!;
    expect(status.settings.revision).toBe(2);expect(status.acknowledgedRevision).toBeNull();
    expect(doc.projection.settingsRevision).toBe(2);expect(doc.projection.selectedTotalMs).toBe(2000);
    await api.syncDevice(identity,{...request(3),acks:[{id:randomUUID(),kind:'settings',revision:2,appliedAt:NOW}]});
    expect((await settings.status(p2)).acknowledgedRevision).toBe(2);
    const opposite=await Promise.all([settings.updateSettings(p1,{kind:'setFreeUse',enabled:false},'legacy-test:3'),settings.updateSettings(p2,{kind:'setFreeUse',enabled:true},'legacy-test:4')]);
    const last=opposite.reduce((a,b)=>a.settings.revision>b.settings.revision?a:b);
    expect((await settings.status(p1)).settings).toEqual(last.settings);
  });
  test('resolved identities fail after device revocation, parent replacement and callback generation change',async()=>{
    await db.doc(path('sessions/1')).set({pairingId:p1.pairingId,chatId:'1',nonce:'current',version:1,expiresAt:now+60000});
    await repo.revokeAccess(identity,`parent:1:${p1.pairingId}`);
    await expect(settings.updateSettings(p1,{kind:'setDefaultLimit',ms:1000},'legacy-test:5',{nonce:'current',version:1})).rejects.toThrow('Unauthorized');
    const replacement=await repo.createPairKey(identity,'Replacement');await repo.pairParent(replacement.secret,'1','1');
    await expect(settings.updateSettings(p1,{kind:'setFreeUse',enabled:true},'legacy-test:6')).rejects.toThrow('Unauthorized');
    await repo.revokeDevice(identity.deviceId);
    await expect(api.syncDevice(identity,request())).rejects.toThrow('Unauthorized');
    expect((await db.doc(path('sync/current')).get()).exists).toBe(false);
  });
  test('receipt UUID conflict and invalid multi-date request roll back all writes',async()=>{
    const ack={id:randomUUID(),kind:'settings' as const,revision:0,appliedAt:NOW};
    await Promise.all([api.syncDevice(identity,{...request(),acks:[ack]}),api.syncDevice(identity,{...request(2),acks:[ack]})]);
    expect((await db.collection(path('receipts')).get()).size).toBe(1);
    await expect(api.syncDevice(identity,{...request(3),acks:[{...ack,appliedAt:START}]})).rejects.toThrow('conflict');
    await expect(api.syncDevice(identity,{...request(4),summaries:[day(),{...day(),date:'2026-10-20',availableFrom:null,availableThrough:null,partial:true,leafTotalsMs:[],appLeafTotalsMs:[],totalActiveMs:0}]})).rejects.toThrow();
    expect((await db.collection(path('days')).get()).empty).toBe(true);
  });
  test('v2 HTTP route sanitizes raw requests and preserves Task4 envelope version',async()=>{
    const router=createRouter(repo),headers={authorization:`Bearer ${deviceSecret}`};
    const result=await router({method:'POST',path:'/v2/sync',headers,body:JSON.stringify(request()),remoteAddress:'127.0.0.1'});
    expect(result.status).toBe(200);expect(result.headers['Cache-Control']).toBe('no-store');expect(result.body.schemaVersion).toBe(2);
    const bad=await router({method:'POST',path:'/v2/sync',headers,body:'{"schemaVersion":2,"sequence":1,"sequence":2}',remoteAddress:'127.0.0.1'});
    expect(bad.status).toBe(400);expect(JSON.stringify(bad.body)).not.toContain('sequence');
    expect((await router({method:'GET',path:'/v1/access',headers,body:'',remoteAddress:'127.0.0.1'})).body.schemaVersion).toBe(1);
  });
});
