/** Shape validation is not authorization or trusted-clock proof. No payload logging. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import { dayBounds, kyivDate, parseDate, parseInstant, retainedDates } from './clock.js';

export type Counter = number;
export type Instant = string;
export type LocalDate = string;
export type CategoryPath = string[];
export interface CategoryRef {id: string; path: CategoryPath | null}
export interface LeafTotal {category: CategoryRef; totalMs: number}
export interface AppLeafTotal {app: string; categoryId: string; totalMs: number}
export interface AppTotal {app: string; totalMs: number}
export interface Settings {
  revision: Counter; selectedPaths: CategoryPath[]; selectedUncategorized: boolean; defaultLimitMs: number;
  todayOverride: {date: LocalDate; limitMs: number} | null; freeUseDate: LocalDate | null; suppressedDate: LocalDate | null;
}
export interface DaySummary {
  date: LocalDate; leafTotalsMs: LeafTotal[]; appLeafTotalsMs: AppLeafTotal[]; totalActiveMs: number; selectedTotalMs: number;
  settingsRevision: Counter; rulesRevision: string; availableFrom: Instant | null; availableThrough: Instant | null;
  partial: boolean; sequence: Counter;
}
export interface LiveState {
  observedAt: Instant; state: 'active' | 'afk' | 'unknown'; app: string | null; title: string | null;
  category: CategoryRef | null; rulesRevision: string | null; categoryCatalog: CategoryRef[];
}
type MessageOptions = {message: string; countdown: boolean};
export type OverlayOptions = MessageOptions & (
  {dismissible: true; repeatEveryMinutes: number | null} | {dismissible: false; durationSeconds: number}
);
interface ActionBase {
  id: string; actorId: string; createdAt: Instant; targetAt: Instant; expiresAt: Instant;
  sequence: Counter; settingsRevision: Counter;
}
export type Action = ActionBase & ({kind: 'notify'; options: MessageOptions} | {kind: 'overlay'; options: OverlayOptions});
export type ActionStatus = 'accepted' | 'presenting' | 'presented' | 'dismissed' | 'completed' | 'replaced' |
  'expired' | 'skipped' | 'canceled' | 'failed' | 'unconfirmed';
export type Reason = 'display_busy' | 'free_use' | 'missed_deadline' | 'canceled' | 'replaced' |
  'presentation_blocked' | 'presentation_failed' | 'crash_during_presentation';
export interface ActionAck {
  id: string; kind: 'action'; actionId: string; eventSequence: Counter; occurrence: Counter;
  status: ActionStatus; at: Instant; acceptedAt: Instant | null; presentedAt: Instant | null; reason: Reason | null;
}
export type Ack = ActionAck | {id: string; kind: 'settings'; revision: Counter; appliedAt: Instant} |
  {id: string; kind: 'cancellation'; revision: Counter; throughActionSequence: Counter; appliedAt: Instant};
export interface Cancellations {revision: Counter; throughActionSequence: Counter; canceledIds: string[]}
export interface SyncRequest {schemaVersion: 2; sequence: Counter; summaries?: DaySummary[]; live?: LiveState; acks: Ack[]}
export interface SyncResponse {
  schemaVersion: 2; requestSequence: Counter; serverNow: Instant; collectionStartedAt: Instant | null;
  settings: Settings; cancellations: Cancellations; deliveryOffers: Action[]; acknowledgedAckIds: string[];
}
export interface Evaluation {
  date: LocalDate; effectiveLimitMs: number; remainingMs: number; freeUse: boolean; suppressed: boolean;
  automaticEligible: boolean; warning: '15m' | '10m' | '5m' | 'expired' | null; dayReset: boolean;
}
/** Mirrors the existing local adapter result; this is not a wire receipt. */
export interface PresentationResult {
  state: 'visible' | 'unconfirmed' | 'failed';
  reason: 'invalid_overlay_handle' | 'unsupported_platform' | 'topmost_rejected' | 'minimize_rejected' |
    'minimize_requested' | 'topmost_requested' | 'windows_request_failed';
  minimized_hwnd: number | null;
}
export interface ContractMap {
  settings: Settings; day: DaySummary; live: LiveState; action: Action; ack: Ack;
  cancellations: Cancellations; 'sync-request': SyncRequest; 'sync-response': SyncResponse;
}
export const MAX_BODY_BYTES = 131072;
const BASE = 'https://aw-telegram.invalid/contracts/v2/';
const ajv = new Ajv({allErrors: false, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false});
ajv.addFormat('local-date', {type: 'string', validate: (value: string) => {try {parseDate(value); return true;} catch {return false;}}});
ajv.addFormat('utc-instant', {type: 'string', validate: (value: string) => {try {parseInstant(value); return true;} catch {return false;}}});
// dist/schemas is populated at build time. Production needs no files outside bot.
const bundled = new URL('./schemas/', import.meta.url);
const schemaDirectory = existsSync(bundled) ? bundled : new URL('../../contracts/v2/', import.meta.url);
for (const name of readdirSync(schemaDirectory).filter(n => n.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL(name, schemaDirectory), 'utf8')));
const aggregateValidators = [
  ajv.compile({type:'array', maxItems:1024, items:{$ref:`${BASE}shared.schema.json#/$defs/LeafTotal`}}),
  ajv.compile({type:'array', maxItems:4096, items:{$ref:`${BASE}shared.schema.json#/$defs/AppLeafTotal`}}),
] as const;

function primitives(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('JSON nesting exceeds transport bound');
  if (typeof value === 'string') {
    for (const c of value) {
      const scalar = c.codePointAt(0)!;
      if (scalar >= 0xd800 && scalar <= 0xdfff) throw new Error('strings must contain Unicode scalar values');
    }
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('numbers must be safe integers');
  } else if (value === null || typeof value === 'boolean') {
    return;
  } else if (Array.isArray(value)) {
    value.forEach(v => primitives(v, depth + 1));
  } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {primitives(key, depth+1); primitives(item, depth+1);}
  } else throw new Error('only strict JSON values are accepted');
}

export function parseJson(raw: string | Uint8Array): unknown {
  let text: string;
  if (typeof raw === 'string') {
    primitives(raw);
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('body exceeds 128 KiB');
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_BODY_BYTES) throw new Error('body exceeds 128 KiB');
    // Preserve a BOM so JSON.parse rejects it, matching Python's UTF-8 boundary.
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw);
  } else throw new Error('expected UTF-8 JSON');
  // JSON.parse establishes syntax; this lexical pass rejects duplicate decoded keys
  // and fractional/exponent number notation before any envelope is consumed.
  const value: unknown = JSON.parse(text);
  const tokens = Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}\[\]:,]|true|false|null/g), m => m[0]);
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i+1] === ':') {
      const key: string = JSON.parse(token); const keys = stack.at(-1);
      if (!keys || keys.has(key)) throw new Error('duplicate object key');
      keys.add(key);
    } else if (/^-?[0-9]/.test(token) && /[.eE]/.test(token)) throw new Error('wire numbers must use integer notation');
  }
  primitives(value);
  return value;
}

export function defaultSettings(): Settings {
  return {revision: 0, selectedPaths: [], selectedUncategorized: false, defaultLimitMs: 14400000,
    todayOverride: null, freeUseDate: null, suppressedDate: null};
}

export function categoryKey(path: CategoryPath): string {
  primitives(path);
  const check = ajv.getSchema(`${BASE}shared.schema.json#/$defs/CategoryPath`)!;
  if (!check(path)) throw new Error('invalid category path');
  return JSON.stringify(path);
}

function category(ref: CategoryRef): void {
  const expected = ref.path === null ? 'uncategorized' : categoryKey(ref.path);
  if (ref.id !== expected) throw new Error('category ID must be canonical exact path or uncategorized');
}

function unique(values: (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

export function selectedTotal(leaves: LeafTotal[], paths: CategoryPath[], uncategorized: boolean): number {
  unique(leaves.map(x => x.category.id), 'leaf category');
  let total = 0;
  for (const leaf of leaves) {
    category(leaf.category); const path = leaf.category.path;
    const selected = path === null ? uncategorized : paths.some(p => p.length <= path.length && p.every((s, i) => path[i] === s));
    if (selected) total += leaf.totalMs;
  }
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('selected total overflow');
  return total;
}

function reconcileApps(leaves: LeafTotal[], rows: AppLeafTotal[]): void {
  const expected = new Map(leaves.map(leaf => [leaf.category.id, leaf.totalMs]));
  const sums = new Map([...expected.keys()].map(id => [id, 0]));
  const pairs = new Map<string, Set<string>>();
  for (const row of rows) {
    let ids = pairs.get(row.app);
    if (!ids) {ids = new Set(); pairs.set(row.app, ids);}
    if (!expected.has(row.categoryId) || ids.has(row.categoryId)) throw new Error('orphan or duplicate app/category row');
    ids.add(row.categoryId);
    const total = sums.get(row.categoryId)! + row.totalMs;
    if (!Number.isSafeInteger(total)) throw new Error('application total overflow');
    sums.set(row.categoryId, total);
  }
  if (pairs.size > 256 || [...expected].some(([id, total]) => sums.get(id) !== total))
    throw new Error('invalid application reconciliation or cardinality');
}

function scalarCompare(a: string, b: string): number {
  const aa = Array.from(a, c => c.codePointAt(0)!), bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i=0; i<Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}

/** Derive from unfiltered category-attributed rows; no source revision is changed. */
export function selectedAppTotals(leaves: LeafTotal[], rows: AppLeafTotal[], paths: CategoryPath[], uncategorized: boolean): AppTotal[] {
  primitives([leaves, rows]);
  if (!aggregateValidators[0](leaves) || !aggregateValidators[1](rows)) throw new Error('invalid aggregate shape');
  selectedTotal(leaves, paths, uncategorized); paths.forEach(categoryKey);
  reconcileApps(leaves, rows);
  const chosen = new Set(leaves.filter(leaf => selectedTotal([leaf], paths, uncategorized)>0).map(leaf => leaf.category.id));
  const totals = new Map<string, number>();
  for (const row of rows) if (chosen.has(row.categoryId)) totals.set(row.app, (totals.get(row.app) ?? 0) + row.totalMs);
  return [...totals].map(([app, totalMs]) => ({app, totalMs})).sort((a,b) => b.totalMs-a.totalMs || scalarCompare(a.app,b.app));
}

export interface DayProjection {sourceSettingsRevision: Counter; settingsRevision: Counter; selectedTotalMs: number; appTotalsMs: AppTotal[]}
export function projectDay(input: DaySummary, settingsInput: Settings): DayProjection {
  const v=validateContract('day',input), s=validateContract('settings',settingsInput);
  const total=selectedTotal(v.leafTotalsMs,s.selectedPaths,s.selectedUncategorized);
  if (v.settingsRevision===s.revision && v.selectedTotalMs!==total) throw new Error('selected total disagrees with known settings');
  return {sourceSettingsRevision:v.settingsRevision,settingsRevision:s.revision,selectedTotalMs:total,
    appTotalsMs:selectedAppTotals(v.leafTotalsMs,v.appLeafTotalsMs,s.selectedPaths,s.selectedUncategorized)};
}

export class ReportCapacityExceeded extends Error {
  constructor() {super('report_capacity_exceeded');}
}
/** One whole day with minimal required envelope. Task5 must bound actual packed bodies. */
export function ensureReportCapacity(day: DaySummary, sequence: Counter = Number.MAX_SAFE_INTEGER): void {
  primitives(day);
  if (day.leafTotalsMs.length>1024 || day.appLeafTotalsMs.length>4096 || new Set(day.appLeafTotalsMs.map(r=>r.app)).size>256)
    throw new ReportCapacityExceeded();
  const request=validateContract('sync-request',{schemaVersion:2,sequence,acks:[],summaries:[day]});
  if (Buffer.byteLength(JSON.stringify(request),'utf8')>MAX_BODY_BYTES) throw new ReportCapacityExceeded();
}

const reasons: Record<ActionStatus, (Reason | null)[]> = {
  accepted: [null], presenting: [null], presented: [null], dismissed: [null], completed: [null],
  replaced: ['replaced'], expired: ['display_busy', 'missed_deadline'], skipped: ['free_use'], canceled: ['canceled'],
  failed: ['presentation_failed'], unconfirmed: ['presentation_blocked', 'crash_during_presentation'],
};

function day(v: DaySummary): void {
  v.leafTotalsMs.forEach(x => category(x.category)); unique(v.leafTotalsMs.map(x => x.category.id), 'leaf category');
  reconcileApps(v.leafTotalsMs, v.appLeafTotalsMs);
  const total = v.leafTotalsMs.reduce((a, b) => a + b.totalMs, 0);
  if (!Number.isSafeInteger(total) || total !== v.totalActiveMs || v.selectedTotalMs > total) throw new Error('invalid disjoint totals');
  const bounds = dayBounds(v.date);
  if (v.availableFrom === null || v.availableThrough === null) {
    if (v.availableFrom !== v.availableThrough || !v.partial || v.leafTotalsMs.length || total || v.selectedTotalMs)
      throw new Error('unavailable coverage must be null/null, partial and empty');
  } else if (v.availableFrom < bounds.start || v.availableThrough > bounds.end || v.availableFrom > v.availableThrough ||
      total > Date.parse(v.availableThrough) - Date.parse(v.availableFrom)) throw new Error('totals or coverage outside actual Kyiv day');
}

function action(v: Action): void {
  const created = Date.parse(v.createdAt), target = Date.parse(v.targetAt), expires = Date.parse(v.expiresAt);
  const delay = target - created;
  const valid = delay === 0 ? expires-created === 60000 : delay >= 60000 && delay <= 1439*60000 && delay % 60000 === 0 && expires-target === 5000;
  if (!valid) throw new Error('invalid original action delivery/execution window');
}

function ack(v: Ack): void {
  if (v.kind !== 'action') return;
  if (v.acceptedAt === null) {
    if (!['expired','skipped','canceled','failed'].includes(v.status) || v.presentedAt !== null || v.occurrence !== 0)
      throw new Error('status/occurrence requires durable acceptance');
  } else if (v.at < v.acceptedAt || v.presentedAt !== null && (v.presentedAt < v.acceptedAt || v.presentedAt > v.at))
    throw new Error('inconsistent receipt timestamps');
  if (!reasons[v.status].includes(v.reason)) throw new Error('reason is incompatible with receipt status');
  if (v.status === 'presented' && v.presentedAt === null)
    throw new Error('status requires confirmed presentation evidence');
  if (['accepted','presenting','expired','skipped','unconfirmed'].includes(v.status) && v.presentedAt !== null)
    throw new Error('status cannot claim confirmed visibility');
}

function live(v: LiveState): void {
  if (v.category !== null) category(v.category);
  v.categoryCatalog.forEach(category); unique(v.categoryCatalog.map(x => x.id), 'catalog category');
  if (v.state === 'unknown' && [v.app,v.title,v.category,v.rulesRevision].some(x => x !== null))
    throw new Error('unknown foreground must clear identity');
}

function settings(v: Settings): void {unique(v.selectedPaths.map(categoryKey), 'selected path');}
function cancellations(v: Cancellations): void {unique(v.canceledIds, 'canceled ID');}

// Dispatch is explicit: nested objects are validated by the enclosing JSON schema.
function semantics<K extends keyof ContractMap>(name: K, value: ContractMap[K]): void {
  switch (name) {
    case 'settings': return settings(value as Settings);
    case 'day': return day(value as DaySummary);
    case 'live': return live(value as LiveState);
    case 'action': return action(value as Action);
    case 'ack': return ack(value as Ack);
    case 'cancellations': return cancellations(value as Cancellations);
    case 'sync-request': {
      const v = value as SyncRequest;
      unique((v.summaries ?? []).map(x => x.date), 'summary date'); (v.summaries ?? []).forEach(day);
      if (v.live !== undefined) live(v.live);
      unique(v.acks.map(x => x.id), 'receipt ID'); v.acks.forEach(ack); return;
    }
    case 'sync-response': {
      const v = value as SyncResponse;
      settings(v.settings); cancellations(v.cancellations);
      unique(v.deliveryOffers.map(x => x.id), 'offered action ID'); unique(v.acknowledgedAckIds, 'acknowledged receipt ID');
      v.deliveryOffers.forEach(action);
      if (v.collectionStartedAt !== null && v.collectionStartedAt > v.serverNow) throw new Error('collection cannot begin in the future');
    }
  }
}

export function validateContract<K extends keyof ContractMap>(name: K, value: unknown): ContractMap[K] {
  const validator: ValidateFunction | undefined = ajv.getSchema(BASE + name + '.schema.json');
  if (!validator || name === ('shared' as string)) throw new Error('unknown contract');
  primitives(value);
  if ((name==='sync-request' || name==='sync-response') && value!==null && typeof value==='object' &&
      'schemaVersion' in value && Number.isInteger(value.schemaVersion) && value.schemaVersion!==2)
    throw new Error('unsupported sync schema version');
  if (!validator(value)) throw new Error(`invalid ${name} shape at ${validator.errors?.[0]?.instancePath ?? ''}`);
  const validated = value as ContractMap[K]; semantics(name, validated);
  return structuredClone(validated);
}

export function collectionStart(cached: Instant | null, received: Instant | null): Instant | null {
  if (cached !== null) parseInstant(cached);
  if (received !== null) parseInstant(received);
  if (cached !== null && cached !== received) throw new Error('immutable collection start changed or disappeared');
  return received;
}

export function validateActivityContext(input: unknown, startedAt: Instant | null, now: Instant): void {
  const request = validateContract('sync-request', input); parseInstant(now);
  if (startedAt === null) {
    if (request.summaries?.length || request.live !== undefined) throw new Error('activity prohibited before first pairing');
    return;
  }
  parseInstant(startedAt);
  if (startedAt > now) throw new Error('collection start is in the future');
  const dates = retainedDates(now);
  for (const summary of request.summaries ?? []) {
    if (!dates.includes(summary.date) || dayBounds(summary.date).end <= startedAt) throw new Error('summary outside retained collection dates');
    if (summary.availableFrom !== null && (summary.availableFrom < startedAt || summary.availableThrough! > now))
      throw new Error('coverage outside collection/current time');
  }
  if (request.live !== undefined && (request.live.observedAt < startedAt || request.live.observedAt > now))
    throw new Error('live observation outside collection/current time');
}

export function actionCanceled(input: unknown, cancellationInput: unknown): boolean {
  const a = validateContract('action', input), fence = validateContract('cancellations', cancellationInput);
  return a.sequence <= fence.throughActionSequence || fence.canceledIds.includes(a.id);
}

export function validateActionReceipt(input: unknown, receiptInput: unknown): void {
  const a = validateContract('action', input), r = validateContract('ack', receiptInput);
  if (r.kind !== 'action' || r.actionId !== a.id) throw new Error('receipt does not refer to this action');
  if (r.at < a.createdAt) throw new Error('receipt event precedes action creation');
  if (r.acceptedAt !== null && (r.acceptedAt < a.createdAt || r.acceptedAt >= a.expiresAt)) throw new Error('acceptance outside original action window');
  if (r.occurrence > 0 && (a.kind !== 'overlay' || !a.options.dismissible || a.options.repeatEveryMinutes === null))
    throw new Error('only repeating dismissible overlays have later occurrences');
  if (r.presentedAt !== null) {
    if (r.occurrence === 0) {
      if (r.presentedAt < a.targetAt || (a.targetAt === a.createdAt ? r.presentedAt >= a.expiresAt : r.presentedAt > a.expiresAt))
        throw new Error('initial presentation missed original window');
    } else if (r.presentedAt < a.targetAt || r.presentedAt >= dayBounds(kyivDate(a.targetAt)).end)
      throw new Error('repetition outside original Kyiv date');
  }
}
