/**
 * Calendar math for the journal: ISO days (`YYYY-MM-DD`), Monday-first weeks and month grids. Pure and timezone-free:
 * every day is handled as a UTC date so a phone in any timezone computes the same grid.
 */

const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function utc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Local calendar date of a moment, as `YYYY-MM-DD`. */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Local `HH:MM` of an epoch time or an ISO timestamp. */
export function localTime(at: number | string): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Monday = 0 ... Sunday = 6. */
export function weekdayIndex(day: string): number {
  return (utc(day).getUTCDay() + 6) % 7;
}

export function addDays(day: string, n: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** `2026-10-13` -> `2026-10`. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** `addMonths('2026-12', 1)` -> `2027-01`. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

/** `Tue 13 Oct 2026`. */
export function longDate(day: string): string {
  const d = utc(day);
  return `${DOW_SHORT[weekdayIndex(day)]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `Tue 13 Oct` (the entry cards). */
export function cardDate(day: string): string {
  const d = utc(day);
  return `${DOW_SHORT[weekdayIndex(day)]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/** `October 2026`. */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTH_LONG[m - 1]} ${y}`;
}

/** `Oct` (the summary line). */
export function monthShort(month: string): string {
  const m = Number(month.slice(5, 7));
  return MONTH_SHORT[m - 1] ?? month;
}

export interface WeekDay {
  date: string;
  /** `Mon` ... `Sun`. */
  dow: string;
  day: number;
  weekend: boolean;
}

/** The seven days (Monday first) of the week that contains `day`. */
export function weekOf(day: string): WeekDay[] {
  const monday = addDays(day, -weekdayIndex(day));
  return DOW_SHORT.map((dow, i) => {
    const date = addDays(monday, i);
    return { date, dow, day: Number(date.slice(8, 10)), weekend: i >= 5 };
  });
}

export interface MonthCell {
  date: string;
  day: number;
  /** A day of the previous or next month shown only to complete the first or last week. */
  pad: boolean;
}

/** The cells of a month grid: Monday-first, padded with neighbouring days so every row is a full week. */
export function monthGrid(month: string): MonthCell[] {
  const first = `${month}-01`;
  const lead = weekdayIndex(first);
  const next = addMonths(month, 1);
  const days = Math.round((utc(`${next}-01`).getTime() - utc(first).getTime()) / 86_400_000);
  const total = Math.ceil((lead + days) / 7) * 7;
  const cells: MonthCell[] = [];
  for (let i = 0; i < total; i++) {
    const date = addDays(first, i - lead);
    cells.push({ date, day: Number(date.slice(8, 10)), pad: monthOf(date) !== month });
  }
  return cells;
}

export const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
