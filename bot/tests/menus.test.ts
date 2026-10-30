import {describe,it,expect} from 'vitest';
import {existsSync} from 'node:fs';
async function load(){
  expect(existsSync(new URL('../src/telegram/menus.ts',import.meta.url)),'endtime menu is missing').toBe(true);
  return {...await import('../src/telegram/commands.js'),...await import('../src/telegram/menus.js')};
}
const status={step:'status' as const,draft:null};

describe('endtime command parsing',()=>{
  it.each(['/endtime','/endtime status','/endtime@AwTelegramBot','/endtime@AwTelegramBot status','  /endtime   status  '])('%j shows status',async text=>{
    const {parseEndtimeCommand}=await load();expect(parseEndtimeCommand(text)).toEqual({kind:'status'});
  });
  it('parses set/on/off and accepts exact bounds',async()=>{
    const {parseEndtimeCommand}=await load();
    expect(parseEndtimeCommand('/endtime set 00:15')).toEqual({kind:'set',localTime:'00:15'});
    expect(parseEndtimeCommand('/endtime set 23:59')).toEqual({kind:'set',localTime:'23:59'});
    expect(parseEndtimeCommand('/endtime on')).toEqual({kind:'on'});expect(parseEndtimeCommand('/endtime off')).toEqual({kind:'off'});
  });
  it.each(['00:14','24:00','9:00','21:00:00','21.00','2100','21:60'])('rejects time %s',async time=>{
    const {parseEndtimeCommand}=await load();expect(parseEndtimeCommand('/endtime set '+time)).toEqual({kind:'invalid',reason:'time'});
  });
  it.each(['/endtime set','/endtime set 21:00 22:00','/endtime enable','/endtime on now','/endtimes','/other'])('rejects usage %j',async text=>{
    const {parseEndtimeCommand}=await load();expect(parseEndtimeCommand(text)).toEqual({kind:'invalid',reason:text==='/endtime set'?'time':'usage'});
  });
});

describe('endtime menu transitions',()=>{
  it('requires review before a button time edit and enables on confirmation',async()=>{
    const {transitionEndtimeMenu:t}=await load();
    const entering=t(status,{kind:'changeTime'});expect(entering).toEqual({state:{step:'enterTime',draft:null}});
    expect(t(entering.state!,{kind:'text',text:'24:00'})).toEqual({state:{step:'enterTime',draft:null},error:'time'});
    const review=t(entering.state!,{kind:'text',text:' 21:30 '});expect(review).toEqual({state:{step:'review',draft:'21:30'}});
    expect(t(review.state!,{kind:'confirm'})).toEqual({state:status,change:{kind:'setEndtime',localTime:'21:30'}});
  });
  it('toggles directly and preserves the saved time',async()=>{
    const {transitionEndtimeMenu:t}=await load();
    expect(t(status,{kind:'toggle',enabled:false})).toEqual({state:status,change:{kind:'setEndtimeEnabled',enabled:false}});
  });
  it('provides back and cancel on every leaf without a mutation',async()=>{
    const {transitionEndtimeMenu:t}=await load();const review={step:'review' as const,draft:'21:30'},entering={step:'enterTime' as const,draft:null};
    expect(t(status,{kind:'back'})).toEqual({state:null});
    expect(t(entering,{kind:'back'})).toEqual({state:status});expect(t(review,{kind:'back'})).toEqual({state:entering});
    expect(t(entering,{kind:'cancel'})).toEqual({state:status,notice:'canceled'});expect(t(review,{kind:'cancel'})).toEqual({state:status,notice:'canceled'});
  });
  it('treats inputs that do not belong to the current step as stale',async()=>{
    const {transitionEndtimeMenu:t}=await load();
    for(const [state,input] of [[status,{kind:'confirm'}],[status,{kind:'text',text:'21:00'}],[{step:'enterTime',draft:null},{kind:'confirm'}],
      [{step:'review',draft:'21:00'},{kind:'toggle',enabled:true}],[{step:'review',draft:'21:00'},{kind:'text',text:'22:00'}]] as const)
      expect(t(state as any,input as any)).toEqual({state,error:'stale'});
  });
  it('round-trips bounded callback data and rejects forged payloads',async()=>{
    const {encodeCallback,decodeCallback}=await load();const nonce='A'.repeat(22);
    for(const action of ['on','off','time','confirm','cancel','back'] as const){
      const data=encodeCallback(nonce,7,action);expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeCallback(data)).toEqual({nonce,version:7,action});
    }
    for(const data of ['et:n:1:delete','et::1:on','et:n:-1:on','et:n:1.5:on','et:n:01:on','xx:n:1:on','et:n:1:on:extra','et:n:9007199254740992:on'])
      expect(decodeCallback(data)).toBeNull();
  });
});
describe('self-removal menu transitions',()=>{
  const nav=()=>import('../src/telegram/navigation.js');
  it('opens the leave screen from Settings, confirms with the leave effect and cancels back to Settings',async()=>{
    const {transitionNav}=await nav();
    expect(transitionNav({screen:'settings'},'leave')).toEqual({state:{screen:'leave'}});
    expect(transitionNav({screen:'leave'},'leaveyes')).toEqual({state:null,effect:'leave'});
    expect(transitionNav({screen:'leave'},'leaveno')).toEqual({state:{screen:'settings'}});
  });
  it.each(['back','leave','hourlyon','settings','refresh'] as const)('treats %s on the leave screen as stale',async action=>{
    const {transitionNav}=await nav();
    expect(transitionNav({screen:'leave'},action)).toEqual({state:{screen:'leave'},error:'stale'});
  });
  it('refuses a confirm from any screen other than leave',async()=>{
    const {transitionNav}=await nav();
    expect(transitionNav({screen:'settings'},'leaveyes').error).toBe('stale');
    expect(transitionNav({screen:'main'},'leaveyes').error).toBe('stale');
  });
});
