/** Private usage and status reports. Plain text only: app names and titles are never interpreted as markup.
 *
 * Rows are recomputed from the stored unfiltered source under the current selection, so a category
 * edit is reflected even on dates whose stored projection predates it. Missing or partial coverage
 * is stated, never shown as a measured zero; only today carries the single latest live title.
 */
import {FirestoreRepository,type ParentIdentity} from '../repository.js';
import {projectDay,validateContract,type DaySummary,type Health,type Instant,type LiveState,type Settings} from '../contracts.js';
import {dayBounds,kyivDate,kyivTime,retainedDates} from '../clock.js';
import {effectiveLimitMs} from '../alerts.js';
import {decodeSettings} from '../settingsCodec.js';
import {text as copy,type Catalogue} from './i18n/index.js';

export type UsagePeriod = 'today' | 'yesterday' | 'week';
export interface ReportData {
  now: Instant; settings: Settings; days: Map<string, DaySummary>;
  live: LiveState | null; health: Health | null; lastContactAt: Instant | null;
}

export const PAGE_CHARS = 3500;
const LIVE_FRESH_MS = 2 * 60000;
const ONLINE_MS = 90000;  // three 30 s syncs, as in the companion's «Стан»

/** One transaction after the caregiver check; reports never create events for anyone else. */
export async function loadReport(repository: FirestoreRepository, identity: ParentIdentity, now: Instant): Promise<ReportData> {
  return repository.db.runTransaction(async tx => {
    await repository.requireParent(tx, identity);
    const root = repository.db.doc(`devices/${identity.deviceId}`);
    const dates = retainedDates(now);
    const [settings, sync, live, health, ...days] = await tx.getAll(root.collection('settings').doc('current'),
      root.collection('sync').doc('current'), root.collection('live').doc('current'), root.collection('health').doc('current'),
      ...dates.map(date => root.collection('days').doc(date)));
    const stored = new Map<string, DaySummary>();
    days.forEach((doc, i) => {const source = doc!.data()?.source; if (source) stored.set(dates[i]!, validateContract('day', source));});
    // An unchanged live state is not rewritten; sync/current records when the laptop last reported it.
    const current = live!.data()?.value ? validateContract('live', live!.data()!.value) : null, seen = sync!.data()?.observed?.live?.observedAt;
    return {now, settings: decodeSettings(settings!.data()), days: stored,
      live: current && seen > current.observedAt ? {...current, observedAt: seen} : current,
      health: health!.data()?.value ?? null, lastContactAt: sync!.data()?.serverReceivedAt ?? null};
  });
}

/** A save reply warns that the change waits for the laptop when its last sync is absent or older than this. */
const OFFLINE_AFTER_MS = 2 * 60000;
/** One read of sync/current, after the save that just authorized the caregiver. */
export async function laptopOffline(repository: FirestoreRepository, identity: ParentIdentity, now: Instant): Promise<boolean> {
  const sync = await repository.db.runTransaction(tx => tx.get(repository.db.doc(`devices/${identity.deviceId}/sync/current`)));
  const at = sync.data()?.serverReceivedAt;
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;  // absent or unparsable counts as offline
  return !Number.isFinite(ms) || Date.parse(now) - ms > OFFLINE_AFTER_MS;
}

const shortDate = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const weekday = (date: string, t: Catalogue): string => t.WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]!;
/** Only the single latest title is shown, flattened to one line and bounded. */
const title = (value: string | null, t: Catalogue): string => {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat ? ` — ${t.quote([...flat].slice(0, 200).join(''))}` : '';
};
const noSelection = (s: Settings): boolean => !s.selectedPaths.length && !s.selectedUncategorized;
function at(instant: string, now: string): string {
  return kyivDate(instant) === kyivDate(now) ? kyivTime(instant) : `${kyivTime(instant)}, ${shortDate(kyivDate(instant))}`;
}

function coverage(day: DaySummary, today: boolean, t: Catalogue): string {
  const from = day.availableFrom, through = day.availableThrough;
  if (through === null) return t.NO_DAY_DATA;
  const lateStart = from !== null && from > dayBounds(day.date).start;
  if (lateStart) return t.coverageFrom(kyivTime(from), kyivTime(through));
  if (today) return t.coverageAsOf(kyivTime(through));
  return day.partial ? t.coveragePartial(kyivTime(through)) : t.COVERAGE_FULL;
}

/** What is left of a limit, or how far it is exceeded. */
const rest = (left: number, t: Catalogue): string => left >= 0 ? t.left(t.duration(left)) : t.over(t.duration(-left));
function limitLine(data: ReportData, date: string, totalMs: number, t: Catalogue): string {
  if (data.settings.freeUseDate === date) return t.LIMIT_FREE;
  const limit = effectiveLimitMs(data.settings, date);
  return t.limitLine(t.duration(limit), rest(limit - totalMs, t));
}

function liveLine(live: LiveState | null, now: string, t: Catalogue): string | null {
  if (!live || !live.app) return null;
  const fresh = Date.parse(now) - Date.parse(live.observedAt) <= LIVE_FRESH_MS;
  if (fresh && live.state === 'afk') return t.liveAway(live.app);
  return fresh ? t.liveNow(live.app, title(live.title, t)) : t.liveLast(at(live.observedAt, now), live.app, title(live.title, t));
}

export function paginate(header: string, lines: string[], t: Catalogue): string[] {
  const pages: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > PAGE_CHARS && current) {pages.push(current); current = `${t.continued(header)}\n${line}`;}
    else current = next;
  }
  return [...pages, current];
}

function dayReport(period: 'today' | 'yesterday', data: ReportData, t: Catalogue): string[] {
  const dates = retainedDates(data.now), date = period === 'today' ? dates[0]! : dates[1]!;
  const header = t.dayHeader(period, shortDate(date));
  const day = data.days.get(date);
  if (!day) return [[header, t.NO_DAY_DATA, ...(period === 'today' ? optional(liveLine(data.live, data.now, t)) : [])].join('\n')];
  const projection = projectDay(day, data.settings), partial = day.partial || day.availableThrough === null;
  const lines = [header, t.counted(t.duration(projection.selectedTotalMs)) + (partial ? t.PARTIAL : ''), coverage(day, period === 'today', t)];
  if (period === 'today') lines.push(limitLine(data, date, projection.selectedTotalMs, t));
  lines.push('');
  if (noSelection(data.settings)) lines.push(t.NO_SELECTION);
  else if (!projection.appTotalsMs.length) lines.push(t.NO_APPS);
  else projection.appTotalsMs.forEach((row, i) => lines.push(`${i + 1}. ${row.app} — ${t.duration(row.totalMs)}`));
  const current = period === 'today' ? liveLine(data.live, data.now, t) : null;
  if (current) lines.push('', current);
  return paginate(header, lines, t);
}
const optional = (line: string | null): string[] => line ? ['', line] : [];

function weekReport(data: ReportData, t: Catalogue): string[] {
  const dates = [...retainedDates(data.now)].reverse(), today = dates.at(-1)!;
  let total = 0, counted = 0, partial = false;
  const lines = [t.WEEK_HEADER];
  for (const date of dates) {
    const day = data.days.get(date), label = `${weekday(date, t)} ${shortDate(date)}`;
    if (!day) {lines.push(t.noData(label)); continue;}
    const ms = projectDay(day, data.settings).selectedTotalMs, dayPartial = day.partial || day.availableThrough === null;
    total += ms; counted++; partial ||= dayPartial;
    const notes = [date === today ? t.WEEK_NOTES.today : null, dayPartial ? t.WEEK_NOTES.partial : null].filter(Boolean);
    lines.push(`${label} — ${t.duration(ms)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  lines.push('', counted ? t.weekTotal(t.duration(total), counted, partial) : t.NO_WEEK_DATA);
  return [lines.join('\n')];
}

/** Ukrainian unless the reader's catalogue is given. */
export function renderUsage(period: UsagePeriod, data: ReportData, t: Catalogue = copy('uk')): string[] {
  return period === 'week' ? weekReport(data, t) : dayReport(period, data, t);
}

export function renderStatus(data: ReportData, t: Catalogue = copy('uk')): string {
  const now = data.now, date = kyivDate(now), contact = data.lastContactAt;
  const lines = [t.STATUS_TITLE];
  if (contact === null) lines.push(t.NEVER_SYNCED);
  else if (Date.parse(now) - Date.parse(contact) <= ONLINE_MS) lines.push(t.online(kyivTime(contact)));
  else lines.push(t.offline(at(contact, now)));
  lines.push(t.awLine(t.AW_STATE[data.health?.awState ?? 'unknown'], !!data.health?.reportError));
  const current = liveLine(data.live, now, t);
  if (current) lines.push(current);
  const day = data.days.get(date);
  if (!day) lines.push(t.TODAY_NO_DATA);
  else {
    const total = projectDay(day, data.settings).selectedTotalMs, partial = day.partial ? t.PARTIAL : '';
    if (data.settings.freeUseDate === date) lines.push(t.todayFree(t.duration(total), partial));
    else {
      const limit = effectiveLimitMs(data.settings, date);
      lines.push(t.todayLimit(t.duration(total), t.duration(limit), rest(limit - total, t), partial));
    }
  }
  lines.push(t.freeUseLine(data.settings.freeUseDate === date));
  lines.push(t.remindersLine(data.settings.suppressedDate === date));
  return lines.join('\n');
}

