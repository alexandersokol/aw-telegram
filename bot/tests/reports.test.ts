import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
import {defaultSettings,type DaySummary,type Settings,type LiveState} from '../src/contracts.js';
import {dayBounds} from '../src/clock.js';

async function load(){
  expect(existsSync(new URL('../src/telegram/reports.ts',import.meta.url)),'report formatter is missing').toBe(true);
  return import('../src/telegram/reports.js');
}
const NOW='2026-10-29T12:32:00.000Z'; // 14:32 Kyiv
const study={id:'["Study"]',path:['Study']},games={id:'["Games"]',path:['Games']},other={id:'uncategorized',path:null};
function day(date:string,rows:[string,any,number][],extra:Partial<DaySummary>={}):DaySummary{
  const leaves=new Map<string,{category:any;totalMs:number}>();
  for(const [,category,ms] of rows){const l=leaves.get(category.id)??{category,totalMs:0};l.totalMs+=ms;leaves.set(category.id,l);}
  const total=rows.reduce((s,r)=>s+r[2],0);
  return {date,leafTotalsMs:[...leaves.values()],appLeafTotalsMs:rows.map(([app,c,ms])=>({app,categoryId:c.id,totalMs:ms})),
    totalActiveMs:total,selectedTotalMs:0,settingsRevision:0,rulesRevision:'r',availableFrom:dayBounds(date).start,
    availableThrough:date==='2026-10-29'?NOW:dayBounds(date).end,partial:false,sequence:1,...extra} as DaySummary;
}
const selected=(extra:Partial<Settings>={}):Settings=>({...defaultSettings(),revision:3,selectedPaths:[['Games']],...extra});
function data(extra:any={}){
  return {now:NOW,settings:selected(),days:new Map<string,DaySummary>([['2026-10-29',day('2026-10-29',[
      ['Minecraft',games,5400000],['Chrome',games,2700000],['Chrome',study,3600000],['Editor',study,600000]])]]),
    live:null as LiveState|null,health:null,lastContactAt:NOW,...extra};
}
const live=(observedAt:string,extra:Partial<LiveState>={}):LiveState=>({observedAt,state:'active',app:'Minecraft',title:'Світ <b>1</b>\nрівень 2',
  category:games,rulesRevision:'r',categoryCatalog:[],...extra});

describe('usage reports',()=>{
  it('lists only selected-category app time, sorted descending, with the selected total and limit',async()=>{
    const {renderUsage}=await load(),[page,...rest]=renderUsage('today',data());
    expect(rest).toEqual([]);
    expect(page).toBe(['📊 Сьогодні, 29.10','Враховано: 2 год 15 хв','Дані станом на 14:32','Ліміт: 4 год 00 хв · залишилось 1 год 45 хв','',
      '1. Minecraft — 1 год 30 хв','2. Chrome — 45 хв'].join('\n'));
  });
  it('recomputes rows under the current selection, including an app spanning both categories',async()=>{
    const {renderUsage}=await load();
    const page=renderUsage('today',data({settings:selected({selectedPaths:[['Study']]})}))[0]!;
    expect(page).toContain('1. Chrome — 1 год 00 хв\n2. Editor — 10 хв');expect(page).not.toContain('Minecraft');
  });
  it('marks partial and first-day data and never shows a measured zero for missing data',async()=>{
    const {renderUsage}=await load();
    const partial=data({days:new Map([['2026-10-29',day('2026-10-29',[['Minecraft',games,60000]],{partial:true,availableFrom:'2026-10-29T08:00:00.000Z'})]])});
    expect(renderUsage('today',partial)[0]).toContain('Враховано: 1 хв (неповні дані)\nДані з 10:00 до 14:32');
    const missing=renderUsage('yesterday',data())[0]!;
    expect(missing).toBe('📊 Учора, 28.10\nДаних за цей день немає.');
  });
  it('explains an empty selection instead of listing apps',async()=>{
    const {renderUsage}=await load(),page=renderUsage('today',data({settings:selected({selectedPaths:[]})}))[0]!;
    expect(page).toContain('Категорії для обліку не вибрано, тому нічого не враховується.');expect(page).not.toMatch(/^1\. /m);
  });
  it('shows free use instead of a remaining allowance and an exceeded allowance accurately',async()=>{
    const {renderUsage}=await load();
    expect(renderUsage('today',data({settings:selected({freeUseDate:'2026-10-29'})}))[0]).toContain('Ліміт: вільний режим до опівночі');
    expect(renderUsage('today',data({settings:selected({todayOverride:{date:'2026-10-29',limitMs:3600000}})}))[0]).toContain('Ліміт: 1 год 00 хв · перевищено на 1 год 15 хв');
  });
  it('adds the live app and single latest title only to today, distinguishing last-known activity',async()=>{
    const {renderUsage}=await load();
    expect(renderUsage('today',data({live:live('2026-10-29T12:31:30.000Z')}))[0]).toMatch(/\n\nЗараз: Minecraft — «Світ <b>1<\/b> рівень 2»$/);
    expect(renderUsage('today',data({live:live('2026-10-29T11:00:00.000Z')}))[0]).toMatch(/\n\nОстання активність о 13:00: Minecraft — «Світ <b>1<\/b> рівень 2»$/);
    expect(renderUsage('today',data({live:live('2026-10-29T12:31:30.000Z',{state:'afk'})}))[0]).toMatch(/\n\nЗараз неактивний\. Остання програма: Minecraft$/);
    const days=new Map([['2026-10-28',day('2026-10-28',[['Minecraft',games,60000]])]]);
    expect(renderUsage('yesterday',data({days,live:live('2026-10-29T12:31:30.000Z')}))[0]).not.toContain('Світ');
  });
  it('summarizes seven Kyiv dates with today last and missing days marked',async()=>{
    const {renderUsage}=await load();
    const days=new Map<string,DaySummary>([['2026-10-29',day('2026-10-29',[['Minecraft',games,5400000]],{partial:true})],
      ['2026-10-27',day('2026-10-27',[['Minecraft',games,1800000]])],['2026-10-23',day('2026-10-23',[['Chrome',study,1800000]])]]);
    expect(renderUsage('week',data({days}))).toEqual([['📊 Останні 7 днів','Пт 23.10 — 0 хв','Сб 24.10 — немає даних','Нд 25.10 — немає даних',
      'Пн 26.10 — немає даних','Вт 27.10 — 30 хв','Ср 28.10 — немає даних','Чт 29.10 — 1 год 30 хв (сьогодні, неповні)','',
      'Разом: 2 год 00 хв за 3 дні з даними (неповні дані).'].join('\n')]);
  });
  it('paginates long reports below the Telegram limit without dropping or repeating apps',async()=>{
    const {renderUsage}=await load();
    const rows:[string,any,number][]=Array.from({length:256},(_,i)=>[`App ${String(i).padStart(3,'0')} ${'я'.repeat(60)}`,games,(300-i)*1000]);
    const pages=renderUsage('today',data({days:new Map([['2026-10-29',day('2026-10-29',rows)]])}));
    expect(pages.length).toBeGreaterThan(1);
    for(const page of pages)expect(page.length).toBeLessThanOrEqual(3500);
    const listed=pages.join('\n').match(/^\d+\. App \d{3}/gm)!;
    expect(listed).toHaveLength(256);expect(new Set(listed).size).toBe(256);
    expect(pages[1]!.startsWith('📊 Сьогодні, 29.10 (продовження)')).toBe(true);
  });
});

describe('laptop status',()=>{
  it('reports connection, ActivityWatch, live app, usage, free use and suppression',async()=>{
    const {renderStatus}=await load();
    const text=renderStatus(data({live:live('2026-10-29T12:31:30.000Z'),health:{observedAt:NOW,awState:'ready',lastSuccessAt:NOW,reportError:null},
      settings:selected({suppressedDate:'2026-10-29'})}));
    expect(text).toBe(['💻 Стан ноутбука','Зв’язок: на зв’язку, остання синхронізація о 14:32','ActivityWatch: працює',
      'Зараз: Minecraft — «Світ <b>1</b> рівень 2»','Сьогодні: 2 год 15 хв з 4 год 00 хв, залишилось 1 год 45 хв',
      'Вільний режим: вимкнено','Автоматичні нагадування: вимкнено до опівночі'].join('\n'));
  });
  it('distinguishes offline and never-synchronized laptops and unavailable data',async()=>{
    const {renderStatus}=await load();
    const offline=renderStatus(data({lastContactAt:'2026-10-28T08:01:00.000Z',health:{observedAt:NOW,awState:'unavailable',lastSuccessAt:null,reportError:null},days:new Map()}));
    expect(offline).toContain('Зв’язок: немає зв’язку з 10:01, 28.10');expect(offline).toContain('ActivityWatch: недоступний');
    expect(offline).toContain('Сьогодні: даних немає');
    expect(renderStatus(data({lastContactAt:null}))).toContain('Зв’язок: ноутбук ще не синхронізувався');
  });
});
