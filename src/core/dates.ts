/** Calendar-date helpers on 'YYYY-MM-DD' strings. All arithmetic is UTC, so there is no DST or timezone drift. */
export type ISODate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function isISODate(s: string): boolean {
  if (!ISO_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function assertISODate(s: string, what = 'date'): ISODate {
  if (!isISODate(s)) throw new Error(`${what} must be a valid YYYY-MM-DD date, got "${s}"`);
  return s;
}

export function parseDate(d: ISODate): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return toISO(new Date(parseDate(d).getTime() + n * MS_PER_DAY));
}

/** a - b in whole days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / MS_PER_DAY);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(d: ISODate): number {
  return parseDate(d).getUTCDay();
}

export function isWeekend(d: ISODate): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function ymd(year: number, month: number, day: number): ISODate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function endOfMonth(year: number, month: number): ISODate {
  return ymd(year, month, daysInMonth(year, month));
}

export function yearOf(d: ISODate): number {
  return Number(d.slice(0, 4));
}

export function monthOf(d: ISODate): number {
  return Number(d.slice(5, 7));
}

/** First day of the calendar month after `d`'s month. */
export function startOfNextMonth(d: ISODate): ISODate {
  const y = yearOf(d);
  const m = monthOf(d);
  return m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}
