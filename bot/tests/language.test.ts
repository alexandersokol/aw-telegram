/** Task 11f (LANG-01): each caregiver's bot language, its fallback from Telegram's language_code, and shared messages
 * written per recipient. */
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DeviceApi} from '../src/deviceApi.js';
import {OutboxService} from '../src/outbox.js';
import {identity,root,request,parent,NOW} from './delivery-fixture.js';
import {setup,events,type Bot} from './bot-fixture.js';

const PAIRING_UK='Щоб підключитися, створіть ключ у програмі на ноутбуці («Доступ батьків») і надішліть його сюди командою /pair КЛЮЧ.';
const PAIRING_EN='To connect, create a key in the laptop app ("Parent access", «Доступ батьків») and send it here with /pair KEY.';
/** A message from a Telegram app set to `code` (undefined: no language_code at all). */
const from=(s:Bot,user:string,text:string,code?:string)=>s.handle(s.message(user,text,
  {from:{id:Number(user),is_bot:false,first_name:'P',...(code===undefined?{}:{language_code:code})}}));
const rows=(s:Bot)=>[...s.db.data].filter(([k])=>k.startsWith('outbox/')).map(([,v]:any)=>v);
const textTo=(s:Bot,user:string)=>rows(s).filter(r=>r.recipient.userId===user).map(r=>r.text);

describe('the language_code fallback',()=>{
  it.each([['uk','Головне меню'],['uk-UA','Головне меню'],['ru','Головне меню'],['en','Main menu'],['de','Main menu'],[undefined,'Main menu']])
  ('a paired caregiver with %j and no stored choice reads %j',async(code,menu)=>{
    const s=await setup();await from(s,'1','/start',code);
    expect(s.last().text).toBe(menu);
  });
  it('gives unpaired users the pairing hint, and pairing failures, in the fallback language',async()=>{
    const s=await setup();
    await from(s,'3','hello','en-US');expect(s.last().text).toBe(PAIRING_EN);
    await from(s,'3','привіт','uk');expect(s.last().text).toBe(PAIRING_UK);
    await from(s,'3','/pair AAAAAAAAAAAAAAAAAAAAAA','en');expect(s.last().text).toBe('Could not connect: the key is invalid, used or expired.');
    const tap={update_id:9000,callback_query:{id:'cb',from:{id:3,is_bot:false,first_name:'P',language_code:'en'},chat_instance:'i',data:'nv:x:0:main',
      message:{message_id:7,date:0,chat:{id:3,type:'private'}}}};
    await s.handle(tap);expect(s.last().text).toBe(PAIRING_EN);
  });
  it('labels the home button of a bare reply in the reader\'s language',async()=>{
    const s=await setup();await from(s,'1','/nonsense','en');
    expect(s.last().text).toBe('Unknown command. List of commands: /help');expect(s.labels()).toEqual([['🏠 Main menu']]);
  });
});

describe('choosing a language',()=>{
  it('/language en stores the choice, which then overrides language_code, for that caregiver only, telling nobody',async()=>{
    const s=await setup(),before=events(s).length;
    await s.say('/language en');
    expect(s.last().text.startsWith('Bot language changed: English.\n\n⚙️ Settings')).toBe(true);
    expect(s.labels()).toContainEqual(['🌐 Language: English']);
    expect(s.db.data.get('telegramUsers/1').lang).toBe('en');expect(s.db.data.get(root+'/parents/1').lang).toBe('en');
    await from(s,'1','/start','uk');expect(s.last().text).toBe('Main menu');
    await s.say('/start','2');expect(s.last().text).toBe('Головне меню');
    expect(s.db.data.get('telegramUsers/2').lang).toBeUndefined();expect(s.db.data.get(root+'/parents/2').lang).toBeUndefined();
    expect(events(s).length).toBe(before);expect(rows(s)).toEqual([]);
    await s.say('/language uk');expect(s.last().text.startsWith('Мову бота змінено: українська.\n\n⚙️ Налаштування')).toBe(true);
    await from(s,'1','/start','en');expect(s.last().text).toBe('Головне меню');
  });
  it('switches from Settings, returning to Settings in the chosen language',async()=>{
    const s=await setup();await s.say('/settings');
    expect(s.labels()).toEqual([['Щогодинні звіти: вимкнено'],['Час завершення: вимкнено'],['🌐 Мова: Українська'],['Допомога'],['🚪 Відключитися'],['← Назад']]);
    await s.tap('🌐 Мова');
    expect(s.last().text).toBe('🌐 Оберіть мову бота:');expect(s.labels()).toEqual([['Українська'],['English'],['← Назад']]);
    await s.tap('English');
    expect(s.last().kind).toBe('edit');expect(s.last().text).toBe('Bot language changed: English.\n\n⚙️ Settings');
    expect(s.labels()).toEqual([['Hourly reports: off'],['Endtime: off'],['🌐 Language: English'],['Help'],['🚪 Disconnect'],['← Back']]);
    expect(s.db.data.get('telegramUsers/1').lang).toBe('en');expect(s.db.data.get('telegramUsers/2').lang).toBeUndefined();
    expect(events(s)).toEqual([]);
    await s.tap('🌐 Language');await s.tap('← Back');expect(s.last().text).toBe('⚙️ Settings');
  });
  it('shows the choice for a bare /language, explains a wrong argument and lists the command in /help',async()=>{
    const s=await setup();
    await s.say('/language');expect(s.last().text).toBe('🌐 Оберіть мову бота:');
    await s.tap('English');expect(s.last().text.startsWith('Bot language changed: English.')).toBe(true);
    await s.say('/language de');expect(s.last().text).toBe('Usage: /language uk or /language en.');
    expect(s.db.data.get('telegramUsers/1').lang).toBe('en');
    await s.say('/help');expect(s.last().text).toContain('/language uk|en — bot language');
    await s.say('/language uk');await s.say('/help');expect(s.last().text).toContain('/language uk|en — мова бота');
  });
  it('keeps the choice through leaving and pairing again',async()=>{
    const s=await setup();await s.say('/language en');
    await s.say('/unpair');await s.tap('Yes, disconnect');
    expect(s.last().text.startsWith('You are disconnected.')).toBe(true);
    expect(s.db.data.get('telegramUsers/1')).toMatchObject({revokedAt:expect.any(Number),lang:'en'});
    const key=await s.repo.createPairKey(identity,'Мама');
    await from(s,'1',`/pair ${key.secret}`,'uk');
    expect(s.last().text.startsWith('Access confirmed.')).toBe(true);expect(s.last().text).toContain('Main menu');
    expect(s.db.data.get('telegramUsers/1')).toMatchObject({revokedAt:null,lang:'en'});
    expect(s.db.data.get(root+'/parents/1')).toMatchObject({revokedAt:null,lang:'en'});
  });
});

describe('shared messages per recipient',()=>{
  it('writes one row in each recipient\'s language',async()=>{
    const s=await setup();await s.say('/language en');
    await s.say('/notify Привіт','2');
    expect(events(s,'status').at(-1).text).toEqual({uk:'Нове нагадування від «Parent»: сповіщення «Привіт». Показати: зараз. Очікуємо підтвердження ноутбука.',
      en:'New reminder from "Parent": notification "Привіт". Show: now. Waiting for the laptop to confirm.'});
    expect(textTo(s,'1')).toEqual(['New reminder from "Parent": notification "Привіт". Show: now. Waiting for the laptop to confirm.']);
    expect(textTo(s,'2')).toEqual(['Нове нагадування від «Parent»: сповіщення «Привіт». Показати: зараз. Очікуємо підтвердження ноутбука.']);
    await s.say('/limit 1 h 30 min today','2');
    expect(s.last().text.startsWith('Збережено: ліміт на сьогодні 1 год 30 хв.')).toBe(true);
    expect(textTo(s,'1').at(-1)).toBe('Settings changed by "Parent". Today\'s limit 1 h 30 min.');
  });
  it('tells the author that the laptop applied a change in the author\'s language',async()=>{
    const s=await setup();await s.say('/language en');await s.say('/limit 90 min today');
    expect(s.last().text.startsWith('Saved: today\'s limit 1 h 30 min.')).toBe(true);
    expect(textTo(s,'2')).toEqual(['Налаштування змінив(-ла) «Parent». Ліміт на сьогодні 1 год 30 хв.']);
    await new DeviceApi(s.repo,s.clock).syncDevice(identity,{...request(1),acks:[{id:randomUUID(),kind:'settings',revision:1,appliedAt:s.clock()}]});
    expect(textTo(s,'1')).toEqual(['✅ The laptop applied: today\'s limit 1 h 30 min.']);
  });
  it('still sends an applied notice stored before 11f as it is',async()=>{
    const s=await setup();
    s.db.data.set(root+'/appliedNotices/s-1',{pairingId:parent('1').pairingId,userId:'1',summary:'ліміт на сьогодні 10 хв',createdAt:NOW,settingsRevision:1});
    s.db.data.set(root+'/settings/current',{...s.db.data.get(root+'/settings/current'),revision:1});
    await new DeviceApi(s.repo,s.clock).syncDevice(identity,{...request(1),acks:[{id:randomUUID(),kind:'settings',revision:1,appliedAt:s.clock()}]});
    expect(textTo(s,'1')).toEqual(['✅ Ноутбук застосував: ліміт на сьогодні 10 хв.']);
  });
  it('delivers a row queued by the earlier backend, whose event holds one string, unchanged',async()=>{
    const s=await setup(),sent:string[]=[];
    const text='Очікуємо підтвердження виконання';
    s.db.data.set('events/old',{id:'old',deviceId:identity.deviceId,at:NOW,kind:'status',text,recipients:[{deviceId:identity.deviceId,userId:'1',pairingId:parent('1').pairingId}],scrubbed:false});
    s.db.data.set('outbox/old-1',{id:'old-1',eventId:'old',recipient:{deviceId:identity.deviceId,userId:'1',pairingId:parent('1').pairingId},text,createdAt:NOW,
      state:'pending',attempts:0,nextAttemptAt:NOW,leaseToken:null,leaseUntil:null,scrubbed:false});
    await s.say('/language en');
    await new OutboxService(s.repo,{send:async(_chat,value)=>{sent.push(value);return {kind:'sent',messageId:1};}},s.clock).deliverOutbox('old-1');
    expect(sent).toEqual([text]);expect(s.db.data.get('outbox/old-1').state).toBe('delivered');
  });
});
