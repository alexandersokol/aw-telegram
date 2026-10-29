/** Owner purge of one device: every subcollection and every top-level index document that names it. */
import {beforeEach,expect,it} from 'vitest';
import {purgeDevice} from '../src/purge.js';
import {fixtureDb,resetFixture} from './emulator-fixture.js';

const A='00000000-0000-4000-8000-00000000000a', B='00000000-0000-4000-8000-00000000000b';

async function seed(db:any,device:string){
  const root=db.doc(`devices/${device}`);
  await root.set({status:'revoked',credentialDigest:null,activeParentIds:['1']});
  await root.collection('settings').doc('current').set({revision:1});
  await root.collection('days').doc('2026-10-28').set({source:{}});
  await root.collection('actions').doc('act').set({open:true});
  await root.collection('actions').doc('act').collection('evidence').doc('1').set({digest:'x'});
  await db.doc(`pairKeys/key-${device}`).set({deviceId:device,accessId:'k'});
  await db.doc(`telegramUsers/user-${device}`).set({deviceId:device,pairingId:'p',revokedAt:null});
  await db.doc(`events/event-${device}`).set({deviceId:device,text:'x'});
  await db.doc(`outbox/out-${device}`).set({recipient:{deviceId:device,userId:'1',pairingId:'p'}});
  await db.doc(`taskIntents/deadline-${device}`).set({kind:'deadline',resourceId:`${device}:act`});
  await db.doc(`taskIntents/outbox-${device}`).set({kind:'outbox',resourceId:`out-${device}`});
  await db.doc(`actionLocations/act-${device}`).set({deviceId:device});
  await db.doc(`enrollments/enr-${device}`).set({deviceId:device,consumedAt:1});
}

async function paths(db:any):Promise<string[]>{
  const found:string[]=[];
  const walk=async(collections:any[])=>{for(const c of collections){for(const d of (await c.get()).docs){found.push(d.ref.path);await walk(await d.ref.listCollections());}
    for(const ref of await c.listDocuments()) await walk(await ref.listCollections());}};
  await walk(await db.listCollections());
  return [...new Set(found)].sort();
}

beforeEach(resetFixture);

it('deletes one device completely and leaves another untouched',async()=>{
  const db=fixtureDb();
  try {
    await seed(db,A);await seed(db,B);
    const report=await purgeDevice(db,A,{confirm:A});
    const left=await paths(db);
    expect(left.filter(p=>p.includes(A)||p.endsWith('-'+A)||p.includes(`${A}:`))).toEqual([]);
    expect(left).toContain(`devices/${B}/actions/act/evidence/1`);
    expect(left).toContain(`telegramUsers/user-${B}`);
    expect(left).toContain(`taskIntents/outbox-${B}`);
    expect(report.indexDocuments).toBe(8);
  } finally {await db.terminate();}
});

it('refuses without the matching confirmation and deletes nothing',async()=>{
  const db=fixtureDb();
  try {
    await seed(db,A);
    const before=await paths(db);
    await expect(purgeDevice(db,A,{confirm:B})).rejects.toThrow('confirmation');
    await expect(purgeDevice(db,'not-a-uuid',{confirm:'not-a-uuid'})).rejects.toThrow('device');
    await db.doc(`devices/${A}`).update({status:'active'});
    await expect(purgeDevice(db,A,{confirm:A})).rejects.toThrow('Revoke the device first');
    await db.doc(`devices/${A}`).update({status:'revoked'});
    expect(await paths(db)).toEqual(before);  // nothing deleted by any refused attempt
  } finally {await db.terminate();}
});
