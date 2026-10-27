import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
// Dynamic imports permit a real missing-feature assertion during the initial RED run.
async function api() {
  expect(existsSync(new URL('../src/contracts.ts', import.meta.url)), 'Shared contract validator is not implemented').toBe(true);
  expect(existsSync(new URL('../src/clock.ts', import.meta.url)), 'Kyiv calendar helpers are not implemented').toBe(true);
  return { models: await import('../src/contracts.js'), clock: await import('../src/clock.js') };
}
describe('shared v1 contract', () => {
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
    expect(models.selectedTotal(c.leaves, c.selectedPaths, false)).toBe(30);
    expect(models.selectedTotal(c.leaves, c.selectedPaths, true)).toBe(35);
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
