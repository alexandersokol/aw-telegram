/** Framework-neutral router plus bounded Node HTTP adapter. No implicit server or credential loading. */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {DeviceApi} from './deviceApi.js';
import {parseJson,validateContract,MAX_BODY_BYTES} from './contracts.js';
import {authorizeDevice} from './auth.js';
import {enroll,envelope} from './enrollment.js';
import {BoundaryError,type FirestoreRepository} from './repository.js';
export interface HttpRequest {method:string;path:string;headers:Record<string,string|string[]|undefined>;body:string|Uint8Array;remoteAddress:string}
export interface HttpResponse {status:number;headers:Record<string,string>;body?:any}
import {OutboxService,type TelegramSender} from './outbox.js';
import {TaskService,createTaskHandler,type TaskAdapter} from './tasks.js';
import {SettingsService} from './settings.js';
import {ActionService} from './actions.js';
import {TelegramBot,type TelegramClient} from './telegram/webhook.js';
/** Telegram sends the configured secret in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
export interface TelegramWebhook {secret:string;handle(update:unknown):Promise<void>}
function webhookSecretMatches(header:unknown,secret:string):boolean {
  if(typeof header!=='string' || !secret) return false;
  const given=Buffer.from(header,'utf8'),expected=Buffer.from(secret,'utf8');
  return given.length===expected.length && timingSafeEqual(given,expected);
}
export function createRouter(repository: FirestoreRepository,options?:{api?:DeviceApi;taskHandler?:ReturnType<typeof createTaskHandler>;telegram?:TelegramWebhook}) {
  const api=options?.api??new DeviceApi(repository);
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const headers:Record<string,string>={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
    try {
      if(!request.path.startsWith('/') || request.path.startsWith('//') || /[\\\x00-\x20#]/.test(request.path)) throw new BoundaryError('Invalid request');
      if(Buffer.byteLength(request.body)>MAX_BODY_BYTES) throw new BoundaryError('Invalid request',413);
      if(request.method==='POST' && request.path==='/v1/enroll') return {status:200,headers,body:await enroll(repository,request.body,request.remoteAddress)};
      if(request.method==='POST'&&request.path==='/internal/tasks'){
        if(!options?.taskHandler)return {status:404,headers,body:{error:'Not found'}};
        return {...await options.taskHandler(request.headers,request.body),headers};
      }
      if(request.method==='POST'&&request.path==='/telegram/webhook'){
        if(!options?.telegram)return {status:404,headers,body:{error:'Not found'}};
        if(!webhookSecretMatches(request.headers['x-telegram-bot-api-secret-token'],options.telegram.secret)) throw new BoundaryError('Unauthorized',401);
        let update:unknown;
        try {update=JSON.parse(Buffer.from(request.body).toString('utf8'));} catch {throw new BoundaryError('Invalid request');}
        // A failure surfaces as 500 so Telegram redelivers; the handler skips completed updates.
        await options.telegram.handle(update);
        return {status:200,headers,body:{}};
      }
      const url=new URL(request.path,'https://local.invalid');
      const identity=await authorizeDevice({authorization:request.headers.authorization},repository);
      if(request.method==='POST' && request.path==='/v2/sync') {
        let input;try {input=validateContract('sync-request',parseJson(request.body));} catch {throw new BoundaryError('Invalid sync request');}
        return {status:200,headers,body:await api.syncDevice(identity,input)};
      }
      if(request.method==='POST' && request.path==='/v1/pair-keys') return {status:201,headers,body:await repository.createPairKey(identity,envelope(request.body,'name'))};
      if(request.method==='GET' && url.pathname==='/v1/access') {
        if(request.body.length || [...url.searchParams.keys()].some(k=>k!=='page') || url.searchParams.getAll('page').length>1) throw new BoundaryError('Invalid request');
        const page=url.searchParams.get('page');
        return {status:200,headers,body:await repository.listAccess(identity,page===null?undefined:page)};
      }
      if(request.method==='DELETE' && request.path.startsWith('/v1/access/')) {
        if(request.body.length || url.search || request.path.slice(11).includes('/')) throw new BoundaryError('Invalid request');
        await repository.revokeAccess(identity,request.path.slice('/v1/access/'.length)); return {status:204,headers};
      }
      return {status:404,headers,body:{error:'Not found'}};
    } catch(error) {
      if(error instanceof BoundaryError) {
        if(error.retryAfter) headers['Retry-After']=String(error.retryAfter);
        return {status:error.status,headers,body:{error:error.message}};
      }
      return {status:500,headers,body:{error:'Request failed'}};
    }
  };
}
export function createHttpHandler(repository: FirestoreRepository,options?:Parameters<typeof createRouter>[1]) {
  const router=createRouter(repository,options);
  return async (request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    let size=0; const chunks:Buffer[]=[];
    try {
      for await (const chunk of request) {
        size+=Buffer.byteLength(chunk); if(size>MAX_BODY_BYTES) {response.writeHead(413,{'Cache-Control':'no-store','Connection':'close'});response.end();return;} chunks.push(Buffer.from(chunk));
      }
      const count=request.rawHeaders.filter((_,i)=>i%2===0 && request.rawHeaders[i]!.toLowerCase()==='authorization').length;
      const headers={...request.headers}; if(count>1) headers.authorization='';
      const result=await router({method:request.method??'',path:request.url??'',headers,body:Buffer.concat(chunks),remoteAddress:request.socket.remoteAddress??''});
      response.writeHead(result.status,result.headers); response.end(result.body===undefined?undefined:JSON.stringify(result.body));
    } catch {if(!response.headersSent) response.writeHead(400,{'Cache-Control':'no-store'});response.end();}
  };
}

/** Task 10 supplies deployed adapters/configuration. Construction itself does no external work. */
export function createBackend(repository:FirestoreRepository,options:{telegram:TelegramSender;taskAdapter:TaskAdapter;oidc:{verify(token:string):Promise<void>};clock?:()=>string;
  webhook?:{secret:string;client:TelegramClient}}){
  const clock=options.clock??(()=>new Date().toISOString());
  const outbox=new OutboxService(repository,options.telegram,clock);
  const tasks=new TaskService(repository,options.taskAdapter,outbox,clock);
  const api=new DeviceApi(repository,clock,()=>tasks.repair(2));
  const taskHandler=createTaskHandler(options.oidc,tasks);
  const bot=options.webhook&&new TelegramBot(repository,new SettingsService(repository,clock),new ActionService(repository,clock),options.webhook.client,clock);
  const telegram=bot&&{secret:options.webhook!.secret,handle:(update:unknown)=>bot.handleUpdate(update)};
  const routes={api,taskHandler,...(telegram?{telegram}:{})};
  return {api,outbox,tasks,router:createRouter(repository,routes),httpHandler:createHttpHandler(repository,routes)};
}
