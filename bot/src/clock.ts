/** Kyiv calendar policy; moment-timezone includes a pinned IANA database. */
import moment from 'moment-timezone';
const ZONE = 'Europe/Kyiv';
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

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
    start: formatInstant(moment.tz(value, 'YYYY-MM-DD', true, ZONE).toDate()),
    end: formatInstant(moment.tz(next, 'YYYY-MM-DD', true, ZONE).toDate()),
  };
}

export function kyivDate(now: string): string {
  return parseDate(moment(parseInstant(now)).tz(ZONE).format('YYYY-MM-DD'));
}

export function retainedDates(now: string): string[] {
  const today = moment.utc(kyivDate(now), 'YYYY-MM-DD', true);
  return Array.from({length: 7}, (_, n) => parseDate(today.clone().subtract(n, 'days').format('YYYY-MM-DD')));
}

export function retentionStart(now: string): string {
  return dayBounds(retainedDates(now)[6]!).start;
}
