/** Authenticated aggregate synchronization. No action producer, network or UI side effects. */
import {decodeSettings} from './settingsCodec.js';
import {BoundaryError,FirestoreRepository,digest,type DeviceIdentity} from './repository.js';
import {defaultSettings,projectDay,validateContract,validateActivityContext,wireBytes,MAX_BODY_BYTES,
  type Settings,type SyncRequest,type SyncResponse,type Cancellations,type Instant} from './contracts.js';
import {retainedDates,parseInstant} from './clock.js';

export function canonical(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value!==null && typeof value==='object')
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const emptyCancellations=():Cancellations=>({revision:0,throughActionSequence:0,canceledIds:[]});
export function boundedResponse(response:SyncResponse):SyncResponse {
  const validated=validateContract('sync-response',response);
  if(wireBytes(validated).length>MAX_BODY_BYTES) throw new BoundaryError('Response capacity exceeded',413);
  return validated;
}
/** Reserve receipt/sequence overhead as well as mandatory controls before a settings commit. */
export function checkSettingsCapacity(settings:Settings,cancellations:Cancellations,now:Instant,startedAt:Instant|null):void {
  boundedResponse({schemaVersion:2,requestSequence:Number.MAX_SAFE_INTEGER,serverNow:now,collectionStartedAt:startedAt,
    settings,cancellations,deliveryOffers:[],
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
  constructor(private readonly repository:FirestoreRepository,private readonly clock:()=>Instant=()=>new Date().toISOString()) {}

  async syncDevice(identity:DeviceIdentity,input:SyncRequest):Promise<SyncResponse> {
    let request:SyncRequest;
    try {request=validateContract('sync-request',input);if(wireBytes(request).length>MAX_BODY_BYTES) throw new Error();}
    catch {throw new BoundaryError('Invalid sync request');}
    const now=this.clock();parseInstant(now);
    return this.repository.db.runTransaction(async tx=>{
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
      const cancellations=validateContract('cancellations',cancelDoc!.data()??emptyCancellations());
      const startedAt=device.collectionStartedAt===null?null:new Date(device.collectionStartedAt).toISOString();
      validateActivityContext(request,startedAt,now);
      const dayDocs=await tx.get(root.collection('days'));
      const receiptRefs=request.acks.map(a=>root.collection('receipts').doc(a.id));
      const receiptDocs=receiptRefs.length?await tx.getAll(...receiptRefs):[];
      const current=syncDoc!.data()??{settingsAckRevision:null,cancellationAckRevision:0,cancellationAckFence:0,maxRequestSequence:0};
      const next={...current};
      for(let i=0;i<request.acks.length;i++) {
        const ack=request.acks[i]!,previous=receiptDocs[i]!.data();
        if(ack.kind==='action') throw new BoundaryError('Action receipt hook is not installed',409);
        if(ack.appliedAt>now) throw new BoundaryError('Invalid receipt');
        if(previous && previous.digest!==digest(canonical(ack))) throw new BoundaryError('Receipt identity conflict',409);
        if(ack.kind==='settings') {
          if(ack.revision>settings.revision) throw new BoundaryError('Unknown settings revision');
          next.settingsAckRevision=Math.max(next.settingsAckRevision??0,ack.revision);
        } else {
          if(ack.revision>cancellations.revision || ack.throughActionSequence>cancellations.throughActionSequence)
            throw new BoundaryError('Unknown cancellation fence');
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
        collectionStartedAt:startedAt,settings,cancellations,deliveryOffers:[],summaryReceipts,
        acknowledgedAckIds:request.acks.map(a=>a.id)});
      // All reads, validation and response capacity checks precede any protected write.
      for(const write of dayWrites) tx.set(write.ref,write.value);
      for(const doc of dayDocs.docs) if(!retained.includes(doc.id)) tx.delete(doc.ref);
      for(let i=0;i<request.acks.length;i++) if(!receiptDocs[i]!.exists)
        tx.set(receiptRefs[i]!,{digest:digest(canonical(request.acks[i])),receivedAt:now});
      if(live) tx.set(liveRef,live);
      if(health) tx.set(healthRef,health);
      tx.set(syncRef,next);
      return response;
    });
  }
}
