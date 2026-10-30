import {beforeAll, beforeEach, afterAll, expect, test} from 'vitest';
import {randomBytes} from 'node:crypto';
import {fixtureDb, resetFixture} from './emulator-fixture.js';
const db = fixtureDb(); let Repository: any, digest: any, privateActor: any, pairPrivateUpdate: any;
let now = 1800000000000, repo: any, device: any;
const modulePath = '../src/repository.js', pairingPath = '../src/pairing.js';
beforeAll(async () => {
  const m = await import(modulePath).catch(() => ({}));
  expect(m.FirestoreRepository,'Task 4 repository must exist').toBeTypeOf('function'); Repository=m.FirestoreRepository; digest=m.digest;
  ({privateActor,pairPrivateUpdate}=await import(pairingPath));
});
beforeEach(async () => {
  await resetFixture(); now=1800000000000; repo=new Repository(db,()=>now);
  const code=randomBytes(32).toString('base64url'); await repo.issueEnrollment(code);
  const wire=await repo.consumeEnrollment(code,'127.0.0.1'); device={deviceId:wire.deviceId,credentialDigest:digest(wire.deviceSecret)};
});
afterAll(async()=>{await db.terminate();});
const actor = (id:string) => ({userId:id,chatId:id});
const key = (name='Мама') => repo.createPairKey(device,name);
async function pair(id:string) {return repo.pairParent((await key()).secret,id,id);}
test('keys expire exactly at 15 minutes, generic failures preserve key',async()=>{
  const k=await key(); now+=900000;
  for(const s of [k.secret,'bad']) await expect(repo.pairParent(s,'101','101')).rejects.toThrow('Invalid pairing');
  expect((await db.collection('pairKeys').get()).docs[0]!.data().consumedAt).toBeNull();
});
test('one key concurrent consumption has one winner, numeric identities persist',async()=>{
  const k=await key(); now+=899999;
  const result=await Promise.allSettled([repo.pairParent(k.secret,'101','101'),repo.pairParent(k.secret,'102','102')]);
  expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const d=(await db.doc(`devices/${device.deviceId}`).get()).data()!;
  expect(d.activeParentIds).toHaveLength(1); expect(d.collectionStartedAt).toBe(now);
  const parent=(await db.collection(`devices/${device.deviceId}/parents`).get()).docs[0]!.data();
  expect(parent.userId).toMatch(/^10[12]$/); expect(parent.hourlyEnabled).toBe(false);
});
test('eleven keys racing admit ten caregivers and leave the rejected key reusable after revocation',async()=>{
  const keys=await Promise.all(Array.from({length:11},()=>key()));
  const results=await Promise.allSettled(keys.map((k,i)=>repo.pairParent(k.secret,String(101+i),String(101+i))));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(10);
  expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
  const rejected=results.findIndex(x=>x.status==='rejected'),winner=results.find(x=>x.status==='fulfilled');
  expect((results[rejected] as PromiseRejectedResult).reason.message).toBe('Invalid pairing');
  expect((await db.doc(`devices/${device.deviceId}`).get()).data()?.activeParentIds).toHaveLength(10);
  expect((await db.collection('pairKeys').get()).docs.filter(x=>x.data().consumedAt===null)).toHaveLength(1);
  expect((await db.doc(`pairKeys/${digest(keys[rejected].secret)}`).get()).data()?.consumedAt).toBeNull();
  expect((await repo.listAccess(device)).parents).toHaveLength(10);
  const parent=(winner as PromiseFulfilledResult<any>).value;
  await repo.revokeAccess(device,`parent:${parent.userId}:${parent.pairingId}`);
  const userId=String(101+rejected),replacement=await repo.pairParent(keys[rejected].secret,userId,userId);
  expect((await db.doc(`pairKeys/${digest(keys[rejected].secret)}`).get()).data()?.pairingId).toBe(replacement.pairingId);
  expect((await repo.listAccess(device)).parents).toHaveLength(10);
});
test('same sender racing two keys has one binding and leaves one key unused',async()=>{
  const keys=await Promise.all([key(),key()]);
  const results=await Promise.allSettled(keys.map(k=>repo.pairParent(k.secret,'101','101')));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((await db.doc(`devices/${device.deviceId}`).get()).data()?.activeParentIds).toEqual(['101']);
});
test('private update adapter rejects unsupported or forged provenance before database use',async()=>{
  const good={message:{from:{id:101,is_bot:false},chat:{id:101,type:'private'}}};
  expect(privateActor(good)).toEqual(actor('101'));
  for(const update of [
    {message:{from:{id:101},chat:{id:-1,type:'group'}}}, {channel_post:good.message},
    {business_message:good.message}, {inline_query:{from:{id:101}}},
    {message:{...good.message,forward_origin:{type:'user'}}},
    {message:{...good.message,sender_chat:{id:101}}},
    {message:{from:{id:9007199254740992},chat:{id:101,type:'private'}}},
    {message:{from:{id:'0101'},chat:{id:'0101',type:'private'}}},
    {message:{from:{id:101,is_bot:true},chat:{id:101,type:'private'}}},
    {message:{from:{id:101},chat:{id:102,type:'private'}}},
  ]) {
    expect(()=>privateActor(update)).toThrow('Unauthorized');
    await expect(pairPrivateUpdate(repo,'bad',update)).rejects.toThrow('Unauthorized');
  }
  expect((await db.collection('throttles').get()).size).toBe(1); // enrollment only
});
test('pairing throttle persists across instances; invalid/used/expired keys share failure',async()=>{
  const other=new Repository(db,()=>now), k=await key(); await repo.pairParent(k.secret,'101','101');
  const expired=await key(); now+=900000;
  for(const value of [k.secret,expired.secret,'bad']) await expect(repo.pairParent(value,'102','102')).rejects.toMatchObject({message:'Invalid pairing',status:400});
  const attempts=await Promise.allSettled(Array.from({length:9},(_,i)=>(i%2?repo:other).pairParent('bad','102','102')));
  expect(attempts.filter((x:any)=>x.reason?.status===429)).toHaveLength(2);
  now+=900000; await expect(other.pairParent('bad','102','102')).rejects.toMatchObject({status:400});
});
test('revocation kills sessions, callbacks and queued recipients; re-pair cannot revive stale references',async()=>{
  const p=await pair('101'), started=(await db.doc(`devices/${device.deviceId}`).get()).data()?.collectionStartedAt;
  const ref={deviceId:device.deviceId,userId:'101',pairingId:p.pairingId};
  const session={...ref,chatId:'101',nonce:'opaque',version:1,expiresAt:now+60000};
  await db.doc(`devices/${device.deviceId}/sessions/101`).set(session);
  expect((await repo.authorizeParent(actor('101'))).pairingId).toBe(p.pairingId);
  expect((await repo.authorizeCallback(actor('101'),'opaque',1)).deviceId).toBe(device.deviceId);
  let sends=0; const deliver=async()=>{await repo.authorizeRecipient(ref); sends++;}; await deliver();
  await repo.revokeAccess(device,`parent:101:${p.pairingId}`);
  expect((await db.doc(`devices/${device.deviceId}/sessions/101`).get()).exists).toBe(false);
  await expect(repo.authorizeParent(actor('101'))).rejects.toThrow('Unauthorized');
  await expect(deliver()).rejects.toThrow('Unauthorized'); expect(sends).toBe(1);
  const replacement=await pair('101'); expect(replacement.pairingId).not.toBe(p.pairingId);
  await db.doc(`devices/${device.deviceId}/sessions/101`).set(session); // delayed old writer cannot revive generation
  await expect(repo.authorizeCallback(actor('101'),'opaque',1)).rejects.toThrow('Unauthorized');
  await expect(deliver()).rejects.toThrow('Unauthorized');
  await repo.revokeAccess(device,`parent:101:${p.pairingId}`);
  expect((await repo.authorizeParent(actor('101'))).pairingId).toBe(replacement.pairingId);
  expect((await db.doc(`devices/${device.deviceId}`).get()).data()?.collectionStartedAt).toBe(started);
});
test('callback guard rereads revocation inside protected mutation transaction',async()=>{
  const p=await pair('101');
  await db.doc(`devices/${device.deviceId}/sessions/101`).set({pairingId:p.pairingId,chatId:'101',nonce:'n',version:2,expiresAt:now+1000});
  const resolved=await repo.authorizeParent(actor('101')); await repo.revokeAccess(device,`parent:101:${p.pairingId}`);
  await expect(db.runTransaction(async tx=>{await repo.requireParent(tx,resolved); tx.set(db.doc(`devices/${device.deviceId}/settings/protected`),{changed:true});})).rejects.toThrow('Unauthorized');
  expect((await db.doc(`devices/${device.deviceId}/settings/protected`).get()).exists).toBe(false);
});
test('foreign chats/devices and expired or version-mismatched callbacks fail',async()=>{
  const p=await pair('101'); await expect(repo.authorizeParent({userId:'101',chatId:'102'})).rejects.toThrow('Unauthorized');
  await expect(repo.authorizeRecipient({deviceId:'foreign',userId:'101',pairingId:p.pairingId})).rejects.toThrow('Unauthorized');
  await db.doc(`devices/${device.deviceId}/sessions/101`).set({pairingId:p.pairingId,chatId:'101',nonce:'n',version:2,expiresAt:now+1000});
  await expect(repo.authorizeCallback(actor('101'),'n',1)).rejects.toThrow('Unauthorized');
  now+=1000; await expect(repo.authorizeCallback(actor('101'),'n',2)).rejects.toThrow('Unauthorized');
  await repo.revokeDevice(device.deviceId); await expect(repo.authorizeRecipient({deviceId:device.deviceId,userId:'101',pairingId:p.pairingId})).rejects.toThrow('Unauthorized');
});
test('pending access IDs are public, scoped, paginated and never alias consumed keys',async()=>{
  const k=await key(), p=await repo.pairParent(k.secret,'101','101'); await repo.revokeAccess(device,k.id);
  expect((await repo.authorizeParent(actor('101'))).pairingId).toBe(p.pairingId);
  await db.doc('pairKeys/foreign').set({deviceId:'other',accessId:'00000000-0000-4000-8000-000000000000',consumedAt:null,revokedAt:null});
  await repo.revokeAccess(device,'key:00000000-0000-4000-8000-000000000000');
  expect((await db.doc('pairKeys/foreign').get()).data()?.revokedAt).toBeNull();
  for(let i=0;i<51;i++) await key(`Parent ${i}`);
  const first=await repo.listAccess(device); expect(first.keys).toHaveLength(50); expect(first.parents).toHaveLength(1); expect(first.nextPage).toBeTypeOf('string');
  const second=await repo.listAccess(device,first.nextPage); expect(second.keys).toHaveLength(1); expect(second.nextPage).toBeNull();
  expect(new Set([...first.keys,...second.keys].map(x=>x.id)).size).toBe(51);
  expect(JSON.stringify(first)).not.toContain('credentialDigest'); expect(JSON.stringify(first)).not.toContain(k.secret);
});
test('pending revoke serializes with pairing; success always ends unauthorized or pairing rejected',async()=>{
  const k=await key(); await Promise.allSettled([repo.pairParent(k.secret,'101','101'),repo.revokeAccess(device,k.id)]);
  const stored=(await db.collection('pairKeys').get()).docs[0]!.data();
  expect(stored.consumedAt!==null || stored.revokedAt!==null).toBe(true);
  expect(stored.consumedAt===null || stored.revokedAt===null).toBe(true);
});
test('a caregiver leaves exactly as the laptop removes them, and can pair again with a new key',async()=>{
  const p=await pair('101'); await pair('102');
  const self={userId:'101',chatId:'101',deviceId:device.deviceId,pairingId:p.pairingId};
  await db.doc(`devices/${device.deviceId}/sessions/101`).set({menu:'nav'});
  await repo.leaveDevice(self);
  expect((await db.doc(`devices/${device.deviceId}/parents/101`).get()).data()!.revokedAt).toBe(now);
  expect((await db.doc('telegramUsers/101').get()).data()!.revokedAt).toBe(now);
  expect((await db.doc(`devices/${device.deviceId}`).get()).data()!.activeParentIds).toEqual(['102']);
  expect((await db.doc(`devices/${device.deviceId}/sessions/101`).get()).exists).toBe(false);
  await expect(repo.leaveDevice(self)).rejects.toThrow('Unauthorized');
  await expect(repo.authorizeParent(actor('101'))).rejects.toThrow('Unauthorized');
  expect((await pair('101')).pairingId).not.toBe(p.pairingId);
});
test('a caregiver\'s language comes from language_code until chosen, and the choice survives revocation and pairing again (LANG-01)',async()=>{
  const {SettingsService}=await import('../src/settings.js'),settings=new SettingsService(repo,()=>new Date(now).toISOString());
  const first=await pair('101');
  expect((await repo.authorizeParent({...actor('101'),languageCode:'en'})).lang).toBe('en');
  expect((await repo.authorizeParent({...actor('101'),languageCode:'uk-UA'})).lang).toBe('uk');
  await settings.setLanguage(await repo.authorizeParent(actor('101')),'en');
  expect((await repo.authorizeParent({...actor('101'),languageCode:'uk'})).lang).toBe('en');
  await repo.revokeAccess(device,`parent:101:${first.pairingId}`);
  expect((await db.doc('telegramUsers/101').get()).data()).toMatchObject({revokedAt:now,lang:'en'});
  const again=await pair('101');
  expect(again.lang).toBe('en');
  expect((await db.doc(`devices/${device.deviceId}/parents/101`).get()).data()).toMatchObject({pairingId:again.pairingId,lang:'en'});
  expect((await repo.authorizeParent({...actor('101'),languageCode:'uk'})).lang).toBe('en');
  expect(privateActor({message:{from:{id:101,is_bot:false,language_code:'en'},chat:{id:101,type:'private'}}})).toEqual({userId:'101',chatId:'101',languageCode:'en'});
});
