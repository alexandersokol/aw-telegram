import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {OutboxService,type SendOutcome} from '../src/outbox.js';
import {minimalHealth} from '../src/contracts.js';
import {fixture,parent,identity,root,request,deviceId} from './delivery-fixture.js';

const SET='2026-10-28T10:00:00.000Z',SHOWN='2026-10-28T11:00:05.000Z',NOW='2026-10-28T12:00:00.000Z';
async function setup(caregivers=2,send:(chat:string)=>Promise<SendOutcome>=async()=>({kind:'sent',messageId:1}),setAt=SET){
  expect(existsSync(new URL('../src/endtime.ts',import.meta.url)),'endtime receipt planning is missing').toBe(true);
  const f=fixture(),ids=Array.from({length:caregivers},(_,i)=>String(i+1));
  f.db.data.set(root,{...f.db.data.get(root),activeParentIds:ids,collectionStartedAt:Date.parse('2026-10-26T00:00:00.000Z')});
  for(const id of ids.slice(2)){
    const p=parent(id);f.db.data.set(root+'/parents/'+id,{...p,pairingId:randomUUID(),revokedAt:null,name:'Parent',joinedAt:0,hourlyEnabled:false});
    f.db.data.set('telegramUsers/'+id,{deviceId,pairingId:f.db.data.get(root+'/parents/'+id).pairingId,revokedAt:null});
  }
  const calls:string[]=[];
  const s={...f,calls,api:new DeviceApi(f.repo,f.clock),settings:new SettingsService(f.repo,f.clock),actions:new ActionService(f.repo,f.clock),
    outbox:new OutboxService(f.repo,{send:async chat=>{calls.push(chat);return send(chat);}},f.clock)};
  f.setTime(setAt);await s.settings.updateSettings(parent(),{kind:'setEndtime',localTime:'13:00'},'set-13');f.setTime(NOW);
  return s;
}
type S=Awaited<ReturnType<typeof setup>>;
const receipt=(extra:any={})=>({id:randomUUID(),kind:'endtime' as const,date:'2026-10-28',settingsRevision:1,endtimeGeneration:1,endtimeLocalTime:'13:00',presentedAt:SHOWN,...extra});
const sync=(s:S,...acks:any[])=>s.api.syncDevice(identity,{...request(),health:minimalHealth(s.clock()),acks});
const keys=(s:S,prefix:string)=>[...s.db.data.keys()].filter(k=>k.startsWith(prefix));
const endtimeEvents=(s:S)=>[...s.db.data].filter(([k,v])=>k.startsWith('events/')&&v.kind==='endtime').map(([,v])=>v);
const endtimeRows=(s:S)=>[...s.db.data].filter(([k,v])=>k.startsWith('outbox/')&&v.policy?.kind==='endtime').map(([k,v])=>({id:k.slice(7),...v}));
const deliverAll=(s:S)=>Promise.all(endtimeRows(s).map(row=>s.outbox.deliverOutbox(row.id)));

describe('endtime receipts',()=>{
  it('turns one confirmed presentation into one alert row per active caregiver',async()=>{
    const s=await setup(10),ack=receipt();
    expect((await sync(s,ack)).acknowledgedAckIds).toEqual([ack.id]);
    const [event]=endtimeEvents(s);
    expect(event.recipients).toHaveLength(10);expect(event.text.uk).toContain('13:00');
    const rows=endtimeRows(s);expect(rows).toHaveLength(10);
    for(const row of rows)expect(row.policy).toEqual({kind:'endtime',deviceId,endtimeDate:'2026-10-28',endtimeGeneration:1});
    expect(s.db.data.has(root+'/receipts/'+ack.id)).toBe(true);
    await deliverAll(s);expect(s.calls).toHaveLength(10);
  });
  it('deduplicates retries and repeats within one generation',async()=>{
    const s=await setup(),ack=receipt();
    await sync(s,ack);await sync(s,ack);
    await sync(s,receipt({presentedAt:'2026-10-28T11:01:10.000Z'}),receipt({presentedAt:'2026-10-28T11:02:10.000Z'}));
    expect(endtimeEvents(s)).toHaveLength(1);expect(endtimeRows(s)).toHaveLength(2);
  });
  it('lets a deliberate later same-day generation alert again but not an unrelated revision',async()=>{
    const s=await setup();await sync(s,receipt());
    await s.settings.updateSettings(parent(),{kind:'setTodayLimit',ms:1000},'limit');
    await sync(s,receipt({settingsRevision:2,presentedAt:'2026-10-28T11:30:00.000Z'}));
    expect(endtimeEvents(s)).toHaveLength(1);
    s.setTime('2026-10-28T11:31:00.000Z');await s.settings.updateSettings(parent('2'),{kind:'setEndtime',localTime:'13:45'},'set-1345');
    s.setTime(NOW);await sync(s,receipt({settingsRevision:3,endtimeGeneration:2,endtimeLocalTime:'13:45',presentedAt:'2026-10-28T11:45:00.000Z'}));
    expect(endtimeEvents(s)).toHaveLength(2);expect(endtimeRows(s).map(r=>r.policy.endtimeGeneration).sort()).toEqual([1,1,2,2]);
  });
  it('accepts proof for an older generation after a later edit only within its revision window',async()=>{
    const s=await setup();
    await s.settings.updateSettings(parent(),{kind:'setEndtime',localTime:'15:00'},'set-15');
    await sync(s,receipt());expect(endtimeEvents(s)).toHaveLength(1);
    const before=structuredClone(s.db.data);
    await expect(sync(s,receipt({settingsRevision:2}))).rejects.toThrow('Invalid endtime receipt');
    expect(s.db.data).toEqual(before);
  });
  it.each([
    ['unknown generation',{endtimeGeneration:5}],['wrong time',{endtimeLocalTime:'13:05',presentedAt:'2026-10-28T11:05:00.000Z'}],
    ['unknown revision',{settingsRevision:9}],['presentation past the clock tolerance',{presentedAt:'2026-10-28T12:05:00.001Z'}],
    ['generation zero',{endtimeGeneration:0,settingsRevision:0}],
  ])('rejects %s atomically',async(_,extra)=>{
    const s=await setup();
    const before=structuredClone(s.db.data);
    await expect(sync(s,receipt(extra))).rejects.toThrow(/Invalid endtime receipt|Invalid sync request/);
    expect(s.db.data).toEqual(before);
  });
  it('rejects proof for a disabled generation',async()=>{
    const s=await setup();await s.settings.updateSettings(parent(),{kind:'setEndtimeEnabled',enabled:false},'off');
    await expect(sync(s,receipt({settingsRevision:2,endtimeGeneration:2}))).rejects.toThrow('Invalid endtime receipt');
  });
  it('defers receipts beyond the transaction write budget without acknowledging them',async()=>{
    const s=await setup(10);s.setTime(SET);
    for(let minute=1;minute<12;minute++)await s.settings.updateSettings(parent(),{kind:'setEndtime',localTime:`13:${String(minute).padStart(2,'0')}`},'set-'+minute);
    s.setTime(NOW);
    const acks=Array.from({length:12},(_,i)=>receipt({settingsRevision:i+1,endtimeGeneration:i+1,endtimeLocalTime:`13:${String(i).padStart(2,'0')}`,presentedAt:`2026-10-28T11:${String(i).padStart(2,'0')}:00.000Z`}));
    const first=await sync(s,...acks);
    expect(first.acknowledgedAckIds).toEqual(acks.slice(0,10).map(a=>a.id));expect(endtimeEvents(s)).toHaveLength(10);
    expect((await sync(s,...acks.slice(10))).acknowledgedAckIds).toEqual(acks.slice(10).map(a=>a.id));
    expect(endtimeEvents(s)).toHaveLength(12);expect(endtimeRows(s)).toHaveLength(120);
  });
  it('acknowledges unretained-date proof without an alert',async()=>{
    const s=await setup(),ack=receipt();s.setTime('2026-11-05T12:00:00.000Z');
    expect((await sync(s,ack)).acknowledgedAckIds).toEqual([ack.id]);expect(endtimeEvents(s)).toEqual([]);
  });
  it.each(['free','clear'] as const)('acknowledges %s-suppressed proof without an alert',async mode=>{
    const s=await setup();
    if(mode==='free')await s.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free');
    else await s.actions.clearActions(parent(),'all','clear');
    const ack=receipt({settingsRevision:2});
    expect((await sync(s,ack)).acknowledgedAckIds).toEqual([ack.id]);expect(endtimeEvents(s)).toEqual([]);
  });
});

describe('endtime suppression',()=>{
  it.each(['free','clear'] as const)('%s cancels queued and uncertain alerts before any later send',async mode=>{
    let first=true;const s=await setup(2,async()=>{if(first){first=false;return {kind:'uncertain'};}return {kind:'sent',messageId:2};});
    await sync(s,receipt());const [uncertain]=endtimeRows(s);
    await s.outbox.deliverOutbox(uncertain!.id);expect(s.db.data.get('outbox/'+uncertain!.id).state).toBe('uncertain');
    if(mode==='free')await s.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free');
    else await s.actions.clearActions(parent(),'all','clear');
    expect(endtimeRows(s).map(r=>[r.state,r.text])).toEqual([['canceled',null],['canceled',null]]);
    s.advance(3600000);await deliverAll(s);expect(s.calls).toHaveLength(1);
  });
  it('suppression cancels queued and leased endtime delivery',async()=>{
    const s=await setup();await sync(s,receipt());const [row]=endtimeRows(s);
    const original=s.db.runTransaction.bind(s.db);let calls=0;
    s.db.runTransaction=async(body:any)=>{
      const result=await original(body);
      // The worker's lease has committed; settings commit before its send.
      if(++calls===1){s.db.runTransaction=original;await s.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free');}
      return result;
    };
    await s.outbox.deliverOutbox(row!.id);
    expect(s.calls).toEqual([]);expect(s.db.data.get('outbox/'+row!.id)).toMatchObject({state:'canceled',text:null,leaseToken:null});
  });
  it('delivery cancels rows the settings transaction did not reach',async()=>{
    const s=await setup();await sync(s,receipt());
    const settings=s.db.data.get(root+'/settings/current');s.db.data.set(root+'/settings/current',{...settings,suppressedDate:'2026-10-28'});
    await deliverAll(s);expect(s.calls).toEqual([]);expect(endtimeRows(s).every(r=>r.state==='canceled')).toBe(true);
  });
  it('leaves alerts for other dates and unrelated messages untouched',async()=>{
    const s=await setup(2,undefined,'2026-10-27T09:00:00.000Z');s.setTime('2026-10-27T12:00:00.000Z');
    await sync(s,receipt({date:'2026-10-27',presentedAt:'2026-10-27T11:00:05.000Z'}));
    s.setTime(NOW);await s.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free');
    expect(endtimeRows(s).map(r=>r.state)).toEqual(['pending','pending']);
    expect(keys(s,'outbox/').map(k=>s.db.data.get(k)).filter(r=>!r.policy).every(r=>r.state==='pending')).toBe(true);
    await deliverAll(s);expect(s.calls).toHaveLength(2);
  });
});
