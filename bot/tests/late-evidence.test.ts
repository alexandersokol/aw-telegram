/** The laptop learns of a clear or free use only at its next sync, so a reminder can truly be shown
 * after either. Such evidence is recorded, the reminder stays cleared or skipped, parents are told why,
 * and the sync never fails (one failed receipt would stop all later syncs). */
import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DeviceApi} from '../src/deviceApi.js';
import {ActionService} from '../src/actions.js';
import {SettingsService} from '../src/settings.js';
import {fixture,parent,identity,root,request,draft} from './delivery-fixture.js';

function setup(){
  const f=fixture();
  return {...f,actions:new ActionService(f.repo,f.clock),api:new DeviceApi(f.repo,f.clock),settings:new SettingsService(f.repo,f.clock)};
}
const ack=(action:any,status:string,extra:any={})=>({id:randomUUID(),kind:'action' as const,actionId:action.id,eventSequence:1,occurrence:0,status,
  at:action.createdAt,acceptedAt:action.createdAt,presentedAt:null,reason:null,...extra});
const texts=(f:any)=>[...f.db.data.entries()].filter(([k]:any)=>k.startsWith('events/')).map(([,v]:any)=>v.text.uk as string);

it('records a presentation made before a clear reached the laptop and keeps the reminder cleared',async()=>{
  const f=setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1},'a');
  await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted')]});
  f.advance(30000);await f.actions.clearActions(parent(),'manual','clear');
  f.setTime(action.targetAt);f.advance(10000);  // offline: shown at its target, reported 10 s later
  const response=await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{eventSequence:2,at:action.targetAt,presentedAt:action.targetAt})]});
  expect(response.acknowledgedAckIds).toHaveLength(1);
  const row=f.db.data.get(root+'/actions/'+action.id);
  expect([row.state,row.open,row.presentedAt]).toEqual(['canceled',false,action.targetAt]);
  expect(texts(f).filter(t=>t.includes('до того, як туди дійшло очищення'))).toHaveLength(1);
});

it('records a presentation made before free use reached the laptop and keeps the reminder skipped',async()=>{
  const f=setup();const {action}=await f.actions.createAction(parent(),{...draft,delayMinutes:1},'a');
  await f.api.syncDevice(identity,request());
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'accepted')]});
  f.advance(20000);await f.settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'free');
  f.setTime(action.targetAt);f.advance(5000);
  const shown=ack(action,'presented',{eventSequence:2,at:action.targetAt,presentedAt:action.targetAt});
  const dismissed=ack(action,'dismissed',{eventSequence:3,at:new Date(Date.parse(action.targetAt)+3000).toISOString()});
  const response=await f.api.syncDevice(identity,{...request(),acks:[shown,dismissed]});
  expect(response.acknowledgedAckIds).toEqual([shown.id,dismissed.id]);
  const row=f.db.data.get(root+'/actions/'+action.id);
  expect([row.state,row.open,row.presentedAt]).toEqual(['skipped',false,action.targetAt]);
  // Two receipts share one batched status message, which still explains the late presentation.
  expect(texts(f).filter(t=>t.includes('до того, як туди дійшов вільний режим'))).toHaveLength(1);
});

it('still accepts a presentation from before the clear as ordinary evidence',async()=>{
  const f=setup();const {action}=await f.actions.createAction(parent(),draft,'a');
  await f.api.syncDevice(identity,request());f.advance(1000);
  await f.actions.clearActions(parent(),'manual','clear');f.advance(1000);
  await f.api.syncDevice(identity,{...request(),acks:[ack(action,'presented',{presentedAt:action.createdAt})]});
  expect(f.db.data.get(root+'/actions/'+action.id).state).toBe('canceled');
  expect(texts(f).some(t=>t.includes('дійшло очищення'))).toBe(false);
});
