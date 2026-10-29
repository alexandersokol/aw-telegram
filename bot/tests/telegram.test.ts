import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {fixture,parent,identity,root,request} from './delivery-fixture.js';

async function setup(){
  expect(existsSync(new URL('../src/telegram/commands.ts',import.meta.url)),'endtime Telegram controller is missing').toBe(true);
  const {EndtimeController}=await import('../src/telegram/commands.js'),f=fixture(),settings=new SettingsService(f.repo,f.clock);
  return {...f,settings,api:new DeviceApi(f.repo,f.clock),actions:new ActionService(f.repo,f.clock),bot:new EndtimeController(f.repo,settings,f.clock)};
}
type S=Awaited<ReturnType<typeof setup>>;
type Reply={text:string;buttons:{text:string;data:string}[][]};
const press=(s:S,reply:Reply,label:string,who=parent())=>s.bot.callback(who,reply.buttons.flat().find(b=>b.text.includes(label))!.data);
const labels=(reply:Reply)=>reply.buttons.map(row=>row.map(b=>b.text));
const events=(s:S,kind?:string)=>[...s.db.data].filter(([k,v])=>k.startsWith('events/')&&(!kind||v.kind===kind)).map(([,v])=>v);
const stored=(s:S)=>s.db.data.get(root+'/settings/current');
const STALE='Це меню застаріло. Відкрийте /endtime знову.';
const TIME_ERROR='Вкажіть час у форматі ГГ:ХХ від 00:15 до 23:59, наприклад 21:00.';

describe('/endtime commands',()=>{
  it('renders the same private status for no argument and status',async()=>{
    const s=await setup();
    const plain=await s.bot.command(parent(),'/endtime',1),status=await s.bot.command(parent(),'/endtime status',2);
    expect(status.text).toBe(plain.text);expect(labels(status)).toEqual(labels(plain));
    expect(plain.text).toBe('🌙 Час завершення\n\nСтан: вимкнено\nЗбережений час: 21:00\nНоутбук: очікує застосування');
    expect(labels(plain)).toEqual([['Увімкнути'],['Змінити час'],['← Назад']]);
    expect(events(s)).toEqual([]);
  });
  it('set enables, off and on keep the saved time, and duplicate updates are harmless',async()=>{
    const s=await setup();
    expect((await s.bot.command(parent(),'/endtime set 21:30',10)).text).toBe('Збережено: час завершення увімкнено, 21:30.\nНоутбук: очікує застосування.');
    expect((await s.bot.command(parent(),'/endtime set 21:30',10)).text).toContain('Збережено');
    expect(stored(s)).toMatchObject({revision:1,endtimeEnabled:true,endtimeLocalTime:'21:30'});
    expect((await s.bot.command(parent(),'/endtime off',11)).text).toBe('Збережено: час завершення вимкнено (збережений час 21:30).\nНоутбук: очікує застосування.');
    expect(stored(s)).toMatchObject({endtimeEnabled:false,endtimeLocalTime:'21:30'});
    await s.bot.command(parent(),'/endtime on',12);expect(stored(s)).toMatchObject({revision:3,endtimeEnabled:true,endtimeLocalTime:'21:30'});
    expect((await s.bot.command(parent(),'/endtime on',13)).text).toBe('Без змін: час завершення вже увімкнено, 21:30.');
    expect(stored(s).revision).toBe(3);
  });
  it('confirms to the issuer and coordinates with every other caregiver only',async()=>{
    const s=await setup();await s.bot.command(parent(),'/endtime set 22:15',20);
    const coordination=events(s,'coordination');
    expect(coordination).toHaveLength(1);expect(coordination[0].recipients.map((r:any)=>r.userId)).toEqual(['2']);
    expect(coordination[0].text).toContain('Час завершення: увімкнено, 22:15.');
  });
  it.each(['/endtime set 24:00','/endtime set 9:00','/endtime set'])('rejects %j with exact guidance and no mutation',async text=>{
    const s=await setup(),before=structuredClone(s.db.data);
    expect(await s.bot.command(parent(),text,30)).toEqual({text:TIME_ERROR,buttons:[]});expect(s.db.data).toEqual(before);
  });
  it('explains usage for unknown arguments',async()=>{
    const s=await setup();
    expect((await s.bot.command(parent(),'/endtime later',31)).text).toBe('Використання: /endtime, /endtime status, /endtime set ГГ:ХХ, /endtime on, /endtime off.');
  });
  it('shows suppression and companion acknowledgement in status',async()=>{
    const s=await setup();await s.bot.command(parent(),'/endtime set 21:00',40);
    await s.settings.updateSettings(parent('2'),{kind:'setFreeUse',enabled:true},'free');
    await s.actions.clearActions(parent('2'),'all','clear');
    await s.api.syncDevice(identity,{...request(),acks:[{id:randomUUID(),kind:'settings',revision:3,appliedAt:s.clock()}]});
    expect((await s.bot.command(parent(),'/endtime',41)).text).toBe('🌙 Час завершення\n\nСтан: увімкнено\nЗбережений час: 21:00\nНоутбук: застосовано\n'+
      'Сьогодні не діє: увімкнено вільний режим.\nСьогодні не діє: автоматичні нагадування вимкнено до півночі.');
  });
});

describe('Endtime menu',()=>{
  it('requires review before a button time edit and confirms saved versus applied state',async()=>{
    const s=await setup(),menu=await s.bot.openMenu(parent());
    const prompt=await press(s,menu,'Змінити час');
    expect(prompt.text).toBe('Введіть час завершення у форматі ГГ:ХХ (від 00:15 до 23:59).');expect(labels(prompt)).toEqual([['Скасувати']]);
    expect((await s.bot.text(parent(),'24:00'))!.text).toBe(TIME_ERROR);
    const review=(await s.bot.text(parent(),'21:45'))!;
    expect(review.text).toBe('Перевірте зміну\n\nЧас завершення: 21:45\nПісля підтвердження його буде увімкнено, а інших батьків повідомлено.');
    expect(labels(review)).toEqual([['Підтвердити'],['Скасувати'],['← Назад']]);
    expect(stored(s).revision).toBe(0);
    const done=await press(s,review,'Підтвердити');
    expect(done.text.startsWith('Збережено: час завершення увімкнено, 21:45.\nНоутбук: очікує застосування.\n\n🌙 Час завершення')).toBe(true);
    expect(labels(done)[0]).toEqual(['Вимкнути']);
    expect(stored(s)).toMatchObject({revision:1,endtimeEnabled:true,endtimeLocalTime:'21:45'});
  });
  it('makes stale and duplicate callbacks harmless',async()=>{
    const s=await setup(),menu=await s.bot.openMenu(parent());
    const prompt=await press(s,menu,'Змінити час');await s.bot.text(parent(),'21:45');
    expect((await press(s,menu,'Увімкнути')).text).toBe(STALE);expect((await press(s,prompt,'Скасувати')).text).toBe(STALE);
    const review=await s.bot.openMenu(parent()).then(m=>press(s,m,'Змінити час')).then(()=>s.bot.text(parent(),'22:00'));
    const results=await Promise.all([press(s,review!,'Підтвердити'),press(s,review!,'Підтвердити')]);
    expect(results.filter(r=>r.text===STALE)).toHaveLength(1);
    expect(stored(s)).toMatchObject({revision:1,endtimeLocalTime:'22:00'});expect(events(s,'coordination')).toHaveLength(1);
    expect(await s.bot.callback(parent(),'et:forged:0:on')).toEqual({text:STALE,buttons:[]});expect(await s.bot.callback(parent(),'garbage')).toEqual({text:STALE,buttons:[]});
  });
  it('cancel and back never mutate, and back leaves the menu',async()=>{
    const s=await setup(),menu=await s.bot.openMenu(parent());
    const prompt=await press(s,menu,'Змінити час');const review=(await s.bot.text(parent(),'21:45'))!;
    const back=await press(s,review,'Назад');expect(back.text).toBe(prompt.text);
    const canceled=await press(s,back,'Скасувати');expect(canceled.text.startsWith('Скасовано.\n\n🌙 Час завершення')).toBe(true);
    expect(await press(s,canceled,'Назад')).toEqual({text:'',buttons:[],navigate:'settings'});
    expect(stored(s).revision).toBe(0);expect(events(s)).toEqual([]);
  });
  it('toggles directly from status',async()=>{
    const s=await setup();await s.bot.command(parent(),'/endtime set 21:00',50);
    const off=await press(s,await s.bot.openMenu(parent()),'Вимкнути');
    expect(off.text.startsWith('Збережено: час завершення вимкнено (збережений час 21:00).')).toBe(true);expect(labels(off)[0]).toEqual(['Увімкнути']);
  });
  it('ignores ordinary text outside time entry and expires sessions after 30 minutes',async()=>{
    const s=await setup();expect(await s.bot.text(parent(),'21:00')).toBeNull();
    const menu=await s.bot.openMenu(parent());await press(s,menu,'Змінити час');
    s.advance(30*60000);expect(await s.bot.text(parent(),'21:00')).toBeNull();
    expect((await press(s,menu,'Змінити час')).text).toBe(STALE);
  });
  it('keeps one caregiver menu independent of another and rejects revoked access',async()=>{
    const s=await setup(),first=await s.bot.openMenu(parent());await s.bot.openMenu(parent('2'));
    expect((await press(s,first,'Змінити час')).text).toContain('Введіть час');
    const second=await s.bot.openMenu(parent('2'));await s.repo.revokeAccess(identity,`parent:2:${parent('2').pairingId}`);
    expect((await press(s,second,'Увімкнути',parent('2'))).text).toBe(STALE);expect(stored(s).revision).toBe(0);
  });
});
