/** Loopback test server for companion/tests/test_e2e_simulated.py: the compiled backend over an in-memory
 * store, a recording Telegram, a simulated task queue and a test-controlled clock. Never deployed (firebase.json
 * ignores scripts/); it binds 127.0.0.1 only and prints "PORT <n>" once listening. Run after npm run build. */
import {createServer} from 'node:http';
import {createBackend} from '../dist/index.js';
import {FirestoreRepository,newSecret} from '../dist/repository.js';

const SECRET='w'.repeat(48);

/** Serial in-memory Firestore: transactions copy-on-write, reads before writes, plus non-transactional calls. */
class MemoryDb {
  data=new Map<string,any>(); private tail=Promise.resolve();
  doc(path:string):any {
    const ref:any={path,id:path.split('/').at(-1),collection:(name:string)=>this.collection(path+'/'+name)};
    ref.get=()=>this.runTransaction(tx=>tx.get(ref));
    for(const op of ['create','set','update','delete']) ref[op]=(v?:any)=>this.runTransaction(async tx=>tx[op](ref,v));
    return ref;
  }
  collection(path:string):any {
    const build=(filters:any[]=[],count=Infinity,order?:string):any=>{
      const q:any={path,query:true,filters,count,order,doc:(id:string)=>this.doc(path+'/'+id),
        where:(...f:any[])=>build([...filters,f],count,order),limit:(n:number)=>build(filters,n,order),orderBy:(s:string)=>build(filters,count,s)};
      q.get=()=>this.runTransaction(tx=>tx.get(q));
      return q;
    };
    return build();
  }
  async runTransaction<T>(body:(tx:any)=>Promise<T>):Promise<T> {
    let release!:()=>void; const prior=this.tail;this.tail=new Promise<void>(r=>{release=r;});await prior;
    const next=structuredClone(this.data);let wrote=false;
    const snap=(path:string)=>{const saved=structuredClone(next.get(path));return {id:path.split('/').at(-1),ref:this.doc(path),exists:next.has(path),data:()=>structuredClone(saved)};};
    const value=(d:any,key:string)=>key.split('.').reduce((v:any,k:string)=>v?.[k],d.data());
    const test=(a:any,op:string,b:any)=>op==='=='?a===b:op==='<'?a<b:op==='<='?a<=b:op==='>'?a>b:op==='>='?a>=b:op==='in'?b.includes(a):false;
    const tx:any={get:async(ref:any)=>{
      if(wrote)throw new Error('read after write');
      if(!ref.query)return snap(ref.path);
      let docs=[...next.keys()].filter(k=>k.startsWith(ref.path+'/')&&!k.slice(ref.path.length+1).includes('/')).map(snap);
      for(const [key,op,b] of ref.filters)docs=docs.filter(d=>test(value(d,key),op,b));
      if(ref.order)docs.sort((a,b)=>value(a,ref.order)>value(b,ref.order)?1:-1);
      docs=docs.slice(0,ref.count);return {docs,size:docs.length,empty:!docs.length};
    },getAll:async(...refs:any[])=>{if(wrote)throw new Error('read after write');return refs.map(r=>snap(r.path));},
      set:(ref:any,v:any)=>{wrote=true;next.set(ref.path,structuredClone(v));},
      create:(ref:any,v:any)=>{if(next.has(ref.path))throw new Error('exists');wrote=true;next.set(ref.path,structuredClone(v));},
      update:(ref:any,v:any)=>{wrote=true;next.set(ref.path,{...next.get(ref.path),...structuredClone(v)});},
      delete:(ref:any)=>{wrote=true;next.delete(ref.path);}};
    try {const result=await body(tx);this.data=next;return result;}finally{release();}
  }
}

let time=Date.parse(process.argv[2] ?? '2026-10-28T06:00:00.000Z');
const clock=()=>new Date(time).toISOString();
const db=new MemoryDb(), repo=new FirestoreRepository(db as any,()=>time);
const messages:{chatId:string;text:string;buttons?:any}[]=[], scheduled:any[]=[], done=new Set<string>();
const client={send:async(chatId:string,r:any)=>{messages.push({chatId,text:r.text,buttons:r.buttons});},
  edit:async(chatId:string,_m:number,r:any)=>{messages.push({chatId,text:r.text,buttons:r.buttons});},answer:async()=>{},delete:async()=>{}};
const backend=createBackend(repo,{clock,oidc:{verify:async()=>{}},
  telegram:{send:async(chatId:string,text:string)=>{messages.push({chatId,text});return {kind:'sent',messageId:messages.length};}},
  taskAdapter:{create:async(row:any)=>{scheduled.push(row);}},webhook:{secret:SECRET,client}});
let update=5000;

async function control(path:string,body:any):Promise<unknown> {
  if(path==='/e2e/clock'){time=Date.parse(body.now);return {now:clock()};}
  if(path==='/e2e/enrollment'){const secret=newSecret(32);await repo.issueEnrollment(secret);return {secret};}
  if(path==='/e2e/telegram'){
    const from={id:Number(body.userId),is_bot:false,first_name:'P'};
    const update_={update_id:++update,message:{message_id:update,date:0,chat:{id:Number(body.userId),type:'private'},from,text:body.text}};
    const r=await backend.router({method:'POST',path:'/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify(update_),remoteAddress:'127.0.0.1'});
    return {status:r.status};
  }
  if(path==='/e2e/tasks'){
    // Deliver what the backend itself enqueued, through /internal/tasks; nothing here enqueues.
    for(let round=0;round<20;round++){
      const due=scheduled.filter(r=>!done.has(r.id+':'+r.dispatchGeneration)&&r.dueAt<=clock());
      if(!due.length)return {ok:true};
      for(const row of due){
        done.add(row.id+':'+row.dispatchGeneration);
        const r=await backend.router({method:'POST',path:'/internal/tasks',headers:{authorization:'Bearer oidc.token.e2e'},
          body:JSON.stringify({kind:row.kind,resourceId:row.resourceId,generation:row.dispatchGeneration}),remoteAddress:'127.0.0.1'});
        if(r.status!==204)throw new Error('task failed: '+r.status);
      }
    }
    throw new Error('task queue did not settle');
  }
  if(path==='/e2e/messages')return messages.filter(m=>m.chatId===String(body.userId));
  throw new Error('unknown control route');
}

const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/e2e/')){
    let raw='';for await(const chunk of req)raw+=chunk;
    try {const result=await control(req.url,raw?JSON.parse(raw):{});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}
    catch(error:any){res.writeHead(500);res.end(String(error?.message));}
    return;
  }
  await backend.httpHandler(req,res);
});
server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address==='object')process.stdout.write(`PORT ${address.port}\n`);});
