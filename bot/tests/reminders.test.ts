import {describe,it,expect} from 'vitest';
import {setup,events,type Bot} from './bot-fixture.js';
import {root} from './delivery-fixture.js';

const HOME='💬 Нагадування\n\nНадішліть повідомлення на ноутбук або\nперегляньте активні й заплановані нагадування.';
const QUEUED='⏳ Запит збережено. Очікуємо підтвердження від ноутбука.';
const FREE='ℹ️ Увімкнено вільний режим до опівночі.\nЦе нагадування буде пропущено.';
const actions=(s:Bot)=>[...s.db.data].filter(([k])=>k.startsWith(root+'/actions/')&&k.split('/').length===4).map(([,v])=>v);
async function home(){const s=await setup();await s.say('/start');await s.tap('Нагадування');return s;}

describe('reminder menu',()=>{
  it('opens the reminder home from the main menu',async()=>{
    const s=await home();
    expect(s.last().text).toBe(HOME);
    expect(s.labels()).toEqual([['🔔 Сповіщення'],['🖥 Повідомлення на екрані'],['📋 Активні та заплановані'],['🧹 Очистити…'],['← Назад']]);
    await s.tap('Назад');expect(s.labels().flat()).toContain('⚙️ Налаштування');
  });
  it('schedules a delayed overlay with countdown after review',async()=>{
    const s=await home();await s.tap('Повідомлення на екрані');
    expect(s.last().text).toBe('Введіть текст повідомлення:');expect(s.labels()).toEqual([['Скасувати']]);
    await s.say('Завершуй гру, будь ласка.');
    expect(s.last().text).toBe('Коли показати повідомлення?');expect(s.labels()).toEqual([['Зараз'],['Через…'],['Скасувати']]);
    await s.tap('Через…');expect(s.labels()).toEqual([['5 хв','10 хв','15 хв','30 хв'],['Інший час'],['Скасувати']]);
    await s.tap('15 хв');expect(s.last().text).toBe('Показувати зворотний відлік у верхньому лівому куті?');
    await s.tap('Так');
    expect(s.last().text).toBe('🖥 Повідомлення на екрані\n\nТекст: Завершуй гру, будь ласка.\nПоказати: через 15 хвилин, о 14:15\n'+
      'Зворотний відлік: увімкнено\nКнопка закриття: є\nПовторення: немає');
    expect(s.labels()).toEqual([['✅ Запланувати'],['⚙️ Додаткові параметри'],['Скасувати']]);
    expect(actions(s)).toEqual([]);
    await s.tap('Запланувати');
    expect(s.last().text).toBe(QUEUED+'\nЗаплановано на 14:15.');
    const [row]=actions(s);
    expect(row.action).toMatchObject({kind:'overlay',options:{message:'Завершуй гру, будь ласка.',countdown:true,dismissible:true,repeatEveryMinutes:null}});
    expect(Date.parse(row.action.targetAt)-Date.parse(row.action.createdAt)).toBe(15*60000);
  });
  it('sends an immediate notification without overlay-only options',async()=>{
    const s=await home();await s.tap('Сповіщення');await s.say('Привіт');await s.tap('Зараз');
    expect(s.last().text).toBe('🔔 Сповіщення\n\nТекст: Привіт\nПоказати: зараз');expect(s.labels()).toEqual([['✅ Надіслати'],['Скасувати']]);
    await s.tap('Надіслати');expect(s.last().text).toBe(QUEUED);
    expect(actions(s)[0].action).toMatchObject({kind:'notify',options:{message:'Привіт',countdown:false}});
  });
  it('configures repetition or a buttonless duration and returns to review',async()=>{
    const s=await home();await s.tap('Повідомлення на екрані');await s.say('Час зробити перерву');await s.tap('Зараз');
    await s.tap('Додаткові параметри');
    expect(s.last().text).toBe('Додаткові параметри');
    expect(s.labels()).toEqual([['Показати один раз ✓'],['Повторювати після закриття'],['Без кнопки закриття'],['← Назад']]);
    await s.tap('Повторювати');expect(s.last().text).toBe('Через скільки хвилин повторювати після закриття? Від 1 до 1439.');
    await s.say('0');expect(s.last().text).toBe('Вкажіть ціле число хвилин від 1 до 1439.');
    await s.say('2');expect(s.last().text).toContain('Повторення: через 2 хв після закриття, до опівночі');
    await s.tap('Додаткові параметри');await s.tap('Без кнопки');
    expect(s.last().text).toBe('Скільки секунд показувати без кнопки закриття? Від 1 до 3600.');
    await s.say('60');
    expect(s.last().text).toBe('🖥 Повідомлення на екрані\n\nТекст: Час зробити перерву\nПоказати: зараз\nКнопка закриття: немає, показ 60 с\nПовторення: немає');
    await s.tap('Надіслати');
    expect(actions(s)[0].action.options).toEqual({message:'Час зробити перерву',countdown:false,dismissible:false,durationSeconds:60});
  });
  it('accepts a custom delay and validates it',async()=>{
    const s=await home();await s.tap('Сповіщення');await s.say('Вечеря');await s.tap('Через…');await s.tap('Інший час');
    expect(s.last().text).toBe('Введіть затримку в хвилинах, від 1 до 1439.');
    await s.say('1440');expect(s.last().text).toBe('Вкажіть ціле число хвилин від 1 до 1439.');
    await s.say('45');await s.tap('Ні');
    expect(s.last().text).toBe('🔔 Сповіщення\n\nТекст: Вечеря\nПоказати: через 45 хвилин, о 14:45\nЗворотний відлік: вимкнено');
  });
  it('validates message length',async()=>{
    const s=await home();await s.tap('Сповіщення');await s.say('я'.repeat(1001));
    expect(s.last().text).toBe('Текст має містити від 1 до 1000 символів.');
  });
  it('cancels without creating anything and makes duplicate submissions harmless',async()=>{
    const s=await home();await s.tap('Сповіщення');await s.say('Привіт');await s.tap('Скасувати');
    expect(s.last().text).toBe('Скасовано.\n\n'+HOME);expect(actions(s)).toEqual([]);
    await s.tap('Сповіщення');await s.say('Привіт');await s.tap('Зараз');const submit=s.button('Надіслати');
    await Promise.all([s.handle(s.press('1',submit)),s.handle(s.press('1',submit))]);
    expect(actions(s)).toHaveLength(1);
    const done=s.last();await s.handle(s.press('1',submit));
    const answers=s.calls.filter(c=>c.kind==='answer');expect(answers.at(-1)).toEqual({kind:'answer',text:'Це меню застаріло. Відкрийте /start знову.'});
    expect(s.last()).toBe(done);
  });
});

describe('free use',()=>{
  it('explains at the start of creation during free use without creating anything',async()=>{
    const s=await setup();await s.say('/free on');await s.say('/start');await s.tap('Нагадування');await s.tap('Сповіщення');
    expect(s.last().text).toBe(FREE);expect(s.labels()).toEqual([['Перейти до ліміту часу'],['← Назад']]);
    expect(actions(s)).toEqual([]);
    await s.tap('Перейти до ліміту часу');expect(s.last().text.startsWith('⏱ Ліміт часу')).toBe(true);
  });
  it('records a command made during free use as skipped and tells everyone',async()=>{
    const s=await setup();await s.say('/free on');await s.say('/notify Привіт');
    expect(s.last().text).toBe(FREE);
    expect(actions(s)[0]).toMatchObject({state:'skipped',open:false});
    expect(events(s,'status').at(-1)!.recipients.map((r:any)=>r.userId).sort()).toEqual(['1','2']);
  });
});

describe('reminder commands',()=>{
  it.each([
    ['/notify Привіт',{kind:'notify',options:{message:'Привіт',countdown:false}},0],
    ['/notify +15 countdown Час на перерву',{kind:'notify',options:{message:'Час на перерву',countdown:true}},15],
    ['/overlay Завершуй гру',{kind:'overlay',options:{message:'Завершуй гру',countdown:false,dismissible:true,repeatEveryMinutes:null}},0],
    ['/overlay +5 repeat=2 Час перерви',{kind:'overlay',options:{message:'Час перерви',countdown:false,dismissible:true,repeatEveryMinutes:2}},5],
    ['/overlay nodismiss=30 Увага <b>тест</b>',{kind:'overlay',options:{message:'Увага <b>тест</b>',countdown:false,dismissible:false,durationSeconds:30}},0],
  ])('%s creates the exact action',async(command,expected,delay)=>{
    const s=await setup();await s.say(command);
    expect(s.last().text).toBe(delay?`${QUEUED}\nЗаплановано на 14:${String(delay).padStart(2,'0')}.`:QUEUED);
    const [row]=actions(s);expect(row.action).toMatchObject(expected);
    expect(Date.parse(row.action.targetAt)-Date.parse(row.action.createdAt)).toBe(delay*60000);
  });
  it.each([
    ['/overlay repeat=5 nodismiss=10 Текст','Повторення не поєднується з показом без кнопки закриття.'],
    ['/notify countdown Текст','Зворотний відлік можливий лише для відкладеного нагадування.'],
    ['/notify repeat=5 Текст','Використання: /notify [+ХВИЛИНИ] [countdown] ТЕКСТ, наприклад /notify +15 countdown Час на перерву.'],
    ['/overlay +0 Текст','Використання: /overlay [+ХВИЛИНИ] [countdown] [repeat=ХВИЛИНИ | nodismiss=СЕКУНДИ] ТЕКСТ.'],
    ['/overlay nodismiss=3601 Текст','Використання: /overlay [+ХВИЛИНИ] [countdown] [repeat=ХВИЛИНИ | nodismiss=СЕКУНДИ] ТЕКСТ.'],
    ['/notify +15','Використання: /notify [+ХВИЛИНИ] [countdown] ТЕКСТ, наприклад /notify +15 countdown Час на перерву.'],
    ['/notify '+'я'.repeat(1001),'Текст має містити від 1 до 1000 символів.'],
  ])('rejects %j without creating an action',async(command,text)=>{
    const s=await setup();await s.say(command);expect(s.last().text).toBe(text);expect(actions(s)).toEqual([]);
  });
  it('accepts a line break between options and the message, keeping its spacing',async()=>{
    const s=await setup();await s.say('/notify +5\nРядок 1\n  Рядок 2');
    expect(actions(s)[0].action.options.message).toBe('Рядок 1\n  Рядок 2');
  });
  it('opens the creation flow for a bare command',async()=>{
    const s=await setup();await s.say('/overlay');expect(s.last().text).toBe('Введіть текст повідомлення:');
    await s.say('Привіт');expect(s.last().text).toBe('Коли показати повідомлення?');
  });
});

describe('/pending',()=>{
  it('pages a long list below the Telegram message limit',async()=>{
    const s=await setup();
    for(let i=0;i<40;i++)await s.say(`/overlay +${i+1} countdown repeat=3 ${'Повідомлення '.repeat(15)}${i}`);
    const before=s.calls.length;await s.say('/pending');
    const pages=s.calls.slice(before).filter(c=>c.kind==='send');
    expect(pages.length).toBeGreaterThan(1);for(const p of pages)expect(p.text!.length).toBeLessThanOrEqual(3500);
    expect(pages.map(p=>p.text).join('\n').match(/^\d+\. 🖥/gm)).toHaveLength(40);
  });
  it('lists open actions with schedule, countdown, repetition and midnight end',async()=>{
    const s=await setup();
    await s.say('/pending');expect(s.last().text).toBe('📋 Активні та заплановані\n\nНемає активних або запланованих нагадувань.');
    await s.say('/overlay +15 countdown Завершуй гру, будь ласка.');await s.say('/overlay repeat=2 Час зробити перерву');
    await s.say('/notify '+'дуже довге повідомлення '.repeat(10));
    await s.say('/pending');
    expect(s.last().text).toBe(['📋 Активні та заплановані','',
      '1. 🖥 Час зробити перерву','   Очікує доставки на ноутбук','   Повторення через 2 хв після закриття','   Діє до опівночі',
      '2. 🔔 '+('дуже довге повідомлення '.repeat(10).trim().slice(0,79))+'…','   Очікує доставки на ноутбук',
      '3. 🖥 Завершуй гру, будь ласка.','   Заплановано на 14:15 · відлік увімкнено'].join('\n'));
    expect(s.labels()).toEqual([['🔄 Оновити'],['🧹 Очистити…'],['← Назад']]);
    await s.tap('Очистити');expect(s.last().text).toBe('Що очистити?');
    await s.tap('Назад');expect(s.last().text).toBe(HOME);
  });
});

describe('coordination wording',()=>{
  it('names the caregiver, reminder, message and schedule for the other caregivers',async()=>{
    const s=await setup();await s.say('/overlay +15 Завершуй гру');
    expect(events(s,'status').at(-1)!.text).toBe('Нове нагадування від «Parent»: повідомлення на екрані «Завершуй гру». Показати: о 14:15. Очікуємо підтвердження ноутбука.');
    await s.say('/free on');await s.say('/notify Привіт');
    expect(events(s,'status').at(-1)!.text).toBe('Нагадування від «Parent» пропущено, бо ввімкнено вільний режим: сповіщення «Привіт».');
    await s.say('/clear manual');expect(events(s,'status').at(-1)!.text).toBe('«Parent» очищує ручні нагадування. Очікуємо підтвердження ноутбука.');
  });
});
