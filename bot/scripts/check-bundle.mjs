// Import an isolated package copy: a source-tree fallback cannot hide missing assets.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
const root = new URL('../', import.meta.url);
const temporary = mkdtempSync(new URL('.bundle-check-', root));
try {
  const directory = pathToFileURL(temporary + '/');
  cpSync(new URL('dist/', root), new URL('dist/', directory), {recursive: true});
  writeFileSync(new URL('package.json', directory), '{"type":"module"}\n');
  const {validateContract, defaultSettings} = await import(new URL('dist/contracts.js', directory));
  assert.deepEqual(validateContract('settings', defaultSettings()), {
    revision: 0, selectedPaths: [], selectedUncategorized: false, defaultLimitMs: 14400000,
    todayOverride: null, freeUseDate: null, suppressedDate: null,
    endtimeEnabled: false, endtimeLocalTime: '21:00', endtimeGeneration: 0,
  });
  assert.deepEqual(validateContract('sync-request', {schemaVersion:2,sequence:0,acks:[],health:{observedAt:'1970-01-01T00:00:00.000Z',awState:'unknown',lastSuccessAt:null,reportError:null}}), {schemaVersion:2,sequence:0,acks:[],health:{observedAt:'1970-01-01T00:00:00.000Z',awState:'unknown',lastSuccessAt:null,reportError:null}});
  assert.throws(()=>validateContract('sync-request', {schemaVersion:1,sequence:0,acks:[]}));
  const day={date:'2026-10-27',leafTotalsMs:[{category:{id:'uncategorized',path:null},totalMs:1}],
    appLeafTotalsMs:[{app:'fixture',categoryId:'uncategorized',totalMs:1}],totalActiveMs:1,selectedTotalMs:0,
    settingsRevision:0,rulesRevision:'fixture',availableFrom:'2026-10-27T08:00:00.000Z',availableThrough:'2026-10-27T09:00:00.000Z',partial:true,sequence:0};
  assert.deepEqual(validateContract('day',day),day);
  const receipt={id:'00000000-0000-4000-8000-000000000099',kind:'endtime',date:'2026-10-29',
    settingsRevision:0,endtimeGeneration:0,endtimeLocalTime:'21:00',presentedAt:'2026-10-29T19:00:00.000Z'};
  assert.deepEqual(validateContract('ack',receipt),receipt);
  assert.throws(()=>validateContract('settings',{...defaultSettings(),endtimeLocalTime:'00:14'}));
  assert.throws(()=>validateContract('ack',{...receipt,presentedAt:null}));
  const {dayBounds,endtimeAt} = await import(new URL('dist/clock.js', directory));
  assert.deepEqual(dayBounds('2026-10-25'), {start: '2026-10-24T21:00:00.000Z', end: '2026-10-25T22:00:00.000Z'});
  assert.equal(endtimeAt('2026-03-29','03:30'),'2026-03-29T01:30:00.000Z');
  assert.equal(endtimeAt('2026-10-25','03:30'),'2026-10-25T00:30:00.000Z');
  assert.equal(endtimeAt('1981-04-01','00:30'),'1981-03-31T21:30:00.000Z');
  assert.equal(endtimeAt('1991-09-29','03:30'),'1991-09-29T01:30:00.000Z');
  assert.deepEqual(dayBounds('1981-04-01'), {start:'1981-03-31T21:00:00.000Z',end:'1981-04-01T20:00:00.000Z'});
  process.stdout.write('Isolated compiled package: schemas and Kyiv time helper passed.\n');
} finally {
  if (!resolve(temporary).startsWith(resolve(fileURLToPath(root)) + sep))
    throw new Error('Refusing cleanup outside bot workspace');
  rmSync(temporary, {recursive: true, force: true});
}
