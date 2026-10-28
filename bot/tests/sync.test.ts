import {describe,it,expect,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {FirestoreRepository} from '../src/repository.js';
import {defaultSettings,validateContract,minimalHealth} from '../src/contracts.js';

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
class MemoryDb {
  data=new Map<string,any>(); private tail=Promise.resolve();
  doc(path:string):any {return {path,id:path.split('/').at(-1),collection:(name:string)=>this.collection(path+'/'+name)};}
  collection(path:string):any {return {path,doc:(name:string)=>this.doc(path+'/'+name),query:true};}
  async runTransaction<T>(body:(tx:any)=>Promise<T>):Promise<T> {
    let release!:()=>void; const prior=this.tail; this.tail=new Promise<void>(r=>{release=r;}); await prior;
    const next=structuredClone(this.data); let wrote=false;
    const snap=(path:string)=>({id:path.split('/').at(-1),ref:this.doc(path),exists:next.has(path),data:()=>structuredClone(next.get(path))});
    const tx:any={get:async(ref:any)=>{
      if(wrote) throw new Error('read after write');
      return ref.query?{docs:[...next.keys()].filter(k=>k.startsWith(ref.path+'/')&&!k.slice(ref.path.length+1).includes('/')).map(snap)}:snap(ref.path);
    },getAll:async(...refs:any[])=>{if(wrote)throw new Error('read after write');return refs.map(r=>snap(r.path));},
      set:(ref:any,value:any)=>{wrote=true;next.set(ref.path,structuredClone(value));},
      update:(ref:any,value:any)=>{wrote=true;next.set(ref.path,{...next.get(ref.path),...structuredClone(value)});},
      delete:(ref:any)=>{wrote=true;next.delete(ref.path);}};
    try {const result=await body(tx);this.data=next;return result;} finally {release();}
  }
}
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
  it('serializes opposite parent intents, preserves unrelated fields and reports pending until device Ack',async()=>{
    const {api,settings,db}=await setup();
    const result=await Promise.all([settings.updateSettings(parent(),{kind:'setFreeUse',enabled:true}),settings.updateSettings(parent('2'),{kind:'setSuppression',enabled:true})]);
    expect(result.map(x=>x.settings.revision)).toEqual([1,2]);
    expect(result[1]?.acknowledgedRevision).toBeNull();
    const current=db.data.get(root+'/settings/current');expect(current.freeUseDate).toBe('2026-10-28');expect(current.suppressedDate).toBe('2026-10-28');
    await api.syncDevice(identity,{...request(),acks:[{id:'00000000-0000-4000-8000-000000000088',kind:'settings',revision:2,appliedAt:NOW}]});
    expect((await settings.status(parent())).acknowledgedRevision).toBe(2);
    const restored=await settings.updateSettings(parent(),{kind:'setSuppression',enabled:false});
    expect(restored.settings.freeUseDate).toBe('2026-10-28');expect(restored.settings.suppressedDate).toBeNull();
    expect(restored.acknowledgedRevision).toBe(2);
  });
  it('reprojects stale source evidence in the settings transaction and rejects generation/callback races',async()=>{
    const {api,settings,db}=await setup();await api.syncDevice(identity,{...request(),summaries:[sourceDay()]});
    await settings.updateSettings(parent(),{kind:'selectCategories',paths:[['Study']],uncategorized:false});
    expect(db.data.get(root+'/days/2026-10-28').projection.appTotalsMs).toEqual([{app:'Editor 😀',totalMs:1000}]);
    await api.syncDevice(identity,{...request(2),summaries:[sourceDay(2,2000)]});
    expect(db.data.get(root+'/days/2026-10-28').projection.selectedTotalMs).toBe(2000);
    expect(db.data.get(root+'/days/2026-10-28').source.settingsRevision).toBe(0);
    await expect(settings.updateSettings({...parent(),pairingId:parent('2').pairingId},{kind:'setDefaultLimit',ms:1})).rejects.toThrow('Unauthorized');
    await expect(settings.updateSettings(parent(),{kind:'setDefaultLimit',ms:1},{nonce:'stale',version:1})).rejects.toThrow('Unauthorized');
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
  const saved=await settings.updateSettings(parent(),{kind:'selectCategories',paths,uncategorized:true});
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
