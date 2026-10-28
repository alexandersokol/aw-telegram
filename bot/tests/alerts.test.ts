import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {defaultSettings} from '../src/contracts.js';
import {parent,NOW} from './delivery-fixture.js';
async function policy(){expect(existsSync(new URL('../src/alerts.ts',import.meta.url)),'pure alert policy is missing').toBe(true);return import('../src/alerts.js');}
const input=(total:number|null,extra:any={})=>({now:NOW,date:'2026-10-28',settings:defaultSettings(),measurement:total===null?null:{selectedTotalMs:total,partial:true,availableThrough:NOW},parents:[{...parent(),hourlyEnabled:true}],states:{},...extra});
describe('alerts',()=>{
  it('catch-up reserves one latest milestone with partial/freshness evidence and no fabricated missing zero',async()=>{
    const {evaluateAlerts}=await policy();expect(evaluateAlerts(input(null))).toEqual([]);
    const events=evaluateAlerts(input(3.5*3600000));expect(events.filter(e=>e.kind==='hourly')).toHaveLength(1);
    expect(events[0]).toMatchObject({hour:3,totalMs:12600000,partial:true,availableThrough:NOW});
  });
  it('enabling midday starts above current floor and category decrease never lowers a reservation',async()=>{
    const {evaluateAlerts,advanceMilestone}=await policy();let s=advanceMilestone(undefined,3.5*3600000,'enable');
    expect(evaluateAlerts(input(3.8*3600000,{states:{[parent().pairingId]:s}})).filter(e=>e.kind==='hourly')).toEqual([]);
    s=advanceMilestone({...s,reservedHighWater:5},1*3600000,'category');expect(s.reservedHighWater).toBe(5);
    expect(evaluateAlerts(input(5.9*3600000,{states:{[parent().pairingId]:s}})).filter(e=>e.kind==='hourly')).toEqual([]);
    expect(evaluateAlerts(input(6*3600000,{states:{[parent().pairingId]:s}})).some(e=>e.kind==='hourly'&&e.hour===6)).toBe(true);
  });
  it('consolidates crossed warnings and suppression leaves hourly independent',async()=>{
    const {evaluateAlerts}=await policy();const total=4*3600000-4*60000;
    let events=evaluateAlerts(input(total));expect(events.filter(e=>e.kind==='warning').map(e=>e.severity)).toEqual(['5m']);
    events=evaluateAlerts(input(total,{settings:{...defaultSettings(),freeUseDate:'2026-10-28',suppressedDate:'2026-10-28'}}));
    expect(events.filter(e=>e.kind==='warning')).toEqual([]);expect(events.some(e=>e.kind==='hourly')).toBe(true);
    expect(evaluateAlerts(input(total,{lastWarning:'5m'})).filter(e=>e.kind==='warning')).toEqual([]);
  });
});

it('keeps unknown enabling baseline pending and establishes it from the first measured total',async()=>{
  const {SettingsService}=await import('../src/settings.js'),{DeviceApi}=await import('../src/deviceApi.js');
  const {fixture,identity,root,request}=await import('./delivery-fixture.js');const f=fixture(),settings=new SettingsService(f.repo,f.clock),api=new DeviceApi(f.repo,f.clock);
  await settings.setHourly(parent(),true,'enable');expect(f.db.data.get(root+'/alertStates/2026-10-28').parents[parent().pairingId].pendingBaseline).toBe(true);
  const day={date:'2026-10-28',sequence:1,settingsRevision:0,rulesRevision:'r',leafTotalsMs:[{category:{id:'uncategorized',path:null},totalMs:7200000}],appLeafTotalsMs:[{app:'Editor',categoryId:'uncategorized',totalMs:7200000}],totalActiveMs:7200000,selectedTotalMs:0,availableFrom:'2026-10-28T02:00:00.000Z',availableThrough:NOW,partial:true};
  // Selecting uncategorized also reserves current total through the shared coordination message.
  await settings.updateSettings(parent(),{kind:'selectCategories',paths:[],uncategorized:true},'select');day.settingsRevision=1;day.selectedTotalMs=7200000;
  await api.syncDevice(identity,{...request(),summaries:[day]});expect([...f.db.data].filter(([k,v])=>k.startsWith('events/')&&v.kind==='hourly')).toHaveLength(0);
  expect(f.db.data.get(root+'/alertStates/2026-10-28').parents[parent().pairingId].observedFloor).toBe(2);
});
