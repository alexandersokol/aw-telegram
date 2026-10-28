import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {fixture,parent,NOW} from './delivery-fixture.js';
async function setup(send:any=async()=>({kind:'sent',messageId:42})){
  expect(existsSync(new URL('../src/outbox.ts',import.meta.url)),'durable outbox is missing').toBe(true);
  const m=await import('../src/outbox.js'),f=fixture();return {...f,...m,worker:new m.OutboxService(f.repo,{send},f.clock)};
}
const event={id:'event-1',deviceId:parent().deviceId,at:NOW,kind:'status',text:'Очікуємо підтвердження виконання',recipients:[parent(),parent('2')]};
describe('outbox',()=>{
  it('stages deterministic event and independent recipients atomically and isolates one Telegram 403',async()=>{
    const f=await setup(async(chat:string)=>chat==='1'?{kind:'forbidden'}:{kind:'sent',messageId:42});await f.worker.enqueueParentEvent(event);await f.worker.enqueueParentEvent(event);
    const rows=[...f.db.data.keys()].filter(k=>k.startsWith('outbox/'));expect(rows).toHaveLength(2);
    await Promise.all(rows.map(k=>f.worker.deliverOutbox(k.slice(7))));expect(rows.map(k=>f.db.data.get(k).state).sort()).toEqual(['delivered','undeliverable']);
    expect(f.db.data.get('devices/'+parent().deviceId+'/parents/1').revokedAt).toBeNull();
  });
  it('honors 429 retry-after, leases contention and reauthorizes generation before send',async()=>{
    let calls=0;const f=await setup(async()=>{calls++;return {kind:'retry',retryAfter:120};});await f.worker.enqueueParentEvent({...event,recipients:[parent()]});
    const id=[...f.db.data.keys()].find(k=>k.startsWith('outbox/'))!.slice(7);await Promise.all([f.worker.deliverOutbox(id),f.worker.deliverOutbox(id)]);expect(calls).toBe(1);
    f.advance(119999);await f.worker.deliverOutbox(id);expect(calls).toBe(1);f.advance(1);f.db.data.get('telegramUsers/1').pairingId=parent('2').pairingId;
    await f.worker.deliverOutbox(id);expect(calls).toBe(1);expect(f.db.data.get('outbox/'+id).state).toBe('canceled');
  });
  it('retries uncertain send with same logical identity and documents possible provider duplicates',async()=>{
    let calls=0;const f=await setup(async()=>{calls++;return calls===1?{kind:'uncertain'}:{kind:'sent',messageId:43};});await f.worker.enqueueParentEvent({...event,recipients:[parent()]});
    const id=[...f.db.data.keys()].find(k=>k.startsWith('outbox/'))!.slice(7);await f.worker.deliverOutbox(id);expect(f.db.data.get('outbox/'+id).state).toBe('uncertain');f.advance(60000);await f.worker.deliverOutbox(id);
    expect(calls).toBe(2);expect(f.db.data.get('outbox/'+id).state).toBe('delivered');
  });
});

it('recovers a crash after provider acceptance and before finalization with a possible duplicate message',async()=>{
  let accepted=0;const f=await setup(async()=>{accepted++;return {kind:'sent',messageId:accepted};});await f.worker.enqueueParentEvent({...event,recipients:[parent()]});
  const id=[...f.db.data.keys()].find(k=>k.startsWith('outbox/'))!.slice(7),original=f.db.runTransaction.bind(f.db);let calls=0;
  f.db.runTransaction=async(body:any)=>{if(++calls===3)throw new Error('simulated crash after provider acceptance');return original(body);};
  await expect(f.worker.deliverOutbox(id)).rejects.toThrow('simulated crash');expect(accepted).toBe(1);expect(f.db.data.get('outbox/'+id).state).toBe('sending');
  f.db.runTransaction=original;f.advance(30001);await f.worker.deliverOutbox(id);expect(accepted).toBe(2);expect(f.db.data.get('outbox/'+id).state).toBe('delivered');
});
it('honors expired lease fencing when an older provider request finally returns',async()=>{
  let finish!:(r:any)=>void,calls=0;const f=await setup(async()=>{calls++;if(calls===1)return new Promise(r=>{finish=r;});return {kind:'sent',messageId:2};});await f.worker.enqueueParentEvent({...event,recipients:[parent()]});
  const id=[...f.db.data.keys()].find(k=>k.startsWith('outbox/'))!.slice(7),first=f.worker.deliverOutbox(id);
  for(let i=0;i<20&&!finish;i++)await Promise.resolve();expect(finish).toBeTypeOf('function');f.advance(30001);await f.worker.deliverOutbox(id);finish({kind:'sent',messageId:1});await first;
  expect(f.db.data.get('outbox/'+id).messageId).toBe(2);
});
