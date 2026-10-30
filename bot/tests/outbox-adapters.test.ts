import {describe,it,expect,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {fixture,parent,NOW} from './delivery-fixture.js';
const config={project:'demo-aw-telegram',location:'europe-west1',queue:'delivery',targetUrl:'https://tasks.example.test/internal/tasks',audience:'https://tasks.example.test/internal/tasks',serviceAccountEmail:'worker@demo-aw-telegram.iam.gserviceaccount.com'};
async function module(){expect(existsSync(new URL('../src/tasks.ts',import.meta.url)),'OIDC and task adapters missing').toBe(true);return import('../src/tasks.js');}
describe('outbox production adapters and durable tasks',()=>{
  it('verifies REAL locally signed JWTs and exact issuer/audience/identity/expiry before task DB reads',async()=>{
    const {GoogleOidcVerifier,createTaskHandler}=await module();
    const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const cert=publicKey.export({type:'spki',format:'pem'}).toString();
    const now=Math.floor(Date.parse(NOW)/1000),base={iss:'https://accounts.google.com',aud:config.audience,email:config.serviceAccountEmail,email_verified:true,iat:now-1,exp:now+60};
    const token=(payload:any,key=privateKey)=>{const content=Buffer.from(JSON.stringify({alg:'RS256',kid:'local'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');return content+'.'+sign('RSA-SHA256',Buffer.from(content),key).toString('base64url');};
    vi.useFakeTimers();vi.setSystemTime(new Date(NOW));
    try{
      let reads=0;const verifier=new GoogleOidcVerifier(config,async()=>({local:cert}),()=>NOW);
      const handler=createTaskHandler(verifier,{execute:async()=>{reads++;}} as any);
      const valid=token(base);expect((await handler({authorization:'Bearer '+valid},JSON.stringify({kind:'sweep',resourceId:'all',generation:0}))).status).toBe(204);
      for(const payload of [{...base,iss:'https://evil.test'},{...base,aud:'wrong'},{...base,email:'wrong'},{...base,email_verified:false},{...base,exp:now-1}])expect((await handler({authorization:'Bearer '+token(payload)},'{}')).status).toBe(401);
      const wrong=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;expect((await handler({authorization:'Bearer '+token(base,wrong)},'{}')).status).toBe(401);
      expect((await handler({authorization:['Bearer '+valid,'Bearer '+valid]},'{}')).status).toBe(401);
      expect((await handler({authorization:'Bearer '+valid},JSON.stringify({kind:'unknown',resourceId:'x',generation:0}))).status).toBe(400);expect(reads).toBe(1);
    }finally{vi.useRealTimers();}
  });
  it('serializes Cloud Tasks REST with trusted configuration and treats deterministic AlreadyExists as success',async()=>{
    const {CloudTasksRestAdapter}=await module();let sent:any;
    const adapter=new CloudTasksRestAdapter(config,{request:async(url:any,init:any)=>{sent={url,...init};return {status:409,body:{}};}},async()=>'access-token');
    await adapter.create({id:'a'.repeat(64),kind:'deadline',resourceId:parent().deviceId+':action',dueAt:NOW,dispatchGeneration:2});
    const body=JSON.parse(sent.body);expect(body.task.name).toContain('/tasks/'+('a'.repeat(64))+'-2');expect(body.task.httpRequest.oidcToken).toEqual({serviceAccountEmail:config.serviceAccountEmail,audience:config.audience});
    expect(JSON.parse(Buffer.from(body.task.httpRequest.body,'base64').toString())).toEqual({kind:'deadline',resourceId:parent().deviceId+':action',generation:2});expect(sent.headers.Authorization).toBe('Bearer access-token');
  });
  it('repairs a lost previously-enqueued deadline with a persisted new dispatch generation',async()=>{
    const {TaskService}=await module();const {taskIntent,applyPlan}=await import('../src/outbox.js');const f=fixture();let calls=0;
    const intent=taskIntent(f.repo,'outbox','message',NOW);await f.repo.db.runTransaction(async tx=>{applyPlan(tx,[intent]);});
    const tasks=new TaskService(f.repo,{create:async()=>{calls++;}},{} as any,f.clock);await tasks.repair();expect(calls).toBe(1);
    f.advance(60001);await tasks.repair();expect(calls).toBe(2);expect(f.db.data.get(intent.ref.path).dispatchGeneration).toBe(1);
  });
  it('exercises real Telegram serializer for success,403,429,timeout without logging token or text',async()=>{
    await module();const {TelegramHttpAdapter}=await import('../src/outbox.js');let sent:any;
    for(const [response,expected] of [[{status:200,body:{ok:true,result:{message_id:7}}},'sent'],[{status:403,body:{}},'forbidden'],[{status:429,body:{parameters:{retry_after:123}}},'retry']]){
      const sender=new TelegramHttpAdapter('123:TEST',{request:async(url,init)=>{sent={url,init};return response as any;}});expect((await sender.send('1','<text>')).kind).toBe(expected);
      expect(JSON.parse(sent.init.body)).toEqual({chat_id:'1',text:'<text>',disable_web_page_preview:true});
    }
    const sender=new TelegramHttpAdapter('123:TEST',{request:async()=>{throw new Error('timeout');}});expect(await sender.send('1','text')).toEqual({kind:'uncertain'});
  });
});

it('does not complete queue work when a live outbox lease prevented delivery',async()=>{
  const {TaskService}=await module();const {taskIntent,applyPlan}=await import('../src/outbox.js'),f=fixture();const intent=taskIntent(f.repo,'outbox','leased',NOW);
  f.db.data.set('outbox/leased',{state:'sending',leaseUntil:'2026-10-28T12:00:30.000Z'});
  await f.repo.db.runTransaction(async tx=>{applyPlan(tx,[intent]);});const tasks=new TaskService(f.repo,{create:async()=>{}},{deliverOutbox:async()=>{}} as any,f.clock);
  await tasks.execute({kind:'outbox',resourceId:'leased',generation:0});expect(f.db.data.get(intent.ref.path).state).not.toBe('completed');
});
it('rejects early and obsolete task generations without touching domain delivery',async()=>{
  const {TaskService}=await module();const {taskIntent,applyPlan}=await import('../src/outbox.js'),f=fixture();const intent=taskIntent(f.repo,'outbox','future','2026-10-28T12:01:00.000Z');let calls=0;
  await f.repo.db.runTransaction(async tx=>{applyPlan(tx,[intent]);});const tasks=new TaskService(f.repo,{create:async()=>{}},{deliverOutbox:async()=>{calls++;}} as any,f.clock);
  await tasks.execute({kind:'outbox',resourceId:'future',generation:0});f.advance(61000);await tasks.execute({kind:'outbox',resourceId:'future',generation:1});expect(calls).toBe(0);
});
it('composes a separate OIDC task route before device auth and repairs after successful sync',async()=>{
  const {createBackend}=await import('../src/index.js'),f=fixture();let repairs=0,verified=0;
  const backend=createBackend(f.repo,{telegram:{send:async()=>({kind:'sent',messageId:1})},taskAdapter:{create:async()=>{repairs++;}},oidc:{verify:async()=>{verified++;throw new Error('bad OIDC');}},clock:f.clock});
  const denied=await backend.router({method:'POST',path:'/internal/tasks',headers:{authorization:'Bearer valid.token.text'},body:'{}',remoteAddress:'127.0.0.1'});expect(denied.status).toBe(500);expect(verified).toBe(1);
  const {taskIntent,applyPlan}=await import('../src/outbox.js');await f.repo.db.runTransaction(async tx=>{applyPlan(tx,[taskIntent(f.repo,'outbox','pending',NOW)]);});
  const {identity,request}=await import('./delivery-fixture.js');await backend.api.syncDevice(identity,request());expect(repairs).toBe(1);
});

it('does not revive a task completed by a fast queue callback before enqueue finalization',async()=>{
  const {TaskService}=await module();const {taskIntent,applyPlan}=await import('../src/outbox.js'),f=fixture();const intent=taskIntent(f.repo,'outbox','fast',NOW);
  await f.repo.db.runTransaction(async tx=>{applyPlan(tx,[intent]);});let tasks:any;
  tasks=new TaskService(f.repo,{create:async()=>{await tasks.execute({kind:'outbox',resourceId:'fast',generation:0});}},{deliverOutbox:async()=>{}} as any,f.clock);
  await tasks.repair();expect(f.db.data.get(intent.ref.path).state).toBe('completed');
});
it('does not retry Telegram before a retry_after larger than one day',async()=>{
  await module();const {OutboxService}=await import('../src/outbox.js'),f=fixture();let calls=0;const outbox=new OutboxService(f.repo,{send:async()=>{calls++;return {kind:'retry',retryAfter:100000};}},f.clock);
  await outbox.enqueueParentEvent({id:'long-retry',deviceId:parent().deviceId,at:NOW,kind:'status',text:{uk:'Запит',en:'Request'},recipients:[parent()]});const id=[...f.db.data.keys()].find(k=>k.startsWith('outbox/'))!.slice(7);await outbox.deliverOutbox(id);f.advance(86400001);await outbox.deliverOutbox(id);expect(calls).toBe(1);
});

it('retains Task6 evidence for seven Kyiv dates, tombstones operation identity and clears completed message text after24h',async()=>{
  const {TaskService}=await module(),{ActionService}=await import('../src/actions.js'),f=fixture();const actions=new ActionService(f.repo,f.clock),{draft,root}=await import('./delivery-fixture.js');const {action}=await actions.createAction(parent(),draft,'retained');
  const ref=root+'/actions/'+action.id,old='2026-10-19T12:00:00.000Z',row=f.db.data.get(ref);row.action={...row.action,createdAt:old,targetAt:old,expiresAt:'2026-10-19T12:01:00.000Z'};row.open=false;
  f.db.data.set(ref+'/evidence/1',{digest:'old',at:old});f.db.data.set(ref+'/occurrences/0',{sequence:1});f.db.data.set(root+'/receipts/old',{digest:'old',receivedAt:old});f.db.data.set(root+'/alertStates/2026-10-19',{date:'2026-10-19',parents:{}});
  const op=[...f.db.data.keys()].find(k=>k.includes('/operations/'))!;f.db.data.get(op).at=old;f.db.data.get(op).expired=false;
  f.db.data.set('events/old',{at:old,text:'old event'});f.db.data.set('outbox/completed',{createdAt:'2026-10-26T12:00:00.000Z',state:'delivered',text:'completed message',scrubbed:false});
  const tasks=new TaskService(f.repo,{create:async()=>{}},{} as any,f.clock);await tasks.sweep();expect(f.db.data.has(ref)).toBe(false);expect(f.db.data.has(ref+'/evidence/1')).toBe(false);expect(f.db.data.has(root+'/receipts/old')).toBe(false);expect(f.db.data.has('events/old')).toBe(false);expect(f.db.data.get('outbox/completed').text).toBeNull();
  expect(f.db.data.get(op)).toMatchObject({expired:true});expect(f.db.data.get(op).result).toBeUndefined();await expect(actions.createAction(parent(),draft,'retained')).rejects.toThrow('expired');
});

it('sweeps Telegram update markers once redelivery can no longer occur',async()=>{
  const {TaskService}=await module(),f=fixture();
  f.db.data.set('telegramUpdates/1',{at:'2026-10-27T11:59:59.999Z'});f.db.data.set('telegramUpdates/2',{at:'2026-10-27T12:00:00.001Z'});
  await new TaskService(f.repo,{create:async()=>{}},{} as any,f.clock).sweep();
  expect(f.db.data.has('telegramUpdates/1')).toBe(false);expect(f.db.data.has('telegramUpdates/2')).toBe(true);
});
