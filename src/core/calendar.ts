import { CALENDAR_FIRST_YEAR, CALENDAR_LAST_YEAR, HK_HOLIDAYS, US_HOLIDAYS } from './calendar-data';
import {
  addDays,
  dayOfWeek,
  diffDays,
  endOfMonth,
  type ISODate,
  isWeekend,
  monthOf,
  startOfNextMonth,
  yearOf,
  ymd,
} from './dates';

export type Market = 'US' | 'HK';

const HOLIDAY_SETS: Record<Market, ReadonlySet<string>> = {
  HK: new Set(HK_HOLIDAYS),
  US: new Set(US_HOLIDAYS),
};

export class CalendarRangeError extends RangeError {
  constructor(day: ISODate) {
    super(
      `calendar covers ${CALENDAR_FIRST_YEAR}-${CALENDAR_LAST_YEAR}; ${day} is outside it (re-run scripts/gen-calendars.ts)`,
    );
    this.name = 'CalendarRangeError';
  }
}

function assertInRange(day: ISODate): void {
  const y = yearOf(day);
  if (y < CALENDAR_FIRST_YEAR || y > CALENDAR_LAST_YEAR) throw new CalendarRangeError(day);
}

export function isHoliday(market: Market, day: ISODate): boolean {
  assertInRange(day);
  return HOLIDAY_SETS[market].has(day);
}

export function isTradingDay(market: Market, day: ISODate): boolean {
  assertInRange(day);
  return !isWeekend(day) && !HOLIDAY_SETS[market].has(day);
}

/** Latest trading day on or before `day`. */
export function lastTradingDayOnOrBefore(market: Market, day: ISODate): ISODate {
  let d = day;
  while (!isTradingDay(market, d)) d = addDays(d, -1);
  return d;
}

/** Latest trading day strictly before `day`. */
export function prevTradingDay(market: Market, day: ISODate): ISODate {
  return lastTradingDayOnOrBefore(market, addDays(day, -1));
}

/** Earliest trading day on or after `day`. */
export function nextTradingDayOnOrAfter(market: Market, day: ISODate): ISODate {
  let d = day;
  while (!isTradingDay(market, d)) d = addDays(d, 1);
  return d;
}

export function nextTradingDay(market: Market, day: ISODate): ISODate {
  return nextTradingDayOnOrAfter(market, addDays(day, 1));
}

/** Trading days in [from, to] inclusive. */
export function tradingDaysBetween(market: Market, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(market, d)) out.push(d);
  return out;
}

/** Last trading day of the calendar month. */
export function lastBusinessDayOfMonth(market: Market, year: number, month: number): ISODate {
  return lastTradingDayOnOrBefore(market, endOfMonth(year, month));
}

/**
 * HKEX monthly stock-option expiry: the business day immediately preceding the last business day of the month.
 * "Business day" is an HKEX trading day, so holidays shift the result (e.g. Good Friday at month end).
 */
export function hkMonthlyExpiry(year: number, month: number): ISODate {
  return prevTradingDay('HK', lastBusinessDayOfMonth('HK', year, month));
}

/** Third Friday of the month, or the preceding trading day when that Friday is a holiday. */
export function usMonthlyExpiry(year: number, month: number): ISODate {
  let d = ymd(year, month, 1);
  while (dayOfWeek(d) !== 5) d = addDays(d, 1);
  d = addDays(d, 14);
  return lastTradingDayOnOrBefore('US', d);
}

/** US stock-option weekly/monthly expiry: Friday, or the last trading day before a holiday Friday. */
export function isUsExpiryDay(day: ISODate): boolean {
  assertInRange(day);
  if (!isTradingDay('US', day)) return false;
  if (dayOfWeek(day) === 5) return true;
  if (dayOfWeek(day) === 4) return !isTradingDay('US', addDays(day, 1)) && !isWeekend(addDays(day, 1));
  return false;
}

export function isHkExpiryDay(day: ISODate): boolean {
  assertInRange(day);
  return hkMonthlyExpiry(yearOf(day), monthOf(day)) === day;
}

export function isExpiryDay(market: Market, day: ISODate): boolean {
  return market === 'HK' ? isHkExpiryDay(day) : isUsExpiryDay(day);
}

/** Expiry days in [from, to] for the market's option rules (HK: monthlies only in v1). */
export function expiriesBetween(market: Market, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (market === 'HK') {
    for (let m = from.slice(0, 7) + '-01'; m <= to; m = startOfNextMonth(m)) {
      const e = hkMonthlyExpiry(yearOf(m), monthOf(m));
      if (e >= from && e <= to) out.push(e);
    }
    return out;
  }
  for (let d = from; d <= to; d = addDays(d, 1)) if (isUsExpiryDay(d)) out.push(d);
  return out;
}

/** Calendar days between two dates (b - a); convenience used for DTE. */
export function dte(asOf: ISODate, expiry: ISODate): number {
  return diffDays(expiry, asOf);
}

/** All calendar rows for seeding the exchange_calendar table. */
export function calendarRows(market: Market): { day: ISODate; isTradingDay: boolean; note: string | null }[] {
  const rows: { day: ISODate; isTradingDay: boolean; note: string | null }[] = [];
  for (let d = ymd(CALENDAR_FIRST_YEAR, 1, 1); d <= ymd(CALENDAR_LAST_YEAR, 12, 31); d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    const holiday = HOLIDAY_SETS[market].has(d);
    rows.push({ day: d, isTradingDay: !holiday, note: holiday ? 'holiday' : null });
  }
  return rows;
}
