import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {createRouter} from '../src/index.js';
import {fixture,identity,root} from './delivery-fixture.js';
import {setup,events} from './bot-fixture.js';

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
  it('answers a stale double tap with a toast and leaves the live menu in place',async()=>{
    const s=await setup();await s.handle(s.message('1','/start'));
    const old=s.button('Налаштування');await s.handle(s.press('1',old));const live=s.last();
    await s.handle(s.press('1',old));
    const answers=s.calls.filter(c=>c.kind==='answer');expect(answers.at(-1)).toEqual({kind:'answer',text:'Це меню застаріло. Відкрийте /start знову.'});
    expect(s.last()).toBe(live);expect(s.last().text).toBe('⚙️ Налаштування');
  });
  it('replies once to a non-retryable failure and marks the update handled',async()=>{
    const s=await setup();
    for(let i=0;i<201;i++)s.db.data.set(root+'/actions/a'+i,{open:true,action:{id:'a'+i}});
    const update=s.message('1','/notify Привіт');
    await s.handle(update);await s.handle(update);
    expect(s.calls.filter(c=>c.kind==='send').map(c=>c.text)).toEqual(['Забагато активних нагадувань. Очистьте їх через /clear і спробуйте знову.']);
  });
  it('shows a non-retryable callback failure as a toast',async()=>{
    const s=await setup();await s.handle(s.message('1','/start'));await s.handle(s.press('1',s.button('Нагадування')));
    await s.handle(s.press('1',s.button('Сповіщення')));await s.handle(s.message('1','Привіт'));await s.handle(s.press('1',s.button('Зараз')));
    for(let i=0;i<201;i++)s.db.data.set(root+'/actions/a'+i,{open:true,action:{id:'a'+i}});
    const review=s.last();await s.handle(s.press('1',s.button('Надіслати')));
    const answers=s.calls.filter(c=>c.kind==='answer');expect(answers.at(-1)).toEqual({kind:'answer',text:'Забагато активних нагадувань. Очистьте їх через /clear і спробуйте знову.'});
    expect(s.last()).toBe(review);
  });
  it('treats a permanent Telegram refusal as handled instead of retrying forever',async()=>{
    const {GrammyError}=await import('grammy');
    const s=await setup(c=>{if(c.kind==='send')throw new GrammyError('blocked',{ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'},'sendMessage',{});return false;});
    const update=s.message('1','/help');
    await s.handle(update);
    expect(s.db.data.has('telegramUpdates/'+update.update_id)).toBe(true);
  });
  it('stores a TTL expiry on markers and writes none for plain unpaired chatter',async()=>{
    const s=await setup(),chatter=s.message('3','привіт'),paired=s.message('1','/help');
    await s.handle(chatter);await s.handle(paired);
    expect(s.db.data.has('telegramUpdates/'+chatter.update_id)).toBe(false);
    const marker=s.db.data.get('telegramUpdates/'+paired.update_id);
    expect(marker.expireAt).toBeInstanceOf(Date);
    expect(marker.expireAt.getTime()-Date.parse(marker.at)).toBe(2*86400000);
  });
  it('fixes the hourly target when rendered, so a redelivered tap replays instead of conflicting',async()=>{
    const {MenuSessions}=await import('../src/telegram/sessions.js');
    const s=await setup();await s.handle(s.message('1','/settings'));
    expect(s.button('Щогодинні звіти').endsWith(':hourlyon')).toBe(true);
    const tap=s.press('1',s.button('Щогодинні звіти')),advance=MenuSessions.prototype.advance;let fail=true;
    MenuSessions.prototype.advance=function(...args:any[]){if(fail){fail=false;return Promise.reject(new Error('transient'));}return (advance as any).apply(this,args);};
    try{
      await expect(s.handle(tap)).rejects.toThrow('transient');
      expect(s.db.data.get(root+'/parents/1').hourlyEnabled).toBe(true);
      await s.handle(tap);
    }finally{MenuSessions.prototype.advance=advance;}
    expect(s.db.data.get(root+'/parents/1').hourlyEnabled).toBe(true);
    expect(s.last().text.startsWith('Щогодинні звіти увімкнено.')).toBe(true);expect(s.button('Щогодинні звіти').endsWith(':hourlyoff')).toBe(true);
  });
  it('names the issuing caregiver in settings coordination',async()=>{
    const s=await setup();await s.handle(s.message('1','/free on'));
    expect(events(s,'coordination').at(-1).text.startsWith('Налаштування змінив(-ла) «Parent».')).toBe(true);
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

describe('reports through the bot',()=>{
  const games={id:'["Games"]',path:['Games']};
  const source=(apps:[string,number][])=>({date:'2026-10-28',leafTotalsMs:[{category:games,totalMs:apps.reduce((s,a)=>s+a[1],0)}],
    appLeafTotalsMs:apps.map(([app,totalMs])=>({app,categoryId:games.id,totalMs})),totalActiveMs:apps.reduce((s,a)=>s+a[1],0),selectedTotalMs:0,
    settingsRevision:0,rulesRevision:'r',availableFrom:'2026-10-28T10:00:00.000Z',availableThrough:'2026-10-28T12:00:00.000Z',partial:false,sequence:1});
  async function withUsage(apps:[string,number][]=[['Minecraft',1800000],['Chrome',600000]]){
    const s=await setup();
    s.db.data.set(root+'/settings/current',{...s.db.data.get(root+'/settings/current'),revision:1,selectedPaths:[{segments:['Games']}]});
    s.db.data.set(root+'/days/2026-10-28',{source:source(apps)});
    return s;
  }
  it('answers /usage privately with today by default and validates the period',async()=>{
    const s=await withUsage();
    await s.handle(s.message('1','/usage'));
    expect(s.last()).toMatchObject({kind:'send',chatId:'1'});
    expect(s.last().text).toContain('📊 Сьогодні, 28.10\nВраховано: 40 хв');expect(s.last().text).toContain('1. Minecraft — 30 хв\n2. Chrome — 10 хв');
    expect(s.last().buttons!.map(r=>r.map(b=>b.text))).toEqual([['Сьогодні','Учора','Останні 7 днів'],['← Назад']]);
    await s.handle(s.message('1','/usage week'));expect(s.last().text.startsWith('📊 Останні 7 днів')).toBe(true);
    await s.handle(s.message('1','/usage month'));expect(s.last().text).toBe('Використання: /usage, /usage today, /usage yesterday або /usage week.');
    expect(events(s)).toEqual([]);expect(s.calls.every(c=>c.chatId===undefined||c.chatId==='1')).toBe(true);
  });
  it('navigates Usage and Status from the main menu',async()=>{
    const s=await withUsage();await s.handle(s.message('1','/start'));
    await s.handle(s.press('1',s.button('Використання')));expect(s.last().text).toBe('📊 Використання\n\nОберіть період:');
    await s.handle(s.press('1',s.button('Учора')));expect(s.last()).toMatchObject({kind:'edit'});expect(s.last().text).toBe('📊 Учора, 27.10\nДаних за цей день немає.');
    await s.handle(s.press('1',s.button('Назад')));await s.handle(s.press('1',s.button('Стан ноутбука')));
    expect(s.last().text).toContain('💻 Стан ноутбука\nЗв’язок: ноутбук ще не синхронізувався');
    await s.handle(s.press('1',s.button('Оновити')));expect(s.last().text.startsWith('💻 Стан ноутбука')).toBe(true);
    await s.handle(s.message('1','/status'));expect(s.last()).toMatchObject({kind:'send'});
  });
  it('sends further pages of a long report as follow-up messages',async()=>{
    const apps:[string,number][]=Array.from({length:120},(_,i)=>[`Програма ${String(i).padStart(3,'0')} ${'ж'.repeat(40)}`,50000-i*100]);
    const s=await withUsage(apps);await s.handle(s.message('1','/usage'));
    const sends=s.calls.filter(c=>c.kind==='send');
    expect(sends.length).toBeGreaterThan(1);expect(sends[0]!.buttons!.length).toBe(2);expect(sends.slice(1).every(c=>!c.buttons!.length)).toBe(true);
    expect(sends.map(c=>c.text).join('\n').match(/^\d+\. Програма/gm)).toHaveLength(120);
  });
});
