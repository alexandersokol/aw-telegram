/** Closed parent intents; authority always includes the current pairing generation. */
import {decodeSettings,encodeSettings} from './settingsCodec.js';
import {BoundaryError,FirestoreRepository,type ParentIdentity} from './repository.js';
import {defaultSettings,projectDay,validateContract,type Settings,type Instant,type Counter} from './contracts.js';
import {kyivDate,parseInstant} from './clock.js';
import {checkSettingsCapacity,emptyCancellations} from './deviceApi.js';

export type SettingsChange = {kind:'selectCategories';paths:string[][];uncategorized:boolean} |
  {kind:'setDefaultLimit'|'setTodayLimit';ms:number} | {kind:'setFreeUse'|'setSuppression';enabled:boolean};
export interface SettingsUpdateResult {settings:Settings;acknowledgedRevision:Counter|null}
export interface CallbackGuard {nonce:string;version:number}

export function applySettingsChange(settings:Settings,change:SettingsChange,now:Instant):Settings {
  const next=structuredClone(settings),date=kyivDate(now);
  if(!change || typeof change!=='object') throw new BoundaryError('Invalid settings change');
  const keys=Object.keys(change).sort().join(',');
  switch(change.kind) {
    case 'selectCategories':
      if(keys!=='kind,paths,uncategorized') throw new BoundaryError('Invalid settings change');
      next.selectedPaths=change.paths;next.selectedUncategorized=change.uncategorized;break;
    case 'setDefaultLimit':
      if(keys!=='kind,ms') throw new BoundaryError('Invalid settings change');
      next.defaultLimitMs=change.ms;next.todayOverride=null;break;
    case 'setTodayLimit':
      if(keys!=='kind,ms') throw new BoundaryError('Invalid settings change');
      next.todayOverride={date,limitMs:change.ms};break;
    case 'setFreeUse': case 'setSuppression':
      if(keys!=='enabled,kind' || typeof change.enabled!=='boolean') throw new BoundaryError('Invalid settings change');
      next[change.kind==='setFreeUse'?'freeUseDate':'suppressedDate']=change.enabled?date:null;break;
    default: throw new BoundaryError('Invalid settings change');
  }
  if(next.revision===Number.MAX_SAFE_INTEGER) throw new BoundaryError('Settings revision exhausted',409);
  next.revision++;
  try {return validateContract('settings',next);} catch {throw new BoundaryError('Invalid settings change');}
}
export class SettingsService {
  constructor(private readonly repository:FirestoreRepository,private readonly clock:()=>Instant=()=>new Date().toISOString()) {}

  async updateSettings(identity:ParentIdentity,change:SettingsChange,callback?:CallbackGuard):Promise<SettingsUpdateResult> {
    const now=this.clock();parseInstant(now);
    return this.repository.db.runTransaction(async tx=>{
      if(callback) await this.repository.requireCallback(tx,identity,callback.nonce,callback.version);
      else await this.repository.requireParent(tx,identity);
      const root=this.repository.db.doc(`devices/${identity.deviceId}`);
      const settingsRef=root.collection('settings').doc('current'),syncRef=root.collection('sync').doc('current');
      const dayRef=root.collection('days').doc(kyivDate(now));
      const [old,sync,day,cancel,device]=await tx.getAll(settingsRef,syncRef,dayRef,root.collection('cancellations').doc('current'),root);
      const settings=applySettingsChange(decodeSettings(old!.data()),change,now);
      const cancellations=validateContract('cancellations',cancel!.data()??emptyCancellations());
      const started=device!.data()!.collectionStartedAt;
      checkSettingsCapacity(settings,cancellations,now,started===null?null:new Date(started).toISOString());
      const evidence=day!.data();
      const projection=evidence?projectDay(evidence.source,settings):null;
      tx.set(settingsRef,encodeSettings(settings));
      if(evidence) tx.set(dayRef,{...evidence,projection});
      return {settings,acknowledgedRevision:sync!.data()?.settingsAckRevision??null};
    });
  }
  async status(identity:ParentIdentity):Promise<SettingsUpdateResult> {
    return this.repository.db.runTransaction(async tx=>{
      await this.repository.requireParent(tx,identity);
      const root=this.repository.db.doc(`devices/${identity.deviceId}`);
      const [settings,sync]=await tx.getAll(root.collection('settings').doc('current'),root.collection('sync').doc('current'));
      return {settings:decodeSettings(settings!.data()),acknowledgedRevision:sync!.data()?.settingsAckRevision??null};
    });
  }
}
