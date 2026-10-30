/** Owner webhook administration: exact setWebhook options, secrets from Secret Manager, nothing secret printed. */
import {it,expect} from 'vitest';
import {WebhookAdmin,secretManagerReader} from '../src/webhookAdmin.js';

const TOKEN='123456:ABCdef_ghi-JKL', SECRET='s'.repeat(64);

function http(reply:(url:string,init:any)=>{status:number;body:any}){
  const calls:any[]=[];
  return {calls,transport:{request:async(url:string,init:any)=>{calls.push({url,init});return reply(url,init);}}};
}

it('sets the webhook with the secret token, the two update types and one connection',async()=>{
  const net=http(()=>({status:200,body:{ok:true,result:true}}));
  const admin=new WebhookAdmin(async name=>name==='TELEGRAM_BOT_TOKEN'?TOKEN:SECRET,net.transport);
  expect(await admin.set('https://api-abc-lm.a.run.app/telegram/webhook')).toBe('Webhook and command menu set');
  const [call]=net.calls;
  expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
  expect(JSON.parse(call.init.body)).toEqual({url:'https://api-abc-lm.a.run.app/telegram/webhook',secret_token:SECRET,
    allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});
});

it('accepts only an HTTPS URL ending in /telegram/webhook',async()=>{
  const admin=new WebhookAdmin(async()=>TOKEN,http(()=>({status:200,body:{ok:true}})).transport);
  for(const url of ['http://x.example/telegram/webhook','https://x.example/other','https://x.example/telegram/webhook?a=1','https://u:p@x.example/telegram/webhook'])
    await expect(admin.set(url)).rejects.toThrow('webhook URL');
});

it('summarizes webhook info and Telegram errors without the token',async()=>{
  const info=http(url=>({status:200,body:{ok:true,result:url.endsWith('getMyCommands')?[]:{url:'https://x.example/telegram/webhook',pending_update_count:3,
    max_connections:1,allowed_updates:['message','callback_query'],last_error_date:1793000000,last_error_message:'Wrong response'}}}));
  const summary=await new WebhookAdmin(async()=>TOKEN,info.transport).info();
  expect(summary).toContain('https://x.example/telegram/webhook');
  expect(summary).toContain('pending updates: 3');
  expect(summary).toContain('Wrong response');expect(summary).toContain('commands: (none)');
  const failing=new WebhookAdmin(async name=>name==='TELEGRAM_BOT_TOKEN'?TOKEN:SECRET,http(()=>({status:401,body:{ok:false,description:'Unauthorized'}})).transport);
  const error=await failing.set('https://x.example/telegram/webhook').catch(e=>e.message);
  expect(error).toBe('Telegram refused: Unauthorized');
  expect(error).not.toContain(TOKEN);
  expect(await new WebhookAdmin(async()=>TOKEN,http(()=>({status:200,body:{ok:true,result:true}})).transport).remove()).toBe('Webhook removed');
});

it('reads the latest secret version through Secret Manager with an owner access token',async()=>{
  const net=http(()=>({status:200,body:{payload:{data:Buffer.from(TOKEN).toString('base64')}}}));
  const read=secretManagerReader('aw-telegram',async()=>'owner-token',net.transport);
  expect(await read('TELEGRAM_BOT_TOKEN')).toBe(TOKEN);
  expect(net.calls[0].url).toBe('https://secretmanager.googleapis.com/v1/projects/aw-telegram/secrets/TELEGRAM_BOT_TOKEN/versions/latest:access');
  expect(net.calls[0].init.headers.Authorization).toBe('Bearer owner-token');
  const denied=secretManagerReader('aw-telegram',async()=>'t',http(()=>({status:403,body:{}})).transport);
  await expect(denied('TELEGRAM_BOT_TOKEN')).rejects.toThrow('Secret TELEGRAM_BOT_TOKEN is not readable');
});

it('refuses a webhook secret the runtime would reject, before calling Telegram',async()=>{
  const net=http(()=>({status:200,body:{ok:true,result:true}}));
  const admin=new WebhookAdmin(async name=>name==='TELEGRAM_BOT_TOKEN'?TOKEN:'short',net.transport);
  await expect(admin.set('https://x.example/telegram/webhook')).rejects.toThrow('invalid format');
  expect(net.calls).toEqual([]);
});

const EN=[
  {command:'start',description:'main menu'},{command:'status',description:'laptop status'},
  {command:'usage',description:'usage'},{command:'limit',description:'time limit'},
  {command:'pending',description:'active reminders'},{command:'clear',description:'clear reminders'},
  {command:'settings',description:'settings'},{command:'help',description:'all commands'},
];
const UK=[
  {command:'start',description:'головне меню'},{command:'status',description:'стан ноутбука'},
  {command:'usage',description:'використання'},{command:'limit',description:'ліміт часу'},
  {command:'pending',description:'активні нагадування'},{command:'clear',description:'очистити нагадування'},
  {command:'settings',description:'налаштування'},{command:'help',description:'усі команди'},
];

it('registers the eight core commands in English by default and in Ukrainian for language_code uk',async()=>{
  const net=http(()=>({status:200,body:{ok:true,result:true}}));
  await new WebhookAdmin(async name=>name==='TELEGRAM_BOT_TOKEN'?TOKEN:SECRET,net.transport).set('https://x.example/telegram/webhook');
  expect(net.calls.map(c=>c.url.split('/').at(-1))).toEqual(['setWebhook','setMyCommands','setMyCommands']);
  expect(JSON.parse(net.calls[1].init.body)).toEqual({commands:EN});
  expect(JSON.parse(net.calls[2].init.body)).toEqual({commands:UK,language_code:'uk'});
});

it('shows both registered menus in info and leaves them in place on remove',async()=>{
  const net=http((url,init)=>({status:200,body:{ok:true,result:url.endsWith('getMyCommands')?(JSON.parse(init.body).language_code==='uk'?UK:EN):
    url.endsWith('getWebhookInfo')?{url:''}:true}}));
  const admin=new WebhookAdmin(async()=>TOKEN,net.transport);
  const summary=await admin.info();
  expect(summary).toContain('commands: /start — main menu, /status — laptop status, /usage — usage, /limit — time limit, '+
    '/pending — active reminders, /clear — clear reminders, /settings — settings, /help — all commands');
  expect(summary).toContain('commands (uk): /start — головне меню, /status — стан ноутбука, /usage — використання, /limit — ліміт часу, '+
    '/pending — активні нагадування, /clear — очистити нагадування, /settings — налаштування, /help — усі команди');
  net.calls.length=0;await admin.remove();
  expect(net.calls.map(c=>c.url.split('/').at(-1))).toEqual(['deleteWebhook']);
});
