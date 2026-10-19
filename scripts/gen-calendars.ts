/**
 * Generates src/core/calendar-data.ts: static exchange holiday tables for HK (HKEX) and US (NYSE), 2010-2027.
 * Run once (`pnpm tsx scripts/gen-calendars.ts`) and commit the output; the app never computes holidays at runtime.
 *
 * HK lunar holidays come from the ICU Chinese calendar built into Node. The result is cross-checked against the
 * independent Python `holidays` package by tests/fixtures/gen/gen_hk_expiry.py (see tests/core/calendar.test.ts).
 */
import { writeFileSync } from 'node:fs';
import { addDays, dayOfWeek, type ISODate, toISO, ymd } from '../src/core/dates';

const FIRST_YEAR = 2010;
const LAST_YEAR = 2027;

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

const chineseFmt = new Intl.DateTimeFormat('en-u-ca-chinese', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});

/** Gregorian date of lunar (month, day) in the lunar year that starts in `year`; leap months are skipped. */
function lunarToGregorian(year: number, lunarMonth: number, lunarDay: number): ISODate {
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 2, 1); t += 86_400_000) {
    const parts = chineseFmt.formatToParts(new Date(t));
    const monthPart = parts.find((p) => p.type === 'month')?.value ?? '';
    const dayPart = Number(parts.find((p) => p.type === 'day')?.value);
    const relatedYear = Number(parts.find((p) => (p.type as string) === 'relatedYear')?.value);
    if (relatedYear !== year) continue;
    if (monthPart === String(lunarMonth) && dayPart === lunarDay) return toISO(new Date(t));
  }
  throw new Error(`no gregorian date for lunar ${year}-${lunarMonth}-${lunarDay}`);
}

/** Ching Ming (Qingming solar term, Beijing time): 4 Apr or 5 Apr. Validated against `holidays` in tests. */
const CHING_MING_DAY: Record<number, number> = {
  2010: 5,
  2011: 5,
  2012: 4,
  2013: 4,
  2014: 5,
  2015: 5,
  2016: 4,
  2017: 4,
  2018: 5,
  2019: 5,
  2020: 4,
  2021: 4,
  2022: 5,
  2023: 5,
  2024: 4,
  2025: 4,
  2026: 5,
  2027: 5,
};

/**
 * Lunar New Year's Day overrides where ICU's astronomical new moon lands minutes on the wrong side of Beijing midnight:
 * 2027's new moon is 23:56 CST on 6 Feb (HK Observatory: LNY = Saturday 6 Feb), ICU says 7 Feb.
 */
const LNY_OVERRIDE: Record<number, ISODate> = { 2027: '2027-02-06' };
/** Before 2011 a Sunday Lunar New Year's Day had no weekday substitute (2010-02-14 is the only case in range). */
const LNY_SUNDAY_SUBSTITUTE_FROM = 2011;

/** One-off HK closures that are not in the standing list. */
const HK_SPECIAL: ISODate[] = [
  '2015-09-03', // 70th anniversary of the victory of the Chinese war of resistance
];

function hkHolidays(year: number): Set<ISODate> {
  const out = new Set<ISODate>();
  const taken = new Set<ISODate>();

  /**
   * A holiday that falls on a Sunday, or on a day already taken by another holiday (e.g. Ching Ming = Easter Monday in
   * 2010, Mid-Autumn's next day = National Day in 2012), moves to the next day that is neither Sunday nor taken.
   */
  const place = (d: ISODate): void => {
    let cur = d;
    while (dayOfWeek(cur) === 0 || taken.has(cur)) cur = addDays(cur, 1);
    taken.add(cur);
    out.add(cur);
  };

  const dated: ISODate[] = [];
  dated.push(ymd(year, 1, 1));
  const lny = LNY_OVERRIDE[year] ?? lunarToGregorian(year, 1, 1);
  const lnyDays = [lny, addDays(lny, 1), addDays(lny, 2)];
  dated.push(...lnyDays.filter((d) => year >= LNY_SUNDAY_SUBSTITUTE_FROM || dayOfWeek(d) !== 0));
  dated.push(ymd(year, 4, CHING_MING_DAY[year] as number));
  const easter = easterSunday(year);
  dated.push(addDays(easter, -2), addDays(easter, -1), addDays(easter, 1));
  dated.push(ymd(year, 5, 1));
  dated.push(lunarToGregorian(year, 4, 8));
  dated.push(lunarToGregorian(year, 5, 5));
  dated.push(ymd(year, 7, 1));
  dated.push(addDays(lunarToGregorian(year, 8, 15), 1));
  dated.push(ymd(year, 10, 1));
  dated.push(lunarToGregorian(year, 9, 9));
  dated.push(ymd(year, 12, 25));
  // "First weekday after Christmas Day": 26 Dec, or 27 Dec when 26 Dec is a Sunday.
  dated.push(dayOfWeek(ymd(year, 12, 26)) === 0 ? ymd(year, 12, 27) : ymd(year, 12, 26));

  // Place the non-Sunday dates first so Sunday substitutes skip over them regardless of insertion order.
  for (const d of dated) if (dayOfWeek(d) !== 0) place(d);
  for (const d of dated) if (dayOfWeek(d) === 0) place(d);
  for (const d of HK_SPECIAL) if (d.startsWith(String(year))) place(d);
  return out;
}

function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  let d = ymd(year, month, 1);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return addDays(d, 7 * (n - 1));
}

function lastWeekday(year: number, month: number, weekday: number): ISODate {
  let d = ymd(year, month, 31);
  while (dayOfWeek(d) !== weekday) d = addDays(d, -1);
  return d;
}

/** NYSE observed-holiday rule: Saturday -> preceding Friday, Sunday -> following Monday. */
function observed(d: ISODate, newYears = false): ISODate | null {
  const w = dayOfWeek(d);
  if (w === 6) return newYears ? null : addDays(d, -1); // New Year's Day on a Saturday: market stays open
  if (w === 0) return addDays(d, 1);
  return d;
}

const US_SPECIAL: ISODate[] = [
  '2012-10-29', // Hurricane Sandy
  '2012-10-30', // Hurricane Sandy
  '2018-12-05', // National day of mourning, G.H.W. Bush
  '2025-01-09', // National day of mourning, J. Carter
];

function usHolidays(year: number): Set<ISODate> {
  const out = new Set<ISODate>();
  const add = (d: ISODate | null): void => {
    if (d) out.add(d);
  };
  add(observed(ymd(year, 1, 1), true));
  add(nthWeekday(year, 1, 1, 3)); // MLK
  add(nthWeekday(year, 2, 1, 3)); // Presidents Day
  add(addDays(easterSunday(year), -2)); // Good Friday
  add(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) add(observed(ymd(year, 6, 19)));
  add(observed(ymd(year, 7, 4)));
  add(nthWeekday(year, 9, 1, 1)); // Labor Day
  add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  add(observed(ymd(year, 12, 25)));
  for (const d of US_SPECIAL) if (d.startsWith(String(year))) out.add(d);
  return out;
}

function collect(fn: (y: number) => Set<ISODate>): ISODate[] {
  const all = new Set<ISODate>();
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) for (const d of fn(y)) all.add(d);
  // Keep only weekday closures: weekend dates carry no information.
  return [...all].filter((d) => dayOfWeek(d) !== 0 && dayOfWeek(d) !== 6).sort();
}

const hk = collect(hkHolidays);
const us = collect(usHolidays);

const fmt = (name: string, list: ISODate[]): string => {
  const rows: string[] = [];
  for (let i = 0; i < list.length; i += 6) {
    rows.push(
      `  ${list
        .slice(i, i + 6)
        .map((d) => `'${d}'`)
        .join(', ')},`,
    );
  }
  return `export const ${name}: readonly string[] = [\n${rows.join('\n')}\n];`;
};

const content = `// GENERATED by scripts/gen-calendars.ts. Do not edit by hand; re-run the script and commit the result.
// Weekday exchange closures only (weekends are implicit). Range: ${FIRST_YEAR}-01-01 .. ${LAST_YEAR}-12-31.
// Unplanned closures (typhoon, emergencies) are not modelled except those listed in the generator.
export const CALENDAR_FIRST_YEAR = ${FIRST_YEAR};
export const CALENDAR_LAST_YEAR = ${LAST_YEAR};

${fmt('HK_HOLIDAYS', hk)}

${fmt('US_HOLIDAYS', us)}
`;
writeFileSync(new URL('../src/core/calendar-data.ts', import.meta.url), content);
console.log(`HK weekday holidays: ${hk.length}, US: ${us.length}`);
