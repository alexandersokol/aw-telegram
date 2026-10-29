import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { Ajv } from 'ajv';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
// Dynamic imports permit a real missing-feature assertion during the initial RED run.
async function api() {
  expect(existsSync(new URL('../src/contracts.ts', import.meta.url)), 'Shared contract validator is not implemented').toBe(true);
  expect(existsSync(new URL('../src/clock.ts', import.meta.url)), 'Kyiv calendar helpers are not implemented').toBe(true);
  return { models: await import('../src/contracts.js'), clock: await import('../src/clock.js') };
}
describe('shared v2 contract', () => {
  it('uses strict endtime settings and dedicated confirmed presentation receipts', async () => {
    const {models} = await api(), data = fixture('endtime');
    expect(models.defaultSettings()).toEqual(data.defaults);
    for (const c of data.wire) {
      if (c.valid) expect(models.validateContract(c.contract, c.value), c.name).toEqual(c.value);
      else expect(() => models.validateContract(c.contract, c.value), c.name).toThrow();
    }
  });
  it('resolves endtime per Kyiv date with earlier overlap and forward gap', async () => {
    const {clock} = await api(), data = fixture('endtime');
    expect(clock.endtimeAt, 'endtime wall-time resolution is not implemented').toBeTypeOf('function');
    for (const c of data.resolutions) expect(clock.endtimeAt(c.date, c.localTime)).toBe(c.instant);
    for (const value of data.invalidTimes) expect(() => clock.endtimeAt('2026-10-29', value)).toThrow();
    for (const value of ['2026-02-30', '1969-12-31', '2100-01-01', '2026-1-01', null])
      expect(() => clock.endtimeAt(value!, '21:00')).toThrow();
  });
  it('matches endtime receipts against the known settings revision and generation', async () => {
    const {models} = await api(), data = fixture('endtime');
    expect(models.validateEndtimeReceipt, 'endtime receipt context validation is not implemented').toBeTypeOf('function');
    for (const c of data.context) {
      if (c.valid) expect(() => models.validateEndtimeReceipt(c.settings, c.receipt), c.name).not.toThrow();
      else expect(() => models.validateEndtimeReceipt(c.settings, c.receipt), c.name).toThrow();
    }
    expect(() => models.validateEndtimeReceipt(data.context[0].settings,
      {id:data.context[0].receipt.id,kind:'settings',revision:7,appliedAt:'2026-10-29T19:00:00.000Z'})).toThrow();
  });
  it('accepts and rejects identical shared wire cases without mutation', async () => {
    const {models} = await api();
    for (const c of fixture('wire')) {
      const raw = JSON.stringify(c.value);
      if (c.valid) expect(models.validateContract(c.contract, models.parseJson(raw)), c.name).toEqual(c.value);
      else expect(() => models.validateContract(c.contract, models.parseJson(raw)), c.name).toThrow();
    }
  });
  it('uses Kyiv calendar dates through both DST transitions', async () => {
    const {clock} = await api(); const data = fixture('time');
    for (const c of data.bounds) {
      expect(clock.dayBounds(c.date)).toEqual({ start: c.bounds[0], end: c.bounds[1] });
      expect(Date.parse(c.bounds[1]) - Date.parse(c.bounds[0])).toBe(c.durationMs);
    }
    for (const c of data.retention) {
      expect(clock.retainedDates(c.now)).toEqual(c.dates);
      expect(clock.kyivDate(c.now)).toBe(c.dates[0]);
      expect(clock.retentionStart(c.now)).toBe(c.start);
    }
    for (const v of data.invalidDates) expect(() => clock.dayBounds(v)).toThrow();
    for (const v of data.invalidInstants) expect(() => clock.parseInstant(v)).toThrow();
  });
  it('round trips exact category paths and counts overlapping ancestors once', async () => {
    const {models} = await api(); const c = fixture('selection');
    expect(models.categoryKey(c.escapedPath)).toBe(c.key);
    expect(models.selectedTotal(c.leaves, c.selectedPaths, false)).toBe(33);
    expect(models.selectedTotal(c.leaves, c.selectedPaths, true)).toBe(38);
    expect(models.selectedTotal(c.leaves, [], false)).toBe(0);
  });
  it('rejects duplicate keys and noninteger JSON without truncating scalar text', async () => {
    const {models} = await api();
    for (const raw of ['{"sequence":1,"sequence":2}', '{"x":{"a":1,"\\u0061":2}}', '{"x":NaN}', '{"x":1.0}', '{"x":1e2}', ' '.repeat(131073), new Uint8Array([34,255,34]), new Uint8Array([239,187,191,123,125]), '{"x":"'+'😀'.repeat(32768)+'"}'])
      expect(() => models.parseJson(raw)).toThrow();
    expect(models.parseJson('{"x":"😀"}')).toEqual({x: '😀'});
    expect(models.defaultSettings()).toEqual(fixture('wire')[0].value);
  });
  it('separates late execution evidence, collection context and cancellation fences', async () => {
    const {models} = await api(); const data = fixture('evidence');
    for (const c of data.receipts) {
      if (c.valid) expect(() => models.validateActionReceipt(c.action, c.receipt)).not.toThrow();
      else expect(() => models.validateActionReceipt(c.action, c.receipt)).toThrow();
    }
    expect(data.receipts[0].arrivedAt > data.receipts[0].action.expiresAt).toBe(true);
    for (const c of data.collectionTransitions) {
      if (c.valid) expect(models.collectionStart(c.cached, c.received)).toBe(c.result);
      else expect(() => models.collectionStart(c.cached, c.received)).toThrow();
    }
    for (const c of data.gates) {
      if (c.valid) expect(() => models.validateActivityContext(c.request, c.startedAt, c.now)).not.toThrow();
      else expect(() => models.validateActivityContext(c.request, c.startedAt, c.now)).toThrow();
    }
    for (const c of data.fences) expect(models.actionCanceled(c.action, c.cancellations)).toBe(c.canceled);
  });
  it('keeps UTC boundary results representable and never shortens retention', async () => {
    const {clock} = await api();
    for (const value of ['0001-12-31T21:57:56.000Z', '9999-01-01T00:00:00.000Z'])
      expect(clock.formatInstant(clock.parseInstant(value))).toBe(value);
    expect(clock.dayBounds('1970-01-01').start).toBe('1969-12-31T21:00:00.000Z');
    expect(clock.retainedDates('1970-01-07T12:00:00.000Z').at(-1)).toBe('1970-01-01');
    expect(() => clock.retainedDates('1970-01-06T12:00:00.000Z')).toThrow();
    expect(() => clock.kyivDate('0001-01-01T12:00:00.000Z')).toThrow();
  });
});

function appDay(apps=1,pairs=1) {
  const rows=Array.from({length:pairs},(_,i)=>({app:`a${i%apps}`,categoryId:`["c${Math.floor(i/apps)}"]`,totalMs:1}));
  const leaves=Array.from({length:Math.ceil(pairs/apps)},(_,i)=>({category:{id:`["c${i}"]`,path:[`c${i}`]},totalMs:Math.min(apps,pairs-i*apps)}));
  return {date:'2026-10-27',leafTotalsMs:leaves,appLeafTotalsMs:rows,totalActiveMs:pairs,selectedTotalMs:pairs,
    settingsRevision:3,rulesRevision:'rules',availableFrom:'2026-10-27T08:00:00.000Z',availableThrough:'2026-10-27T09:00:00.000Z',partial:true,sequence:17};
}
it('projects exact unfiltered applications under edited settings with Unicode scalar ties',async()=>{
  const {models}=await api(); const c=fixture('selection');
  for(const p of c.projections) {
    const rows=models.selectedAppTotals(c.leaves,c.appLeafTotalsMs,p.paths,p.uncategorized);
    expect(rows).toEqual(p.apps);
    expect(rows.reduce((n,r)=>n+r.totalMs,0)).toBe(models.selectedTotal(c.leaves,p.paths,p.uncategorized));
    expect(models.selectedTotal(c.leaves,p.paths,p.uncategorized)).toBe(p.total);
  }
  const day={...appDay(),leafTotalsMs:c.leaves,appLeafTotalsMs:c.appLeafTotalsMs,totalActiveMs:78,selectedTotalMs:33};
  const settings={...models.defaultSettings(),revision:4,selectedPaths:[['GamesPlus']]};
  expect(models.projectDay(day,settings)).toEqual({sourceSettingsRevision:3,settingsRevision:4,selectedTotalMs:40,appTotalsMs:[{app:'Browser',totalMs:40}]});
  expect(day.settingsRevision).toBe(3); expect(day.selectedTotalMs).toBe(33);
  expect(()=>models.projectDay(day,{...settings,revision:3})).toThrow();
  expect(models.projectDay(day,{...settings,revision:3,selectedPaths:c.selectedPaths}).selectedTotalMs).toBe(33);
});
it('separates application cardinality from the atomic whole-body UTF-8 bound',async()=>{
  const {models}=await api();
  for(const [apps,pairs,valid] of [[256,256,true],[257,257,false],[256,4096,true],[256,4097,false]] as const) {
    const day=appDay(apps,pairs);
    if(valid) expect(()=>models.validateContract('day',day)).not.toThrow();
    else {
      expect(()=>models.validateContract('day',day)).toThrow();
      expect(()=>models.ensureReportCapacity(day)).toThrow('report_capacity_exceeded');
    }
  }
  expect(()=>models.ensureReportCapacity(appDay(256,256))).not.toThrow();
  expect(()=>models.ensureReportCapacity(appDay(256,4096))).toThrow('report_capacity_exceeded');
  const day=appDay(9,9),path=Array(16).fill('😀"\\'.repeat(80));
  const category={id:models.categoryKey(path),path};
  day.leafTotalsMs=[{category,totalMs:9}];
  day.appLeafTotalsMs.forEach((r,i)=>{r.categoryId=category.id;r.app='😀"\\'.repeat(80)+i;});
  expect(()=>models.validateContract('day',day)).not.toThrow();
  expect(()=>models.ensureReportCapacity(day)).toThrow('report_capacity_exceeded');
  expect(models.parseJson(Buffer.from('{}'+' '.repeat(131070)))).toEqual({});
  expect(()=>models.parseJson(Buffer.from('{}'+' '.repeat(131071)))).toThrow();
});

it('reuses compiled validation while repeatedly recalculating application projections',async()=>{
  const {models}=await api(); const c=fixture('selection'),p=c.projections[0];
  models.selectedAppTotals(c.leaves,c.appLeafTotalsMs,p.paths,p.uncategorized);
  const compile=vi.spyOn(Ajv.prototype,'compile');
  try {
    for(let i=0;i<25;i++) expect(models.selectedAppTotals(c.leaves,c.appLeafTotalsMs,p.paths,p.uncategorized)).toEqual(p.apps);
    const invalid=structuredClone(c.appLeafTotalsMs); invalid[0].totalMs=0;
    expect(()=>models.selectedAppTotals(c.leaves,invalid,p.paths,p.uncategorized)).toThrow();
    // A long-running sync/selection loop must not add new schemas per call.
    expect(compile.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {compile.mockRestore();}
});
