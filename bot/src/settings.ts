/** Closed parent intents; authority always includes the current pairing generation. */
import {decodeSettings,encodeSettings,needsSettingsMigration} from './settingsCodec.js';
import {BoundaryError,FirestoreRepository,MAX_POLICY_HISTORY,type EndtimePolicyGeneration,type ParentIdentity} from './repository.js';
import {defaultSettings,projectDay,validateContract,type Settings,type Instant,type Counter} from './contracts.js';
import {kyivDate,parseInstant,retainedDates,retentionStart} from './clock.js';
import {readActionSnapshot,readOperation,planCancellation} from './actions.js';
import {readAlerts,planAlerts,measurement} from './alertPlans.js';
import {advanceMilestone} from './alerts.js';
import {applyPlan} from './outbox.js';
import {planEndtimeSuppression} from './endtime.js';
import {canonical,checkSettingsCapacity,emptyCancellations} from './deviceApi.js';

export type SettingsChange = {kind:'selectCategories';paths:string[][];uncategorized:boolean} |
  {kind:'setDefaultLimit'|'setTodayLimit';ms:number} | {kind:'setFreeUse'|'setSuppression'|'setEndtimeEnabled';enabled:boolean} |
  {kind:'setEndtime';localTime:string};
/** changed is false for an effective no-op; status reads omit it. */
export interface SettingsUpdateResult {settings:Settings;acknowledgedRevision:Counter|null;changed?:boolean}
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
    case 'setEndtime':
      if(keys!=='kind,localTime') throw new BoundaryError('Invalid settings change');
      next.endtimeLocalTime=change.localTime;next.endtimeEnabled=true;break;
    case 'setEndtimeEnabled':
      if(keys!=='enabled,kind' || typeof change.enabled!=='boolean') throw new BoundaryError('Invalid settings change');
      next.endtimeEnabled=change.enabled;break;
    default: throw new BoundaryError('Invalid settings change');
  }
  try {validateContract('settings',next);} catch {throw new BoundaryError('Invalid settings change');}
  if(canonical(next)===canonical(settings))return next;
  if(next.revision===Number.MAX_SAFE_INTEGER) throw new BoundaryError('Settings revision exhausted',409);
  next.revision++;
  if(next.endtimeEnabled!==settings.endtimeEnabled || next.endtimeLocalTime!==settings.endtimeLocalTime){
    if(next.endtimeGeneration===Number.MAX_SAFE_INTEGER) throw new BoundaryError('Endtime generation exhausted',409);
    next.endtimeGeneration++;
  }
  return next;
}

function retainedGenerations(history:EndtimePolicyGeneration[],now:Instant):EndtimePolicyGeneration[] {
  const start=retentionStart(now);
  // The last policy before the window may still govern any retained date.
  const baseline=history.filter(entry=>entry.changedAt<start).at(-1);
  return history.filter(entry=>entry===baseline || entry.changedAt>=start);
}
const endtimeSummary=(change:SettingsChange,settings:Settings):string=>change.kind==='setEndtime'||change.kind==='setEndtimeEnabled'?
  ` Час завершення: ${settings.endtimeEnabled?'увімкнено':'вимкнено'}, ${settings.endtimeLocalTime}.`:'';
export class SettingsService {
  constructor(private readonly repository:FirestoreRepository,private readonly clock:()=>Instant=()=>new Date().toISOString()) {}

  async updateSettings(identity:ParentIdentity,change:SettingsChange,operationId:string,callback?:CallbackGuard):Promise<SettingsUpdateResult> {
    const now=this.clock();parseInstant(now);
    return this.repository.db.runTransaction(async tx=>{
      if(callback) await this.repository.requireCallback(tx,identity,callback.nonce,callback.version);
      else await this.repository.requireParent(tx,identity);
      const operation=await readOperation(this.repository,tx,identity,operationId,change);
      if(operation.previous){
        const result={...operation.previous.result,settings:decodeSettings(operation.previous.result.settings)};
        if(needsSettingsMigration(operation.previous.result.settings))
          tx.set(operation.ref,{...operation.previous,result:{...result,settings:encodeSettings(result.settings)}});
        return result;
      }
      const root=this.repository.db.doc(`devices/${identity.deviceId}`);
      const settingsRef=root.collection('settings').doc('current'),syncRef=root.collection('sync').doc('current');
      const dayRef=root.collection('days').doc(kyivDate(now));
      const [old,sync,day,cancel,device]=await tx.getAll(settingsRef,syncRef,dayRef,root.collection('cancellations').doc('current'),root);
      const previous=decodeSettings(old!.data()),settings=applySettingsChange(previous,change,now);
      const result={settings,acknowledgedRevision:sync!.data()?.settingsAckRevision??null,changed:settings.revision!==previous.revision};
      if(settings.revision===previous.revision){
        // Reserve the intent ID, but do not repeat cancellations, alerts or policy transitions.
        tx.set(operation.ref,{digest:operation.hash,result:{...result,settings:encodeSettings(settings)},at:now,expired:false});
        if(needsSettingsMigration(old!.data()))tx.set(settingsRef,encodeSettings(settings));
        return result;
      }
      const actions=await readActionSnapshot(this.repository,tx,identity.deviceId);
      const alerts=await readAlerts(this.repository,tx,identity.deviceId,now);
      let policy=actions.policy;
      if(settings.endtimeGeneration!==previous.endtimeGeneration){
        const history=retainedGenerations(policy.endtimeGenerations??[],now);
        if(history.length>=MAX_POLICY_HISTORY)throw new BoundaryError('Policy transition capacity exceeded',409);
        const entry:EndtimePolicyGeneration={generation:settings.endtimeGeneration,settingsRevision:settings.revision,
          changedAt:now,enabled:settings.endtimeEnabled,localTime:settings.endtimeLocalTime};
        policy={...policy,endtimeGenerations:[...history,entry]};
      }
      let cancellations=validateContract('cancellations',cancel!.data()??emptyCancellations());
      if(change.kind==='setFreeUse'&&change.enabled)cancellations=planCancellation(actions,cancellations,now,'free');
      const started=device!.data()!.collectionStartedAt;
      checkSettingsCapacity(settings,cancellations,now,started===null?null:new Date(started).toISOString());
      const evidence=day!.data();
      const projection=evidence?projectDay(evidence.source,settings):null;
      const alertWrites=await planAlerts(this.repository,tx,identity.deviceId,now,settings,actions.parents,alerts,measurement(evidence?{...evidence,projection}:null),{id:'settings:'+identity.pairingId+':'+operationId,text:'Налаштування змінено батьком '+identity.userId+'.'+endtimeSummary(change,settings),category:change.kind==='selectCategories',issuerPairingId:identity.pairingId});
      const suppressionWrites=(change.kind==='setFreeUse'||change.kind==='setSuppression')&&change.enabled?
        await planEndtimeSuppression(this.repository,tx,identity.deviceId,kyivDate(now)):[];
      if(change.kind==='setFreeUse'){
        const transitions=(policy.transitions??[]).filter((x:any)=>retainedDates(now).includes(kyivDate(x.at)));
        if(transitions.length>=MAX_POLICY_HISTORY)throw new BoundaryError('Policy transition capacity exceeded',409);
        transitions.push({at:now,freeUseDate:settings.freeUseDate,beforeFreeUseDate:previous.freeUseDate});
        const fences=(policy.fences??[]).filter((f:any)=>retainedDates(now).includes(kyivDate(f.at)));
        if(change.enabled){
          if(fences.length>=MAX_POLICY_HISTORY)throw new BoundaryError('Policy transition capacity exceeded',409);
          fences.push({at:now,throughActionSequence:0,canceledIds:cancellations.canceledIds});
        }
        policy={...policy,transitions,fences};
      }
      if(policy!==actions.policy)tx.set(root.collection('policy').doc('current'),policy);
      tx.set(operation.ref,{digest:operation.hash,result:{...result,settings:encodeSettings(result.settings)},at:now,expired:false});
      tx.set(root.collection('cancellations').doc('current'),cancellations);
      applyPlan(tx,[...alertWrites,...suppressionWrites]);
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
      const decoded=decodeSettings(settings!.data());
      if(needsSettingsMigration(settings!.data()))tx.set(settings!.ref,encodeSettings(decoded));
      return {settings:decoded,acknowledgedRevision:sync!.data()?.settingsAckRevision??null};
    });
  }
}
