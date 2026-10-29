/** Kyiv calendar policy; moment-timezone includes a pinned IANA database. */
import moment from 'moment-timezone';
const ZONE = 'Europe/Kyiv';
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ENDTIME = /^(?:00:(?:1[5-9]|[2-5][0-9])|(?:0[1-9]|1[0-9]|2[0-3]):[0-5][0-9])(?![\s\S])/;
const KYIV_ZONE = moment.tz.zone(ZONE)!;

function resolveKyiv(value: string, localTime: string): string {
  const wall = Date.parse(`${value}T${localTime}:00.000Z`);
  // Do not use moment's local parser: historical adjacent transitions can make
  // it return an instant whose wall time does not match the requested value.
  const candidates = [...new Set(KYIV_ZONE.offsets)].map(offset => ({offset, at:wall+offset*60000}))
    .filter(({offset, at}) => KYIV_ZONE.utcOffset(at) === offset).map(({at}) => at);
  if (candidates.length) return formatInstant(new Date(Math.min(...candidates)));
  // A missing time uses the pre-transition offset, moving forward by the gap.
  for (let i=0; i<KYIV_ZONE.untils.length-1; i++) {
    const transition=KYIV_ZONE.untils[i]!, before=KYIV_ZONE.offsets[i]!, after=KYIV_ZONE.offsets[i+1]!;
    if (after < before && wall >= transition-before*60000 && wall < transition-after*60000)
      return formatInstant(new Date(wall+before*60000));
  }
  throw new Error('unable to resolve Kyiv wall time');
}

export function parseDate(value: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error('expected calendar date');
  const year = Number(value.slice(0, 4));
  const parsed = moment.utc(value, 'YYYY-MM-DD', true);
  if (year < 1970 || year > 2099 || !parsed.isValid() || parsed.format('YYYY-MM-DD') !== value)
    throw new Error('invalid calendar date or unsupported year (1970..2099)');
  return value;
}

export function parseInstant(value: string): Date {
  if (typeof value !== 'string' || !INSTANT.test(value)) throw new Error('expected canonical UTC milliseconds');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value || value.startsWith('0000'))
    throw new Error('invalid Gregorian instant');
  return parsed;
}

export function formatInstant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new Error('expected valid Date');
  const formatted = value.toISOString();
  if (!INSTANT.test(formatted) || formatted.startsWith('0000')) throw new Error('unsupported UTC instant');
  return formatted;
}

export function dayBounds(value: string): {start: string; end: string} {
  parseDate(value);
  const next = moment.utc(value, 'YYYY-MM-DD', true).add(1, 'day').format('YYYY-MM-DD');
  return {
    start: resolveKyiv(value, '00:00'),
    end: resolveKyiv(next, '00:00'),
  };
}

export const isEndtimeLocalTime = (value: unknown): value is string => typeof value === 'string' && ENDTIME.test(value);

/** Resolve independently per Kyiv date: first repeated time, gaps shifted forward. */
export function endtimeAt(value: string, localTime: string): string {
  parseDate(value);
  if (!isEndtimeLocalTime(localTime))
    throw new Error('expected exact endtime HH:MM from 00:15 through 23:59');
  return resolveKyiv(value, localTime);
}

export function kyivDate(now: string): string {
  return parseDate(moment(parseInstant(now)).tz(ZONE).format('YYYY-MM-DD'));
}

/** Kyiv wall-clock `HH:mm` for display only. */
export function kyivTime(instant: string): string {
  return moment(parseInstant(instant)).tz(ZONE).format('HH:mm');
}

export function retainedDates(now: string): string[] {
  const today = moment.utc(kyivDate(now), 'YYYY-MM-DD', true);
  return Array.from({length: 7}, (_, n) => parseDate(today.clone().subtract(n, 'days').format('YYYY-MM-DD')));
}

export function retentionStart(now: string): string {
  return dayBounds(retainedDates(now)[6]!).start;
}
