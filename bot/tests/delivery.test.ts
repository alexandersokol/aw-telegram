import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {fixture,parent,identity,root,NOW,request,draft} from './delivery-fixture.js';
async function setup(){
  expect(existsSync(new URL('../src/actions.ts',import.meta.url)),'action lifecycle is missing').toBe(true);
  const {ActionService}=await import('../src/actions.js');const f=fixture();
  return {...f,actions:new ActionService(f.repo,f.clock),api:new DeviceApi(f.repo,f.clock),settings:new SettingsService(f.repo,f.clock)};
}
const ack=(action:any,status='accepted',extra:any={})=>({id:randomUUID(),kind:'action' as const,actionId:action.id,eventSequence:1,occurrence:0,status,at:NOW,acceptedAt:NOW,presentedAt:null,reason:null,...extra});
describe('delivery lifecycle',()=>{
  it('rejects endtime receipts that match no enabled generation without acknowledging them',async()=>{
    const f=await setup();const before=structuredClone(f.db.data);
    await expect(f.api.syncDevice(identity,{...request(),acks:[{
      id:randomUUID(),kind:'endtime',date:'2026-10-28',settingsRevision:0,endtimeGeneration:0,
      endtimeLocalTime:'13:00',presentedAt:'2026-10-28T11:00:00.000Z',
    }]})).rejects.toThrow('Invalid endtime receipt');
    expect(f.db.data).toEqual(before);
  });
  it('commits precisely three actual offers at 0/20/40 seconds and never at expiry',async()=>{
    const f=await setup();const {action}=await f.actions.createAction(parent(),draft,'update:1');
    for(const [delta,count] of [[0,1],[19999,0],[1,1],[20000,1],[20000,0]]){
      f.advance(delta!);const r=await f.api.syncDevice(identity,request());expect(r.deliveryOffers.length).toBe(count);
      if(count)expect(r.deliveryOffers[0]?.id).toBe(action.id);
    }
    expect(f.db.data.get(root+'/actions/'+action.id).offerCount).toBe(3);
  });
  it('deduplicates trusted operation intent with current authority and rejects conflicting reuse',async()=>{
    const f=await setup();const a=await f.actions.createAction(parent(),draft,'update:1');
    expect(await f.actions.createAction(parent(),draft,'update:1')).toEqual(a);
    await expect(f.actions.createAction(parent(),{...draft,delayMinutes:1},'update:1')).rejects.toThrow('conflict');
    f.db.data.get(root+'/parents/1').revokedAt=1;
    await expect(f.actions.createAction(parent(),draft,'update:1')).rejects.toThrow('Unauthorized');
  });
  it('closes offline delivery without a cancellation fence and corrects timely late evidence once',async()=>{
    const f=await setup();const {action}=await f.actions.createAction(parent(),draft,'1');await f.api.syncDevice(identity,request());
    f.advance(60000);await f.actions.expireAction(action.id);
    expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('delivery_unconfirmed');
    const r=ack(action,'presented',{presentedAt:NOW});await f.api.syncDevice(identity,{...request(),acks:[r]});
    const count=[...f.db.data.keys()].filter(k=>k.startsWith('events/')).length;
    await f.api.syncDevice(identity,{...request(),acks:[r]});expect([...f.db.data.keys()].filter(k=>k.startsWith('events/')).length).toBe(count);
    expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('presented');
    await expect(f.api.syncDevice(identity,{...request(),acks:[{...r,status:'dismissed'}]})).rejects.toThrow('conflict');
    expect((await f.api.syncDevice(identity,request())).deliveryOffers).toEqual([]);
  });
  it('scheduled delivery remains eligible beyond 60s and acceptance remains execution-unconfirmed after grace',async()=>{
    const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:2},'1');
    f.advance(61000);expect((await f.api.syncDevice(identity,request())).deliveryOffers.length).toBe(1);
    const accepted=f.clock();await f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted',{at:accepted,acceptedAt:accepted})]});
    f.setTime(action.expiresAt);await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('accepted');
    f.advance(1);await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('execution_unconfirmed');
    const r=ack(action,'presented',{eventSequence:2,at:action.targetAt,acceptedAt:accepted,presentedAt:action.targetAt});
    await f.api.syncDevice(identity,{...request(),acks:[r]});expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('presented');
  });
  it('requires offered acceptance, unique event sequence and coherent occurrence evidence',async()=>{
    const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'1');
    await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action)]})).rejects.toThrow();
    await f.api.syncDevice(identity,request());await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:NOW})]});
    await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted')]})).rejects.toThrow('conflict');
    f.advance(120000);
    await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:2,occurrence:1,at:f.clock(),presentedAt:f.clock()})]})).rejects.toThrow();
  });
  it('clear serializes the action fence and free-use preserves future timers without reviving current work',async()=>{
    const f=await setup();const a=await f.actions.createAction(parent(),draft,'1');const b=await f.actions.createAction(parent(),{...draft,delayMinutes:10},'2');
    await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'3');
    let r=await f.api.syncDevice(identity,request());expect(r.cancellations.canceledIds).toContain(a.action.id);expect(r.deliveryOffers.map(a=>a.id)).toContain(b.action.id);
    const skipped=await f.actions.createAction(parent(),draft,'4');expect(skipped.state).toBe('skipped');
    await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:false},'5');r=await f.api.syncDevice(identity,request());expect(r.deliveryOffers.map(a=>a.id)).not.toContain(a.action.id);
    await f.actions.clearActions(parent(),'all','6');const c=await f.actions.createAction(parent(),draft,'7');r=await f.api.syncDevice(identity,request());
    expect(r.cancellations.throughActionSequence).toBe(b.action.sequence+1);expect(r.deliveryOffers.map(a=>a.id)).toEqual([c.action.id]);
    expect(r.settings.suppressedDate).toBe('2026-10-28');
  });
});

it('rejects regressing receipts and records presentation evidence after a cancellation as late',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),draft,'1');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:NOW})]});f.advance(1);
  await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted',{eventSequence:2,at:f.clock()})]})).rejects.toThrow();
  const g=await setup();const b=(await g.actions.createAction(parent(),draft,'1')).action;await g.api.syncDevice(identity,request());g.advance(1000);await g.actions.clearActions(parent(),'manual','clear');g.advance(1000);
  // Shown before the clear reached the laptop: recorded, and the reminder stays cleared (late-evidence.test.ts).
  await g.api.syncDevice(identity,{...request(),acks:[ack(b,'presented',{at:g.clock(),presentedAt:g.clock()})]});expect(g.db.data.get(root+'/actions/'+b.id).state).toBe('canceled');
});
it('skips timers due during historical free use even after free use was turned off',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1},'1');await f.api.syncDevice(identity,request());
  f.advance(20000);await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'2');f.advance(60000);await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:false},'3');
  await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('skipped');
});
it('rejects an oversized free-use cancellation atomically rather than trimming explicit IDs',async()=>{
  const f=await setup();const first=(await f.actions.createAction(parent(),draft,'seed')).action;
  for(let i=1;i<102;i++){const a={...first,id:randomUUID(),sequence:i+1};const row=structuredClone(f.db.data.get(root+'/actions/'+first.id));row.action=a;f.db.data.set(root+'/actions/'+a.id,row);}
  f.db.data.set(root+'/actionControls/current',{sequence:102});const before=structuredClone(f.db.data);
  await expect(f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'oversize')).rejects.toThrow('capacity');expect(f.db.data).toEqual(before);
});
it('does not offer due-free timers before a delayed deadline worker can run',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1},'1');f.advance(20000);await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'2');f.advance(40000);
  expect((await f.api.syncDevice(identity,request())).deliveryOffers).toEqual([]);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('skipped');
});
it('cannot reuse another parent pairing operation or forge action creator settings',async()=>{
  const f=await setup();const a=await f.actions.createAction(parent(),draft,'same');const b=await f.actions.createAction(parent('2'),draft,'same');expect(a.action.id).not.toBe(b.action.id);
  await expect(f.actions.createAction(parent(),{...draft,actorId:'2'} as any,'bad')).rejects.toThrow();
});

it('encodes stable settings operation results without Firestore nested arrays and decodes retries',async()=>{
  const f=await setup();const value={kind:'selectCategories' as const,paths:[['Study','Editor']],uncategorized:false};const result=await f.settings.updateSettings(parent(),value,'categories');
  const operation=[...f.db.data].find(([k])=>k.includes('/operations/'))![1];expect(operation.result.settings.selectedPaths).toEqual([{segments:['Study','Editor']}]);
  expect(await f.settings.updateSettings(parent(),value,'categories')).toEqual(result);
});
it('does not reopen a repeat family when timely proof arrives after its original Kyiv midnight',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1,options:{...draft.options,repeatEveryMinutes:1}},'timer');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action)]});f.setTime('2026-10-28T22:01:00.000Z');await f.actions.expireAction(action.id);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:2,at:action.targetAt,presentedAt:action.targetAt})]});
  expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('presented');expect(f.db.data.get(root+'/actions/'+action.id).open).toBe(false);
});
it('reinstates a durable original-midnight closure when late proof reopens a live repeat family',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1,options:{...draft.options,repeatEveryMinutes:1}},'timer');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action)]});f.advance(66000);await f.actions.expireAction(action.id);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:2,at:action.targetAt,presentedAt:action.targetAt})]});
  expect([...f.db.data].some(([k,v])=>k.startsWith('taskIntents/')&&v.dueAt==='2026-10-28T22:00:00.000Z'&&v.state!=='completed')).toBe(true);
});
it('ends repeating initial-offer eligibility at original target midnight even if five-second grace crosses it',async()=>{
  const f=await setup();f.setTime('2026-10-28T21:58:59.000Z');const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1,options:{...draft.options,repeatEveryMinutes:1}},'timer');
  f.setTime('2026-10-28T22:00:01.000Z');expect((await f.api.syncDevice(identity,request())).deliveryOffers).toEqual([]);
  await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{at:f.clock(),acceptedAt:action.createdAt,presentedAt:f.clock()})]})).rejects.toThrow();
});

it('counts only offers included in the full UTF-8 response and leaves omitted attempts untouched',async()=>{
  const f=await setup(),first=(await f.actions.createAction(parent(),{...draft,options:{...draft.options,message:'😀'.repeat(1000)}},'seed')).action;
  for(let i=1;i<100;i++){const a={...first,id:randomUUID(),sequence:i+1};const row=structuredClone(f.db.data.get(root+'/actions/'+first.id));row.action=a;f.db.data.set(root+'/actions/'+a.id,row);}
  const response=await f.api.syncDevice(identity,request());expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(131072);expect(response.deliveryOffers.length).toBeGreaterThan(0);expect(response.deliveryOffers.length).toBeLessThan(100);
  const included=new Set(response.deliveryOffers.map(a=>a.id));for(const [key,row] of f.db.data)if(key.startsWith(root+'/actions/')&&!key.slice((root+'/actions/').length).includes('/'))expect(row.offerCount).toBe(included.has(row.action.id)?1:0);
});
it('validates a whole repeated occurrence chain without changing original presentation timestamps',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'repeat');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:NOW})]});f.advance(10000);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,at:f.clock(),presentedAt:NOW})]});f.advance(60000);
  const shown=f.clock();await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:3,occurrence:1,at:shown,presentedAt:shown})]});
  expect(f.db.data.get(root+'/actions/'+action.id).initialOccurrence.presentedAt).toBe(NOW);expect(f.db.data.get(root+'/actions/'+action.id+'/occurrences/1').presentedAt).toBe(shown);
  await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:4,occurrence:1,at:shown,presentedAt:NOW})]})).rejects.toThrow();
});

it('accepts 100 action receipts atomically within a bounded Firestore document-write budget',async()=>{
  const f=await setup(),first=(await f.actions.createAction(parent(),draft,'seed')).action;const actions=[];
  for(let i=0;i<100;i++){const a={...first,id:i?randomUUID():first.id,sequence:i+1};const row=structuredClone(f.db.data.get(root+'/actions/'+first.id));row.action=a;row.firstOfferedAt=NOW;row.lastOfferedAt=NOW;row.offerCount=1;f.db.data.set(root+'/actions/'+a.id,row);actions.push(a);}
  let writes=0;const original=f.db.runTransaction.bind(f.db);f.db.runTransaction=(body:any)=>original(async(tx:any)=>body(new Proxy(tx,{get(target,key){if(['set','update','delete','create'].includes(String(key)))return(...args:any[])=>{writes++;return target[key](...args);};return target[key];}})));
  const receipts=actions.map(a=>ack(a,'presented',{presentedAt:NOW})),response=await f.api.syncDevice(identity,{...request(),acks:receipts});expect(response.acknowledgedAckIds).toHaveLength(100);expect(writes).toBeLessThanOrEqual(450);console.info('100 action receipt document writes:',writes);
  expect(actions.every(a=>f.db.data.get(root+'/actions/'+a.id).state==='presented')).toBe(true);
});

it('acknowledges only the complete cancellation fence for a known revision',async()=>{
  const f=await setup();await f.actions.createAction(parent(),draft,'1');const first=await f.actions.clearActions(parent(),'manual','clear1');
  const receipt={id:randomUUID(),kind:'cancellation' as const,revision:first.revision,throughActionSequence:0,appliedAt:NOW};const before=structuredClone(f.db.data);
  await expect(f.api.syncDevice(identity,{...request(),acks:[receipt]})).rejects.toThrow('complete');expect(f.db.data).toEqual(before);
  await f.actions.createAction(parent(),draft,'2');await f.actions.clearActions(parent(),'manual','clear2');
  const response=await f.api.syncDevice(identity,{...request(),acks:[{...receipt,throughActionSequence:first.throughActionSequence}]});expect(response.acknowledgedAckIds).toEqual([receipt.id]);expect(f.db.data.get(root+'/sync/current').cancellationAckRevision).toBe(first.revision);
});

it('offers an original timer targeting tomorrow and ignores early closure rather than treating future retention as expired',async()=>{
  const f=await setup();f.setTime('2026-10-28T21:59:30.000Z');const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:10},'tomorrow');
  expect(action.targetAt).toBe('2026-10-28T22:09:30.000Z');expect((await f.api.syncDevice(identity,request())).deliveryOffers.map(a=>a.id)).toContain(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('pending');
  await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('pending');
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted',{at:action.createdAt,acceptedAt:action.createdAt})]});
  f.advance(1000);await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free-today');
  f.setTime(new Date(Date.parse(action.expiresAt)+1).toISOString());await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('execution_unconfirmed');
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:2,at:action.targetAt,acceptedAt:action.createdAt,presentedAt:action.targetAt})]});expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('presented');
});

it.each([2,10])('durably drains 100 repeating first presentations for %i caregivers with sync overhead within 450 writes per request',async caregiverCount=>{
  const f=await setup();
  for(let i=3;i<=caregiverCount;i++){
    const p={...parent(String(i)),pairingId:randomUUID()};f.db.data.get(root).activeParentIds.push(p.userId);
    f.db.data.set(root+'/parents/'+p.userId,{...p,revokedAt:null,name:'Parent',joinedAt:0,hourlyEnabled:false});
    f.db.data.set('telegramUsers/'+p.userId,{deviceId:p.deviceId,pairingId:p.pairingId,revokedAt:null});
  }
  const first=(await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'seed-repeat')).action;
  const receiptActions=[];
  for(let i=0;i<200;i++){
    const a={...first,id:i?randomUUID():first.id,sequence:i+1};
    const row=structuredClone(f.db.data.get(root+'/actions/'+first.id));row.action=a;
    if(i<100){row.firstOfferedAt=NOW;row.lastOfferedAt=NOW;row.offerCount=1;receiptActions.push(a);}else{row.firstOfferedAt=null;row.lastOfferedAt=null;row.offerCount=0;}
    f.db.data.set(root+'/actions/'+a.id,row);
  }
  const {retainedDates,dayBounds}=await import('../src/clock.js');const dates=retainedDates(NOW),totalMs=4*3600000-4*60000;
  f.db.data.get(root).collectionStartedAt=Date.parse(dayBounds(dates.at(-1)!).start);
  f.db.data.get(root+'/settings/current').selectedUncategorized=true;
  for(const id of f.db.data.get(root).activeParentIds)f.db.data.get(root+'/parents/'+id).hourlyEnabled=true;
  const summaries=dates.map(date=>{const bounds=dayBounds(date);return {date,sequence:1,settingsRevision:0,rulesRevision:'r',leafTotalsMs:[{category:{id:'uncategorized',path:null},totalMs}],appLeafTotalsMs:[{app:'Editor',categoryId:'uncategorized',totalMs}],totalActiveMs:totalMs,selectedTotalMs:totalMs,availableFrom:bounds.start,availableThrough:bounds.end<NOW?bounds.end:NOW,partial:true};});
  let writes=0;const original=f.db.runTransaction.bind(f.db);
  f.db.runTransaction=(body:any)=>original(async(tx:any)=>body(new Proxy(tx,{get(target,key){if(['set','update','delete','create'].includes(String(key)))return(...args:any[])=>{writes++;return target[key](...args);};return target[key];}})));
  const receipts=receiptActions.map(a=>ack(a,'presented',{presentedAt:NOW}));
  const response=await f.api.syncDevice(identity,{...request(),acks:receipts,summaries,health:{observedAt:NOW,awState:'ready',lastSuccessAt:NOW,reportError:null},live:{observedAt:NOW,state:'active',app:'Editor',title:'PRIVATE CURRENT TITLE',category:null,rulesRevision:'r',categoryCatalog:[]}});
  expect(response.acknowledgedAckIds).toHaveLength(caregiverCount===10?50:100);expect(writes).toBeLessThanOrEqual(450);
  expect(response.deliveryOffers.length).toBeGreaterThan(0);
  if(caregiverCount===2)expect(response.deliveryOffers.length).toBeLessThan(100);
  if(caregiverCount===10){
    expect(response.acknowledgedAckIds).toEqual(receipts.slice(0,50).map(a=>a.id));
    expect(receipts.slice(50).every(a=>!f.db.data.has(root+'/receipts/'+a.id))).toBe(true);
    const remaining=receipts.filter(a=>!response.acknowledgedAckIds.includes(a.id));writes=0;
    const retry=await f.api.syncDevice(identity,{...request(2),acks:remaining,summaries,health:{observedAt:NOW,awState:'ready',lastSuccessAt:NOW,reportError:null}});
    expect(retry.acknowledgedAckIds).toEqual(remaining.map(a=>a.id));expect(writes).toBeLessThanOrEqual(450);
    expect([...response.acknowledgedAckIds,...retry.acknowledgedAckIds]).toEqual(receipts.map(a=>a.id));
    const events=[...f.db.data].filter(([key,row])=>key.startsWith('events/')&&row.actions?.length).map(([,row])=>row);
    expect(events).toHaveLength(2);expect(events.every(e=>e.recipients.length===10)).toBe(true);
    writes=0;await f.api.syncDevice(identity,{...request(1),acks:receipts,summaries});
    expect([...f.db.data].filter(([key,row])=>key.startsWith('events/')&&row.actions?.length)).toHaveLength(2);
    expect(writes).toBeLessThanOrEqual(450);
  }
  expect(receiptActions.every(a=>f.db.data.get(root+'/actions/'+a.id).state==='presented')).toBe(true);
  const offered=new Set(response.deliveryOffers.map(a=>a.id));for(const [key,row]of f.db.data)if(key.startsWith(root+'/actions/')&&!key.slice((root+'/actions/').length).includes('/')&&row.action.sequence>100)expect(row.offerCount).toBe(offered.has(row.action.id)?1:0);
  const midnightIntents=[...f.db.data].filter(([key,row])=>key.startsWith('taskIntents/')&&row.kind==='deadline'&&row.dueAt==='2026-10-28T22:00:00.000Z');expect(midnightIntents).toHaveLength(100);
});

it('partially acknowledges later occurrences alongside 200 cancellation updates without losing control receipts or replaying evidence',async()=>{
  const f=await setup();
  for(let i=3;i<=10;i++){
    const p={...parent(String(i)),pairingId:randomUUID()};f.db.data.get(root).activeParentIds.push(p.userId);
    f.db.data.set(root+'/parents/'+p.userId,{...p,revokedAt:null,name:'Parent',joinedAt:0,hourlyEnabled:false});
    f.db.data.set('telegramUsers/'+p.userId,{deviceId:p.deviceId,pairingId:p.pairingId,revokedAt:null});
  }
  const first=(await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'seed-later')).action;
  const receipts=[];
  for(let i=0;i<200;i++){
    const action={...first,id:i?randomUUID():first.id,sequence:i+1},row=structuredClone(f.db.data.get(root+'/actions/'+first.id));row.action=action;
    if(i<98){
      Object.assign(row,{state:'dismissed',acceptedAt:NOW,presentedAt:NOW,firstOfferedAt:NOW,lastOfferedAt:NOW,offerCount:1,latestSequence:2,latestAt:NOW,
        initialOccurrence:{sequence:2,status:'dismissed',presentedAt:NOW,dismissedAt:NOW,terminal:true}});
      receipts.push(ack(action,'presented',{eventSequence:3,occurrence:1,at:'2026-10-28T12:01:00.000Z',presentedAt:'2026-10-28T12:01:00.000Z'}));
    }
    f.db.data.set(root+'/actions/'+action.id,row);
  }
  f.db.data.set(root+'/actionControls/current',{sequence:200});f.advance(120000);
  const cancellation=await f.actions.clearActions(parent(),'manual','cancel-all');
  const controls=[{id:randomUUID(),kind:'settings' as const,revision:0,appliedAt:f.clock()},
    {id:randomUUID(),kind:'cancellation' as const,revision:cancellation.revision,throughActionSequence:cancellation.throughActionSequence,appliedAt:f.clock()}];
  const all=[receipts[0],controls[0],...receipts.slice(1),controls[1]],original=f.db.runTransaction.bind(f.db);let writes=0;
  f.db.runTransaction=(body:any)=>original(async(tx:any)=>body(new Proxy(tx,{get(target,key){if(['set','update','delete','create'].includes(String(key)))return(...args:any[])=>{writes++;return target[key](...args);};return target[key];}})));
  const firstResponse=await f.api.syncDevice(identity,{...request(2),acks:all});
  expect(firstResponse.acknowledgedAckIds).toEqual(all.filter(a=>a.kind!=='action'||receipts.slice(0,49).includes(a)).map(a=>a.id));
  expect(writes).toBeLessThanOrEqual(450);expect(firstResponse.deliveryOffers).toEqual([]);
  expect(f.db.data.get(root+'/sync/current')).toMatchObject({settingsAckRevision:0,cancellationAckRevision:cancellation.revision,cancellationAckFence:200,maxRequestSequence:2});
  const remaining=receipts.slice(49);expect(remaining.every(a=>!f.db.data.has(root+'/receipts/'+a.id))).toBe(true);
  writes=0;const secondResponse=await f.api.syncDevice(identity,{...request(3),acks:remaining});
  expect(secondResponse.acknowledgedAckIds).toEqual(remaining.map(a=>a.id));expect(writes).toBeLessThanOrEqual(450);
  expect(receipts.every(a=>f.db.data.get(root+'/actions/'+a.actionId+'/occurrences/1').presentedAt==='2026-10-28T12:01:00.000Z')).toBe(true);
  const eventCount=[...f.db.data.keys()].filter(key=>key.startsWith('events/')).length;
  await f.api.syncDevice(identity,{...request(1),acks:all});
  expect([...f.db.data.keys()].filter(key=>key.startsWith('events/'))).toHaveLength(eventCount);
  expect(f.db.data.get(root+'/sync/current').maxRequestSequence).toBe(3);
});

it('preserves tomorrow delivery across both Kyiv DST calendar transitions',async()=>{
  for(const created of ['2026-10-24T20:59:30.000Z','2026-10-25T21:59:30.000Z']){
    const f=await setup();f.setTime(created);f.db.data.get(root).collectionStartedAt=Date.parse(created)-3600000;
    const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:10},'dst-tomorrow');
    const response=await f.api.syncDevice(identity,{...request(),health:{observedAt:created,awState:'unknown',lastSuccessAt:null,reportError:null}});expect(response.deliveryOffers.map(a=>a.id)).toContain(action.id);
    await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('pending');
  }
});

it('reads legacy separate initial occurrence facts without allowing rewritten presentation or early repeat',async()=>{
  const f=await setup();const {action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'legacy-zero');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:NOW})]});
  const actionPath=root+'/actions/'+action.id,row=f.db.data.get(actionPath);f.db.data.set(actionPath+'/occurrences/0',row.initialOccurrence);delete row.initialOccurrence;
  f.advance(10000);await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,at:f.clock(),presentedAt:f.clock()})]})).rejects.toThrow('Conflicting occurrence');
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,at:f.clock(),presentedAt:NOW})]});
  expect(f.db.data.get(actionPath).initialOccurrence.presentedAt).toBe(NOW);
  f.advance(59999);await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:3,occurrence:1,at:f.clock(),presentedAt:f.clock()})]})).rejects.toThrow('Invalid repeated occurrence');
  f.advance(1);await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:3,occurrence:1,at:f.clock(),presentedAt:f.clock()})]});expect(f.db.data.get(actionPath+'/occurrences/1').presentedAt).toBe(f.clock());
});

it.each(['dismissed','completed','replaced'])('accepts contract-valid %s without native visibility evidence and closes once work',async status=>{
  const f=await setup(),{action}=await f.actions.createAction(parent(),draft,'null-'+status);await f.api.syncDevice(identity,request());
  const receipt=ack(action,status,{reason:status==='replaced'?'replaced':null});const response=await f.api.syncDevice(identity,{...request(),acks:[receipt]});
  expect(response.acknowledgedAckIds).toEqual([receipt.id]);const row=f.db.data.get(root+'/actions/'+action.id);expect(row.state).toBe(status);expect(row.open).toBe(false);expect(row.presentedAt).toBeNull();
  const event=[...f.db.data].filter(([key])=>key.startsWith('events/')).at(-1)![1];expect(event.text.uk).not.toContain('Показ підтверджено');expect(event.text.uk).toContain('показ не підтверджено');
  f.advance(60000);await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe(status);expect((await f.api.syncDevice(identity,request())).deliveryOffers).toEqual([]);
});
it('reports zero confirmed displays for a mixed batch of null-evidence widget terminals',async()=>{
  const f=await setup(),receipts=[];
  for(const [i,status]of ['dismissed','completed','replaced'].entries()){
    const {action}=await f.actions.createAction(parent(),draft,'null-batch:'+i);await f.api.syncDevice(identity,request());receipts.push(ack(action,status,{reason:status==='replaced'?'replaced':null}));
  }
  await f.api.syncDevice(identity,{...request(),acks:receipts});const event=[...f.db.data].filter(([key])=>key.startsWith('events/')).at(-1)![1];expect(event.text.uk).toContain('Підтверджено показ: 0.');
});
it('keeps repeating null-evidence dismissal on its original interval and midnight without borrowing earlier visibility',async()=>{
  const f=await setup(),{action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'null-repeat');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:NOW})]});f.advance(10000);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,at:f.clock(),presentedAt:NOW})]});f.advance(60000);
  const dismissed=f.clock();await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:3,occurrence:1,at:dismissed})]});
  let row=f.db.data.get(root+'/actions/'+action.id);expect(row.open).toBe(true);expect(row.state).toBe('dismissed');expect(row.presentedAt).toBe(NOW);expect(f.db.data.get(root+'/actions/'+action.id+'/occurrences/1').presentedAt).toBeNull();
  const event=[...f.db.data].filter(([key])=>key.startsWith('events/')).at(-1)![1];expect(event.text.uk).not.toContain('Показ підтверджено');expect(event.text.uk).toContain('показ не підтверджено');
  const second=(await f.actions.createAction(parent(),draft,'null-mixed-with-old-proof')).action;await f.api.syncDevice(identity,request());
  f.advance(60000);await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:4,occurrence:2,at:f.clock()}),ack(second,'completed',{at:f.clock(),acceptedAt:second.createdAt})]});
  const batch=[...f.db.data].filter(([key])=>key.startsWith('events/')).at(-1)![1];expect(batch.text.uk).toContain('Підтверджено показ: 0.');
  f.setTime('2026-10-28T22:00:00.000Z');await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).open).toBe(false);
});
it('preserves an initially unproven repeating dismissal through delivery closure and valid next occurrence',async()=>{
  const f=await setup(),{action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'initial-null-repeat');await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed')]});expect(f.db.data.get(root+'/actions/'+action.id).open).toBe(true);
  expect([...f.db.data].some(([key,row])=>key.startsWith('taskIntents/')&&row.dueAt==='2026-10-28T22:00:00.000Z')).toBe(true);
  f.advance(59999);await expect(f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,occurrence:1,at:f.clock()})]})).rejects.toThrow('Invalid repeated occurrence');
  f.advance(1);await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('dismissed');expect(f.db.data.get(root+'/actions/'+action.id).open).toBe(true);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed',{eventSequence:2,occurrence:1,at:f.clock()})]});
  f.setTime('2026-10-28T22:00:00.000Z');await f.actions.expireAction(action.id);expect(f.db.data.get(root+'/actions/'+action.id).open).toBe(false);
});

it('retains real proof for the same occurrence when a later terminal receipt omits it',async()=>{
  const f=await setup(),a=(await f.actions.createAction(parent(),draft,'same-proof')).action,b=(await f.actions.createAction(parent(),draft,'no-proof')).action;await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(a,'presented',{presentedAt:NOW})]});f.advance(1);
  await f.api.syncDevice(identity,{...request(),acks:[ack(a,'completed',{eventSequence:2,at:f.clock()}),ack(b,'completed',{at:f.clock()})]});
  const event=[...f.db.data].filter(([key])=>key.startsWith('events/')).at(-1)![1];expect(event.text.uk).toContain('Підтверджено показ: 1.');expect(event.actions.find((item:any)=>item.id===a.id).presentedAt).toBe(NOW);expect(event.actions.find((item:any)=>item.id===b.id).presentedAt).toBeNull();
});
it('accepts historical null-visibility dismissal after midnight without reopening a repeat family',async()=>{
  const f=await setup(),{action}=await f.actions.createAction(parent(),{...draft,options:{...draft.options,repeatEveryMinutes:1}},'late-null');await f.api.syncDevice(identity,request());
  f.advance(60000);await f.actions.expireAction(action.id);f.setTime('2026-10-28T22:00:00.001Z');
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'dismissed')]});const row=f.db.data.get(root+'/actions/'+action.id);expect(row.state).toBe('dismissed');expect(row.open).toBe(false);expect(row.initialOccurrence.presentedAt).toBeNull();
});
