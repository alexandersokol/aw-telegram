/** Task 10c end-to-end: enrollment, pairing, reports, settings, reminders, alerts, endtime and access removal
 * through the real router, webhook and task queue, with a wire-level laptop. */
import {it,expect} from 'vitest';
import {world} from './e2e-harness.js';

const MIN=60000, HOUR=3600000;

async function paired(w:ReturnType<typeof world>,count=2){
  const laptop=await w.laptop();
  await laptop.sync();
  const people=[];
  for(let i=1;i<=count;i++){
    const person=w.caregiver(String(100+i));
    await person.say('/pair '+await laptop.key('Батько '+i));
    people.push(person);
  }
  await laptop.sync();
  return {laptop,people};
}

it('enrolls, pairs two caregivers, reports usage and carries a limit change to the laptop',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  expect(mama!.last()).toContain('Доступ підтверджено');
  expect(laptop.state.last.collectionStartedAt).not.toBeNull();
  expect(laptop.state.last.activeCaregivers).toBe(2);

  w.advance(HOUR);
  await laptop.sync({usageMs:30*MIN,live:true});
  await mama!.say('/add_category Games');
  await w.runTasks();
  expect(tato!.inbox().some(m=>m.text.includes('Games'))).toBe(true);  // shared change, coordinated

  await laptop.sync({usageMs:30*MIN,live:true});
  await mama!.say('/usage');
  expect(mama!.last()).toContain('game.exe');
  await mama!.say('/status');
  expect(mama!.last()).toMatch(/на зв’язку/);

  await mama!.say('/limit 2h today');
  const response=await laptop.sync({usageMs:30*MIN,live:true});
  expect(response.settings.todayOverride).toMatchObject({limitMs:2*HOUR});
  await w.runTasks();
  expect(tato!.inbox().some(m=>m.text.includes('Налаштування змінив'))).toBe(true);

  w.advance(10*MIN);
  await mama!.say('/status');
  expect(mama!.last()).toMatch(/немає зв’язку/);  // the laptop went quiet: the report says so
});

const uuid=(n:number)=>`00000000-0000-4000-9000-${String(n).padStart(12,'0')}`;
const receipt=(n:number,action:any,status:string,at:string,acceptedAt:string,extra:any={})=>({id:uuid(n),kind:'action',actionId:action.id,
  eventSequence:1,occurrence:0,status,at,acceptedAt,presentedAt:null,reason:null,...extra});

it('shows a reminder on the laptop, confirms it to both caregivers, expires one while the laptop is off and clears',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  await mama!.say('/overlay Час на перерву');
  const offered=await laptop.sync();
  const [action]=offered.deliveryOffers;
  expect(action).toMatchObject({kind:'overlay',options:{message:'Час на перерву'}});
  const at=w.clock();
  await laptop.sync({acks:[receipt(1,action,'accepted',at,at),receipt(2,action,'presented',at,at,{eventSequence:2,presentedAt:at})]});
  await w.runTasks();
  // Two receipts in one sync arrive as one batched status: «Підтверджено показ: 1».
  for(const person of [mama!,tato!]) expect(person.inbox().some(m=>/Показ підтверджено|Підтверджено показ: 1/.test(m.text))).toBe(true);

  await mama!.say('/notify +5 Скоро вечеря');  // the laptop is off from here on
  w.advance(10*MIN);
  await w.runTasks();
  expect(mama!.inbox().some(m=>m.text.includes('Не вдалося підтвердити доставку'))).toBe(true);

  await mama!.say('/overlay +30 Вимкни гру');
  await mama!.say('/clear manual');  // manual clearing acts at once
  const cleared=await laptop.sync();
  expect(cleared.cancellations.revision).toBeGreaterThan(0);
  expect(cleared.deliveryOffers).toEqual([]);  // the cleared timer is never offered
});

it('sends hourly updates to who asked, allowance warnings to everyone, and honours free use, Clear all and restore',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  w.advance(5*HOUR);  // usage can never exceed the time covered since collection started
  await laptop.sync({usageMs:0,live:true});
  await mama!.say('/add_category Games');
  await mama!.say('/hourly on');
  await laptop.sync({usageMs:65*MIN,live:true});
  await w.runTasks();
  expect(mama!.inbox().some(m=>m.text.startsWith('Використано 65 хв'))).toBe(true);
  expect(tato!.inbox().some(m=>m.text.startsWith('Використано'))).toBe(false);  // personal preference

  await laptop.sync({usageMs:3*HOUR+46*MIN,live:true});  // 14 minutes left of four hours
  await w.runTasks();
  for(const person of [mama!,tato!]) expect(person.inbox().some(m=>m.text.startsWith('Залишилося 15 хв'))).toBe(true);

  const warnings=()=>tato!.inbox().filter(m=>/Залишилося \d+ хв|Денний час вичерпано/.test(m.text)).length;
  await mama!.say('/free on');
  await laptop.sync({usageMs:3*HOUR+56*MIN,live:true});
  await w.runTasks();
  expect(warnings()).toBe(1);  // only the 15-minute warning: free use silences the 5-minute one
  await mama!.say('/free off');
  await w.runTasks();
  // Ending free use catches up at once (FREE-08), folded into the coordination message.
  expect(tato!.last()).toMatch(/Вільний режим вимкнено.*Залишилося 5 хв або менше/s);
  await mama!.say('/clear all');
  await mama!.tap('Очистити всі');  // Clear all always asks first
  await laptop.sync({usageMs:4*HOUR+1*MIN,live:true});
  await w.runTasks();
  expect(tato!.inbox().some(m=>m.text.includes('Денний час вичерпано'))).toBe(false);  // suppressed until midnight
  await mama!.say('/restore');
  await w.runTasks();
  expect(tato!.last()).toMatch(/Автоматичні нагадування відновлено.*Денний час вичерпано/s);
  expect(mama!.last()).toMatch(/^Денний час вичерпано/);  // the issuer gets the alert as its own message
});

it('alerts every caregiver once the laptop confirms the endtime overlay',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  await mama!.say('/endtime set 21:00');  // a typed time applies directly; the menu flow reviews
  await mama!.say('/endtime on');
  const settings=(await laptop.sync()).settings;
  expect(settings).toMatchObject({endtimeEnabled:true,endtimeLocalTime:'21:00'});
  w.setTime('2026-10-28T19:00:05.000Z');  // 21:00:05 in Kyiv
  const ack={id:uuid(50),kind:'endtime',date:'2026-10-28',settingsRevision:settings.revision,endtimeLocalTime:'21:00',
    endtimeGeneration:settings.endtimeGeneration,presentedAt:w.clock()};
  await laptop.sync({acks:[ack]});
  await laptop.sync({acks:[ack]});  // a repeated receipt is not a second alert
  await w.runTasks();
  for(const person of [mama!,tato!])
    expect(person.inbox().filter(m=>m.text.startsWith('Настав час завершення 21:00')).length).toBe(1);
});

it('admits ten caregivers, refuses the eleventh until one is removed, and pauses the laptop when none is left',async()=>{
  const w=world();
  const {laptop,people}=await paired(w,10);
  expect(laptop.state.last.activeCaregivers).toBe(10);
  const eleventh=w.caregiver('200'),key=await laptop.key('Одинадцятий');
  await eleventh.say('/pair '+key);
  expect(eleventh.last()).toContain('Не вдалося підключитися');
  await people[0]!.say('/limit 3h daily');
  await w.runTasks();
  expect(people.slice(1).every(p=>p.inbox().some(m=>m.text.includes('Налаштування змінив')))).toBe(true);  // fan-out to the other nine

  const listed=await laptop.access();
  const first=listed.parents.find((p:any)=>p.userId===people[0]!.userId);
  expect(await laptop.revoke(first.id)).toBe(204);
  await people[0]!.say('/status');
  expect(people[0]!.last()).toContain('/pair');  // a removed caregiver is treated as unpaired
  await eleventh.say('/pair '+key);  // the refused key was not consumed
  expect(eleventh.last()).toContain('Доступ підтверджено');

  for(const parent of (await laptop.access()).parents) await laptop.revoke(parent.id);
  expect((await laptop.sync()).activeCaregivers).toBe(0);
});

it('lets caregivers remove themselves; the other keeps working and the laptop pauses at zero (ACCESS-09)',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  await mama!.say('/settings');
  await mama!.tap('Відключитися');
  await mama!.tap('Так, відключитися');
  expect(mama!.last()).toContain('Вас відключено.');
  await mama!.say('/status');
  expect(mama!.last()).toContain('/pair');
  await w.runTasks();
  expect(tato!.inbox().some(m=>/відключ/i.test(m.text))).toBe(false);  // nobody is told
  expect((await laptop.sync()).activeCaregivers).toBe(1);

  await tato!.say('/status');
  expect(tato!.last()).not.toContain('/pair');
  await tato!.say('/unpair');
  expect(tato!.last()).toContain('Ви останній підключений дорослий.');
  await tato!.tap('Так, відключитися');
  expect((await laptop.sync()).activeCaregivers).toBe(0);
});
