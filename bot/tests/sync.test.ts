import {MemoryDb} from './delivery-fixture.js';
import {describe,it,expect,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {FirestoreRepository} from '../src/repository.js';
import {defaultSettings,validateContract,minimalHealth} from '../src/contracts.js';
import {decodeSettings,encodeSettings} from '../src/settingsCodec.js';
import {ActionService,operationRef} from '../src/actions.js';
import {draft} from './delivery-fixture.js';
import {applySettingsChange,SettingsService,type SettingsChange} from '../src/settings.js';

const NOW='2026-10-28T12:00:00.000Z', START='2026-10-28T10:00:00.000Z';
const deviceId='00000000-0000-4000-8000-000000000001';
const identity={deviceId,credentialDigest:'a'.repeat(64)};
const parent=(userId='1')=>({deviceId,userId,chatId:userId,pairingId:'00000000-0000-4000-8000-00000000000'+userId});
const root=`devices/${deviceId}`;
export const sourceDay=(sequence=1,totalMs=1000)=>({date:'2026-10-28',sequence,settingsRevision:0,rulesRevision:'r1',
  leafTotalsMs:[{category:{id:'["Study"]',path:['Study']},totalMs}],appLeafTotalsMs:[{app:'Editor 😀',categoryId:'["Study"]',totalMs}],
  totalActiveMs:totalMs,selectedTotalMs:0,availableFrom:START,availableThrough:NOW,partial:false});
export const request=(sequence=1)=>({schemaVersion:2 as const,sequence,health:minimalHealth(NOW),acks:[]});

// Serial, rollback-capable boundary fake. Real concurrency is verified separately in the guarded emulator.
async function setup() {
  expect(existsSync(new URL('../src/deviceApi.ts',import.meta.url)),'Authenticated sync service is not implemented').toBe(true);
  expect(existsSync(new URL('../src/settings.ts',import.meta.url)),'Transactional settings service is not implemented').toBe(true);
  const {DeviceApi}=await import('../src/deviceApi.js'),{SettingsService}=await import('../src/settings.js');
  const db=new MemoryDb(),repository=new FirestoreRepository(db as any,()=>Date.parse(NOW));
  db.data.set(root,{status:'active',credentialDigest:identity.credentialDigest,activeParentIds:['1','2'],collectionStartedAt:Date.parse(START)});
  db.data.set(root+'/settings/current',defaultSettings());
  for(const user of ['1','2']) {
    const p=parent(user);db.data.set(root+'/parents/'+user,{...p,revokedAt:null,name:'Parent',joinedAt:0,hourlyEnabled:false});
    db.data.set('telegramUsers/'+user,{deviceId,pairingId:p.pairingId,revokedAt:null});
  }
  return {db,repository,api:new DeviceApi(repository,()=>NOW),settings:new SettingsService(repository,()=>NOW)};
}

const endtimeFields=['endtimeEnabled','endtimeLocalTime','endtimeGeneration'] as const;
const generation=(n:number,changedAt=NOW)=>({generation:n,settingsRevision:n,changedAt,enabled:true,localTime:'21:00'});
function legacySettings() {
  const stored:any=encodeSettings({...defaultSettings(),revision:7,selectedPaths:[['Study','Editor']],
    selectedUncategorized:true,defaultLimitMs:12345,todayOverride:{date:'2026-10-28',limitMs:6789},
    freeUseDate:'2026-10-27',suppressedDate:'2026-10-26'});
  for(const field of endtimeFields)delete stored[field];
  return stored;
}

describe('persisted endtime settings migration',()=>{
  it('decodes only fully legacy storage while wire inputs remain strict',()=>{
    const legacy=legacySettings(),before=structuredClone(legacy);
    expect(decodeSettings(legacy)).toEqual({...legacy,selectedPaths:[['Study','Editor']],
      endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0});
    expect(legacy).toEqual(before);
    expect(()=>validateContract('settings',{...legacy,selectedPaths:[['Study','Editor']]})).toThrow();
    for(let mask=1;mask<7;mask++) {
      const partial:any={...legacy};
      for(let i=0;i<3;i++)if(mask&(1<<i))partial[endtimeFields[i]!]=defaultSettings()[endtimeFields[i]!];
      expect(()=>decodeSettings(partial)).toThrow();
    }
    expect(()=>decodeSettings({...legacy,unknown:true})).toThrow();
    expect(()=>decodeSettings({...encodeSettings(defaultSettings()),endtimeLocalTime:'00:14'})).toThrow();
  });
  it.each(['status','sync','update','create','clear'] as const)('%s durably migrates stored settings without losing policy fields',async path=>{
    const {db,api,settings,repository}=await setup(),legacy=legacySettings();
    db.data.set(root+'/settings/current',legacy);
    const actions=new ActionService(repository,()=>NOW);
    if(path==='status')expect((await settings.status(parent())).settings.revision).toBe(7);
    if(path==='sync')expect((await api.syncDevice(identity,request())).settings.revision).toBe(7);
    if(path==='update')await settings.updateSettings(parent(),{kind:'setTodayLimit',ms:5678},'migration:update');
    if(path==='create')await actions.createAction(parent(),draft,'migration:create');
    if(path==='clear')await actions.clearActions(parent(),'manual','migration:clear');
    expect(db.data.get(root+'/settings/current')).toEqual({...legacy,
      ...(path==='update'?{revision:8,todayOverride:{date:'2026-10-28',limitMs:5678}}:{}),
      endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0});
    const before=structuredClone(db.data.get(root+'/settings/current'));
    await settings.status(parent());
    expect(db.data.get(root+'/settings/current')).toEqual(before);
  });
  it('deadline processing durably migrates the settings it reads',async()=>{
    const {db,repository}=await setup();
    const actions=new ActionService(repository,()=>NOW),created=await actions.createAction(parent(),draft,'migration:create');
    const legacy=legacySettings();db.data.set(root+'/settings/current',legacy);
    await new ActionService(repository,()=> '2026-10-28T12:02:00.000Z').expireAction(created.action.id);
    expect(db.data.get(root+'/settings/current')).toEqual({...legacy,endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0});
  });
  it('migrates a replayed operation result without reapplying the change or replacing newer settings',async()=>{
    const {db,settings,repository}=await setup(),change={kind:'setDefaultLimit' as const,ms:12345};
    await settings.updateSettings(parent(),change,'migration:replay');
    const ref=operationRef(repository,parent(),'migration:replay'),operation=db.data.get(ref.path);
    const legacy=legacySettings();operation.result.settings=legacy;operation.result.acknowledgedRevision=6;
    const current=encodeSettings({...defaultSettings(),revision:9,endtimeEnabled:true,endtimeLocalTime:'22:00',endtimeGeneration:2});
    db.data.set(root+'/settings/current',current);
    const before=structuredClone(db.data);
    const result=await settings.updateSettings(parent(),change,'migration:replay');
    expect(result.settings).toEqual({...legacy,selectedPaths:[['Study','Editor']],endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0});
    expect(db.data.get(ref.path)).toEqual({...before.get(ref.path),result:{...before.get(ref.path).result,
      settings:{...legacy,endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0}}});
    expect(db.data.get(root+'/settings/current')).toEqual(current);
    expect([...db.data.keys()]).toEqual([...before.keys()]);
  });
  it('rolls migration back with a rejected sync and rejects partial storage before writes',async()=>{
    const {db,api,settings}=await setup(),legacy=legacySettings();db.data.set(root+'/settings/current',legacy);
    let before=structuredClone(db.data);
    await expect(api.syncDevice(identity,{...request(),acks:[{id:'00000000-0000-4000-8000-000000000099',kind:'settings',revision:8,appliedAt:NOW}]})).rejects.toThrow('Unknown settings revision');
    expect(db.data).toEqual(before);
    for(let mask=1;mask<7;mask++) {
      const partial:any={...legacy};
      for(let i=0;i<3;i++)if(mask&(1<<i))partial[endtimeFields[i]!]=defaultSettings()[endtimeFields[i]!];
      db.data.set(root+'/settings/current',partial);before=structuredClone(db.data);
      await expect(settings.status(parent())).rejects.toThrow();
      await expect(settings.updateSettings(parent(),{kind:'setTodayLimit',ms:1000},'migration:partial')).rejects.toThrow();
      await expect(api.syncDevice(identity,request())).rejects.toThrow();
      expect(db.data).toEqual(before);
    }
  });
});

describe('v2 authenticated sync',()=>{
  it('requires typed health, rejects future success and unique summary receipts',()=>{
    expect(validateContract('sync-request',request())).toEqual(request());
    expect(()=>validateContract('sync-request',{...request(),health:{...minimalHealth(NOW),lastSuccessAt:'2026-10-29T00:00:00.000Z'}})).toThrow();
  });
  it('replaces whole dates, receipts old sources without refreshing measurement, conflicts atomically',async()=>{
    const {api,db}=await setup();
    const first=await api.syncDevice(identity,{...request(),summaries:[sourceDay()]});
    expect(first.summaryReceipts).toEqual([{date:'2026-10-28',sequence:1}]);
    await api.syncDevice(identity,{...request(3),summaries:[sourceDay(3,500)]});
    const replay=await api.syncDevice(identity,{...request(2),summaries:[sourceDay(2,2000)]});
    expect(replay.summaryReceipts[0]?.sequence).toBe(3);
    const before=structuredClone(db.data);
    await expect(api.syncDevice(identity,{...request(4),summaries:[sourceDay(3,999)]})).rejects.toThrow('conflict');
    expect(db.data).toEqual(before);
    expect(db.data.get(root+'/days/2026-10-28').source.totalActiveMs).toBe(500);
  });
  it('rechecks revoked authority inside mutation and rejects activity before pairing',async()=>{
    const {api,db}=await setup();db.data.get(root).credentialDigest='b'.repeat(64);
    await expect(api.syncDevice(identity,request())).rejects.toThrow('Unauthorized');
    db.data.get(root).credentialDigest=identity.credentialDigest;db.data.get(root).collectionStartedAt=null;
    expect((await api.syncDevice(identity,request())).collectionStartedAt).toBeNull();
    await expect(api.syncDevice(identity,{...request(),summaries:[sourceDay()]})).rejects.toThrow();
    await expect(api.syncDevice(identity,{...request(),health:{...minimalHealth(NOW),observedAt:'2026-10-29T00:00:00.000Z'}})).rejects.toThrow();
  });
  it('omitted live preserves original observation while explicit unknown replaces current only',async()=>{
    const {api,db}=await setup();
    const live={observedAt:START,state:'active' as const,app:'Editor',title:'PRIVATE TITLE A',category:null,rulesRevision:'r',categoryCatalog:[]};
    await api.syncDevice(identity,{...request(),health:minimalHealth(START),live});
    await api.syncDevice(identity,{...request(2),health:{...minimalHealth(NOW),awState:'unavailable'}});
    expect(db.data.get(root+'/live/current').value).toEqual(live);
    const health={...minimalHealth(NOW),awState:'unavailable' as const};
    await api.syncDevice(identity,{...request(3),health,live:{...live,observedAt:'2026-10-28T11:00:00.000Z',title:'PRIVATE TITLE B'}});
    expect(JSON.stringify([...db.data])).not.toContain('PRIVATE TITLE A');
    await expect(api.syncDevice(identity,{...request(4),health,live:{...live,observedAt:'2026-10-28T11:00:00.000Z',state:'unknown',app:null,title:null,rulesRevision:null}})).rejects.toThrow('conflict');
    // Same observation with different identity is a conflict, never an arrival-order overwrite.
    expect(db.data.get(root+'/live/current').value.title).toBe('PRIVATE TITLE B');
    await api.syncDevice(identity,{...request(5),health,live:{...live,observedAt:NOW,state:'unknown',app:null,title:null,rulesRevision:null}});
    expect(db.data.get(root+'/live/current').value.app).toBeNull();
    expect([...db.data.keys()].filter(k=>k.includes('/live/'))).toEqual([root+'/live/current']);
  });
  it('durably deduplicates receipt IDs, rejects unknown action hook and future revision',async()=>{
    const {api,db}=await setup();
    const ack={id:'00000000-0000-4000-8000-000000000099',kind:'settings' as const,revision:0,appliedAt:NOW};
    for(const sequence of [1,2]) expect((await api.syncDevice(identity,{...request(sequence),acks:[ack]})).acknowledgedAckIds).toEqual([ack.id]);
    await expect(api.syncDevice(identity,{...request(3),acks:[{...ack,revision:1}]})).rejects.toThrow();
    expect(db.data.get(root+'/sync/current').settingsAckRevision).toBe(0);
    await expect(api.syncDevice(identity,{...request(4),summaries:[{...sourceDay(),settingsRevision:1}]})).rejects.toThrow();
    expect(db.data.has(root+'/days/2026-10-28')).toBe(false);
  });
});
describe('revisioned settings',()=>{
  it('set enables, off retains time, and on reuses it without changing the input',()=>{
    const initial=defaultSettings(),before=structuredClone(initial);
    const set=applySettingsChange(initial,{kind:'setEndtime',localTime:'23:59'},NOW);
    expect(set).toEqual({...initial,revision:1,endtimeEnabled:true,endtimeLocalTime:'23:59',endtimeGeneration:1});
    const off=applySettingsChange(set,{kind:'setEndtimeEnabled',enabled:false},NOW);
    expect(off).toEqual({...set,revision:2,endtimeEnabled:false,endtimeGeneration:2});
    expect(applySettingsChange(off,{kind:'setEndtimeEnabled',enabled:true},NOW)).toEqual({...set,revision:3,endtimeGeneration:3});
    expect(initial).toEqual(before);
  });
  it.each(['00:15','01:00','23:59'])('accepts exact endtime %s',localTime=>{
    expect(applySettingsChange(defaultSettings(),{kind:'setEndtime',localTime},NOW)).toMatchObject({endtimeEnabled:true,endtimeLocalTime:localTime,endtimeGeneration:1,revision:1});
  });
  it.each(['00:00','00:14','24:00','9:00','21:00:00',' 21:00','21:00 ','21:00\n',null,2100])('rejects malformed endtime %s',localTime=>{
    expect(()=>applySettingsChange(defaultSettings(),{kind:'setEndtime',localTime} as any,NOW)).toThrow('Invalid settings change');
  });
  it.each([
    {kind:'setEndtime',localTime:'21:00',enabled:true},{kind:'setEndtime'},
    {kind:'setEndtimeEnabled',enabled:1},{kind:'setEndtimeEnabled',enabled:'true'},
    {kind:'setEndtimeEnabled',enabled:true,localTime:'21:00'},{kind:'setEndtimeEnabled'},
  ])('rejects open or mistyped endtime intents %#',change=>{
    expect(()=>applySettingsChange(defaultSettings(),change as any,NOW)).toThrow('Invalid settings change');
  });
  it('advances only settings revision for unrelated changes and no counters for effective no-ops',()=>{
    const initial={...defaultSettings(),revision:7,endtimeEnabled:true,endtimeLocalTime:'22:00',endtimeGeneration:3};
    for(const change of [
      {kind:'setEndtime',localTime:'22:00'},{kind:'setEndtimeEnabled',enabled:true},
      {kind:'setFreeUse',enabled:false},{kind:'setSuppression',enabled:false},
      {kind:'setDefaultLimit',ms:14400000},{kind:'selectCategories',paths:[],uncategorized:false},
    ] as SettingsChange[])expect(applySettingsChange(initial,change,NOW)).toEqual(initial);
    for(const change of [
      {kind:'setDefaultLimit',ms:1234},{kind:'setTodayLimit',ms:1234},
      {kind:'selectCategories',paths:[['Study']],uncategorized:true},{kind:'setFreeUse',enabled:true},
      {kind:'setSuppression',enabled:true},
    ] as SettingsChange[])expect(applySettingsChange(initial,change,NOW)).toMatchObject({revision:8,endtimeGeneration:3,endtimeLocalTime:'22:00',endtimeEnabled:true});
  });
  it('checks exhaustion only for counters that must advance',()=>{
    const max=Number.MAX_SAFE_INTEGER;
    const full={...defaultSettings(),revision:max,endtimeGeneration:max};
    expect(applySettingsChange(full,{kind:'setEndtimeEnabled',enabled:false},NOW)).toEqual(full);
    expect(()=>applySettingsChange(full,{kind:'setTodayLimit',ms:1234},NOW)).toThrow('Settings revision exhausted');
    const genFull={...full,revision:7};
    expect(applySettingsChange(genFull,{kind:'setTodayLimit',ms:1234},NOW)).toMatchObject({revision:8,endtimeGeneration:max});
    expect(()=>applySettingsChange(genFull,{kind:'setEndtime',localTime:'21:00'},NOW)).toThrow('Endtime generation exhausted');
    expect(applySettingsChange({...defaultSettings(),revision:max-1,endtimeGeneration:max-1},{kind:'setEndtime',localTime:'21:00'},NOW)).toMatchObject({revision:max,endtimeGeneration:max});
  });
  it('stores generations with their original revision and leaves unrelated edits in that generation',async()=>{
    const {db,settings}=await setup();
    await settings.updateSettings(parent(),{kind:'setTodayLimit',ms:1000},'endtime:limit');
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:set');
    await settings.updateSettings(parent('2'),{kind:'selectCategories',paths:[['Study']],uncategorized:true},'endtime:categories');
    await settings.updateSettings(parent(),{kind:'setEndtimeEnabled',enabled:false},'endtime:off');
    expect(db.data.get(root+'/policy/current').endtimeGenerations).toEqual([
      {generation:1,settingsRevision:2,changedAt:NOW,enabled:true,localTime:'22:00'},
      {generation:2,settingsRevision:4,changedAt:NOW,enabled:false,localTime:'22:00'},
    ]);
    expect((await settings.status(parent())).settings).toMatchObject({revision:4,endtimeGeneration:2});
  });
  it('no-op commands reserve operation identity without any settings, alert, cancellation or policy side effects',async()=>{
    const {db,settings,repository}=await setup();
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'21:00'},'endtime:first');
    const before=structuredClone(db.data);
    const result=await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'21:00'},'endtime:noop');
    const op=operationRef(repository,parent(),'endtime:noop');
    expect(result.settings.revision).toBe(1);
    expect(db.data.has(op.path)).toBe(true);
    const withoutOp=new Map(db.data);withoutOp.delete(op.path);expect(withoutOp).toEqual(before);
    const after=structuredClone(db.data);
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'21:00'},'endtime:noop');
    expect(db.data).toEqual(after);
    await expect(settings.updateSettings(parent(),{kind:'setEndtimeEnabled',enabled:false},'endtime:noop')).rejects.toThrow('conflict');
  });
  it('no-op free-use does not add cancellation fences or transitions',async()=>{
    const {db,settings,repository}=await setup();
    await settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'endtime:free');
    const before=structuredClone(db.data);
    await settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'endtime:free-noop');
    const after=new Map(db.data);after.delete(operationRef(repository,parent(),'endtime:free-noop').path);
    expect(after).toEqual(before);
  });
  it('preserves generation history and other policy data through free-use and both clear paths',async()=>{
    const {db,settings,repository}=await setup();
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:set');
    const history=structuredClone(db.data.get(root+'/policy/current').endtimeGenerations);
    db.data.get(root+'/policy/current').extension={keep:true};
    await settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'endtime:free');
    await settings.updateSettings(parent(),{kind:'setFreeUse',enabled:false},'endtime:restore');
    const actions=new ActionService(repository,()=>NOW);
    await actions.clearActions(parent(),'manual','endtime:clear-manual');
    await actions.clearActions(parent(),'all','endtime:clear-all');
    expect(db.data.get(root+'/policy/current')).toMatchObject({endtimeGenerations:history,extension:{keep:true}});
    expect(db.data.get(root+'/policy/current').transitions).toHaveLength(2);
    expect(db.data.get(root+'/policy/current').fences).toHaveLength(3);
  });
  it('retains the pre-window baseline and all seven Kyiv dates across DST, and prunes expired generations',async()=>{
    const {db,settings}=await setup();
    db.data.set(root+'/settings/current',encodeSettings({...defaultSettings(),revision:5,endtimeEnabled:true,endtimeGeneration:5}));
    db.data.set(root+'/policy/current',{transitions:[],fences:[],endtimeGenerations:[
      generation(1,'2026-10-01T12:00:00.000Z'),generation(2,'2026-10-20T12:00:00.000Z'),
      generation(3,'2026-10-21T20:59:59.999Z'), // Kyiv Oct 21, before retained window
      generation(4,'2026-10-21T21:00:00.000Z'), // Kyiv Oct 22, seven dates include this boundary
      generation(5,'2026-10-27T22:00:00.000Z'),
    ]});
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'23:00'},'endtime:retain');
    expect(db.data.get(root+'/policy/current').endtimeGenerations).toEqual([
      generation(3,'2026-10-21T20:59:59.999Z'),generation(4,'2026-10-21T21:00:00.000Z'),
      generation(5,'2026-10-27T22:00:00.000Z'),{generation:6,settingsRevision:6,changedAt:NOW,enabled:true,localTime:'23:00'},
    ]);
    const later=new SettingsService(new FirestoreRepository(db as any),()=> '2026-11-05T12:00:00.000Z');
    await later.updateSettings(parent(),{kind:'setEndtimeEnabled',enabled:false},'endtime:later');
    expect(db.data.get(root+'/policy/current').endtimeGenerations).toEqual([
      {generation:6,settingsRevision:6,changedAt:NOW,enabled:true,localTime:'23:00'},
      {generation:7,settingsRevision:7,changedAt:'2026-11-05T12:00:00.000Z',enabled:false,localTime:'23:00'},
    ]);
  });
  it('enforces history capacity before writes, permits no-ops and unrelated edits at capacity',async()=>{
    const {db,settings}=await setup();
    db.data.set(root+'/settings/current',encodeSettings({...defaultSettings(),revision:255,endtimeGeneration:255,endtimeEnabled:true}));
    db.data.set(root+'/policy/current',{transitions:[],endtimeGenerations:Array.from({length:255},(_,i)=>generation(i+1))});
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:last-slot');
    expect(db.data.get(root+'/policy/current').endtimeGenerations).toHaveLength(256);
    const before=structuredClone(db.data);
    await expect(settings.updateSettings(parent(),{kind:'setEndtimeEnabled',enabled:false},'endtime:overflow')).rejects.toThrow('Policy transition capacity exceeded');
    expect(db.data).toEqual(before);
    expect((await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:full-noop')).settings.revision).toBe(256);
    expect((await settings.updateSettings(parent(),{kind:'setTodayLimit',ms:1000},'endtime:full-limit')).settings).toMatchObject({revision:257,endtimeGeneration:256});
  });
  it('keeps old operation replays and reordered sync acknowledgements from restoring older endtime',async()=>{
    const {db,settings,api}=await setup();
    const change={kind:'setEndtime' as const,localTime:'21:00'};
    await settings.updateSettings(parent(),change,'endtime:old');
    await settings.updateSettings(parent('2'),{kind:'setEndtime',localTime:'23:00'},'endtime:new');
    await api.syncDevice(identity,{...request(2),acks:[{id:'00000000-0000-4000-8000-000000000071',kind:'settings',revision:2,appliedAt:NOW}]});
    await api.syncDevice(identity,{...request(1),acks:[{id:'00000000-0000-4000-8000-000000000072',kind:'settings',revision:1,appliedAt:NOW}]});
    const history=structuredClone(db.data.get(root+'/policy/current'));
    expect((await settings.updateSettings(parent(),change,'endtime:old')).settings).toMatchObject({revision:1,endtimeGeneration:1,endtimeLocalTime:'21:00'});
    expect(await settings.status(parent())).toMatchObject({settings:{revision:2,endtimeGeneration:2,endtimeLocalTime:'23:00'},acknowledgedRevision:2});
    expect(db.data.get(root+'/policy/current')).toEqual(history);
  });
  it('coordinates an endtime change with all other caregivers, excluding only the issuer',async()=>{
    const {db,settings}=await setup();
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:coordination');
    const events=[...db.data].filter(([key,value])=>key.startsWith('events/')&&value.kind==='coordination').map(([,value])=>value);
    expect(events).toHaveLength(1);expect(events[0].recipients).toEqual([{deviceId,userId:'2',pairingId:parent('2').pairingId}]);
  });
  it('still sends an allowance warning made due by a settings edit to the excluded issuer',async()=>{
    const {db,settings,api}=await setup();await api.syncDevice(identity,{...request(),summaries:[sourceDay()]});
    await settings.updateSettings(parent(),{kind:'selectCategories',paths:[['Study']],uncategorized:false},'endtime:select');
    await settings.updateSettings(parent(),{kind:'setTodayLimit',ms:60000},'endtime:warn');
    const events=[...db.data].filter(([key])=>key.startsWith('events/')).map(([,value])=>value);
    const recipients=(kind:string)=>events.filter(e=>e.kind===kind&&e.text.includes('Залишилося 5 хв')).flatMap(e=>e.recipients.map((r:any)=>r.userId));
    expect(recipients('coordination')).toEqual(['2']);expect(recipients('warning')).toEqual(['1']);
    expect(db.data.get(root+'/alertStates/2026-10-28').lastWarning).toBe('5m');
  });
  it('creates no recipient-less coordination event for a sole caregiver',async()=>{
    const {db,settings}=await setup();
    db.data.set(root,{...db.data.get(root),activeParentIds:['1']});db.data.get(root+'/parents/2').revokedAt=1;
    await settings.updateSettings(parent(),{kind:'setEndtime',localTime:'22:00'},'endtime:sole');
    expect([...db.data.keys()].filter(key=>key.startsWith('events/'))).toEqual([]);
  });
  it('serializes opposite parent intents, preserves unrelated fields and reports pending until device Ack',async()=>{
    const {api,settings,db}=await setup();
    const result=await Promise.all([settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true},'legacy-test:1'),settings.updateSettings(parent('2'),{kind:'setSuppression',enabled:true},'legacy-test:2')]);
    expect(result.map(x=>x.settings.revision)).toEqual([1,2]);
    expect(result[1]?.acknowledgedRevision).toBeNull();
    const current=db.data.get(root+'/settings/current');expect(current.freeUseDate).toBe('2026-10-28');expect(current.suppressedDate).toBe('2026-10-28');
    await api.syncDevice(identity,{...request(),acks:[{id:'00000000-0000-4000-8000-000000000088',kind:'settings',revision:2,appliedAt:NOW}]});
    expect((await settings.status(parent())).acknowledgedRevision).toBe(2);
    const restored=await settings.updateSettings(parent(),{kind:'setSuppression',enabled:false},'legacy-test:3');
    expect(restored.settings.freeUseDate).toBe('2026-10-28');expect(restored.settings.suppressedDate).toBeNull();
    expect(restored.acknowledgedRevision).toBe(2);
  });
  it('reprojects stale source evidence in the settings transaction and rejects generation/callback races',async()=>{
    const {api,settings,db}=await setup();await api.syncDevice(identity,{...request(),summaries:[sourceDay()]});
    await settings.updateSettings(parent(),{kind:'selectCategories',paths:[['Study']],uncategorized:false},'legacy-test:4');
    expect(db.data.get(root+'/days/2026-10-28').projection.appTotalsMs).toEqual([{app:'Editor 😀',totalMs:1000}]);
    await api.syncDevice(identity,{...request(2),summaries:[sourceDay(2,2000)]});
    expect(db.data.get(root+'/days/2026-10-28').projection.selectedTotalMs).toBe(2000);
    expect(db.data.get(root+'/days/2026-10-28').source.settingsRevision).toBe(0);
    await expect(settings.updateSettings({...parent(),pairingId:parent('2').pairingId},{kind:'setDefaultLimit',ms:1},'legacy-test:5')).rejects.toThrow('Unauthorized');
    await expect(settings.updateSettings(parent(),{kind:'setDefaultLimit',ms:1},'legacy-test:6',{nonce:'stale',version:1})).rejects.toThrow('Unauthorized');
  });
});

it('emulator guard rejects zero/out-of-range ports before constructing a client',async()=>{
  const {emulatorAddress}=await import('./emulator-fixture.js');
  vi.stubEnv('METADATA_SERVER_DETECTION','none');vi.stubEnv('GCLOUD_PROJECT','demo-aw-telegram');vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS','');
  try {for(const host of ['127.0.0.1:0','localhost:65536','127.0.0.1:999999']) {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST',host);expect(()=>emulatorAddress()).toThrow();
  }} finally {vi.unstubAllEnvs();}
});

it('R5 stores category paths in Firestore maps and returns unchanged wire arrays',async()=>{
  const {settings,db,api}=await setup();
  const paths=[['Study','a/b~"\\😀'],['Other']];
  const saved=await settings.updateSettings(parent(),{kind:'selectCategories',paths,uncategorized:true},'legacy-test:7');
  expect(saved.settings.selectedPaths).toEqual(paths);
  expect(db.data.get(root+'/settings/current').selectedPaths).toEqual(paths.map(segments=>({segments})));
  expect((await api.syncDevice(identity,request())).settings.selectedPaths).toEqual(paths);
});
it('R3 reserves largest mandatory health and safe sequence width in capacity checks',async()=>{
  const {ensureReportCapacity,wireBytes}=await import('../src/contracts.js');
  const d=sourceDay(1,256);
  d.appLeafTotalsMs=Array.from({length:256},(_,i)=>({app:String(i).padStart(4,'0')+'a'.repeat(252),categoryId:'["Study"]',totalMs:1}));
  const envelope={schemaVersion:2,sequence:Number.MAX_SAFE_INTEGER,health:minimalHealth(),acks:[],summaries:[d]};
  let extra=131070-wireBytes(envelope).length;
  for(const row of d.appLeafTotalsMs) {const n=Math.min(extra,252);row.app=row.app.slice(0,4)+'é'.repeat(n)+'a'.repeat(252-n);extra-=n;}
  expect(wireBytes(envelope).length).toBe(131070);
  expect(()=>ensureReportCapacity(d)).toThrow('report_capacity_exceeded');
});
