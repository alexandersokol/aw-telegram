import {beforeAll, beforeEach, afterAll, describe, expect, test} from 'vitest';
import {fixtureDb, resetFixture} from './emulator-fixture.js';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const modulePath = '../src/repository.js';
const authPath = '../src/auth.js';
const httpPath = '../src/index.js';
let Repository: any, authorizeDevice: any, createRouter: any, digest: any;
const db = fixtureDb();
let now = 1800000000000;
let repo: any;
const secret = () => randomBytes(32).toString('base64url');
beforeAll(async () => {
  const m = await import(modulePath).catch(() => ({}));
  expect(m.FirestoreRepository, 'Task 4 repository must exist').toBeTypeOf('function');
  Repository = m.FirestoreRepository; digest = m.digest;
  authorizeDevice = (await import(authPath)).authorizeDevice;
  createRouter = (await import(httpPath)).createRouter;
});
beforeEach(async () => {await resetFixture(); now = 1800000000000; repo = new Repository(db, () => now);});
afterAll(async () => {await db.terminate();});
async function enroll() {
  const code = secret(); await repo.issueEnrollment(code); const result = await repo.consumeEnrollment(code, '127.0.0.1');
  return {...result, identity: await authorizeDevice({authorization: `Bearer ${result.deviceSecret}`}, repo)};
}
describe('auth Admin transactions', () => {
  test('owner CLI issues once and recovers an orphan using stdin, without secret arguments', async () => {
    now=Date.now(); // CLI intentionally uses real trusted process time, not this suite's fake clock.
    const cli = new URL('../scripts/enroll.ts', import.meta.url);
    const run = (args: string[], input?: string) => spawnSync(process.execPath, ['--experimental-strip-types',cli.pathname.replace(/^\/([A-Za-z]:)/,'$1'),...args],{encoding:'utf8',env:{...process.env,METADATA_SERVER_DETECTION:'none'},input,timeout:20000});
    const issue=run(['issue','--project','demo-aw-telegram','--backend-url','https://backend.example']);
    expect(issue.status,issue.stderr).toBe(0);
    const bundle=JSON.parse(issue.stdout); expect(bundle.backendUrl).toBe('https://backend.example');
    const d=await repo.consumeEnrollment(bundle.secret,'127.0.0.1');
    const revoke=run(['revoke-enrollment','--project','demo-aw-telegram'],bundle.secret);
    expect(revoke.status,revoke.stderr).toBe(0); expect(revoke.stdout).not.toContain(bundle.secret);
    await expect(authorizeDevice({authorization:`Bearer ${d.deviceSecret}`},repo)).rejects.toThrow('Unauthorized');
    const foreign=run(['issue','--project','real-project','--backend-url','https://backend.example']);
    expect(foreign.status).not.toBe(0); expect(foreign.stderr).not.toContain('private_key');
  });
  test('enrollment stores only a digest and consumes exactly once under concurrency', async () => {
    const code = secret(); await repo.issueEnrollment(code);
    const results = await Promise.allSettled([repo.consumeEnrollment(code, '127.0.0.1'), repo.consumeEnrollment(code, '127.0.0.1')]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const result: any = (results.find(x => x.status === 'fulfilled') as any).value;
    const doc = (await db.doc(`devices/${result.deviceId}`).get()).data()!;
    expect(doc.credentialDigest).toBe(digest(result.deviceSecret)); expect(doc.collectionStartedAt).toBeNull();
    expect(doc.activeParentIds).toEqual([]); expect(JSON.stringify(doc)).not.toContain(result.deviceSecret);
    expect((await db.doc(`devices/${result.deviceId}/settings/current`).get()).data()?.defaultLimitMs).toBe(14400000);
  });
  test('enrollment expires exactly at 15 minutes and never revives on retry', async () => {
    const code = secret(); await repo.issueEnrollment(code); now += 900000;
    await expect(repo.consumeEnrollment(code, '127.0.0.1')).rejects.toThrow('Invalid enrollment');
    expect((await db.collection('devices').get()).empty).toBe(true);
  });
  test('enrollment just before expiry succeeds', async () => {
    const code = secret(); await repo.issueEnrollment(code); now += 899999;
    expect((await repo.consumeEnrollment(code, '127.0.0.1')).deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });
  test('device authority comes exclusively from canonical bearer, duplicate digests fail closed', async () => {
    const d = await enroll();
    for (const header of [undefined, d.deviceId, `Bearer ${d.deviceSecret}=`, [`Bearer ${d.deviceSecret}`], `bearer ${d.deviceSecret}`, `Bearer ${d.deviceSecret},x`])
      await expect(authorizeDevice({authorization: header, deviceId: d.deviceId}, repo)).rejects.toThrow('Unauthorized');
    await db.doc('devices/duplicate').set({credentialDigest: digest(d.deviceSecret), status: 'active'});
    await expect(authorizeDevice({authorization: `Bearer ${d.deviceSecret}`}, repo)).rejects.toThrow('Unauthorized');
  });
  test('revoked device invalidates an identity resolved before revocation', async () => {
    const d = await enroll(); await repo.revokeDevice(d.deviceId);
    await expect(repo.createPairKey(d.identity, 'Parent')).rejects.toThrow('Unauthorized');
    await expect(repo.listAccess(d.identity)).rejects.toThrow('Unauthorized');
    await expect(repo.revokeAccess(d.identity, 'key:00000000-0000-4000-8000-000000000000')).rejects.toThrow('Unauthorized');
    await expect(authorizeDevice({authorization: `Bearer ${d.deviceSecret}`}, repo)).rejects.toThrow('Unauthorized');
  });
  test('persistent enrollment throttle is shared across instances and resets at boundary', async () => {
    const other = new Repository(db, () => now);
    const attempts = await Promise.allSettled(Array.from({length: 7}, (_, i) => (i%2 ? repo : other).consumeEnrollment(secret(), '::ffff:127.0.0.1')));
    expect(attempts.filter((x: any) => x.reason?.status === 429)).toHaveLength(2);
    await expect(repo.consumeEnrollment(secret(), '127.0.0.1')).rejects.toMatchObject({status:429});
    now += 900000;
    await expect(other.consumeEnrollment(secret(), '127.0.0.1')).rejects.toMatchObject({status:400});
    const text = JSON.stringify((await db.collection('throttles').get()).docs.map(x => ({id:x.id, ...x.data()})));
    expect(text).not.toContain('127.0.0.1');
  });
});
describe('auth HTTP boundary', () => {
  test('closed raw envelopes reject duplicates, forged carriers and malformed UTF8 without echo', async () => {
    const router = createRouter(repo);
    for (const body of ['{"schemaVersion":1,"secret":"x","secret":"y"}', '{"schemaVersion":1,"secret":"x","deviceId":"victim"}', '{"schemaVersion":1.0,"secret":"x"}', Buffer.from([0xff])]) {
      const response = await router({method:'POST', path:'/v1/enroll', headers:{}, body, remoteAddress:'127.0.0.1'});
      expect(response.status).toBe(400); expect(response.body).toEqual({error:'Invalid request'});
    }
    const result = await router({method:'GET',path:'/v1/access?deviceId=victim', headers:{'x-device-id':'victim'}, body:'',remoteAddress:'127.0.0.1'});
    expect(result.status).not.toBe(200);
  });
  test('HTTP exchange, access and deletion are no-store, and trust socket IP only', async () => {
    const router = createRouter(repo), code = secret(); await repo.issueEnrollment(code);
    const response = await router({method:'POST',path:'/v1/enroll',headers:{'x-forwarded-for':'8.8.8.8'},body:JSON.stringify({schemaVersion:1,secret:code}),remoteAddress:'127.0.0.1'});
    expect(response.status).toBe(200); expect(response.headers['Cache-Control']).toBe('no-store');
    const headers = {authorization:`Bearer ${response.body.deviceSecret}`};
    const key = await router({method:'POST',path:'/v1/pair-keys',headers,body:'{"schemaVersion":1,"name":"Мама"}',remoteAddress:'127.0.0.1'});
    expect(key.status).toBe(201); expect(key.body.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(key.body.id).toMatch(/^key:/);
    const access = await router({method:'GET',path:'/v1/access',headers,body:'',remoteAddress:'127.0.0.1'});
    expect(access.status).toBe(200); expect(access.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(access.body)).not.toContain(key.body.secret);
    expect((await router({method:'DELETE',path:`/v1/access/${key.body.id}`,headers,body:'',remoteAddress:'127.0.0.1'})).status).toBe(204);
    for (let i=0;i<4;i++) await router({method:'POST',path:'/v1/enroll',headers:{'x-forwarded-for':`${i}.8.8.8`},body:'{"schemaVersion":1,"secret":"bad"}',remoteAddress:'127.0.0.1'});
    const denied = await router({method:'POST',path:'/v1/enroll',headers:{'x-forwarded-for':'9.8.8.8'},body:'{"schemaVersion":1,"secret":"bad"}',remoteAddress:'127.0.0.1'});
    expect(denied.status).toBe(429); expect(denied.headers['Retry-After']).toBe('900');
  });
  test('bad labels and forbidden bodies are rejected without persisting keys', async () => {
    const d = await enroll(), router = createRouter(repo), headers = {authorization:`Bearer ${d.deviceSecret}`};
    for (const name of ['', 'x'.repeat(81), '\ud800'])
      expect((await router({method:'POST',path:'/v1/pair-keys',headers,body:JSON.stringify({schemaVersion:1,name}),remoteAddress:'127.0.0.1'})).status).toBe(400);
    expect((await router({method:'GET',path:'/v1/access',headers,body:'{}',remoteAddress:'127.0.0.1'})).status).toBe(400);
    expect((await db.collection('pairKeys').get()).empty).toBe(true);
  });
});
