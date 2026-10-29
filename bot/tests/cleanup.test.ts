/** Task 10 retention: the daily cleanup covers every stored collection and repairs stranded delivery. */
import {it,expect} from 'vitest';
import {cleanup} from '../src/cleanup.js';
import {TaskService} from '../src/tasks.js';
import {fixture,root,NOW} from './delivery-fixture.js';

const ms=(iso:string)=>Date.parse(iso), DAY=86400000;

it('keeps exactly the seven retained Kyiv dates of an inactive laptop across the DST change',async()=>{
  const f=fixture();  // NOW is 2026-10-28; Kyiv left summer time on 2026-10-25
  for(const date of ['2026-10-21','2026-10-22','2026-10-25','2026-10-28']) {
    f.db.data.set(`${root}/days/${date}`,{source:{date}});
    f.db.data.set(`${root}/alertStates/${date}`,{date,parents:{}});
  }
  await cleanup(f.repo,NOW);
  expect(['2026-10-21','2026-10-22','2026-10-25','2026-10-28'].map(d=>f.db.data.has(`${root}/days/${d}`))).toEqual([false,true,true,true]);
  expect([f.db.data.has(`${root}/alertStates/2026-10-21`),f.db.data.has(`${root}/alertStates/2026-10-22`)]).toEqual([false,true]);
});

it('forgets the last window title of a laptop silent for longer than retention',async()=>{
  const f=fixture();
  // Retention starts at Kyiv midnight of 2026-10-22, still summer time (UTC+3): 21:00Z.
  f.db.data.set(`${root}/live/current`,{sequence:1,value:{observedAt:'2026-10-21T20:59:59.999Z',state:'active',title:'Old game'}});
  await cleanup(f.repo,NOW);
  expect(f.db.data.has(`${root}/live/current`)).toBe(false);
  f.db.data.set(`${root}/live/current`,{sequence:2,value:{observedAt:'2026-10-27T12:00:00.000Z',state:'active',title:'Recent'}});
  await cleanup(f.repo,NOW);
  expect(f.db.data.has(`${root}/live/current`)).toBe(true);
});

it('deletes expired menu sessions, throttle windows, old keys and unused enrollments',async()=>{
  const f=fixture(), now=ms(NOW);
  f.db.data.set(`${root}/sessions/1`,{expiresAt:now-1});f.db.data.set(`${root}/sessions/2`,{expiresAt:now+60000});
  f.db.data.set('throttles/pair-old',{windowStartedAt:now-2000000,count:3,expiresAt:now-1});
  f.db.data.set('throttles/pair-live',{windowStartedAt:now,count:1,expiresAt:now+900000});
  const key=(expiresAt:number,extra:any={})=>({deviceId:'d',accessId:'a',name:'x',expiresAt,consumedAt:null,consumedBy:null,pairingId:null,revokedAt:null,...extra});
  f.db.data.set('pairKeys/expired-long-ago',key(now-7*DAY-1));
  f.db.data.set('pairKeys/revoked-long-ago',key(now-8*DAY,{revokedAt:now-8*DAY}));
  f.db.data.set('pairKeys/consumed-long-ago',key(now-9*DAY,{consumedAt:now-9*DAY,consumedBy:'1',pairingId:'p'}));
  f.db.data.set('pairKeys/expired-yesterday',key(now-DAY));
  f.db.data.set('enrollments/unused-old',{expiresAt:now-7*DAY-1,consumedAt:null,deviceId:null,allowedDeviceCount:1});
  f.db.data.set('enrollments/consumed-old',{expiresAt:now-30*DAY,consumedAt:now-30*DAY,deviceId:'d',allowedDeviceCount:1});
  const result=await cleanup(f.repo,NOW);
  const kept=(path:string)=>f.db.data.has(path);
  expect([kept(`${root}/sessions/1`),kept(`${root}/sessions/2`)]).toEqual([false,true]);
  expect([kept('throttles/pair-old'),kept('throttles/pair-live')]).toEqual([false,true]);
  expect(['expired-long-ago','revoked-long-ago','consumed-long-ago','expired-yesterday'].map(k=>kept('pairKeys/'+k))).toEqual([false,false,false,true]);
  // A consumed enrollment stays: owner recovery can still revoke the device it created.
  expect([kept('enrollments/unused-old'),kept('enrollments/consumed-old')]).toEqual([false,true]);
  expect(result.deleted).toBe(6);
});

it('deletes operation tombstones once a replay is impossible, keeping recent ones',async()=>{
  const f=fixture();
  f.db.data.set(`${root}/operations/old`,{digest:'a',at:'2026-09-27T11:59:59.999Z',expired:true});
  f.db.data.set(`${root}/operations/young`,{digest:'b',at:'2026-10-10T12:00:00.000Z',expired:true});
  await cleanup(f.repo,NOW);
  expect([f.db.data.has(`${root}/operations/old`),f.db.data.has(`${root}/operations/young`)]).toEqual([false,true]);
});

it('re-arms delivery for a pending message that lost its task intent',async()=>{
  const f=fixture();
  const row=(id:string)=>({id,eventId:'e',recipient:{deviceId:'d',userId:'1',pairingId:'p'},text:'Привіт',createdAt:NOW,state:'pending',attempts:0,nextAttemptAt:NOW,leaseToken:null,leaseUntil:null});
  f.db.data.set('outbox/stranded',row('stranded'));
  f.db.data.set('outbox/armed',row('armed'));
  f.db.data.set('taskIntents/armed',{id:'armed',kind:'outbox',resourceId:'armed',dueAt:NOW,state:'pending',dispatchGeneration:0});
  const result=await cleanup(f.repo,NOW);
  const intents=[...f.db.data.entries()].filter(([k,v]:any)=>k.startsWith('taskIntents/')&&v.resourceId==='stranded');
  expect(intents.length).toBe(1);
  expect(intents[0]![1]).toMatchObject({kind:'outbox',state:'pending',dueAt:NOW});
  expect([...f.db.data.values()].filter((v:any)=>v.resourceId==='armed').length).toBe(1);
  expect(result.repaired).toBe(1);
});

it('keeps going past one bounded page until nothing is left',async()=>{
  const f=fixture(), now=ms(NOW);
  for(let i=0;i<250;i++) f.db.data.set(`throttles/old-${i}`,{windowStartedAt:0,count:1,expiresAt:now-1});
  const result=await cleanup(f.repo,NOW);
  expect([...f.db.data.keys()].filter(k=>k.startsWith('throttles/')).length).toBe(0);
  expect(result.rounds).toBeGreaterThan(1);
});

it('runs from the daily sweep task',async()=>{
  const f=fixture();
  f.db.data.set('throttles/old',{windowStartedAt:0,count:1,expiresAt:0});
  await new TaskService(f.repo,{create:async()=>{}},{} as any,f.clock).sweep();
  expect(f.db.data.has('throttles/old')).toBe(false);
});
