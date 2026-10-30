/** cleanup() against the Firestore emulator: real null equality, in-plus-range queries, ordering and limits. */
import {beforeEach,expect,it} from 'vitest';
import {cleanup} from '../src/cleanup.js';
import {FirestoreRepository} from '../src/repository.js';
import {fixtureDb,resetFixture} from './emulator-fixture.js';

const NOW='2026-10-28T12:00:00.000Z', nowMs=Date.parse(NOW), DAY=86400000;
const REVOKED='devices/00000000-0000-4000-8000-000000000000', ACTIVE='devices/00000000-0000-4000-8000-0000000000ff';

beforeEach(resetFixture);

it('clears, deletes and keeps the right records on real Firestore',async()=>{
  const db=fixtureDb();
  try {
    const writer=db.bulkWriter();
    for(let i=0;i<130;i++) writer.set(db.doc(`outbox/m${i}`),{createdAt:'2026-10-26T12:00:00.000Z',state:'delivered',text:'Привіт',scrubbed:false});
    writer.set(db.doc('outbox/fresh'),{createdAt:'2026-10-28T11:00:00.000Z',state:'delivered',text:'Свіже',scrubbed:false});
    writer.set(db.doc(REVOKED),{status:'revoked',activeParentIds:[]});
    writer.set(db.doc(`${REVOKED}/days/2026-10-01`),{source:{}});
    writer.set(db.doc(ACTIVE),{status:'active',activeParentIds:['1']});
    writer.set(db.doc(`${ACTIVE}/days/2026-10-02`),{source:{}});
    writer.set(db.doc(`${ACTIVE}/days/2026-10-28`),{source:{}});
    for(let i=0;i<7;i++){
      writer.set(db.doc(`${ACTIVE}/actions/a${i}`),{action:{createdAt:'2026-10-19T12:00:00.000Z'},open:false});
      writer.set(db.doc(`${ACTIVE}/actions/a${i}/evidence/1`),{digest:'x',at:'2026-10-19T12:00:00.000Z'});
    }
    writer.set(db.doc(`${ACTIVE}/actions/recent`),{action:{createdAt:'2026-10-27T12:00:00.000Z'},open:true});
    writer.set(db.doc('enrollments/unused'),{expiresAt:nowMs-8*DAY,consumedAt:null,deviceId:null,allowedDeviceCount:1});
    writer.set(db.doc('enrollments/consumed'),{expiresAt:nowMs-30*DAY,consumedAt:nowMs-30*DAY,deviceId:'d',allowedDeviceCount:1});
    writer.set(db.doc('outbox/stranded'),{state:'pending',createdAt:'2026-10-28T11:00:00.000Z',nextAttemptAt:'2026-10-28T11:30:00.000Z',text:'x',scrubbed:false});
    await writer.close();

    await cleanup(new FirestoreRepository(db,()=>nowMs),NOW);

    const texts=(await db.collection('outbox').where('state','==','delivered').get()).docs.map(d=>[d.id,d.data().text]);
    expect(texts.filter(([id,text])=>id!=='fresh'&&text!==null)).toEqual([]);
    expect(texts.find(([id])=>id==='fresh')![1]).toBe('Свіже');  // younger than a day
    const exists=async(path:string)=>(await db.doc(path).get()).exists;
    expect([await exists(`${REVOKED}/days/2026-10-01`),await exists(`${ACTIVE}/days/2026-10-02`),await exists(`${ACTIVE}/days/2026-10-28`)]).toEqual([false,false,true]);
    expect((await db.collection(`${ACTIVE}/actions`).get()).docs.map(d=>d.id)).toEqual(['recent']);
    expect([await exists('enrollments/unused'),await exists('enrollments/consumed')]).toEqual([false,true]);
    const intents=await db.collection('taskIntents').where('kind','==','outbox').where('resourceId','==','stranded').get();
    expect(intents.size).toBe(1);
  } finally {await db.terminate();}
});

it('removes alert states outside the retained dates by their date ID, with or without a date field',async()=>{
  const db=fixtureDb();
  try {
    await db.doc(ACTIVE).set({status:'active',activeParentIds:[]});
    await db.doc(`${ACTIVE}/alertStates/2026-10-20`).set({parents:{},lastWarning:null});  // /hourly before 11d wrote no date
    await db.doc(`${ACTIVE}/alertStates/2026-10-21`).set({date:'2026-10-21',parents:{},lastWarning:null});
    await db.doc(`${ACTIVE}/alertStates/2026-10-22`).set({parents:{},lastWarning:null});
    await cleanup(new FirestoreRepository(db,()=>nowMs),NOW);
    expect((await db.collection(`${ACTIVE}/alertStates`).get()).docs.map(d=>d.id)).toEqual(['2026-10-22']);
  } finally {await db.terminate();}
});
