/** Task 10b deployment wiring: Functions options, request adaptation, task configuration and redacted logs. */
import {it,expect} from 'vitest';
import {api,sweep,clientAddress,taskConfiguration,toHttpRequest,REGION} from '../src/functions.js';
import {createRouter,routeLabel} from '../src/index.js';
import {fixture} from './delivery-fixture.js';

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
