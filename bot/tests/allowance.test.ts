import {describe,it,expect} from 'vitest';
import {setup,events,type Bot} from './bot-fixture.js';
import {root,NOW} from './delivery-fixture.js';

const SAVED_PENDING='\nНоутбук: очікує застосування.';
const stored=(s:Bot)=>s.db.data.get(root+'/settings/current');
const catalog=[{id:'["Games"]',path:['Games']},{id:'["Games","Minecraft"]',path:['Games','Minecraft']},{id:'["Media"]',path:['Media']},{id:'uncategorized',path:null}];
async function withCatalog(entries=catalog){
  const s=await setup();
  s.db.data.set(root+'/live/current',{sequence:1,value:{observedAt:NOW,state:'active',app:'Minecraft',title:null,category:null,rulesRevision:'r',categoryCatalog:entries}});
  return s;
}
const nested=(value:unknown):boolean=>Array.isArray(value)?value.some(v=>Array.isArray(v)||nested(v)):
  !!value&&typeof value==='object'&&Object.values(value).some(nested);
const coordination=(s:Bot)=>events(s,'coordination').map(e=>e.text);

describe('/limit',()=>{
  it('shows the allowance status with every action',async()=>{
    const s=await setup();await s.say('/limit');
    expect(s.last().text).toBe('⏱ Ліміт часу\n\nСьогодні: 4 год 00 хв (щоденний ліміт)\nЩоденний ліміт: 4 год 00 хв\nВраховано сьогодні: даних немає\n'+
      'Категорії: не вибрано\nВільний режим: вимкнено');
    expect(s.labels()).toEqual([['Змінити на сьогодні'],['Змінити щоденний ліміт'],['Категорії'],['Увімкнути вільний режим'],['← Назад']]);
  });
  it.each([
    ['/limit 2:30 today','Збережено: ліміт на сьогодні 2 год 30 хв.',{todayOverride:{date:'2026-10-28',limitMs:9000000},defaultLimitMs:14400000}],
    ['/limit 90 хв today','Збережено: ліміт на сьогодні 1 год 30 хв.',{todayOverride:{date:'2026-10-28',limitMs:5400000}}],
    ['/limit 3h daily','Збережено: щоденний ліміт 3 год 00 хв.',{defaultLimitMs:10800000,todayOverride:null}],
    ['/limit 1 год 15 хв daily','Збережено: щоденний ліміт 1 год 15 хв.',{defaultLimitMs:4500000}],
    ['/limit 0 today','Збережено: ліміт на сьогодні 0 хв.',{todayOverride:{date:'2026-10-28',limitMs:0}}],
  ])('%s saves directly and coordinates',async(command,text,expected)=>{
    const s=await setup();await s.say(command);
    expect(s.last().text).toBe(text+SAVED_PENDING);expect(stored(s)).toMatchObject(expected);
    expect(coordination(s)).toHaveLength(1);expect(coordination(s)[0]).toContain(text.replace('Збережено: ','').replace(/^./,c=>c.toUpperCase()));
  });
  it.each(['/limit 2:30','/limit today','/limit 2:30 weekly'])('explains usage for %j',async command=>{
    const s=await setup();await s.say(command);
    expect(s.last().text).toBe('Використання: /limit, /limit ТРИВАЛІСТЬ today або /limit ТРИВАЛІСТЬ daily, наприклад /limit 2:30 today.');
  });
  it.each(['25:00','24:01','-5','2:75','abc','1.5'])('rejects duration %j',async value=>{
    const s=await setup();await s.say(`/limit ${value} today`);
    expect(s.last().text).toBe('Вкажіть тривалість від 0 до 24 годин, наприклад 2:30, 90 хв або 1 год 30 хв.');expect(stored(s).revision).toBe(0);
  });
  it('requires review before a menu limit change and explains its effect',async()=>{
    const s=await setup();await s.say('/limit');await s.tap('Змінити щоденний ліміт');
    expect(s.last().text).toBe('Введіть новий щоденний ліміт, наприклад 4:00 або 240 хв.');expect(s.labels()).toEqual([['Скасувати']]);
    await s.say('99:00');expect(s.last().text).toBe('Вкажіть тривалість від 0 до 24 годин, наприклад 2:30, 90 хв або 1 год 30 хв.');
    await s.say('3:00');
    expect(s.last().text).toBe('Перевірте зміну\n\nНовий щоденний ліміт: 3 год 00 хв\nДіє з сьогодні й надалі та замінює зміну лише на сьогодні. Інших батьків буде повідомлено.');
    expect(s.labels()).toEqual([['Підтвердити'],['Скасувати']]);expect(stored(s).revision).toBe(0);
    await s.tap('Підтвердити');
    expect(s.last().text.startsWith('Збережено: щоденний ліміт 3 год 00 хв.'+SAVED_PENDING+'\n\n⏱ Ліміт часу\n\nСьогодні: 3 год 00 хв (щоденний ліміт)')).toBe(true);
  });
  it('cancels a menu change without mutation and returns to the main menu on back',async()=>{
    const s=await setup();await s.say('/start');await s.tap('Ліміт часу');
    await s.tap('Змінити на сьогодні');expect(s.last().text).toBe('Введіть ліміт на сьогодні, наприклад 2:30 або 90 хв.');
    await s.say('1:00');
    expect(s.last().text).toBe('Перевірте зміну\n\nЛіміт лише на сьогодні: 1 год 00 хв\nЩоденний ліміт не зміниться. Зміна діє до опівночі. Інших батьків буде повідомлено.');
    await s.tap('Скасувати');expect(s.last().text.startsWith('Скасовано.\n\n⏱ Ліміт часу')).toBe(true);
    await s.tap('Назад');expect(s.labels().flat()).toContain('⚙️ Налаштування');
    expect(stored(s).revision).toBe(0);expect(events(s)).toEqual([]);
  });
  it('rejects stale limit buttons and duplicate confirmations',async()=>{
    const s=await setup();await s.say('/limit');const old=s.button('Змінити на сьогодні');
    await s.tap('Змінити на сьогодні');await s.say('1:00');const confirm=s.button('Підтвердити');
    await Promise.all([s.handle(s.press('1',confirm)),s.handle(s.press('1',confirm))]);
    expect(stored(s).revision).toBe(1);expect(coordination(s)).toHaveLength(1);
    await s.handle(s.press('1',old));
    const answers=s.calls.filter(c=>c.kind==='answer');expect(answers.at(-1)).toEqual({kind:'answer',text:'Це меню застаріло. Відкрийте /limit знову.'});
  });
});

describe('free use and restore',()=>{
  it('toggles free use by command with saved-versus-applied state',async()=>{
    const s=await setup();
    await s.say('/free on');expect(s.last().text).toBe('Збережено: вільний режим увімкнено до опівночі.'+SAVED_PENDING);
    expect(stored(s).freeUseDate).toBe('2026-10-28');
    await s.say('/free on');expect(s.last().text).toBe('Без змін: вільний режим уже увімкнено.');
    await s.say('/free off');expect(s.last().text).toBe('Збережено: вільний режим вимкнено.'+SAVED_PENDING);
    await s.say('/free maybe');expect(s.last().text).toBe('Використання: /free on або /free off.');
  });
  it('reviews free use in the menu and swaps its button',async()=>{
    const s=await setup();await s.say('/limit');await s.tap('Увімкнути вільний режим');
    expect(s.last().text).toBe('Перевірте зміну\n\nУвімкнути вільний режим до опівночі?\nНагадування й попередження про ліміт буде пропущено, облік часу продовжиться. Інших батьків буде повідомлено.');
    await s.tap('Підтвердити');
    expect(s.last().text).toContain('Вільний режим: увімкнено до опівночі');expect(s.labels()).toContainEqual(['Вимкнути вільний режим']);
  });
  it('restores Clear-all suppression only, and says when free use still pauses reminders',async()=>{
    const s=await setup();
    await s.say('/restore');expect(s.last().text).toBe('Без змін: автоматичні нагадування не вимкнено.');
    await s.actions.clearActions({deviceId:root.slice(8),userId:'2',chatId:'2',pairingId:s.db.data.get(root+'/parents/2').pairingId},'all','clear-2');
    await s.say('/free on');await s.say('/limit');
    expect(s.last().text).toContain('Автоматичні нагадування: вимкнено до опівночі');expect(s.labels()).toContainEqual(['Відновити нагадування']);
    await s.tap('Відновити нагадування');
    expect(s.last().text).toBe('Перевірте зміну\n\nВідновити автоматичні нагадування на сьогодні?\nСкасовані ручні нагадування не повернуться. Інших батьків буде повідомлено.');
    await s.tap('Підтвердити');
    expect(s.last().text.startsWith('Збережено: автоматичні нагадування відновлено.\nВільний режим усе ще увімкнено, тому нагадування призупинені, доки його не вимкнуть.'+SAVED_PENDING)).toBe(true);
    expect(stored(s)).toMatchObject({suppressedDate:null,freeUseDate:'2026-10-28'});
  });
});

describe('categories',()=>{
  it('lists, adds and removes categories from the laptop catalog with review',async()=>{
    const s=await withCatalog();await s.say('/categories');
    expect(s.last().text).toBe('Категорії для обліку\n\nВибрано: нічого, тому нічого не враховується.');
    expect(s.labels()).toEqual([['Додати'],['← Назад']]);
    await s.tap('Додати');
    expect(s.last().text).toBe('Оберіть категорію, яку додати до обліку:');
    expect(s.labels()).toEqual([['Games'],['Games › Minecraft'],['Media'],['Без категорії'],['← Назад']]);
    await s.tap('Games');
    expect(s.last().text).toBe('Перевірте зміну\n\nДодати до обліку: Games\nСьогоднішній облік буде перераховано з усіх даних за день. Інших батьків буде повідомлено.');
    expect(nested(s.db.data.get(root+'/sessions/1'))).toBe(false);
    await s.tap('Підтвердити');
    expect(s.last().text).toBe('Збережено: категорії для обліку — Games.'+SAVED_PENDING+'\n\nКатегорії для обліку\n\nВибрано:\n• Games');
    expect(stored(s).selectedPaths).toEqual([{segments:['Games']}]);
    // A descendant of a selected category is already counted and is not offered.
    await s.tap('Додати');expect(s.labels()).toEqual([['Media'],['Без категорії'],['← Назад']]);
    await s.tap('Без категорії');await s.tap('Підтвердити');expect(stored(s).selectedUncategorized).toBe(true);
    await s.tap('Видалити');expect(s.labels()).toEqual([['Games'],['Без категорії'],['← Назад']]);
    await s.tap('Games');expect(s.last().text.startsWith('Перевірте зміну\n\nПрибрати з обліку: Games')).toBe(true);
    await s.tap('Підтвердити');
    expect(stored(s)).toMatchObject({selectedPaths:[],selectedUncategorized:true});
    expect(coordination(s).at(-1)).toContain('Категорії для обліку: Без категорії.');
  });
  it('pages long catalogs and keeps picks bound to the rendered page',async()=>{
    const entries=Array.from({length:19},(_,i)=>({id:JSON.stringify(['Cat'+String(i).padStart(2,'0')]),path:['Cat'+String(i).padStart(2,'0')]}));
    const s=await withCatalog(entries);await s.say('/categories');await s.tap('Додати');
    expect(s.labels().slice(0,8).flat()).toEqual(entries.slice(0,8).map(e=>e.path[0]));expect(s.labels().at(-2)).toEqual(['›']);
    await s.tap('›');await s.tap('›');expect(s.labels().slice(0,3).flat()).toEqual(['Cat16','Cat17','Cat18']);expect(s.labels().at(-2)).toEqual(['‹']);
    await s.tap('Cat17');expect(s.last().text).toContain('Додати до обліку: Cat17');
  });
  it('explains a missing catalog',async()=>{
    const s=await setup();await s.say('/categories');await s.tap('Додати');
    expect(s.last().text).toBe('Список категорій ще не отримано з ноутбука. Спробуйте пізніше.');expect(s.labels()).toEqual([['← Назад']]);
  });
  it('adds and removes by command using the displayed name',async()=>{
    const s=await withCatalog();
    await s.say('/add_category games > minecraft');expect(s.last().text).toBe('Збережено: категорії для обліку — Games › Minecraft.'+SAVED_PENDING);
    await s.say('/add_category Games › Minecraft');expect(s.last().text).toBe('Без змін: «Games › Minecraft» уже враховується.');
    await s.say('/add_category Ігри');expect(s.last().text).toBe('Категорію «Ігри» не знайдено. Перелік: /categories');
    await s.say('/remove_category Media');expect(s.last().text).toBe('Без змін: «Media» не враховується.');
    await s.say('/remove_category games/minecraft');expect(stored(s).selectedPaths).toEqual([]);
    await s.say('/add_category Games');await s.say('/remove_category Games › Minecraft');
    expect(s.last().text).toBe('«Games › Minecraft» враховується через «Games». Щоб її не враховувати, приберіть «Games».');
    await s.say('/add_category');expect(s.last().text).toBe('Використання: /add_category НАЗВА, наприклад /add_category Games › Minecraft.');
  });
});

describe('/clear',()=>{
  const confirmAll='Скасувати всі активні та заплановані\nнагадування й вимкнути попередження\nпро денний ліміт до опівночі?\n\nОблік часу та щогодинні звіти продовжаться.';
  it('clears manual reminders directly and confirms Clear all first',async()=>{
    const s=await setup();
    await s.say('/clear manual');expect(s.last().text).toBe('Запит збережено: ручні нагадування буде скасовано.\n⏳ Очікуємо підтвердження від ноутбука.');
    expect(stored(s).suppressedDate).toBeNull();
    await s.say('/clear all');expect(s.last().text).toBe(confirmAll);expect(s.labels()).toEqual([['✅ Очистити всі'],['Скасувати']]);
    expect(stored(s).suppressedDate).toBeNull();
    await s.tap('Очистити всі');
    expect(s.last().text).toBe('Запит збережено: усі нагадування буде скасовано, попередження про ліміт вимкнено до опівночі.\n⏳ Очікуємо підтвердження від ноутбука.');
    expect(stored(s).suppressedDate).toBe('2026-10-28');
  });
  it('offers the scope menu, cancels without effect and explains usage',async()=>{
    const s=await setup();await s.say('/clear');
    expect(s.last().text).toBe('Що очистити?');expect(s.labels()).toEqual([['Лише ручні'],['Усі нагадування'],['← Назад']]);
    await s.tap('Усі нагадування');expect(s.last().text).toBe(confirmAll);
    await s.tap('Скасувати');expect(s.last().text).toBe('Скасовано.');expect(stored(s).suppressedDate).toBeNull();
    expect(events(s)).toEqual([]);
    await s.say('/clear later');expect(s.last().text).toBe('Використання: /clear, /clear manual або /clear all.');
  });
});
