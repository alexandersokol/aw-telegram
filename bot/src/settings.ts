/** Closed parent intents; authority always includes the current pairing generation. */
import {decodeSettings,encodeSettings} from './settingsCodec.js';
import {BoundaryError,FirestoreRepository,type ParentIdentity} from './repository.js';
import {defaultSettings,projectDay,validateContract,type Settings,type Instant,type Counter} from './contracts.js';
import {kyivDate,parseInstant,retainedDates} from './clock.js';
import {readActionSnapshot,readOperation,planCancellation} from './actions.js';
import {readAlerts,planAlerts,measurement} from './alertPlans.js';
import {advanceMilestone} from './alerts.js';
import {applyPlan} from './outbox.js';
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

  async updateSettings(identity:ParentIdentity,change:SettingsChange,operationId:string,callback?:CallbackGuard):Promise<SettingsUpdateResult> {
    const now=this.clock();parseInstant(now);
    return this.repository.db.runTransaction(async tx=>{
      if(callback) await this.repository.requireCallback(tx,identity,callback.nonce,callback.version);
      else await this.repository.requireParent(tx,identity);
      const operation=await readOperation(this.repository,tx,identity,operationId,change);
      if(operation.previous)return {...operation.previous.result,settings:decodeSettings(operation.previous.result.settings)};
      const root=this.repository.db.doc(`devices/${identity.deviceId}`);
      const settingsRef=root.collection('settings').doc('current'),syncRef=root.collection('sync').doc('current');
      const dayRef=root.collection('days').doc(kyivDate(now));
      const [old,sync,day,cancel,device]=await tx.getAll(settingsRef,syncRef,dayRef,root.collection('cancellations').doc('current'),root);
      const settings=applySettingsChange(decodeSettings(old!.data()),change,now);
      const actions=await readActionSnapshot(this.repository,tx,identity.deviceId);
      const alerts=await readAlerts(this.repository,tx,identity.deviceId,now);
      let cancellations=validateContract('cancellations',cancel!.data()??emptyCancellations());
      if(change.kind==='setFreeUse'&&change.enabled)cancellations=planCancellation(actions,cancellations,now,'free');
      const started=device!.data()!.collectionStartedAt;
      checkSettingsCapacity(settings,cancellations,now,started===null?null:new Date(started).toISOString());
      const evidence=day!.data();
      const projection=evidence?projectDay(evidence.source,settings):null;
      const alertWrites=await planAlerts(this.repository,tx,identity.deviceId,now,settings,actions.parents,alerts,measurement(evidence?{...evidence,projection}:null),{id:'settings:'+identity.pairingId+':'+operationId,text:'Налаштування змінено батьком '+identity.userId+'.',category:change.kind==='selectCategories'});
      if(change.kind==='setFreeUse'){
        const transitions=actions.policy.transitions.filter((x:any)=>retainedDates(now).includes(kyivDate(x.at)));
        if(transitions.length>=256)throw new BoundaryError('Policy transition capacity exceeded',409);
        transitions.push({at:now,freeUseDate:settings.freeUseDate,beforeFreeUseDate:decodeSettings(old!.data()).freeUseDate});
        const fences=(actions.policy.fences??[]).filter((f:any)=>retainedDates(now).includes(kyivDate(f.at)));
        if(change.enabled){
          if(fences.length>=256)throw new BoundaryError('Policy transition capacity exceeded',409);
          fences.push({at:now,throughActionSequence:0,canceledIds:cancellations.canceledIds});
        }
        tx.set(root.collection('policy').doc('current'),{transitions,fences});
      }
      const result={settings,acknowledgedRevision:sync!.data()?.settingsAckRevision??null};
      tx.set(operation.ref,{digest:operation.hash,result:{...result,settings:encodeSettings(result.settings)},at:now,expired:false});
      tx.set(root.collection('cancellations').doc('current'),cancellations);
      applyPlan(tx,alertWrites);
      tx.set(settingsRef,encodeSettings(settings));
      if(evidence) tx.set(dayRef,{...evidence,projection});
      return result;
    });
  }
  async setHourly(identity:ParentIdentity,enabled:boolean,operationId:string,callback?:CallbackGuard):Promise<void> {
    if(typeof enabled!=='boolean')throw new BoundaryError('Invalid hourly preference');const now=this.clock();
    await this.repository.db.runTransaction(async tx=>{
      const parent=callback?await this.repository.requireCallback(tx,identity,callback.nonce,callback.version):await this.repository.requireParent(tx,identity);
      const op=await readOperation(this.repository,tx,identity,operationId,{kind:'hourly',enabled});if(op.previous)return;
      const root=this.repository.db.doc(`devices/${identity.deviceId}`),day=(await tx.get(root.collection('days').doc(kyivDate(now)))).data();
      const alerts=await readAlerts(this.repository,tx,identity.deviceId,now),m=measurement(day);
      if(enabled&&!parent.hourlyEnabled)alerts.value.parents[identity.pairingId]=advanceMilestone(alerts.value.parents[identity.pairingId],m?.selectedTotalMs??null,'enable');
      tx.set(alerts.ref,alerts.value);tx.update(root.collection('parents').doc(identity.userId),{hourlyEnabled:enabled});tx.set(op.ref,{digest:op.hash,result:null,at:now,expired:false});
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
