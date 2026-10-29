/** Admin-only authorization boundary. Never log request bodies, secrets or subjects. */
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import type {Firestore, Transaction, DocumentSnapshot} from 'firebase-admin/firestore';
import {defaultSettings,type Counter,type Instant} from './contracts.js';

export const KEY_LIFETIME_MS = 900000;
export const ENROLL_ATTEMPTS = 5;
export const PAIR_ATTEMPTS = 10;
export const KEY_PAGE_SIZE = 50;
export const MAX_ACTIVE_CAREGIVERS = 10;
export const MAX_POLICY_HISTORY = 256;
/** A generation covers settingsRevision up to (but excluding) the next entry's revision. */
export interface EndtimePolicyGeneration {
  generation:Counter; settingsRevision:Counter; changedAt:Instant; enabled:boolean; localTime:string;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const digest = (value: string): string => createHash('sha256').update(value,'utf8').digest('hex');
export const newSecret = (bytes: 16 | 32): string => randomBytes(bytes).toString('base64url');
export function canonicalSecret(value: unknown, bytes: 16 | 32): value is string {
  return typeof value==='string' && /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value,'base64url').length===bytes && Buffer.from(value,'base64url').toString('base64url')===value;
}
export class BoundaryError extends Error {
  constructor(message: string, public readonly status = 400, public readonly retryAfter?: number) {super(message);}
}
export const unauthorized = (): never => {throw new BoundaryError('Unauthorized',401);};
export interface DeviceIdentity {deviceId: string; credentialDigest: string}
export interface PrivateActor {userId: string; chatId: string}
export interface RecipientRef {deviceId: string; userId: string; pairingId: string}
export interface ParentIdentity extends RecipientRef {chatId: string}
export interface Parent extends ParentIdentity {name: string; joinedAt: number; revokedAt: number | null; hourlyEnabled: boolean}
export function numericId(value: unknown): string {
  if(typeof value==='number' && Number.isSafeInteger(value) && value>0) return String(value);
  if(typeof value==='string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return unauthorized();
}
export function label(value: unknown): string {
  if(typeof value!=='string' || !value.trim() || [...value].length>80 ||
    [...value].some(c=>{const n=c.codePointAt(0)!; return n>=0xd800 && n<=0xdfff;}))
    throw new BoundaryError('Invalid request');
  return value;
}
function ipSubject(value: string): string {
  let ip=value.toLowerCase(); if(ip.startsWith('::ffff:') && isIP(ip.slice(7))===4) ip=ip.slice(7);
  const family=isIP(ip); if(!family) throw new BoundaryError('Invalid request');
  return family===6 ? new URL(`http://[${ip}]/`).hostname : ip;
}
function activeDevice(snapshot: DocumentSnapshot, identity?: DeviceIdentity): Record<string, any> {
  const device=snapshot.data();
  if(!device || device.status!=='active' || typeof device.credentialDigest!=='string' ||
    (identity && device.credentialDigest!==identity.credentialDigest) || !Array.isArray(device.activeParentIds) ||
    device.activeParentIds.length>MAX_ACTIVE_CAREGIVERS || new Set(device.activeParentIds).size!==device.activeParentIds.length) unauthorized();
  return device!;
}
function actorChecked(actor: PrivateActor): void {
  if(numericId(actor.userId)!==actor.userId || numericId(actor.chatId)!==actor.chatId || actor.userId!==actor.chatId) unauthorized();
}
export class FirestoreRepository {
  constructor(readonly db: Firestore, private readonly clock: () => number = Date.now) {}

  /** Fixed-window counts commit even when subsequent key consumption is denied. */
  private async throttle(scope: 'enroll' | 'pair', subject: string, maximum: number): Promise<void> {
    const ref=this.db.doc(`throttles/${scope}-${digest(subject)}`);
    const retry=await this.db.runTransaction(async tx=>{
      const old=(await tx.get(ref)).data(), now=this.clock();
      const start=old && Number.isSafeInteger(old.windowStartedAt) && now<old.windowStartedAt+KEY_LIFETIME_MS ? old.windowStartedAt : now;
      const count=start===old?.windowStartedAt ? old?.count : 0;
      if(!Number.isSafeInteger(count) || count<0) return 900;
      if(count>=maximum) return Math.max(1,Math.ceil((start+KEY_LIFETIME_MS-now)/1000));
      tx.set(ref,{windowStartedAt:start,count:count+1,expiresAt:start+KEY_LIFETIME_MS}); return 0;
    });
    if(retry) throw new BoundaryError('Try again later',429,retry);
  }
  /** Local owner CLI only. No HTTP mint route. */
  async issueEnrollment(secret: string): Promise<void> {
    if(!canonicalSecret(secret,32)) throw new BoundaryError('Invalid request');
    await this.db.doc(`enrollments/${digest(secret)}`).create({expiresAt:this.clock()+KEY_LIFETIME_MS,consumedAt:null,deviceId:null,allowedDeviceCount:1});
  }
  async consumeEnrollment(secret: string, sourceIp: string): Promise<{schemaVersion:1;deviceId:string;deviceSecret:string}> {
    await this.throttle('enroll',ipSubject(sourceIp),ENROLL_ATTEMPTS);
    if(!canonicalSecret(secret,32)) throw new BoundaryError('Invalid enrollment');
    const deviceId=randomUUID(), deviceSecret=newSecret(32), credentialDigest=digest(deviceSecret);
    const enrollment=this.db.doc(`enrollments/${digest(secret)}`), device=this.db.doc(`devices/${deviceId}`);
    await this.db.runTransaction(async tx=>{
      const data=(await tx.get(enrollment)).data(), now=this.clock();
      if(!data || data.consumedAt!==null || data.allowedDeviceCount!==1 || !Number.isSafeInteger(data.expiresAt) || now>=data.expiresAt)
        throw new BoundaryError('Invalid enrollment');
      tx.update(enrollment,{consumedAt:now,deviceId});
      tx.create(device,{status:'active',credentialDigest,enrolledAt:now,collectionStartedAt:null,activeParentIds:[]});
      tx.create(device.collection('settings').doc('current'),defaultSettings());
    });
    return {schemaVersion:1,deviceId,deviceSecret};
  }
  async resolveDevice(credentialDigest: string): Promise<DeviceIdentity> {
    const matches=await this.db.collection('devices').where('credentialDigest','==',credentialDigest).limit(2).get();
    if(matches.size!==1) return unauthorized();
    const snapshot=matches.docs[0]!; activeDevice(snapshot);
    return {deviceId:snapshot.id,credentialDigest};
  }
  /** Later Task 5 mutations must call this again inside their own transaction. */
  async requireDevice(tx: Transaction, identity: DeviceIdentity): Promise<Record<string, any>> {
    if(!UUID.test(identity.deviceId) || !/^[0-9a-f]{64}$/.test(identity.credentialDigest)) return unauthorized();
    return activeDevice(await tx.get(this.db.doc(`devices/${identity.deviceId}`)),identity);
  }
  async createPairKey(identity: DeviceIdentity, name: string) {
    label(name); const secret=newSecret(16), accessId=randomUUID();
    const expiresAt=await this.db.runTransaction(async tx=>{
      await this.requireDevice(tx,identity); const now=this.clock();
      tx.create(this.db.doc(`pairKeys/${digest(secret)}`),{deviceId:identity.deviceId,accessId,name,expiresAt:now+KEY_LIFETIME_MS,consumedAt:null,consumedBy:null,pairingId:null,revokedAt:null});
      return now+KEY_LIFETIME_MS;
    });
    return {schemaVersion:1 as const,id:`key:${accessId}`,name,secret,expiresAt:new Date(expiresAt).toISOString()};
  }
  /** Internal scalar method: the trusted private update adapter supplies sender/chat. */
  async pairParent(secret: string, userId: string, chatId: string): Promise<Parent> {
    actorChecked({userId,chatId}); await this.throttle('pair',userId,PAIR_ATTEMPTS);
    if(!canonicalSecret(secret,16)) throw new BoundaryError('Invalid pairing');
    const pairingId=randomUUID(), keyRef=this.db.doc(`pairKeys/${digest(secret)}`), bindingRef=this.db.doc(`telegramUsers/${userId}`);
    return this.db.runTransaction(async tx=>{
      const key=(await tx.get(keyRef)).data(), now=this.clock();
      if(!key || key.consumedAt!==null || key.revokedAt!==null || !Number.isSafeInteger(key.expiresAt) || now>=key.expiresAt || !UUID.test(key.deviceId))
        throw new BoundaryError('Invalid pairing');
      const deviceRef=this.db.doc(`devices/${key.deviceId}`), parentRef=deviceRef.collection('parents').doc(userId);
      const [d,b,p]=await tx.getAll(deviceRef,bindingRef,parentRef), device=d!.data(), binding=b!.data(), previous=p!.data();
      if(!device || device.status!=='active' || !device.credentialDigest || !Array.isArray(device.activeParentIds) ||
        device.activeParentIds.length>=MAX_ACTIVE_CAREGIVERS || new Set(device.activeParentIds).size!==device.activeParentIds.length ||
        device.activeParentIds.includes(userId) || (binding && binding.revokedAt===null) || (previous && previous.revokedAt===null))
        throw new BoundaryError('Invalid pairing');
      const parent:Parent={deviceId:key.deviceId,userId,chatId,pairingId,name:key.name,joinedAt:now,revokedAt:null,hourlyEnabled:false};
      tx.update(keyRef,{consumedAt:now,consumedBy:userId,pairingId});
      tx.set(parentRef,parent); tx.set(bindingRef,{deviceId:key.deviceId,pairingId,revokedAt:null});
      tx.update(deviceRef,{activeParentIds:[...device.activeParentIds,userId],collectionStartedAt:device.collectionStartedAt??now});
      return parent;
    });
  }
  async listAccess(identity: DeviceIdentity, page?: string) {
    if(page!==undefined && !UUID.test(page)) throw new BoundaryError('Invalid request');
    return this.db.runTransaction(async tx=>{
      const device=await this.requireDevice(tx,identity);
      let query=this.db.collection('pairKeys').where('deviceId','==',identity.deviceId).where('consumedAt','==',null).orderBy('accessId').limit(KEY_PAGE_SIZE+1);
      if(page) query=query.startAfter(page);
      const keys=await tx.get(query);
      const parents=device.activeParentIds.length ? await tx.getAll(...device.activeParentIds.map((id:string)=>this.db.doc(`devices/${identity.deviceId}/parents/${numericId(id)}`))) : [];
      const now=this.clock();
      return {schemaVersion:1 as const,parents:parents.map(p=>{
        const d: any=p.data(); if(!d || d.revokedAt!==null || !UUID.test(d.pairingId)) return unauthorized();
        return {id:`parent:${p.id}:${d.pairingId}`,name:d.name,userId:p.id,status:'active'};
      }),keys:keys.docs.slice(0,KEY_PAGE_SIZE).map(k=>{
        const d=k.data(); return {id:`key:${d.accessId}`,name:d.name,expiresAt:new Date(d.expiresAt).toISOString(),status:d.revokedAt!==null?'revoked':now>=d.expiresAt?'expired':'pending'};
      }),nextPage:keys.size>KEY_PAGE_SIZE?keys.docs[KEY_PAGE_SIZE-1]!.data().accessId as string:null};
    });
  }
  async revokeAccess(identity: DeviceIdentity, accessId: string): Promise<void> {
    const parts=accessId.split(':');
    await this.db.runTransaction(async tx=>{
      const device=await this.requireDevice(tx,identity), now=this.clock();
      if(parts.length===2 && parts[0]==='key' && UUID.test(parts[1]!)) {
        const keys=await tx.get(this.db.collection('pairKeys').where('deviceId','==',identity.deviceId).where('accessId','==',parts[1]).limit(2));
        if(keys.size!==1) return;
        const key=keys.docs[0]!, data=key.data();
        if(data.deviceId===identity.deviceId && data.accessId===parts[1] && data.consumedAt===null && data.revokedAt===null) tx.update(key.ref,{revokedAt:now});
      } else if(parts.length===3 && parts[0]==='parent' && /^[1-9][0-9]{0,15}$/.test(parts[1]!) && UUID.test(parts[2]!)) {
        const userId=numericId(parts[1]), parentRef=this.db.doc(`devices/${identity.deviceId}/parents/${userId}`), bindingRef=this.db.doc(`telegramUsers/${userId}`);
        const [p,b]=await tx.getAll(parentRef,bindingRef), parent=p!.data(), binding=b!.data();
        if(!parent || parent.pairingId!==parts[2] || parent.revokedAt!==null) return;
        tx.update(parentRef,{revokedAt:now});
        if(binding?.deviceId===identity.deviceId && binding.pairingId===parts[2]) tx.update(bindingRef,{revokedAt:now});
        tx.update(this.db.doc(`devices/${identity.deviceId}`),{activeParentIds:device.activeParentIds.filter((id:string)=>id!==userId)});
        tx.delete(this.db.doc(`devices/${identity.deviceId}/sessions/${userId}`));
      }
    });
  }
  /** Owner-only recovery. A revoked device can no longer use pending keys or parents. */
  async revokeDevice(deviceId: string): Promise<void> {
    if(!UUID.test(deviceId)) throw new BoundaryError('Invalid request');
    const ref=this.db.doc(`devices/${deviceId}`);
    await this.db.runTransaction(async tx=>{if((await tx.get(ref)).exists) tx.update(ref,{status:'revoked',credentialDigest:null,revokedAt:this.clock()});});
  }
  /** Owner can recover a lost response using the original code via stdin, never bearer replay. */
  async revokeEnrollment(secret: string): Promise<void> {
    if(!canonicalSecret(secret,32)) throw new BoundaryError('Invalid request');
    const ref=this.db.doc(`enrollments/${digest(secret)}`);
    await this.db.runTransaction(async tx=>{
      const enrollment=(await tx.get(ref)).data(); if(!enrollment) return;
      const deviceRef=typeof enrollment.deviceId==='string' && UUID.test(enrollment.deviceId) ? this.db.doc(`devices/${enrollment.deviceId}`) : null;
      const device=deviceRef ? await tx.get(deviceRef) : null;
      const now=this.clock(); tx.update(ref,{expiresAt:now,revokedAt:now});
      if(device?.exists) tx.update(deviceRef!,{status:'revoked',credentialDigest:null,revokedAt:now});
    });
  }
  async authorizeParent(actor: PrivateActor): Promise<ParentIdentity> {
    actorChecked(actor);
    return this.db.runTransaction(async tx=>{
      const binding=(await tx.get(this.db.doc(`telegramUsers/${actor.userId}`))).data();
      if(!binding) return unauthorized();
      const identity={...actor,deviceId:binding.deviceId,pairingId:binding.pairingId};
      await this.requireParent(tx,identity); return identity;
    });
  }
  /** Call before protected reads/writes in the same transaction, including callbacks. */
  async requireParent(tx: Transaction, identity: ParentIdentity): Promise<Parent> {
    actorChecked(identity);
    if(!UUID.test(identity.deviceId) || !UUID.test(identity.pairingId)) return unauthorized();
    const [d,b,p]=await tx.getAll(this.db.doc(`devices/${identity.deviceId}`),this.db.doc(`telegramUsers/${identity.userId}`),this.db.doc(`devices/${identity.deviceId}/parents/${identity.userId}`));
    const device=activeDevice(d!), binding=b!.data(), parent=p!.data();
    if(!device.activeParentIds.includes(identity.userId) || !binding || binding.revokedAt!==null || binding.deviceId!==identity.deviceId ||
      binding.pairingId!==identity.pairingId || !parent || parent.revokedAt!==null || parent.chatId!==identity.chatId || parent.pairingId!==identity.pairingId) return unauthorized();
    return parent as Parent;
  }
  async requireCallback(tx: Transaction, identity: ParentIdentity, nonce: string, version: number): Promise<Parent> {
    const parent=await this.requireParent(tx,identity);
    const session=(await tx.get(this.db.doc(`devices/${identity.deviceId}/sessions/${identity.userId}`))).data();
    if(!session || typeof nonce!=='string' || !nonce || !Number.isSafeInteger(version) || version<0 ||
      session.pairingId!==identity.pairingId || session.chatId!==identity.chatId || session.nonce!==nonce || session.version!==version ||
      !Number.isSafeInteger(session.expiresAt) || this.clock()>=session.expiresAt) return unauthorized();
    return parent;
  }
  async authorizeCallback(actor: PrivateActor, nonce: string, version: number): Promise<ParentIdentity> {
    actorChecked(actor);
    return this.db.runTransaction(async tx=>{
      const b=(await tx.get(this.db.doc(`telegramUsers/${actor.userId}`))).data(); if(!b) return unauthorized();
      const identity={...actor,deviceId:b.deviceId,pairingId:b.pairingId};
      await this.requireCallback(tx,identity,nonce,version); return identity;
    });
  }
  /** Resolve actual current chat immediately before each send/retry, after lease. No send implementation here. */
  async authorizeRecipient(ref: RecipientRef): Promise<Parent> {
    return this.db.runTransaction(tx=>this.requireParent(tx,{...ref,chatId:ref.userId}));
  }
}
