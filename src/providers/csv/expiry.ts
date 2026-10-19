import { CalendarRangeError, hkMonthlyExpiry, isExpiryDay, type Market } from '../../core/calendar';
import { CALENDAR_FIRST_YEAR, CALENDAR_LAST_YEAR } from '../../core/calendar-data';
import { type ISODate, monthOf, yearOf } from '../../core/dates';

/**
 * Why `expiry` is not an expiry day on the market's calendar, as text to follow the word "expiry <date>", or null when
 * it is one. HK accepts monthly expiries only; days outside the static calendar tables are reported, not thrown.
 */
export function expiryDayProblem(market: Market, expiry: ISODate): string | null {
  try {
    if (isExpiryDay(market, expiry)) return null;
    if (market === 'HK') {
      const monthly = hkMonthlyExpiry(yearOf(expiry), monthOf(expiry));
      return `is not a monthly expiry day on the HK calendar (the ${expiry.slice(0, 7)} expiry is ${monthly})`;
    }
    return 'is not an expiry day on the US calendar (a Friday, or the Thursday before a Friday market holiday)';
  } catch (e) {
    if (!(e instanceof CalendarRangeError)) throw e;
    return `is outside the calendar tables (${CALENDAR_FIRST_YEAR}-${CALENDAR_LAST_YEAR})`;
  }
}
