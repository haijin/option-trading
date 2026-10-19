import { describe, expect, it } from 'vitest';
import {
  briefSessionDue,
  canonicalUrl,
  fmtDayMonth,
  fmtStrike,
  hkDayOf,
  hkDayStart,
  isHttpUrl,
  localClock,
  marketIsOpen,
  newsFetchDue,
  newsHash,
  newsWindow,
} from '../../src/core/news';

describe('Hong Kong day boundaries', () => {
  it('buckets an instant by the Hong Kong calendar day', () => {
    expect(hkDayOf(new Date('2026-10-12T15:59:59Z'))).toBe('2026-10-12'); // 23:59:59 HKT
    expect(hkDayOf(new Date('2026-10-12T16:00:00Z'))).toBe('2026-10-13'); // 00:00 HKT
    expect(hkDayOf(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
  });

  it('starts a day at 00:00 HKT', () => {
    expect(hkDayStart('2026-10-13').toISOString()).toBe('2026-10-12T16:00:00.000Z');
  });

  it('a past day ends where the next one starts; days widen the window backwards', () => {
    const now = new Date('2026-10-13T00:30:00Z');
    const one = newsWindow('2026-10-09', 1, now);
    expect(one.from.toISOString()).toBe('2026-10-08T16:00:00.000Z');
    expect(one.to.toISOString()).toBe('2026-10-09T16:00:00.000Z');
    expect(one.rolling).toBe(false);
    const three = newsWindow('2026-10-09', 3, now);
    expect(three.from.toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(three.to.toISOString()).toBe('2026-10-09T16:00:00.000Z');
  });

  it('today with one day is the rolling last 24 hours; with more days it runs from midnight to now', () => {
    const now = new Date('2026-10-13T00:30:00Z');
    const rolling = newsWindow('2026-10-13', 1, now);
    expect(rolling.rolling).toBe(true);
    expect(rolling.from.toISOString()).toBe('2026-10-12T00:30:00.000Z');
    expect(rolling.to.getTime()).toBe(now.getTime() + 1); // exclusive: one millisecond past now
    const week = newsWindow('2026-10-13', 7, now);
    expect(week.rolling).toBe(false);
    expect(week.from.toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(week.to.getTime()).toBe(now.getTime() + 1);
  });
});

describe('urls', () => {
  it('drops fragments and tracking parameters so the same story dedupes', () => {
    const a = 'https://Finance.Yahoo.com/markets/stocks/articles/x-123.html?.tsrc=rss&utm_source=feed#top';
    const b = 'https://finance.yahoo.com/markets/stocks/articles/x-123.html';
    expect(canonicalUrl(a)).toBe(b);
    expect(newsHash(a)).toBe(newsHash(b));
    expect(newsHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a query that identifies the story', () => {
    expect(canonicalUrl('https://example.com/read?id=7&utm_medium=x')).toBe('https://example.com/read?id=7');
  });

  it('accepts only http(s) links', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com/a')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('printing', () => {
  it('prints a day and a strike the way a trader writes them', () => {
    expect(fmtDayMonth('2026-11-14')).toBe('14 Nov');
    expect(fmtDayMonth('2026-01-05')).toBe('5 Jan');
    expect(fmtStrike(65)).toBe('65');
    expect(fmtStrike(62.5)).toBe('62.5');
    expect(fmtStrike(112.5000001)).toBe('112.5');
  });
});

describe('schedule', () => {
  it('reads a clock in a time zone', () => {
    expect(localClock(new Date('2026-10-13T01:30:00Z'), 'Asia/Hong_Kong')).toEqual({
      date: '2026-10-13',
      minutes: 9 * 60 + 30,
    });
    expect(localClock(new Date('2026-10-13T01:30:00Z'), 'America/New_York')).toEqual({
      date: '2026-10-12',
      minutes: 21 * 60 + 30,
    });
  });

  it('knows when each market is open (and that a weekend is not)', () => {
    expect(marketIsOpen('HK', new Date('2026-10-13T02:00:00Z'))).toBe(true); // Tue 10:00 HKT
    expect(marketIsOpen('HK', new Date('2026-10-13T09:00:00Z'))).toBe(false); // 17:00 HKT
    expect(marketIsOpen('US', new Date('2026-10-13T15:00:00Z'))).toBe(true); // 11:00 ET
    expect(marketIsOpen('US', new Date('2026-10-13T21:00:00Z'))).toBe(false); // 17:00 ET
    expect(marketIsOpen('HK', new Date('2026-10-10T02:00:00Z'))).toBe(false); // Saturday
  });

  it('fetches at the top of every hour, and at :30 only while a market is open', () => {
    expect(newsFetchDue(new Date('2026-10-13T03:00:00Z'))).toBe(true);
    expect(newsFetchDue(new Date('2026-10-13T03:30:00Z'))).toBe(true); // 11:30 HKT, HK open
    expect(newsFetchDue(new Date('2026-10-13T16:00:00Z'))).toBe(true);
    expect(newsFetchDue(new Date('2026-10-13T22:30:00Z'))).toBe(false); // 06:30 HKT / 18:30 ET: both closed
    expect(newsFetchDue(new Date('2026-10-10T03:30:00Z'))).toBe(false); // Saturday :30
    expect(newsFetchDue(new Date('2026-10-10T03:00:00Z'))).toBe(true); // Saturday top of hour: HKEXnews posts then
  });

  it('writes a brief only on a trading day of its market', () => {
    // Tue 13 Oct 2026 07:30 HKT, 21:00 HKT
    expect(briefSessionDue('hk_open', new Date('2026-10-12T23:30:00Z'))).toBe(true);
    expect(briefSessionDue('us_open', new Date('2026-10-13T13:00:00Z'))).toBe(true);
    // Sat 10 Oct 07:30 HKT
    expect(briefSessionDue('hk_open', new Date('2026-10-09T23:30:00Z'))).toBe(false);
    // Mon 12 Oct 21:00 HKT is Mon morning in New York: Columbus Day, a trading day for stocks
    expect(briefSessionDue('us_open', new Date('2026-10-12T13:00:00Z'))).toBe(true);
    // Fri 2 Oct 2026 21:00 HKT is Fri morning in New York: open; Sat 3 Oct is not
    expect(briefSessionDue('us_open', new Date('2026-10-03T13:00:00Z'))).toBe(false);
  });
});
