/** Shared Telegram bot harness: in-memory Firestore, a recording client and update builders. */
import {expect} from 'vitest';
import {existsSync} from 'node:fs';
import {SettingsService} from '../src/settings.js';
import {ActionService} from '../src/actions.js';
import {fixture} from './delivery-fixture.js';

export type Call={kind:'send'|'edit'|'answer'|'delete';chatId?:string;messageId?:number;text?:string;buttons?:{text:string;data:string}[][]};
export async function setup(fail:(call:Call)=>boolean=()=>false){
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
  const settings=new SettingsService(f.repo,f.clock),actions=new ActionService(f.repo,f.clock);
  const bot=new TelegramBot(f.repo,settings,actions,client,f.clock);
  let update=100;
  const from=(user:string)=>({id:Number(user),is_bot:false,first_name:'P'});
  const message=(user:string,text:string,extra:any={})=>({update_id:++update,message:{message_id:update,date:0,chat:{id:Number(user),type:'private'},from:from(user),text,...extra}});
  const press=(user:string,data:string,messageId=7)=>({update_id:++update,callback_query:{id:'cb'+update,from:from(user),chat_instance:'i',data,
    message:{message_id:messageId,date:0,chat:{id:Number(user),type:'private'}}}});
  const handle=(u:any)=>bot.handleUpdate(u);
  const last=()=>calls.filter(c=>c.kind==='send'||c.kind==='edit').at(-1)!;
  const labels=()=>last().buttons!.map(row=>row.map(b=>b.text));
  const button=(label:string)=>{
    const found=last().buttons!.flat().find(b=>b.text.includes(label));
    if(!found)throw new Error(`no button "${label}" in ${JSON.stringify(labels())}`);
    return found.data;
  };
  /** Send a message, or press a button by label, as caregiver 1 unless stated. */
  const say=(text:string,user='1')=>handle(message(user,text));
  const tap=(label:string,user='1')=>handle(press(user,button(label)));
  return {...f,calls,bot,settings,actions,handle,message,press,last,labels,button,say,tap};
}
export type Bot=Awaited<ReturnType<typeof setup>>;
export const events=(s:Bot,kind?:string)=>[...s.db.data].filter(([k,v]:any)=>k.startsWith('events/')&&(!kind||v.kind===kind)).map(([,v]:any)=>v);
