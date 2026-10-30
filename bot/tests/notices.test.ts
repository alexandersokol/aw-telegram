/** UX-03: the author of a settings change or clear is told once when the laptop applies it. */
import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture,parent,identity,root,request} from './delivery-fixture.js';

/** Action planning that leaves only `spare` of its budget, standing in for a sync whose other writes are near 450. */
const busy=vi.hoisted(()=>({spare:null as number|null}));
vi.mock('../src/actions.js',async original=>{
  const actual:any=await original();
  return {...actual,planActionSync:async(...args:any[])=>{
    const writes=await actual.planActionSync(...args),budget=args[8] as number;
    if(busy.spare===null)return writes;
    return [...writes,...Array.from({length:budget-busy.spare-writes.length},(_,i)=>({ref:args[0].db.doc('filler/'+i),value:{i}}))];
  }};
});
import {DeviceApi} from '../src/deviceApi.js';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {OutboxService,TelegramHttpAdapter} from '../src/outbox.js';
import {cleanup} from '../src/cleanup.js';
import {appliedText} from '../src/notices.js';
import {text} from '../src/telegram/i18n/index.js';
const uk=text('uk'),APPLIED_PREFIX=uk.APPLIED_PREFIX;

function setup(){
  const f=fixture(),api=new DeviceApi(f.repo,f.clock);
  let sequence=0;
  const sync=(acks:{settings?:number;cancellation?:{revision:number;throughActionSequence:number}}={})=>api.syncDevice(identity,{...request(++sequence),acks:[
    ...(acks.settings===undefined?[]:[{id:randomUUID(),kind:'settings' as const,revision:acks.settings,appliedAt:f.clock()}]),
    ...(acks.cancellation?[{id:randomUUID(),kind:'cancellation' as const,...acks.cancellation,appliedAt:f.clock()}]:[])]});
  /** Applied events with their Ukrainian text (the authors here are Ukrainian). */
  const applied=()=>[...f.db.data].filter(([k,v])=>k.startsWith('events/')&&v.kind==='applied').map(([,v])=>({...v,text:v.text.uk}));
  const notices=()=>[...f.db.data.keys()].filter(k=>k.startsWith(root+'/appliedNotices/'));
  /** The outbox row of the first "applied" message; the issuer gets no coordination copy. */
  const appliedRow=()=>[...f.db.data].find(([k,v])=>k.startsWith('outbox/')&&v.eventId===applied()[0].id)![1].id as string;
  return {...f,api,sync,applied,notices,appliedRow,settings:new SettingsService(f.repo,f.clock),actions:new ActionService(f.repo,f.clock),
    revision:()=>f.db.data.get(root+'/settings/current').revision as number};
}
const limit=(minutes:number)=>({kind:'setTodayLimit' as const,ms:minutes*60000});

describe('applied messages',()=>{
  it('records the author and the coordination summary of each change, and nothing for a no-op',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await s.settings.updateSettings(parent('1'),limit(10),'b');  // «Без змін»
    expect(s.notices()).toEqual([root+'/appliedNotices/s-1']);
    expect(s.db.data.get(root+'/appliedNotices/s-1')).toEqual({pairingId:parent('1').pairingId,userId:'1',
      summary:{uk:'ліміт на сьогодні 10 хв',en:"today's limit 10 min"},lang:'uk',createdAt:s.clock(),settingsRevision:1});
  });
  it('sends one message listing both changes of one author, to that author only',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');s.advance(1000);
    await s.settings.updateSettings(parent('1'),{kind:'setFreeUse',enabled:true},'b');
    await s.sync({settings:s.revision()});
    expect(s.applied()).toMatchObject([{recipients:[{userId:'1',pairingId:parent('1').pairingId,deviceId:identity.deviceId}],
      text:'✅ Ноутбук застосував: ліміт на сьогодні 10 хв; вільний режим увімкнено до опівночі.'}]);
    expect(s.notices()).toEqual([]);
  });
  it('sends one message to each of two authors',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await s.settings.updateSettings(parent('2'),{kind:'setDefaultLimit',ms:3*3600000},'b');
    await s.sync({settings:s.revision()});
    expect(s.applied().map(e=>[e.recipients.map((r:any)=>r.userId),e.text])).toEqual([
      [['1'],'✅ Ноутбук застосував: ліміт на сьогодні 10 хв.'],[['2'],'✅ Ноутбук застосував: щоденний ліміт 3 год 00 хв.']]);
  });
  it('sends one message for a setting and a clear acknowledged together',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');s.advance(1000);
    const cleared=await s.actions.clearActions(parent('1'),'manual','b');
    await s.sync({settings:s.revision(),cancellation:{revision:cleared.revision,throughActionSequence:cleared.throughActionSequence}});
    expect(s.applied().map(e=>e.text)).toEqual(['✅ Ноутбук застосував: ліміт на сьогодні 10 хв; ручні нагадування скасовано.']);
    const all=await s.actions.clearActions(parent('2'),'all','c');
    await s.sync({settings:s.revision(),cancellation:{revision:all.revision,throughActionSequence:all.throughActionSequence}});
    expect(s.applied().at(-1)).toMatchObject({recipients:[{userId:'2'}],
      text:'✅ Ноутбук застосував: усі нагадування скасовано, попередження про ліміт вимкнено до опівночі.'});
  });
  it('waits for the acknowledgement that covers the change, and a repeated sync sends nothing',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await s.settings.updateSettings(parent('1'),limit(20),'b');
    await s.sync();await s.sync({settings:1});
    expect(s.applied().map(e=>e.text)).toEqual(['✅ Ноутбук застосував: ліміт на сьогодні 10 хв.']);
    const ack={...request(50),acks:[{id:randomUUID(),kind:'settings' as const,revision:2,appliedAt:s.clock()}]};
    await s.api.syncDevice(identity,ack);await s.api.syncDevice(identity,ack);await s.sync({settings:2});
    expect(s.applied().map(e=>e.text)).toEqual(['✅ Ноутбук застосував: ліміт на сьогодні 10 хв.','✅ Ноутбук застосував: ліміт на сьогодні 20 хв.']);
  });
  it('sends nothing to an author removed before the laptop applied the change',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await s.settings.updateSettings(parent('2'),limit(20),'b');
    await s.repo.leaveDevice(parent('1'));
    await s.sync({settings:s.revision()});
    expect(s.applied().map(e=>e.recipients[0].userId)).toEqual(['2']);
    expect(s.notices()).toEqual([]);
  });
  it('cancels a queued message to an author removed before delivery',async()=>{
    const s=setup(),sent:string[]=[];
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await s.sync({settings:s.revision()});
    await s.repo.leaveDevice(parent('1'));
    const outbox=new OutboxService(s.repo,{send:async(_chat,text)=>{sent.push(text);return {kind:'sent',messageId:1};}},s.clock);
    const id=s.appliedRow();
    await outbox.deliverOutbox(id!);
    expect(sent).toEqual([]);expect(s.db.data.get('outbox/'+id).state).toBe('canceled');
  });
  it('sends at most 50 notices per sync and the rest on the following syncs',async()=>{
    const s=setup();
    for(let i=1;i<=120;i++){await s.settings.updateSettings(parent('1'),limit(i),'op'+i);s.advance(1);}
    await s.sync({settings:120});
    expect(s.notices()).toHaveLength(70);expect(s.db.data.get(root+'/sync/current').noticesDue).toBe(true);
    await s.sync();await s.sync();
    const lists=s.applied().map(e=>e.text.split('; '));
    expect(lists.map(l=>l.length)).toEqual([50,50,20]);
    expect(lists.flat().map(t=>Number(/(\d+) хв/.exec(t)![1]))).toEqual(Array.from({length:120},(_,i)=>i+1).map(m=>m%60));
    expect(s.notices()).toEqual([]);
    await s.sync();
    expect(s.db.data.get(root+'/sync/current').noticesDue).toBeUndefined();expect(s.applied()).toHaveLength(3);
  });
  it('fits notices into the write budget the rest of the sync leaves and defers the others in order',async()=>{
    const s=setup();
    for(let i=1;i<=50;i++){await s.settings.updateSettings(parent(i<=30?'1':'2'),limit(i),'op'+i);s.advance(1);}
    try{
      busy.spare=10;  // the first author's event (3) and seven deletions fit; nothing else does
      await s.sync({settings:50});
      expect(s.applied().map(e=>[e.recipients[0].userId,e.text.split('; ').length])).toEqual([['1',7]]);
      expect(s.notices()).toHaveLength(43);expect(s.db.data.get(root+'/sync/current').noticesDue).toBe(true);
      busy.spare=0;  // no room at all: nothing read, nothing lost
      await s.sync();
      expect(s.applied()).toHaveLength(1);expect(s.notices()).toHaveLength(43);expect(s.db.data.get(root+'/sync/current').noticesDue).toBe(true);
    }finally{busy.spare=null;}
    await s.sync();
    expect(s.applied().map(e=>[e.recipients[0].userId,e.text.split('; ').length])).toEqual([['1',7],['1',23],['2',20]]);
    expect(s.applied().flatMap(e=>e.text.split('; ')).map(t=>Number(/(\d+) хв/.exec(t)![1]))).toEqual(Array.from({length:50},(_,i)=>i+1));
    expect(s.notices()).toEqual([]);expect(s.db.data.get(root+'/sync/current').noticesDue).toBeUndefined();
  });
  it('cuts an overlong message on a code-point boundary',()=>{
    const text=appliedText(uk,['a'.repeat(3498-APPLIED_PREFIX.length)+'😀😀']);
    expect(text).toBe(APPLIED_PREFIX+'a'.repeat(3498-APPLIED_PREFIX.length)+'…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
    expect(appliedText(uk,['b'.repeat(3497-APPLIED_PREFIX.length)+'😀😀']).endsWith('😀…')).toBe(true);
  });
  it('keeps a message with many long summaries within the outbox bound',async()=>{
    const s=setup();
    for(let i=1;i<=50;i++)s.db.data.set(root+'/appliedNotices/s-'+i,{pairingId:parent('1').pairingId,userId:'1',summary:'ж'.repeat(200),createdAt:s.clock(),settingsRevision:i});
    s.db.data.set(root+'/settings/current',{...s.db.data.get(root+'/settings/current'),revision:50});
    await s.sync({settings:50});
    expect(s.applied()[0].text.length).toBe(3500);expect(s.applied()[0].text.endsWith('…')).toBe(true);
  });
  it('delivers through the outbox as plain text without buttons',async()=>{
    const s=setup(),bodies:any[]=[];
    await s.settings.updateSettings(parent('1'),limit(10),'a');await s.sync({settings:1});
    const http={request:async(_url:string,init:any)=>{bodies.push(JSON.parse(init.body));return {status:200,body:{ok:true,result:{message_id:5}}};}};
    const outbox=new OutboxService(s.repo,new TelegramHttpAdapter('1:abc',http),s.clock);
    await outbox.deliverOutbox(s.appliedRow());
    expect(bodies).toEqual([{chat_id:'1',text:'✅ Ноутбук застосував: ліміт на сьогодні 10 хв.',disable_web_page_preview:true}]);
  });
  it('drops notices older than the retention window in the daily cleanup',async()=>{
    const s=setup();
    await s.settings.updateSettings(parent('1'),limit(10),'a');
    await cleanup(s.repo,'2026-11-03T12:00:00.000Z');expect(s.notices()).toHaveLength(1);
    await cleanup(s.repo,'2026-11-05T12:00:00.000Z');expect(s.notices()).toEqual([]);
  });
});
