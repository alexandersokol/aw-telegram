import {beforeAll,afterAll,expect,test} from 'vitest';
import {initializeTestEnvironment,assertFails, type RulesTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,collection,getDoc,getDocs,setDoc,updateDoc,deleteDoc} from 'firebase/firestore';
import {readFileSync} from 'node:fs';
import {emulatorAddress,projectId} from './emulator-fixture.js';
let env:RulesTestEnvironment;
const paths=['devices/d','devices/d/settings/current','devices/d/days/2026-10-28','devices/d/live/current','devices/d/parents/101','devices/d/actions/a','devices/d/alertState/a','devices/d/sessions/101','devices/d/outbox/a','pairKeys/k','enrollments/e','telegramUsers/101','throttles/t','unknown/nested/path/d'];
beforeAll(async()=>{
  const address=emulatorAddress();
  env=await initializeTestEnvironment({projectId,firestore:{...address,rules:readFileSync(new URL('../../firestore.rules',import.meta.url),'utf8')}});
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx=>{for(const path of paths)await setDoc(doc(ctx.firestore(),path),{test:true});});
});
afterAll(async()=>{await env?.cleanup();});
test('deny-all rules reject authenticated and anonymous get/list/create/update/delete on every scope',async()=>{
  for(const ctx of [env.unauthenticatedContext(),env.authenticatedContext('owner')]){
    const db=ctx.firestore();
    for(const path of paths){
      await assertFails(getDoc(doc(db,path))); await assertFails(getDoc(doc(db,path+'-missing')));
      await assertFails(getDocs(collection(db,path.slice(0,path.lastIndexOf('/')))));
      await assertFails(setDoc(doc(db,path+'-new'),{test:true}));
      await assertFails(updateDoc(doc(db,path),{test:false})); await assertFails(deleteDoc(doc(db,path)));
    }
  }
  expect(true).toBe(true); // all operations above must reject with permission denied
});
