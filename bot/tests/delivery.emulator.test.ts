/** Real Task6 transactions; exact local demo emulator only. */
import {beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureDb,resetFixture} from './emulator-fixture.js';
import {FirestoreRepository,digest,type DeviceIdentity,type ParentIdentity} from '../src/repository.js';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {OutboxService,taskIntent,applyPlan} from '../src/outbox.js';
import {TaskService} from '../src/tasks.js';
import {minimalHealth,type SyncRequest} from '../src/contracts.js';
const db=fixtureDb(),NOW='2026-10-28T12:00:00.000Z';
let time:number,repo:FirestoreRepository,api:DeviceApi,settings:SettingsService,actions:ActionService,identity:DeviceIdentity,p1:ParentIdentity,p2:ParentIdentity;
const clock=()=>new Date(time).toISOString();
const request=(sequence=1):SyncRequest=>({schemaVersion:2,sequence,acks:[],health:minimalHealth(NOW)});
const draft={kind:'overlay' as const,delayMinutes:0,options:{message:'Час перерви',countdown:false,dismissible:true as const,repeatEveryMinutes:null}};
const path=(s:string)=>`devices/${identity.deviceId}/${s}`;
beforeEach(async()=>{
 await resetFixture();time=Date.parse(NOW);repo=new FirestoreRepository(db,()=>time);
 const code=randomBytes(32).toString('base64url');await repo.issueEnrollment(code);const enrolled=await repo.consumeEnrollment(code,'127.0.0.1');identity=await repo.resolveDevice(digest(enrolled.deviceSecret));
 const k1=await repo.createPairKey(identity,'Parent 1'),k2=await repo.createPairKey(identity,'Parent 2');p1=await repo.pairParent(k1.secret,'1','1');p2=await repo.pairParent(k2.secret,'2','2');
 api=new DeviceApi(repo,clock);settings=new SettingsService(repo,clock);actions=new ActionService(repo,clock);
});
afterAll(async()=>{await db.terminate();});
describe('delivery emulator races and rollback',()=>{
 it('fans out to ten caregivers and cancels only a revoked generation even after re-pairing',async()=>{
  const parents=[p1,p2];
  for(let i=3;i<=10;i++){const key=await repo.createPairKey(identity,'Parent '+i);parents.push(await repo.pairParent(key.secret,String(i),String(i)));}
  await settings.setHourly(parents[9]!,true,'tenth-hourly');
  expect((await db.collection(path('parents')).get()).docs.filter(doc=>doc.data().hourlyEnabled).map(doc=>doc.id)).toEqual(['10']);
  await actions.createAction(p1,draft,'ten-action');
  const event=(await db.collection('events').get()).docs.find(doc=>doc.data().kind==='status')!.data();
  expect(event.recipients).toHaveLength(10);
  const rows=(await db.collection('outbox').where('eventId','==',event.id).get()).docs;
  await repo.revokeAccess(identity,`parent:10:${parents[9]!.pairingId}`);
  const key=await repo.createPairKey(identity,'Replacement');const replacement=await repo.pairParent(key.secret,'10','10');
  expect(replacement.pairingId).not.toBe(parents[9]!.pairingId);
  const chats:string[]=[],outbox=new OutboxService(repo,{send:async chat=>{chats.push(chat);return {kind:'sent',messageId:42};}},clock);
  await Promise.all(rows.map(row=>outbox.deliverOutbox(row.id)));
  expect(chats.sort()).toEqual(['1','2','3','4','5','6','7','8','9']);
  const final=await Promise.all(rows.map(row=>row.ref.get()));
  expect(final.filter(doc=>doc.data()?.state==='delivered')).toHaveLength(9);
  expect(final.filter(doc=>doc.data()?.state==='canceled').map(doc=>doc.data()?.recipient.userId)).toEqual(['10']);
 });
 it('serializes duplicate operations without burning sequences and conflicts body reuse',async()=>{
  const result=await Promise.all(Array.from({length:5},()=>actions.createAction(p1,draft,'update:1')));expect(new Set(result.map(r=>r.action.id)).size).toBe(1);expect((await db.doc(path('actionControls/current')).get()).data()?.sequence).toBe(1);
  await expect(actions.createAction(p1,{...draft,delayMinutes:1},'update:1')).rejects.toThrow('conflict');expect((await db.collection('events').get()).size).toBe(1);
 });
 it('concurrent offer claims yield exactly one actual offer and no phantom attempt',async()=>{
  const a=await actions.createAction(p1,draft,'1');const results=await Promise.all([api.syncDevice(identity,request(1)),api.syncDevice(identity,request(2))]);expect(results.flatMap(r=>r.deliveryOffers)).toHaveLength(1);
  time+=20000;await api.syncDevice(identity,request(3));time+=20000;await api.syncDevice(identity,request(4));time+=20000;expect((await api.syncDevice(identity,request(5))).deliveryOffers).toEqual([]);expect((await db.doc(path('actions/'+a.action.id)).get()).data()?.offerCount).toBe(3);
 });
 it('serializes create/clear and preserves only actions beyond the committed sequence fence',async()=>{
  await actions.createAction(p1,draft,'first');const [created,cleared]=await Promise.all([actions.createAction(p2,draft,'race'),actions.clearActions(p1,'manual','clear')]);const offered=(await api.syncDevice(identity,request())).deliveryOffers;
  expect(offered.every(a=>a.sequence>cleared.throughActionSequence)).toBe(true);expect(created.action.sequence).toBe(2);
 });
 it('rejects invalid receipt and summary without committing any receipt, action or outbox changes',async()=>{
  const a=await actions.createAction(p1,draft,'first');await api.syncDevice(identity,request());const before=await db.collection('events').get();
  await expect(api.syncDevice(identity,{...request(2),acks:[{id:randomUUID(),kind:'action',actionId:a.action.id,eventSequence:1,occurrence:0,status:'presented',at:NOW,acceptedAt:NOW,presentedAt:NOW,reason:null}],summaries:[{date:'2026-10-28',sequence:1,settingsRevision:99,rulesRevision:'r',leafTotalsMs:[],appLeafTotalsMs:[],totalActiveMs:0,selectedTotalMs:0,availableFrom:NOW,availableThrough:NOW,partial:true}]})).rejects.toThrow();
  expect((await db.collection('events').get()).size).toBe(before.size);expect((await db.doc(path('actions/'+a.action.id)).get()).data()?.state).toBe('pending');expect((await db.collection(path('receipts')).get()).size).toBe(0);
 });
 it('records accepted offline timer uncertainty and one correction without reoffer or fence',async()=>{
  const {action}=await actions.createAction(p1,{...draft,delayMinutes:1},'timer');await api.syncDevice(identity,request());await api.syncDevice(identity,{...request(2),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:1,occurrence:0,status:'accepted',at:NOW,acceptedAt:NOW,presentedAt:null,reason:null}]});time=Date.parse(action.expiresAt)+1;await actions.expireAction(action.id);expect((await db.doc(path('actions/'+action.id)).get()).data()?.state).toBe('execution_unconfirmed');
  const ack={id:randomUUID(),kind:'action' as const,actionId:action.id,eventSequence:2,occurrence:0,status:'presented' as const,at:action.targetAt,acceptedAt:NOW,presentedAt:action.targetAt,reason:null};await api.syncDevice(identity,{...request(3),acks:[ack]});const count=(await db.collection('events').get()).size;await api.syncDevice(identity,{...request(4),acks:[ack]});expect((await db.collection('events').get()).size).toBe(count);expect((await api.syncDevice(identity,request(5))).deliveryOffers).toEqual([]);
 });
 it('isolates recipient leases, revoked generations, provider 403 and 429',async()=>{
  let calls=0;const outbox=new OutboxService(repo,{send:async(chat)=>{calls++;return chat==='1'?{kind:'forbidden'}:{kind:'retry',retryAfter:120};}},clock);
  await outbox.enqueueParentEvent({id:'test-event',deviceId:identity.deviceId,at:NOW,kind:'status',text:'Запит',recipients:[p1,p2]});const docs=(await db.collection('outbox').get()).docs;
  await Promise.all(docs.flatMap(doc=>[outbox.deliverOutbox(doc.id),outbox.deliverOutbox(doc.id)]));expect(calls).toBe(2);expect((await db.doc(path('parents/1')).get()).data()?.revokedAt).toBeNull();
  const pending=(await db.collection('outbox').where('state','==','pending').get()).docs[0]!;time+=120000;await repo.revokeAccess(identity,`parent:2:${p2.pairingId}`);await outbox.deliverOutbox(pending.id);expect(calls).toBe(2);expect((await pending.ref.get()).data()?.state).toBe('canceled');
 });
 it('repairs enqueue failure then lost-enqueued work without a new domain event',async()=>{
  let calls=0,fail=true;const tasks=new TaskService(repo,{create:async()=>{calls++;if(fail)throw new Error('offline');}},{deliverOutbox:async()=>{}} as any,clock);
  const intent=taskIntent(repo,'outbox','pending',NOW);await db.runTransaction(async tx=>{applyPlan(tx,[intent]);});await tasks.repair();expect((await intent.ref.get()).data()?.state).toBe('pending');fail=false;time+=60001;await tasks.repair();expect((await intent.ref.get()).data()?.state).toBe('enqueued');time+=60001;await tasks.repair();expect((await intent.ref.get()).data()?.dispatchGeneration).toBe(1);expect(calls).toBe(3);expect((await db.collection('events').get()).size).toBe(0);
 });
 it('deduplicates concurrent endtime receipts and cancels their queued and leased delivery on suppression',async()=>{
  await settings.updateSettings(p1,{kind:'setEndtime',localTime:'14:05'},'endtime');time=Date.parse('2026-10-28T12:10:00.000Z');
  const receipt=()=>({id:randomUUID(),kind:'endtime' as const,date:'2026-10-28',settingsRevision:1,endtimeGeneration:1,endtimeLocalTime:'14:05',presentedAt:'2026-10-28T12:05:03.000Z'});
  const same=receipt(),health=minimalHealth(clock());
  await Promise.all([same,same,receipt()].map((ack,i)=>api.syncDevice(identity,{schemaVersion:2,sequence:i+1,health,acks:[ack]})));
  expect((await db.collection('events').where('kind','==','endtime').get()).size).toBe(1);
  const rows=(await db.collection('outbox').where('policy.endtimeDate','==','2026-10-28').get()).docs;expect(rows).toHaveLength(2);
  const chats:string[]=[];let leased!:()=>void,resume!:()=>void;const paused=new Promise<void>(r=>{resume=r;});
  const outbox=new OutboxService(repo,{send:async chat=>{chats.push(chat);return {kind:'sent',messageId:1};}},clock);
  // Pause one worker after its lease commits: authorization runs between the lease and the pre-send recheck.
  const authorize=repo.authorizeRecipient.bind(repo);repo.authorizeRecipient=async r=>{leased();await paused;return authorize(r);};
  const leasedOnce=new Promise<void>(r=>{leased=r;}),first=outbox.deliverOutbox(rows[0]!.id);await leasedOnce;
  expect((await rows[0]!.ref.get()).data()?.state).toBe('sending');
  await settings.updateSettings(p2,{kind:'setFreeUse',enabled:true},'free');
  expect((await rows[1]!.ref.get()).data()).toMatchObject({state:'canceled',text:null});
  resume();await first;repo.authorizeRecipient=authorize;await outbox.deliverOutbox(rows[1]!.id);
  expect(chats).toEqual([]);expect((await rows[0]!.ref.get()).data()).toMatchObject({state:'canceled',text:null,leaseToken:null});
 });
 it('rolls back settings and coordination if mandatory controls exceed capacity',async()=>{
  const paths=Array.from({length:200},(_,i)=>Array.from({length:8},(_,j)=>String(i)+'x'.repeat(77)+j));const before=(await db.collection('events').get()).size;
  await expect(settings.updateSettings(p1,{kind:'selectCategories',paths,uncategorized:true},'too-big')).rejects.toThrow();expect((await db.doc(path('settings/current')).get()).data()?.revision).toBe(0);expect((await db.collection('events').get()).size).toBe(before);
 });
});

it('stores and retries nonempty category operation results through the real Firestore codec',async()=>{
 const change={kind:'selectCategories' as const,paths:[['Study','Editor']],uncategorized:false};
 const first=await settings.updateSettings(p1,change,'codec');const second=await settings.updateSettings(p1,change,'codec');expect(second).toEqual(first);
 const operations=await db.collection(path('operations')).get();expect(operations.docs[0]!.data().result.settings.selectedPaths).toEqual([{segments:['Study','Editor']}]);
});

it('preserves tomorrow-target timers through offer, early deadline invocation and accepted offline reconciliation',async()=>{
 time=Date.parse('2026-10-28T21:59:30.000Z');const {action}=await actions.createAction(p1,{...draft,delayMinutes:10},'tomorrow');
 expect((await api.syncDevice(identity,request())).deliveryOffers.map(a=>a.id)).toContain(action.id);await actions.expireAction(action.id);expect((await db.doc(path('actions/'+action.id)).get()).data()?.state).toBe('pending');
 await api.syncDevice(identity,{...request(2),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:1,occurrence:0,status:'accepted',at:action.createdAt,acceptedAt:action.createdAt,presentedAt:null,reason:null}]});
 time=Date.parse(action.expiresAt)+1;await actions.expireAction(action.id);expect((await db.doc(path('actions/'+action.id)).get()).data()?.state).toBe('execution_unconfirmed');
 await api.syncDevice(identity,{...request(3),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:2,occurrence:0,status:'presented',at:action.targetAt,acceptedAt:action.createdAt,presentedAt:action.targetAt,reason:null}]});expect((await db.doc(path('actions/'+action.id)).get()).data()?.state).toBe('presented');
});

it('persists initial occurrence in the action row and validates a later repetition against its dismissal',async()=>{
 const {action}=await actions.createAction(p1,{...draft,options:{...draft.options,repeatEveryMinutes:1}},'repeat-evidence');await api.syncDevice(identity,request());
 await api.syncDevice(identity,{...request(2),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:1,occurrence:0,status:'presented',at:NOW,acceptedAt:NOW,presentedAt:NOW,reason:null}]});
 let saved=(await db.doc(path('actions/'+action.id)).get()).data()!;expect(saved.initialOccurrence.presentedAt).toBe(NOW);expect((await db.doc(path('actions/'+action.id+'/occurrences/0')).get()).exists).toBe(false);
 time+=10000;await api.syncDevice(identity,{...request(3),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:2,occurrence:0,status:'dismissed',at:clock(),acceptedAt:NOW,presentedAt:NOW,reason:null}]});
 time+=60000;await api.syncDevice(identity,{...request(4),acks:[{id:randomUUID(),kind:'action',actionId:action.id,eventSequence:3,occurrence:1,status:'presented',at:clock(),acceptedAt:NOW,presentedAt:clock(),reason:null}]});
 saved=(await db.doc(path('actions/'+action.id)).get()).data()!;expect(saved.initialOccurrence.presentedAt).toBe(NOW);expect((await db.doc(path('actions/'+action.id+'/occurrences/1')).get()).data()?.presentedAt).toBe(clock());
});

it('persists null-visibility repeat dismissal and its interval without falsely confirming display',async()=>{
 const {action}=await actions.createAction(p1,{...draft,options:{...draft.options,repeatEveryMinutes:1}},'null-repeat');await api.syncDevice(identity,request());
 const first={id:randomUUID(),kind:'action' as const,actionId:action.id,eventSequence:1,occurrence:0,status:'dismissed' as const,at:NOW,acceptedAt:NOW,presentedAt:null,reason:null};
 expect((await api.syncDevice(identity,{...request(2),acks:[first]})).acknowledgedAckIds).toEqual([first.id]);
 time+=60000;await actions.expireAction(action.id);let row=(await db.doc(path('actions/'+action.id)).get()).data()!;expect(row.state).toBe('dismissed');expect(row.open).toBe(true);expect(row.initialOccurrence.presentedAt).toBeNull();
 await api.syncDevice(identity,{...request(3),acks:[{...first,id:randomUUID(),eventSequence:2,occurrence:1,at:clock()}]});expect((await db.doc(path('actions/'+action.id+'/occurrences/1')).get()).data()?.presentedAt).toBeNull();
 const statuses=(await db.collection('events').where('kind','==','status').get()).docs.map(doc=>doc.data());expect(statuses.filter(e=>e.actions?.some((a:any)=>a.id===action.id)).every(e=>!e.text.includes('Показ підтверджено'))).toBe(true);
 time=Date.parse('2026-10-28T22:00:00.000Z');await actions.expireAction(action.id);row=(await db.doc(path('actions/'+action.id)).get()).data()!;expect(row.open).toBe(false);
});
