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
import {duration} from '../format.js';

export type UsagePeriod = 'today' | 'yesterday' | 'week';
export interface ReportData {
  now: Instant; settings: Settings; days: Map<string, DaySummary>;
  live: LiveState | null; health: Health | null; lastContactAt: Instant | null;
}

export const PAGE_CHARS = 3500;
const LIVE_FRESH_MS = 2 * 60000;
const ONLINE_MS = 60000;
const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

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
    return {now, settings: decodeSettings(settings!.data()), days: stored,
      live: live!.data()?.value ? validateContract('live', live!.data()!.value) : null,
      health: health!.data()?.value ?? null, lastContactAt: sync!.data()?.serverReceivedAt ?? null};
  });
}

export {duration};
const shortDate = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const weekday = (date: string): string => WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]!;
const days = (n: number): string => n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дні' : 'днів';
/** Only the single latest title is shown, flattened to one line and bounded. */
const title = (value: string | null): string => {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat ? ` — «${[...flat].slice(0, 200).join('')}»` : '';
};
const noSelection = (s: Settings): boolean => !s.selectedPaths.length && !s.selectedUncategorized;
function at(instant: string, now: string): string {
  return kyivDate(instant) === kyivDate(now) ? kyivTime(instant) : `${kyivTime(instant)}, ${shortDate(kyivDate(instant))}`;
}

function coverage(day: DaySummary, today: boolean): string {
  const from = day.availableFrom, through = day.availableThrough;
  if (through === null) return 'Даних за цей день немає.';
  const lateStart = from !== null && from > dayBounds(day.date).start;
  if (lateStart) return `Дані з ${kyivTime(from)} до ${kyivTime(through)}`;
  if (today) return `Дані станом на ${kyivTime(through)}`;
  return day.partial ? `Дані неповні, до ${kyivTime(through)}` : 'Дані повні';
}

function limitLine(data: ReportData, date: string, totalMs: number): string {
  if (data.settings.freeUseDate === date) return 'Ліміт: вільний режим до опівночі';
  const limit = effectiveLimitMs(data.settings, date), left = limit - totalMs;
  return `Ліміт: ${duration(limit)} · ${left >= 0 ? `залишилось ${duration(left)}` : `перевищено на ${duration(-left)}`}`;
}

function liveLine(live: LiveState | null, now: string): string | null {
  if (!live || !live.app) return null;
  const fresh = Date.parse(now) - Date.parse(live.observedAt) <= LIVE_FRESH_MS;
  if (fresh && live.state === 'afk') return `Зараз неактивний. Остання програма: ${live.app}`;
  return fresh ? `Зараз: ${live.app}${title(live.title)}` : `Остання активність о ${at(live.observedAt, now)}: ${live.app}${title(live.title)}`;
}

export function paginate(header: string, lines: string[]): string[] {
  const pages: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > PAGE_CHARS && current) {pages.push(current); current = `${header} (продовження)\n${line}`;}
    else current = next;
  }
  return [...pages, current];
}

function dayReport(period: 'today' | 'yesterday', data: ReportData): string[] {
  const dates = retainedDates(data.now), date = period === 'today' ? dates[0]! : dates[1]!;
  const header = `📊 ${period === 'today' ? 'Сьогодні' : 'Учора'}, ${shortDate(date)}`;
  const day = data.days.get(date);
  if (!day) return [[header, 'Даних за цей день немає.', ...(period === 'today' ? optional(liveLine(data.live, data.now)) : [])].join('\n')];
  const projection = projectDay(day, data.settings), partial = day.partial || day.availableThrough === null;
  const lines = [header, `Враховано: ${duration(projection.selectedTotalMs)}${partial ? ' (неповні дані)' : ''}`, coverage(day, period === 'today')];
  if (period === 'today') lines.push(limitLine(data, date, projection.selectedTotalMs));
  lines.push('');
  if (noSelection(data.settings)) lines.push('Категорії для обліку не вибрано, тому нічого не враховується.');
  else if (!projection.appTotalsMs.length) lines.push('У вибраних категоріях програм немає.');
  else projection.appTotalsMs.forEach((row, i) => lines.push(`${i + 1}. ${row.app} — ${duration(row.totalMs)}`));
  const current = period === 'today' ? liveLine(data.live, data.now) : null;
  if (current) lines.push('', current);
  return paginate(header, lines);
}
const optional = (line: string | null): string[] => line ? ['', line] : [];

function weekReport(data: ReportData): string[] {
  const dates = [...retainedDates(data.now)].reverse(), today = dates.at(-1)!;
  let total = 0, counted = 0, partial = false;
  const lines = ['📊 Останні 7 днів'];
  for (const date of dates) {
    const day = data.days.get(date), label = `${weekday(date)} ${shortDate(date)}`;
    if (!day) {lines.push(`${label} — немає даних`); continue;}
    const ms = projectDay(day, data.settings).selectedTotalMs, dayPartial = day.partial || day.availableThrough === null;
    total += ms; counted++; partial ||= dayPartial;
    const notes = [date === today ? 'сьогодні' : null, dayPartial ? 'неповні' : null].filter(Boolean);
    lines.push(`${label} — ${duration(ms)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  lines.push('', counted ? `Разом: ${duration(total)} за ${counted} ${days(counted)} з даними${partial ? ' (неповні дані)' : ''}.` : 'Даних за цей тиждень немає.');
  return [lines.join('\n')];
}

export function renderUsage(period: UsagePeriod, data: ReportData): string[] {
  return period === 'week' ? weekReport(data) : dayReport(period, data);
}

const AW_STATE: Record<Health['awState'], string> = {
  ready: 'працює', partial: 'неповні дані', stale: 'дані застаріли', unavailable: 'недоступний',
  unsupported: 'категорії не налаштовано', unknown: 'невідомо',
};

export function renderStatus(data: ReportData): string {
  const now = data.now, date = kyivDate(now), contact = data.lastContactAt;
  const lines = ['💻 Стан ноутбука'];
  if (contact === null) lines.push('Зв’язок: ноутбук ще не синхронізувався');
  else if (Date.parse(now) - Date.parse(contact) <= ONLINE_MS) lines.push(`Зв’язок: на зв’язку, остання синхронізація о ${kyivTime(contact)}`);
  else lines.push(`Зв’язок: немає зв’язку з ${at(contact, now)}`);
  lines.push(`ActivityWatch: ${data.health ? AW_STATE[data.health.awState] : 'невідомо'}${data.health?.reportError ? ' (звіт завеликий, показано останні дані)' : ''}`);
  const current = liveLine(data.live, now);
  if (current) lines.push(current);
  const day = data.days.get(date);
  if (!day) lines.push('Сьогодні: даних немає');
  else {
    const total = projectDay(day, data.settings).selectedTotalMs, partial = day.partial ? ' (неповні дані)' : '';
    if (data.settings.freeUseDate === date) lines.push(`Сьогодні: ${duration(total)}${partial}, вільний режим`);
    else {
      const limit = effectiveLimitMs(data.settings, date), left = limit - total;
      lines.push(`Сьогодні: ${duration(total)} з ${duration(limit)}, ${left >= 0 ? `залишилось ${duration(left)}` : `перевищено на ${duration(-left)}`}${partial}`);
    }
  }
  lines.push(`Вільний режим: ${data.settings.freeUseDate === date ? 'увімкнено до опівночі' : 'вимкнено'}`);
  lines.push(`Автоматичні нагадування: ${data.settings.suppressedDate === date ? 'вимкнено до опівночі' : 'активні'}`);
  return lines.join('\n');
}

