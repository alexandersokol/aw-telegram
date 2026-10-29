/** Authenticated aggregate synchronization. No action producer, network or UI side effects. */
import {decodeSettings,encodeSettings,needsSettingsMigration} from './settingsCodec.js';
import {BoundaryError,FirestoreRepository,MAX_ACTIVE_CAREGIVERS,digest,type DeviceIdentity} from './repository.js';
import {defaultSettings,projectDay,validateContract,validateActivityContext,wireBytes,MAX_BODY_BYTES,
  type Settings,type SyncRequest,type SyncResponse,type Cancellations,type Instant,type EndtimeAck} from './contracts.js';
import {applyPlan,type PlannedWrite} from './outbox.js';
import {readActionSnapshot,planActionSync} from './actions.js';
import {readAlerts,planAlerts,measurement} from './alertPlans.js';
import {retainedDates,parseInstant} from './clock.js';
import {planEndtimeAck} from './endtime.js';

export function canonical(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value!==null && typeof value==='object')
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
/** One ten-caregiver receipt plans 21 writes, so at most 220 of the 450-write transaction. */
const ENDTIME_WRITE_BUDGET=200;
export const emptyCancellations=():Cancellations=>({revision:0,throughActionSequence:0,canceledIds:[]});
export function boundedResponse(response:SyncResponse):SyncResponse {
  const validated=validateContract('sync-response',response);
  if(wireBytes(validated).length>MAX_BODY_BYTES) throw new BoundaryError('Response capacity exceeded',413);
  return validated;
}
/** Reserve receipt/sequence overhead as well as mandatory controls before a settings commit. */
export function checkSettingsCapacity(settings:Settings,cancellations:Cancellations,now:Instant,startedAt:Instant|null):void {
  boundedResponse({schemaVersion:2,requestSequence:Number.MAX_SAFE_INTEGER,serverNow:now,collectionStartedAt:startedAt,
    activeCaregivers:MAX_ACTIVE_CAREGIVERS,settings,cancellations,deliveryOffers:[],
    acknowledgedAckIds:Array.from({length:100},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),
    summaryReceipts:retainedDates(now).map(date=>({date,sequence:Number.MAX_SAFE_INTEGER}))});
}
function observedUpdate(previous:any,value:{observedAt:Instant},sequence:number):any|null {
  if(previous && sequence<=previous.sequence) return null;
  if(previous && value.observedAt<previous.value.observedAt) return null;
  if(previous && value.observedAt===previous.value.observedAt && canonical(value)!==canonical(previous.value))
    throw new BoundaryError('Observation conflict',409);
  return {sequence,value};
}

export class DeviceApi {
  constructor(private readonly repository:FirestoreRepository,private readonly clock:()=>Instant=()=>new Date().toISOString(),private readonly repair?:()=>Promise<void>) {}

  async syncDevice(identity:DeviceIdentity,input:SyncRequest):Promise<SyncResponse> {
    let request:SyncRequest;
    try {request=validateContract('sync-request',input);if(wireBytes(request).length>MAX_BODY_BYTES) throw new Error();}
    catch {throw new BoundaryError('Invalid sync request');}
    const now=this.clock();parseInstant(now);
    const committed=await this.repository.db.runTransaction(async tx=>{
      // Authorization resolved by the router is rechecked against the same mutation snapshot.
      const device=await this.repository.requireDevice(tx,identity);
      const root=this.repository.db.doc(`devices/${identity.deviceId}`);
      const settingsRef=root.collection('settings').doc('current');
      const cancellationRef=root.collection('cancellations').doc('current');
      const syncRef=root.collection('sync').doc('current');
      const liveRef=root.collection('live').doc('current');
      const healthRef=root.collection('health').doc('current');
      const [settingsDoc,cancelDoc,syncDoc,liveDoc,healthDoc]=await tx.getAll(settingsRef,cancellationRef,syncRef,liveRef,healthRef);
      const settings=decodeSettings(settingsDoc!.data());
      const migrateSettings=needsSettingsMigration(settingsDoc!.data());
      const cancellations=validateContract('cancellations',cancelDoc!.data()??emptyCancellations());
      const startedAt=device.collectionStartedAt===null?null:new Date(device.collectionStartedAt).toISOString();
      validateActivityContext(request,startedAt,now);
      const dayDocs=await tx.get(root.collection('days'));
      const receiptRefs=request.acks.map(a=>root.collection('receipts').doc(a.id));
      const receiptDocs=receiptRefs.length?await tx.getAll(...receiptRefs):[];
      const current=syncDoc!.data()??{settingsAckRevision:null,cancellationAckRevision:0,cancellationAckFence:0,maxRequestSequence:0};
      const next={...current};
      const actions=await readActionSnapshot(this.repository,tx,identity.deviceId,request.acks.filter(a=>a.kind==='action').map(a=>a.actionId));
      const alertSnapshot=await readAlerts(this.repository,tx,identity.deviceId,now);
      const endtimeAcks:EndtimeAck[]=[];
      for(let i=0;i<request.acks.length;i++) {
        const ack=request.acks[i]!,previous=receiptDocs[i]!.data();
        if(previous && previous.digest!==digest(canonical(ack))) throw new BoundaryError('Receipt identity conflict',409);
        if(ack.kind==='action') continue;
        if(ack.kind==='endtime') {
          // An already stored receipt was planned (or suppressed) when it was first accepted.
          if(!previous)endtimeAcks.push(ack);
          continue;
        }
        if(ack.appliedAt>now) throw new BoundaryError('Invalid receipt');
        if(previous && previous.digest!==digest(canonical(ack))) throw new BoundaryError('Receipt identity conflict',409);
        if(ack.kind==='settings') {
          if(ack.revision>settings.revision) throw new BoundaryError('Unknown settings revision');
          next.settingsAckRevision=Math.max(next.settingsAckRevision??0,ack.revision);
        } else {
          if(ack.revision>cancellations.revision || ack.throughActionSequence>cancellations.throughActionSequence)
            throw new BoundaryError('Unknown cancellation fence');
          if(ack.revision===cancellations.revision&&ack.throughActionSequence!==cancellations.throughActionSequence)
            throw new BoundaryError('Cancellation receipt must acknowledge the complete fence');
          next.cancellationAckRevision=Math.max(next.cancellationAckRevision,ack.revision);
          next.cancellationAckFence=Math.max(next.cancellationAckFence,ack.throughActionSequence);
        }
      }
      const retained=retainedDates(now);
      const oldDays=new Map(dayDocs.docs.map(doc=>[doc.id,doc]));
      const dayWrites:{ref:any;value:any}[]=[];
      const summaryReceipts:SyncResponse['summaryReceipts']=[];
      for(const source of request.summaries??[]) {
        if(source.sequence===0 || source.settingsRevision>settings.revision) throw new BoundaryError('Invalid source revision');
        const projection=projectDay(source,settings),previous=oldDays.get(source.date)?.data();
        const sourceDigest=digest(canonical(source));
        if(previous && source.sequence===previous.sequence && sourceDigest!==previous.digest)
          throw new BoundaryError('Summary sequence conflict',409);
        const sequence=Math.max(previous?.sequence??0,source.sequence);
        summaryReceipts.push({date:source.date,sequence});
        if(!previous || source.sequence>previous.sequence)
          dayWrites.push({ref:root.collection('days').doc(source.date),value:{source,digest:sourceDigest,sequence,projection,serverReceivedAt:now}});
      }
      const live=request.live===undefined?null:observedUpdate(liveDoc!.data(),request.live,request.sequence);
      const health=observedUpdate(healthDoc!.data(),request.health,request.sequence);
      if(request.sequence>next.maxRequestSequence) {
        next.maxRequestSequence=request.sequence;next.serverReceivedAt=now;
      }
      const response=boundedResponse({schemaVersion:2,requestSequence:request.sequence,serverNow:now,
        collectionStartedAt:startedAt,activeCaregivers:device.activeParentIds.length,settings,cancellations,deliveryOffers:[],summaryReceipts,
        acknowledgedAckIds:request.acks.map(a=>a.id)});
      const changedToday=dayWrites.find(w=>w.value.source.date===retained[0])?.value;
      const alertWrites=changedToday?await planAlerts(this.repository,tx,identity.deviceId,now,settings,actions.parents,alertSnapshot,measurement(changedToday)):[];
      // Event identity covers device/date/generation; identical rows planned twice in one request collapse.
      // Receipts past the budget stay unacknowledged; the companion retains and resends them.
      const endtimeWrites=new Map<string,PlannedWrite>(),deferred=new Set<string>();
      for(const ack of endtimeAcks) {
        if(endtimeWrites.size>=ENDTIME_WRITE_BUDGET){deferred.add(ack.id);continue;}
        for(const write of await planEndtimeAck(this.repository,tx,identity.deviceId,ack,actions.policy,actions.parents,settings,now))
          endtimeWrites.set(write.ref.path,write);
      }
      let actionAcks=request.acks.filter(a=>a.kind==='action'),selectedAcks=request.acks.filter(a=>!deferred.has(a.id));
      let mandatoryWrites:number,actionWrites:PlannedWrite[];
      for(;;){
        const selectedIds=new Set(selectedAcks.map(a=>a.id));
        const newReceipts=receiptDocs.filter((doc,i)=>!doc.exists&&selectedIds.has(request.acks[i]!.id)).length;
        mandatoryWrites=dayWrites.length+newReceipts+(live?1:0)+(health?1:0)+1+alertWrites.length+endtimeWrites.size+(migrateSettings?1:0);
        response.acknowledgedAckIds=selectedAcks.map(a=>a.id);response.deliveryOffers=[];
        try{
          actionWrites=await planActionSync(this.repository,tx,actions,actionAcks,settings,cancellations,now,response,450-mandatoryWrites);
          break;
        }catch(error){
          if(!(error instanceof BoundaryError)||error.message!=='Sync transaction capacity exceeded'||actionAcks.length<=1)throw error;
          // Planning has no writes. Keep a prefix of action evidence; control receipts are cheap
          // and still applied. The companion retains every ID omitted from this response.
          actionAcks=actionAcks.slice(0,Math.ceil(actionAcks.length/2));
          const retainedIds=new Set(actionAcks.map(a=>a.id));
          selectedAcks=request.acks.filter(a=>!deferred.has(a.id)&&(a.kind!=='action'||retainedIds.has(a.id)));
        }
      }
      boundedResponse(response);
      // Physical cleanup is optional; it cannot displace controls, accepted receipts or source writes.
      const cleanup=dayDocs.docs.filter(doc=>!retained.includes(doc.id)).slice(0,Math.max(0,450-mandatoryWrites-actionWrites.length));
      // All reads, validation and response capacity checks precede any protected write.
      if(migrateSettings)tx.set(settingsRef,encodeSettings(settings));
      applyPlan(tx,[...actionWrites,...alertWrites,...endtimeWrites.values()]);
      for(const write of dayWrites) tx.set(write.ref,write.value);
      for(const doc of cleanup) tx.delete(doc.ref);
      const acknowledgedIds=new Set(response.acknowledgedAckIds);
      for(let i=0;i<request.acks.length;i++) if(!receiptDocs[i]!.exists&&acknowledgedIds.has(request.acks[i]!.id))
        tx.set(receiptRefs[i]!,{digest:digest(canonical(request.acks[i])),receivedAt:now});
      if(live) tx.set(liveRef,live);
      if(health) tx.set(healthRef,health);
      tx.set(syncRef,next);
      return response;
    });
    // Domain changes have committed; queue failures remain repairable on the next sync or sweep.
    if(this.repair)try{await this.repair();}catch{/* Deliberately omit provider details. */}
    return committed;
  }
}
