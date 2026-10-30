/** Task 11f catalogues: parity (also enforced by the compiler), no empty value, the language_code fallback, and
 * durations in both languages. */
import {describe,it,expect} from 'vitest';
import {defaultSettings} from '../src/contracts.js';
import {text,languageOf,storedLang,both,LANGS} from '../src/telegram/i18n/index.js';
import {parseDuration} from '../src/telegram/allowance.js';

const settings={...defaultSettings(),endtimeEnabled:true};
/** Sample arguments for every function in the catalogue; a new function without samples fails the parity test. */
const SAMPLES:Record<string,unknown[]>={
  duration:[5400000],categoryLabel:[['Games','Minecraft']],selectionLabel:[[['Games']],true],quote:['x'],
  hourlyLabel:[true],endtimeLabel:[settings],hourlySaved:[false],savedText:['x.',true,'note'],
  endtimeStatus:[settings,0,'2026-10-28'],endtimeSaved:[settings,true,true],endtimeReview:['21:00'],
  limitStatus:[{today:'2 h',override:true,daily:'2 h',usage:null,partial:false,categories:null,free:true,suppressed:true}],
  categoriesScreen:[['Games']],reviewToday:['2 h'],reviewDaily:['2 h'],reviewFree:[true],reviewCategory:[true,'Games'],
  savedToday:['2 h'],sameToday:['2 h'],savedDaily:['2 h'],sameDaily:['2 h'],savedFree:[true],sameFree:[false],
  savedCategories:['Games'],sameCategory:[true,'Games'],countedVia:['Games › A','Games'],notCounted:['A'],categoryNotFound:['A'],
  minutesShort:[5],secondsShort:[30],scheduledAt:['18:45'],
  reminderReview:[{kind:'overlay',message:'m',delay:{minutes:15,at:'18:45'},countdown:true,buttonless:null,repeat:2}],
  pendingButtonless:[30],pendingRepeat:[2],continued:['h'],coverageFrom:['10:00','12:00'],coverageAsOf:['12:00'],coveragePartial:['12:00'],
  limitLine:['2 h','1 h left'],left:['1 h'],over:['1 h'],liveAway:['app'],liveNow:['app',' — t'],liveLast:['13:00','app',''],
  dayHeader:['today','28.10'],counted:['1 h'],noData:['Mon 26.10'],weekTotal:['3 h',2,true],online:['13:00'],offline:['13:00'],
  awLine:['running',true],todayFree:['1 h',''],todayLimit:['1 h','2 h','1 h left',''],freeUseLine:[true],remindersLine:[false],
  reminderCreated:['overlay','m','Mama','18:45'],reminderSkipped:['notify','m','Mama'],clearing:['all','Mama'],receiptBatch:[2,1],
  settingsChangedBy:['Mama'],summaryEndtime:[true,'21:00'],summaryToday:['2 h'],summaryDaily:['2 h'],summaryCategories:['Games'],
  summaryFree:[true],summarySuppression:[false],currentTime:[30,true,'2026-10-28T12:00:00.000Z'],used:[30,false,'2026-10-28T12:00:00.000Z'],
  warning:[5],endtimeReached:['21:00','2026-10-28'],
};
/** Every leaf value of a catalogue, functions called with their samples, as [path, value]. */
function leaves(value:unknown,path:string):[string,unknown][] {
  if(typeof value==='function'){
    const key=path.split('.').at(-1)!;
    if(!(key in SAMPLES))return [[path,undefined]];
    return leaves(value(...SAMPLES[key]!),path);
  }
  if(Array.isArray(value))return value.flatMap((v,i)=>leaves(v,`${path}[${i}]`));
  if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>leaves(v,`${path}.${k}`));
  return [[path,value]];
}

describe('catalogues',()=>{
  it('have the same keys and shape, and no empty value',()=>{
    const uk=leaves(text('uk'),'uk'),en=leaves(text('en'),'en');
    expect(en.map(([p])=>p.slice(2))).toEqual(uk.map(([p])=>p.slice(2)));
    for(const [path,value] of [...uk,...en]){
      expect(typeof value,path).toBe('string');
      expect((value as string).trim(),path).not.toBe('');
    }
  });
  it('really are two languages',()=>{
    const uk=leaves(text('uk'),''),en=leaves(text('en'),'');
    const same=uk.filter(([p,v],i)=>v===en[i]![1]&&!/LANGUAGE_NAMES|LIMIT_LABELS\.(prev|next)|COMMANDS\[\d+\]\.command|categoryLabel|quote|WEEKDAYS/.test(p));
    expect(same.map(([p])=>p)).toEqual([]);
  });
  it('renders shared messages in every language',()=>{
    expect(both(t=>t.warning(null))).toEqual({uk:'Денний час вичерпано.',en:'Daily time is used up.'});
    expect(Object.keys(both(t=>t.HINT))).toEqual([...LANGS]);
  });
});

describe('choosing the language',()=>{
  it.each([['uk','uk'],['uk-UA','uk'],['UK','uk'],['ru','uk'],['ru-RU','uk'],['en','en'],['en-GB','en'],['de','en'],['ukr','en'],['',''],[undefined,'en'],[7,'en']])
  ('language_code %j gives %s',(code,lang)=>{expect(languageOf(code)).toBe(lang||'en');});
  it('reads only a known stored choice',()=>{
    expect([storedLang('uk'),storedLang('en'),storedLang('de'),storedLang(undefined)]).toEqual(['uk','en',undefined,undefined]);
  });
});

describe('durations',()=>{
  it.each([[0,'0 хв','0 min'],[30000,'менше 1 хв','under 1 min'],[90*60000,'1 год 30 хв','1 h 30 min'],[45*60000,'45 хв','45 min'],
    [24*3600000,'24 год 00 хв','24 h 00 min']])('%i ms renders as %s and %s',(ms,uk,en)=>{
    expect(text('uk').duration(ms)).toBe(uk);expect(text('en').duration(ms)).toBe(en);
  });
  it.each([['1 год 30 хв',90],['1 h 30 min',90],['90 хв',90],['90 min',90],['2:30',150],['2 h',120],['2 год',120],['1h30m',90],['90',90]])
  ('parses %j in either language',(input,minutes)=>{expect(parseDuration(input as string)).toBe((minutes as number)*60000);});
});
