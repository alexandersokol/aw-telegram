/** Task 10b deployment wiring: Functions options, request adaptation, task configuration and redacted logs. */
import {it,expect} from 'vitest';
import {api,sweep,clientAddress,taskConfiguration,toHttpRequest,REGION} from '../src/functions.js';
import {createRouter,routeLabel} from '../src/index.js';
import {fixture} from './delivery-fixture.js';
import {E2eDb} from './e2e-harness.js';
import {FirestoreRepository,newSecret} from '../src/repository.js';
import {DeviceApi} from '../src/deviceApi.js';
import {minimalHealth} from '../src/contracts.js';

it('runs the api in europe-central2 as aw-backend with both secrets, scaling 0 to 2',()=>{
  const endpoint=(api as any).__endpoint;
  expect(endpoint.region).toEqual([REGION]);
  expect(endpoint.serviceAccountEmail).toBe('aw-backend@aw-telegram.iam.gserviceaccount.com');  // never the raw shorthand
  expect([endpoint.minInstances,endpoint.maxInstances]).toEqual([0,2]);
  expect(endpoint.secretEnvironmentVariables.map((s:any)=>s.key).sort()).toEqual(['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET']);
  expect(endpoint.httpsTrigger).toBeDefined();
});

it('sweeps daily after Kyiv midnight with one instance at most',()=>{
  const endpoint=(sweep as any).__endpoint;
  expect(endpoint.scheduleTrigger).toMatchObject({schedule:'30 0 * * *',timeZone:'Europe/Kyiv'});
  expect([endpoint.region,endpoint.serviceAccountEmail,endpoint.maxInstances]).toEqual([[REGION],'aw-backend@aw-telegram.iam.gserviceaccount.com',1]);
});

it('adapts a Functions request without trusting caller-supplied addresses',()=>{
  const req={method:'POST',originalUrl:'/v2/sync',headers:{authorization:'Bearer a','x-forwarded-for':'6.6.6.6, 203.0.113.9'},
    rawHeaders:['Authorization','Bearer a','Authorization','Bearer b'],rawBody:Buffer.from('{}'),socket:{remoteAddress:'169.254.1.1'}};
  const adapted=toHttpRequest(req as any);
  expect(adapted).toMatchObject({method:'POST',path:'/v2/sync',remoteAddress:'203.0.113.9'});
  expect(adapted.headers.authorization).toBe('');  // duplicated credentials never authorize
  expect(Buffer.from(adapted.body).toString()).toBe('{}');
  expect(clientAddress(undefined,'10.0.0.1')).toBe('10.0.0.1');
});

it('targets Cloud Tasks at the deployed origin as aw-tasks-invoker, or not at all before it is known',()=>{
  expect(taskConfiguration('aw-telegram','https://api-abc-lm.a.run.app')).toEqual({project:'aw-telegram',location:REGION,queue:'delivery',
    targetUrl:'https://api-abc-lm.a.run.app/internal/tasks',audience:'https://api-abc-lm.a.run.app/internal/tasks',
    serviceAccountEmail:'aw-tasks-invoker@aw-telegram.iam.gserviceaccount.com'});
  expect(taskConfiguration('aw-telegram','')).toBeNull();
  expect(()=>taskConfiguration('aw-telegram','http://api.example')).toThrow();
});

it('reports unexpected failures by route and error type only',async()=>{
  const f=fixture(),reported:any[]=[];
  const router=createRouter(f.repo,{taskHandler:(async()=>{throw new TypeError('token 123:ABC in message');}) as any,
    report:(route,error)=>reported.push([route,(error as any)?.constructor?.name])});
  const failed=await router({method:'POST',path:'/internal/tasks',headers:{},body:'{}',remoteAddress:''});
  expect(failed).toMatchObject({status:500,body:{error:'Request failed'}});
  expect(reported).toEqual([['POST /internal/tasks','TypeError']]);
  const rejected=await router({method:'DELETE',path:'/v1/access/parent:1:00000000-0000-4000-8000-000000000001',headers:{},body:'',remoteAddress:''});
  expect(rejected.status).toBe(401);  // a boundary error is an answer, not a failure
  expect(reported.length).toBe(1);
  expect(routeLabel('DELETE','/v1/access/parent:1:00000000-0000-4000-8000-000000000001')).toBe('DELETE /v1/access/:id');
  expect(routeLabel('GET','/v1/access?page=00000000-0000-4000-8000-000000000001')).toBe('GET /v1/access');
  expect(routeLabel('POST','/anything')).toBe('POST other');
});

it('logs a refused sync once with its fixed reason and the laptop clock skew, never the request',async()=>{
  const NOW='2026-10-28T12:00:00.000Z',repo=new FirestoreRepository(new E2eDb() as any,()=>Date.parse(NOW)),refused:any[]=[],reported:any[]=[];
  const code=newSecret(32);await repo.issueEnrollment(code);const {deviceSecret}=await repo.consumeEnrollment(code,'127.0.0.1');
  const router=createRouter(repo,{api:new DeviceApi(repo,()=>NOW),refused:(route,refusal)=>refused.push([route,refusal]),report:(route)=>reported.push(route)});
  const sync=(sequence:number,observedAt:string)=>router({method:'POST',path:'/v2/sync',headers:{authorization:'Bearer '+deviceSecret},
    body:JSON.stringify({schemaVersion:2,sequence,acks:[],health:minimalHealth(observedAt)}),remoteAddress:''});
  expect((await sync(1,'2026-10-28T12:00:01.000Z')).status).toBe(200);  // 1 s ahead: the 2026-10-30 incident
  const refusal=await sync(2,'2026-10-28T12:06:00.000Z');
  expect(refusal).toMatchObject({status:400,body:{error:'Invalid activity context'}});
  expect((await sync(3,'not an instant')).status).toBe(400);
  expect((await router({method:'POST',path:'/v2/sync',headers:{},body:'{}',remoteAddress:''})).status).toBe(401);  // unauthenticated: not logged
  expect(refused).toEqual([['POST /v2/sync',{status:400,reason:'health observation is in the future',skewMs:360000}],
    ['POST /v2/sync',{status:400,reason:'Invalid sync request',skewMs:null}]]);
  expect(reported).toEqual([]);
});
