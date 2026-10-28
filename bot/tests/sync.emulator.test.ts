/** Real transactions against the exact local demo emulator only. No production fallback. */
import {beforeEach,afterAll,describe,test,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureDb,resetFixture} from './emulator-fixture.js';
import {FirestoreRepository,digest,type DeviceIdentity,type ParentIdentity} from '../src/repository.js';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {minimalHealth,type SyncRequest} from '../src/contracts.js';
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
      settings.updateSettings(p1,{kind:'selectCategories',paths:[['Study']],uncategorized:false}),
      settings.updateSettings(p2,{kind:'setFreeUse',enabled:true}),
      api.syncDevice(identity,{...request(2),summaries:[day(2,2000)]})]);
    const status=await settings.status(p1),doc=(await db.doc(path('days/2026-10-28')).get()).data()!;
    expect(status.settings.revision).toBe(2);expect(status.acknowledgedRevision).toBeNull();
    expect(doc.projection.settingsRevision).toBe(2);expect(doc.projection.selectedTotalMs).toBe(2000);
    await api.syncDevice(identity,{...request(3),acks:[{id:randomUUID(),kind:'settings',revision:2,appliedAt:NOW}]});
    expect((await settings.status(p2)).acknowledgedRevision).toBe(2);
    const opposite=await Promise.all([settings.updateSettings(p1,{kind:'setFreeUse',enabled:false}),settings.updateSettings(p2,{kind:'setFreeUse',enabled:true})]);
    const last=opposite.reduce((a,b)=>a.settings.revision>b.settings.revision?a:b);
    expect((await settings.status(p1)).settings).toEqual(last.settings);
  });
  test('resolved identities fail after device revocation, parent replacement and callback generation change',async()=>{
    await db.doc(path('sessions/1')).set({pairingId:p1.pairingId,chatId:'1',nonce:'current',version:1,expiresAt:now+60000});
    await repo.revokeAccess(identity,`parent:1:${p1.pairingId}`);
    await expect(settings.updateSettings(p1,{kind:'setDefaultLimit',ms:1000},{nonce:'current',version:1})).rejects.toThrow('Unauthorized');
    const replacement=await repo.createPairKey(identity,'Replacement');await repo.pairParent(replacement.secret,'1','1');
    await expect(settings.updateSettings(p1,{kind:'setFreeUse',enabled:true})).rejects.toThrow('Unauthorized');
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
