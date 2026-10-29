import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {createRouter} from '../src/index.js';
import {fixture,identity,root} from './delivery-fixture.js';

type Call={kind:'send'|'edit'|'answer'|'delete';chatId?:string;messageId?:number;text?:string;buttons?:{text:string;data:string}[][]};
async function setup(fail:(call:Call)=>boolean=()=>false){
  expect(existsSync(new URL('../src/telegram/webhook.ts',import.meta.url)),'Telegram webhook handler is missing').toBe(true);
  const {TelegramBot}=await import('../src/telegram/webhook.js'),f=fixture();
  const calls:Call[]=[];
  const record=async(call:Call)=>{if(fail(call))throw new Error('Telegram unavailable');calls.push(call);};
  const client={
    send:async(chatId:string,reply:any)=>record({kind:'send',chatId,text:reply.text,buttons:reply.buttons}),
    edit:async(chatId:string,messageId:number,reply:any)=>record({kind:'edit',chatId,messageId,text:reply.text,buttons:reply.buttons}),
    answer:async(_id:string)=>record({kind:'answer'}),
    delete:async(chatId:string,messageId:number)=>record({kind:'delete',chatId,messageId}),
  };
  const settings=new SettingsService(f.repo,f.clock);
  const bot=new TelegramBot(f.repo,settings,new ActionService(f.repo,f.clock),client,f.clock);
  let update=100;
  const from=(user:string)=>({id:Number(user),is_bot:false,first_name:'P'});
  const message=(user:string,text:string,extra:any={})=>({update_id:++update,message:{message_id:update,date:0,chat:{id:Number(user),type:'private'},from:from(user),text,...extra}});
  const press=(user:string,data:string,messageId=7)=>({update_id:++update,callback_query:{id:'cb'+update,from:from(user),chat_instance:'i',data,
    message:{message_id:messageId,date:0,chat:{id:Number(user),type:'private'}}}});
  const handle=(u:any)=>bot.handleUpdate(u);
  const last=()=>calls.filter(c=>c.kind==='send'||c.kind==='edit').at(-1)!;
  const button=(label:string)=>last().buttons!.flat().find(b=>b.text.includes(label))!.data;
  return {...f,calls,bot,settings,handle,message,press,last,button};
}
const events=(s:any,kind?:string)=>[...s.db.data].filter(([k,v]:any)=>k.startsWith('events/')&&(!kind||v.kind===kind)).map(([,v]:any)=>v);
const PAIRING='Щоб підключитися, створіть ключ у програмі на ноутбуці («Доступ батьків») і надішліть його сюди командою /pair КЛЮЧ.';

describe('unpaired and pairing',()=>{
  it('answers unpaired users with pairing instructions only',async()=>{
    const s=await setup();
    for(const text of ['/start','/usage','привіт'])await s.handle(s.message('3',text));
    expect(s.calls.map(c=>c.text)).toEqual([PAIRING,PAIRING,PAIRING]);
    expect([...s.db.data.keys()].filter(k=>k.startsWith('devices/')&&k.includes('/parents/3'))).toEqual([]);
  });
  it.each(['/pair','/start'])('pairs with %s KEY, removes the key message and shows the main menu',async command=>{
    const s=await setup(),key=await s.repo.createPairKey(identity,'Тато');
    await s.handle(s.message('3',`${command} ${key.secret}`));
    expect(s.db.data.get(root+'/parents/3')).toMatchObject({userId:'3',revokedAt:null,name:'Тато'});
    expect(s.calls.find(c=>c.kind==='delete')).toMatchObject({chatId:'3'});
    expect(s.last().text).toContain('Доступ підтверджено');expect(s.last().buttons!.flat().map(b=>b.text)).toContain('⚙️ Налаштування');
  });
  it('rejects invalid keys and already paired accounts without detail',async()=>{
    const s=await setup();
    await s.handle(s.message('3','/pair AAAAAAAAAAAAAAAAAAAAAA'));
    expect(s.last().text).toBe('Не вдалося підключитися: ключ недійсний, використаний або прострочений.');
    await s.handle(s.message('1','/pair AAAAAAAAAAAAAAAAAAAAAA'));
    expect(s.last().text).toBe('Цей обліковий запис уже підключено.');
  });
  it('treats a revoked caregiver as unpaired',async()=>{
    const s=await setup();
    await s.repo.revokeAccess(identity,`parent:2:${s.db.data.get(root+'/parents/2').pairingId}`);
    await s.handle(s.message('2','/settings'));expect(s.last().text).toBe(PAIRING);
  });
});

describe('private-chat boundary and update delivery',()=>{
  it.each([
    ['group',(m:any)=>({...m,message:{...m.message,chat:{id:-5,type:'group'}}})],
    ['bot sender',(m:any)=>({...m,message:{...m.message,from:{...m.message.from,is_bot:true}}})],
    ['forwarded',(m:any)=>({...m,message:{...m.message,forward_origin:{type:'user'}}})],
    ['no update id',(m:any)=>({...m,update_id:'x'})],
  ])('ignores %s updates without replying',async(_,mutate)=>{
    const s=await setup();await s.handle(mutate(s.message('1','/start')));expect(s.calls).toEqual([]);
  });
  it('processes a redelivered update once',async()=>{
    const s=await setup(),update=s.message('1','/endtime set 21:30');
    await s.handle(update);await s.handle(update);
    expect(s.calls.filter(c=>c.kind==='send')).toHaveLength(1);expect(events(s,'coordination')).toHaveLength(1);
  });
  it('retries a partially failed update without repeating its mutation',async()=>{
    let first=true;const s=await setup(c=>c.kind==='send'&&first&&!(first=false));
    const update=s.message('1','/endtime set 21:30');
    await expect(s.handle(update)).rejects.toThrow('Telegram unavailable');
    await s.handle(update);
    expect(s.calls.filter(c=>c.kind==='send').map(c=>c.text)).toEqual(['Збережено: час завершення увімкнено, 21:30.\nНоутбук: очікує застосування.']);
    expect(s.db.data.get(root+'/settings/current').revision).toBe(1);expect(events(s,'coordination')).toHaveLength(1);
  });
});

describe('paired navigation',()=>{
  it('shows the main menu and navigates Settings, Endtime and back by editing the menu message',async()=>{
    const s=await setup();await s.handle(s.message('1','/start'));
    expect(s.last().buttons!.map(r=>r.map(b=>b.text))).toEqual([['📊 Використання','💻 Стан ноутбука'],['💬 Нагадування','⏱ Ліміт часу'],['⚙️ Налаштування']]);
    await s.handle(s.press('1',s.button('Налаштування')));
    expect(s.last()).toMatchObject({kind:'edit',messageId:7});
    expect(s.last().buttons!.map(r=>r.map(b=>b.text))).toEqual([['Щогодинні звіти: вимкнено'],['Час завершення: вимкнено'],['Допомога'],['← Назад']]);
    expect(s.calls.filter(c=>c.kind==='answer')).toHaveLength(1);
    await s.handle(s.press('1',s.button('Час завершення')));expect(s.last().text.startsWith('🌙 Час завершення')).toBe(true);
    await s.handle(s.press('1',s.button('Назад')));expect(s.last().buttons!.flat().map(b=>b.text)).toContain('Допомога');
    await s.handle(s.press('1',s.button('Назад')));expect(s.last().buttons!.flat().map(b=>b.text)).toContain('⚙️ Налаштування');
  });
  it('toggles hourly reports privately and shows the saved endtime in Settings',async()=>{
    const s=await setup();await s.handle(s.message('1','/endtime set 22:00'));
    await s.handle(s.message('1','/settings'));
    expect(s.last().buttons!.flat().map(b=>b.text)).toContain('Час завершення: 22:00');
    const before=events(s).length;
    await s.handle(s.press('1',s.button('Щогодинні звіти')));
    expect(s.last().text.startsWith('Щогодинні звіти увімкнено.')).toBe(true);
    expect(s.last().buttons![0]![0]!.text).toBe('Щогодинні звіти: увімкнено');
    expect(s.db.data.get(root+'/parents/1').hourlyEnabled).toBe(true);expect(s.db.data.get(root+'/parents/2').hourlyEnabled).toBe(false);
    expect(events(s)).toHaveLength(before);
  });
  it('rejects stale navigation buttons',async()=>{
    const s=await setup();await s.handle(s.message('1','/start'));
    const old=s.button('Налаштування');await s.handle(s.press('1',old));await s.handle(s.press('1',old));
    expect(s.last().text).toBe('Це меню застаріло. Відкрийте /start знову.');
  });
  it('routes time entry text into the Endtime menu',async()=>{
    const s=await setup();await s.handle(s.message('1','/endtime'));
    await s.handle(s.press('1',s.button('Змінити час')));await s.handle(s.message('1','21:15'));
    expect(s.last().text.startsWith('Перевірте зміну')).toBe(true);
    await s.handle(s.press('1',s.button('Підтвердити')));
    expect(s.db.data.get(root+'/settings/current')).toMatchObject({endtimeEnabled:true,endtimeLocalTime:'21:15'});
  });
  it('handles /hourly and /help and explains unknown input',async()=>{
    const s=await setup();
    await s.handle(s.message('1','/hourly on'));expect(s.last().text).toBe('Щогодинні звіти увімкнено.');
    await s.handle(s.message('1','/hourly maybe'));expect(s.last().text).toBe('Використання: /hourly on або /hourly off.');
    await s.handle(s.message('1','/help'));expect(s.last().text).toContain('/endtime');
    await s.handle(s.message('1','просто текст'));expect(s.last().text).toBe('Оберіть дію в меню: /start');
    await s.handle(s.message('1','/nonsense'));expect(s.last().text).toContain('Невідома команда');
  });
});

describe('webhook route',()=>{
  const SECRET='s'.repeat(64);
  const request=(headers:Record<string,string>,body:string)=>({method:'POST',path:'/telegram/webhook',headers,body,remoteAddress:'127.0.0.1'});
  it('requires the exact webhook secret before handling an update',async()=>{
    const f=fixture(),handled:unknown[]=[];
    const router=createRouter(f.repo,{telegram:{secret:SECRET,handle:async u=>{handled.push(u);}}});
    const body=JSON.stringify({update_id:1});
    expect((await router(request({},body))).status).toBe(401);
    expect((await router(request({'x-telegram-bot-api-secret-token':SECRET.slice(1)+'x'},body))).status).toBe(401);
    expect((await router(request({'x-telegram-bot-api-secret-token':SECRET},'{nope'))).status).toBe(400);
    expect(handled).toEqual([]);
    expect((await router(request({'x-telegram-bot-api-secret-token':SECRET},body))).status).toBe(200);
    expect(handled).toEqual([{update_id:1}]);
  });
  it('returns 500 on handler failure so Telegram redelivers, and 404 without configuration',async()=>{
    const f=fixture();
    const failing=createRouter(f.repo,{telegram:{secret:SECRET,handle:async()=>{throw new Error('boom');}}});
    expect((await failing(request({'x-telegram-bot-api-secret-token':SECRET},'{"update_id":1}'))).status).toBe(500);
    expect((await createRouter(f.repo)(request({'x-telegram-bot-api-secret-token':SECRET},'{}'))).status).toBe(404);
  });
});

describe('grammY client adapter',()=>{
  it('sends plain-text messages with inline keyboards and tolerates unmodified edits',async()=>{
    const {Api}=await import('grammy'),{grammyClient}=await import('../src/telegram/webhook.js');
    const api=new Api('123:test'),seen:{method:string;payload:any}[]=[];
    api.config.use(async(_prev,method,payload)=>{
      seen.push({method,payload});
      if(method==='editMessageText')return {ok:false,error_code:400,description:'Bad Request: message is not modified: specified new message content and reply markup are exactly the same'} as any;
      return {ok:true,result:method==='sendMessage'?{message_id:1,date:0,chat:{id:5,type:'private'}}:true} as any;
    });
    const client=grammyClient(api),reply={text:'<b>Привіт</b>',buttons:[[{text:'Так',data:'nv:n:0:back'}]]};
    await client.send('5',reply);await client.edit('5',9,reply);await client.answer('cb');await client.send('5',{text:'Без кнопок',buttons:[]});
    expect(seen.map(s=>s.method)).toEqual(['sendMessage','editMessageText','answerCallbackQuery','sendMessage']);
    expect(seen[0]!.payload).toEqual({chat_id:5,text:'<b>Привіт</b>',link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:'Так',callback_data:'nv:n:0:back'}]]}});
    expect(seen[0]!.payload.parse_mode).toBeUndefined();expect(seen[3]!.payload.reply_markup).toBeUndefined();
  });
});
