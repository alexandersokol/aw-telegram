/** End-to-end world: the real backend router over an in-memory Firestore, a recording Telegram, a simulated
 * Cloud Tasks queue and a wire-level laptop. Nothing leaves the process. */
import {MemoryDb} from './delivery-fixture.js';
import {FirestoreRepository,newSecret} from '../src/repository.js';
import {createBackend} from '../src/index.js';
import {kyivDate,dayBounds} from '../src/clock.js';
import type {ScheduleRow} from '../src/tasks.js';

export const WEBHOOK_SECRET='w'.repeat(48);

/** The memory store plus Firestore's non-transactional reads and writes, each run as its own transaction. */
export class E2eDb extends MemoryDb {
  override collection(path:string):any {return this.wrap(super.collection(path));}
  private wrap(query:any):any {
    const self=this;
    return new Proxy(query,{get(target,prop){
      if(prop==='get')return ()=>self.runTransaction(tx=>tx.get(target));
      const value=target[prop];
      return ['where','limit','orderBy'].includes(prop as string)?(...args:any[])=>self.wrap(value(...args)):value;
    }});
  }
  override doc(path:string):any {
    const ref=super.doc(path);
    return {...ref,get:()=>this.runTransaction(tx=>tx.get(ref)),create:(v:any)=>this.runTransaction(async tx=>tx.create(ref,v)),
      set:(v:any)=>this.runTransaction(async tx=>tx.set(ref,v)),update:(v:any)=>this.runTransaction(async tx=>tx.update(ref,v)),
      delete:()=>this.runTransaction(async tx=>tx.delete(ref))};
  }
}
export type Message={chatId:string;text:string;buttons?:{text:string;data:string}[][];via:'reply'|'outbox'};

export function world(start='2026-10-28T06:00:00.000Z'){
  const db=new E2eDb();let time=Date.parse(start);
  const clock=()=>new Date(time).toISOString();
  const repo=new FirestoreRepository(db as any,()=>time);
  const messages:Message[]=[],scheduled:ScheduleRow[]=[],done=new Set<string>();
  const client={
    send:async(chatId:string,reply:any)=>{messages.push({chatId,text:reply.text,buttons:reply.buttons,via:'reply'});},
    edit:async(chatId:string,_id:number,reply:any)=>{messages.push({chatId,text:reply.text,buttons:reply.buttons,via:'reply'});},
    answer:async()=>{},delete:async()=>{},
  };
  let failure:unknown=null;
  const backend=createBackend(repo,{clock,oidc:{verify:async()=>{}},report:(_route,error)=>{failure=error;},
    telegram:{send:async(chatId:string,text:string)=>{messages.push({chatId,text,via:'outbox'});return {kind:'sent' as const,messageId:messages.length};}},
    taskAdapter:{create:async(row:ScheduleRow)=>{scheduled.push(row);}},
    webhook:{secret:WEBHOOK_SECRET,client}});
  const call=async(method:string,path:string,body:unknown,headers:Record<string,string>={})=>
    backend.router({method,path,headers,body:body===undefined?'':JSON.stringify(body),remoteAddress:'203.0.113.1'});
  let update=1000;

  /** Telegram, as a caregiver in a private chat. */
  const caregiver=(userId:string)=>{
    const from={id:Number(userId),is_bot:false,first_name:'P'+userId,language_code:'uk'};
    const post=(u:any)=>call('POST','/telegram/webhook',u,{'x-telegram-bot-api-secret-token':WEBHOOK_SECRET});
    const inbox=()=>messages.filter(m=>m.chatId===userId);
    return {userId,inbox,last:()=>inbox().at(-1)?.text??'',
      say:(text:string)=>post({update_id:++update,message:{message_id:update,date:0,chat:{id:Number(userId),type:'private'},from,text}}),
      tap:(label:string)=>{
        const button=[...inbox()].reverse().flatMap(m=>m.buttons?.flat()??[]).find(b=>b.text.includes(label));
        if(!button)throw new Error(`no button "${label}" for ${userId}`);
        return post({update_id:++update,callback_query:{id:'cb'+update,from,chat_instance:'i',data:button.data,
          message:{message_id:7,date:0,chat:{id:Number(userId),type:'private'}}}});
      }};
  };

  /** A laptop speaking the device wire protocol. */
  const laptop=async()=>{
    const code=newSecret(32);await repo.issueEnrollment(code);
    const enrolled=(await call('POST','/v1/enroll',{schemaVersion:1,secret:code})).body;
    const auth={authorization:'Bearer '+enrolled.deviceSecret};
    let sequence=0,daySequence=0,revision=0,started:string|null=null;
    const state={acks:[] as any[],last:null as any};
    // Before the first pairing the companion reports minimal health, as the contract requires.
    const health=()=>started?{observedAt:clock(),awState:'ready',lastSuccessAt:clock(),reportError:null}:
      {observedAt:clock(),awState:'unknown',lastSuccessAt:null,reportError:null};
    return {deviceId:enrolled.deviceId as string,state,
      key:async(name:string)=>(await call('POST','/v1/pair-keys',{schemaVersion:1,name},auth)).body.secret as string,
      access:async()=>(await call('GET','/v1/access',undefined,auth)).body,
      revoke:async(id:string)=>(await call('DELETE','/v1/access/'+id,undefined,auth)).status,
      /** One sync; usageMs adds a today summary counted in Games, live adds the foreground Games app. */
      sync:async(options:{usageMs?:number;live?:boolean;acks?:any[]}={})=>{
        time+=1000;  // a real laptop syncs every 30 s; two observations never share an instant
        const request:any={schemaVersion:2,sequence:++sequence,health:health(),acks:options.acks??[]};
        if(started&&options.usageMs!==undefined){
          const date=kyivDate(clock()),from=started>dayBounds(date).start?started:dayBounds(date).start;
          request.summaries=[{date,sequence:++daySequence,settingsRevision:0,rulesRevision:'r1',
            leafTotalsMs:options.usageMs?[{category:{id:'["Games"]',path:['Games']},totalMs:options.usageMs}]:[],
            appLeafTotalsMs:options.usageMs?[{app:'game.exe',categoryId:'["Games"]',totalMs:options.usageMs}]:[],totalActiveMs:options.usageMs,
            selectedTotalMs:0,availableFrom:from,availableThrough:clock(),partial:false}];
        }
        if(started&&options.live)request.live={observedAt:clock(),state:'active',app:'game.exe',title:'Game',
          category:{id:'["Games"]',path:['Games']},rulesRevision:'r1',categoryCatalog:[{id:'["Games"]',path:['Games']},{id:'["Study"]',path:['Study']}]};
        const response=await call('POST','/v2/sync',request,auth);
        if(response.status!==200)throw new Error('sync rejected: '+response.body?.error+' '+String((failure as any)?.stack??''));
        started=response.body.collectionStartedAt;revision=response.body.settings.revision;void revision;
        state.last=response.body;
        return response.body;
      }};
  };

  /** Cloud Tasks: deliver every due task the backend itself enqueued, through /internal/tasks, until the queue
   * settles. Nothing here enqueues: only production triggers (a sync, a webhook update, a task) do. */
  const runTasks=async()=>{
    for(let round=0;round<20;round++){
      const due=scheduled.filter(r=>!done.has(r.id+':'+r.dispatchGeneration)&&r.dueAt<=clock());
      if(!due.length)return;
      for(const row of due){
        done.add(row.id+':'+row.dispatchGeneration);
        const r=await call('POST','/internal/tasks',{kind:row.kind,resourceId:row.resourceId,generation:row.dispatchGeneration},{authorization:'Bearer oidc.token.e2e'});
        if(r.status!==204)throw new Error('task failed: '+r.status);
      }
    }
    throw new Error('task queue did not settle');
  };
  return {db,repo,backend,clock,messages,caregiver,laptop,runTasks,
    advance:(ms:number)=>{time+=ms;},setTime:(iso:string)=>{time=Date.parse(iso);}};
}
