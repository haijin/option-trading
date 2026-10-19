import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CalendarRangeError,
  expiriesBetween,
  hkMonthlyExpiry,
  isExpiryDay,
  isHkExpiryDay,
  isTradingDay,
  isUsExpiryDay,
  lastTradingDayOnOrBefore,
  prevTradingDay,
  usMonthlyExpiry,
} from '../../src/core/calendar';
import { HK_HOLIDAYS, US_HOLIDAYS } from '../../src/core/calendar-data';
import { addDays, dayOfWeek } from '../../src/core/dates';

const fixture = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1);

/**
 * The oracle is the independent Python `holidays` package (tests/fixtures/gen/gen_hk_expiry.py). It lists a
 * "day following National Day" (3 Oct) in 2012, 2017 and 2023. The Holidays Ordinance schedule has no such holiday
 * (17 statutory days: National Day, the day following Mid-Autumn, Chung Yeung ...) and HKEX traded on those dates, so
 * the static table deliberately differs. Documented in DECISIONS.md. No other difference is tolerated.
 */
const HK_ORACLE_ONLY_ACCEPTED = ['2012-10-03', '2017-10-03', '2023-10-03'];

describe('static exchange calendars vs the independent oracle', () => {
  it('US holidays equal the oracle exactly (2010-2027)', () => {
    expect([...US_HOLIDAYS]).toEqual(fixture('us_holidays_expected.csv'));
  });

  it('HK holidays equal the oracle except the documented 3 Oct days', () => {
    const oracle = new Set(fixture('hk_holidays_expected.csv'));
    const mine = new Set(HK_HOLIDAYS);
    expect([...mine].filter((d) => !oracle.has(d))).toEqual([]);
    expect([...oracle].filter((d) => !mine.has(d))).toEqual(HK_ORACLE_ONLY_ACCEPTED);
  });

  it('holiday tables contain weekday closures only', () => {
    for (const d of [...HK_HOLIDAYS, ...US_HOLIDAYS]) expect([0, 6]).not.toContain(dayOfWeek(d));
  });
});

describe('HK monthly option expiry', () => {
  const expected = fixture('hk_expiry_expected.csv').map((l) => l.split(',') as [string, string]);

  it('has an expected value for every month 2010-2027', () => {
    expect(expected).toHaveLength(18 * 12);
  });

  it.each(expected)('%s expires on %s', (month, expiry) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    expect(hkMonthlyExpiry(y, m)).toBe(expiry);
  });

  it('shifts for holidays: Good Friday 2024-03-29 pushes the last business day to Thu 28th, expiry Wed 27th', () => {
    expect(hkMonthlyExpiry(2024, 3)).toBe('2024-03-27');
    expect(hkMonthlyExpiry(2013, 3)).toBe('2013-03-27');
  });

  it('is the business day before the last business day in ordinary months', () => {
    expect(hkMonthlyExpiry(2026, 10)).toBe('2026-10-29'); // 30 Oct is the last business day (31 Oct is Saturday)
    expect(hkMonthlyExpiry(2024, 2)).toBe('2024-02-28'); // 29 Feb Thursday is the last business day
  });

  it('exercises weekend and holiday skips in the committed list', () => {
    let holidaySkips = 0;
    let weekendSkips = 0;
    for (const [month, expiry] of expected) {
      const [y, m] = month.split('-').map(Number) as [number, number];
      const lastBd = lastTradingDayOnOrBefore(
        'HK',
        `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`,
      );
      const naive = addDays(lastBd, -1);
      if (naive !== expiry) {
        if (dayOfWeek(naive) === 0 || dayOfWeek(naive) === 6) weekendSkips++;
        else holidaySkips++;
      }
    }
    expect(weekendSkips).toBeGreaterThan(10);
    expect(holidaySkips).toBeGreaterThan(0);
  });

  it('expiry days are recognised as expiry days, neighbours are not', () => {
    expect(isHkExpiryDay('2024-03-27')).toBe(true);
    expect(isHkExpiryDay('2024-03-28')).toBe(false);
    expect(isExpiryDay('HK', '2024-03-27')).toBe(true);
  });
});

describe('trading-day helpers', () => {
  it('US 2026-07-03 (Friday) is the observed Independence Day holiday', () => {
    expect(isTradingDay('US', '2026-07-03')).toBe(false);
    expect(lastTradingDayOnOrBefore('US', '2026-07-04')).toBe('2026-07-02');
  });

  it('HK 2026-10-10 (Saturday) rolls back to Friday 2026-10-09', () => {
    expect(lastTradingDayOnOrBefore('HK', '2026-10-10')).toBe('2026-10-09');
    expect(prevTradingDay('HK', '2026-10-09')).toBe('2026-10-08');
  });

  it('US expiry days: Fridays, and Thursday when the Friday is a holiday', () => {
    expect(isUsExpiryDay('2026-10-16')).toBe(true);
    expect(isUsExpiryDay('2026-10-15')).toBe(false);
    expect(isUsExpiryDay('2026-07-02')).toBe(true); // Friday 3 Jul is a holiday
    expect(isUsExpiryDay('2026-07-03')).toBe(false);
    expect(usMonthlyExpiry(2026, 10)).toBe('2026-10-16');
    expect(usMonthlyExpiry(2025, 4)).toBe('2025-04-17'); // third Friday 18 Apr is Good Friday
  });

  it('expiriesBetween lists HK monthlies and US Fridays', () => {
    expect(expiriesBetween('HK', '2026-10-10', '2026-12-31')).toEqual(['2026-10-29', '2026-11-27', '2026-12-30']);
    expect(expiriesBetween('US', '2026-10-12', '2026-10-31')).toEqual(['2026-10-16', '2026-10-23', '2026-10-30']);
  });

  it('refuses dates outside the static range instead of guessing', () => {
    expect(() => isTradingDay('HK', '2028-01-03')).toThrow(CalendarRangeError);
    expect(() => isTradingDay('US', '2009-12-31')).toThrow(CalendarRangeError);
  });
});
