import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffDays } from '../../src/core/dates';
import { iv30 } from '../../src/indicators/chain-iv';
import { createReplayFetch, ReplayMissError, requestKey, writeReplayFixture } from '../../src/providers/http-replay';
import { ProviderError, YahooClient } from '../../src/providers/yahoo/client';
import {
  buildYahooSnapshot,
  expiryOf,
  finite,
  localDate,
  MARKET_TZ,
  normalizeCalendar,
  normalizeChartBars,
  normalizePutRows,
  normalizeStatementRow,
  selectExpiries,
  toDate,
} from '../../src/providers/yahoo/normalize';

const BASE = 'tests/fixtures/http/yahoo-recorded';
const client = new YahooClient({ fetch: createReplayFetch(BASE) });
const tmp: string[] = [];
const overlayDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ot-overlay-'));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe('replay fetch', () => {
  it('request keys ignore host, period1/period2 and crumb but keep the symbol and option expiry', () => {
    const a = requestKey(
      'GET',
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?period1=1&period2=2&interval=1d&crumb=abc',
    );
    const b = requestKey(
      'GET',
      'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&period2=999&period1=7',
    );
    expect(a).toBe(b);
    expect(
      requestKey('GET', 'https://query2.finance.yahoo.com/v7/finance/options/AAPL?date=1792713600&crumb=z'),
    ).toContain('date=1792713600');
  });

  it('never falls through to the network: an unrecorded request throws', async () => {
    const f = createReplayFetch(BASE);
    await expect(f('https://query2.finance.yahoo.com/v8/finance/chart/ZZZZ?interval=1d')).rejects.toBeInstanceOf(
      ReplayMissError,
    );
  });

  it('answers the cookie/crumb handshake with canned responses', async () => {
    const f = createReplayFetch(BASE);
    const crumb = await f('https://query1.finance.yahoo.com/v1/test/getcrumb');
    expect(await crumb.text()).toBe('replaycrumb');
    const page = await f('https://finance.yahoo.com/quote/AAPL');
    expect(page.headers.getSetCookie().length).toBe(1);
  });
});

describe('bars (chart)', () => {
  it('US bars: ~10 years, ascending, unique days, last bar is the last NYSE session', async () => {
    const bars = normalizeChartBars(await client.chart('AAPL', '2016-10-10', '2026-10-11'), 'yahoo');
    expect(bars.length).toBeGreaterThan(2400);
    expect(bars[0]?.day).toBe('2016-10-10');
    expect(bars[bars.length - 1]?.day).toBe('2026-10-09');
    expect(new Set(bars.map((b) => b.day)).size).toBe(bars.length);
    for (let i = 1; i < bars.length; i++)
      expect((bars[i] as { day: string }).day > (bars[i - 1] as { day: string }).day).toBe(true);
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.close).toBeGreaterThan(0);
      expect(b.source).toBe('yahoo');
    }
    expect(bars[bars.length - 1]?.close).toBeCloseTo(336.64, 2);
  });

  it('HK bars are dated in Hong Kong time, not shifted by UTC (09:30 HKT is 01:30 UTC the same day)', async () => {
    const raw = await client.chart('0700.HK', '2016-10-10', '2026-10-11');
    expect(raw.timezone).toBe('Asia/Hong_Kong');
    const bars = normalizeChartBars(raw, 'yahoo');
    expect(bars[bars.length - 1]).toMatchObject({ day: '2026-10-09', close: expect.closeTo(424.8, 1) });
  });

  it('localDate respects the exchange timezone', () => {
    const t = new Date('2026-10-09T01:30:00Z');
    expect(localDate(t, 'Asia/Hong_Kong')).toBe('2026-10-09');
    expect(localDate(new Date('2026-10-09T23:30:00Z'), 'Asia/Hong_Kong')).toBe('2026-10-10');
    expect(localDate(new Date('2026-10-09T03:00:00Z'), 'America/New_York')).toBe('2026-10-08');
  });

  it('drops rows with null prices and keeps the last of duplicate days', () => {
    const q = (date: string, close: unknown) => ({ date, open: close, high: close, low: close, close, volume: 5 });
    const bars = normalizeChartBars(
      {
        timezone: 'UTC',
        currency: 'USD',
        quotes: [
          q('2026-01-05T14:30:00Z', 10),
          q('2026-01-06T14:30:00Z', null),
          q('2026-01-07T14:30:00Z', 11),
          q('2026-01-07T20:00:00Z', 12),
        ],
      },
      'yahoo',
    );
    expect(bars.map((b) => [b.day, b.close])).toEqual([
      ['2026-01-05', 10],
      ['2026-01-07', 12],
    ]);
  });

  it('indices and FX are recorded too (VIX, SPY, 2800.HK, HSI, USDHKD, CNYHKD)', async () => {
    for (const s of ['^VIX', 'SPY', '2800.HK', '^HSI', 'HKD=X', 'CNYHKD=X']) {
      const bars = normalizeChartBars(await client.chart(s, '2016-10-10', '2026-10-11'), 'yahoo');
      expect(bars.length, s).toBeGreaterThan(2400);
    }
  });
});

describe('fundamentals', () => {
  it('HK annual statements normalise with money fields filled and reported_at left to the writer', async () => {
    const rows = await client.fundamentals('0700.HK', 'annual', '2014-01-01');
    const st = rows.map((r) => normalizeStatementRow(r, { currency: 'CNY' })).filter((s) => s !== null);
    expect(st.length).toBeGreaterThanOrEqual(4);
    const last = st[st.length - 1];
    expect(last?.periodType).toBe('annual');
    expect(last?.periodEnd).toBe('2025-12-31');
    expect(last?.currency).toBe('CNY');
    for (const f of ['revenue', 'netIncome', 'totalAssets', 'totalLiabilities', 'cfo', 'ebit'] as const) {
      expect(last?.[f], f).not.toBeNull();
    }
    expect(last?.reportedAtActual).toBeNull();
  });

  it('US quarterly statements are typed quarterly', async () => {
    const st = (await client.fundamentals('AAPL', 'quarterly', '2014-01-01'))
      .map((r) => normalizeStatementRow(r, { currency: 'USD' }))
      .filter((s) => s !== null);
    expect(st.length).toBeGreaterThanOrEqual(4);
    expect(new Set(st.map((s) => s?.periodType))).toEqual(new Set(['quarterly']));
  });

  it('rows without a period or with no financial content are dropped, not guessed', () => {
    expect(normalizeStatementRow({ date: new Date('2025-12-31'), periodType: 'TTM' }, { currency: 'USD' })).toBeNull();
    expect(normalizeStatementRow({ date: new Date('2025-12-31'), periodType: '12M' }, { currency: 'USD' })).toBeNull();
    expect(normalizeStatementRow({ periodType: '12M', totalAssets: 5 }, { currency: 'USD' })).toBeNull();
  });

  it('profile reports the financial currency separately from the trading currency (HSBC: USD vs HKD)', async () => {
    const p = await client.profile('0005.HK');
    expect(p).toMatchObject({ tradingCurrency: 'HKD', financialCurrency: 'USD', sector: 'Financial Services' });
  });
});

describe('option chains', () => {
  it('AAPL snapshot is dated by the underlying quote in New York time and keeps puts within the strike range', async () => {
    const head = await client.options('AAPL');
    const snapshotDate = localDate(toDate(head.underlyingTime) as Date, MARKET_TZ.US);
    expect(snapshotDate).toBe('2026-10-09');
    expect(Number(head.underlyingPrice)).toBeCloseTo(336.64, 2);
    const expiries = selectExpiries(head.expirationDates, snapshotDate, 14, 75);
    expect(expiries.length).toBeGreaterThanOrEqual(4);
    const puts: { expiry: string; row: (typeof head.puts)[number] }[] = [];
    for (const e of expiries) {
      const r = await client.options('AAPL', e);
      const expiry = expiryOf(r) as string;
      expect(diffDays(expiry, snapshotDate)).toBeGreaterThanOrEqual(14);
      for (const row of r.puts) puts.push({ expiry, row });
    }
    const snap = buildYahooSnapshot({ underlyingPrice: Number(head.underlyingPrice), snapshotDate, puts }, 100);
    expect(snap.source).toBe('yahoo');
    expect(snap.tier).toBe('real');
    expect(snap.quotes.length).toBeGreaterThan(100);
    for (const q of snap.quotes) {
      expect(q.right).toBe('P');
      expect(q.strike).toBeGreaterThanOrEqual(0.5 * 336.64);
      expect(q.strike).toBeLessThanOrEqual(1.15 * 336.64);
      expect(q.multiplier).toBe(100);
    }
    // a real IV30 comes out of the recorded chain (AAPL vol is nowhere near 0 or 500%)
    const iv = iv30(snap, 0.04);
    expect(iv?.iv30).toBeGreaterThan(0.1);
    expect(iv?.iv30).toBeLessThan(1);
  });

  it('IV below 1% (Yahoo junk for stale rows) becomes null instead of a fake 0% vol', () => {
    const quotes = normalizePutRows(
      [{ expiry: '2026-11-20', row: { strike: 330, bid: 1, ask: 1.2, impliedVolatility: 0.00001 } }],
      { underlying: 336, multiplier: 100, strikeLo: 0.5, strikeHi: 1.15 },
    );
    expect(quotes[0]?.iv).toBeNull();
  });

  it('negative or non-numeric quotes are not trusted', () => {
    const quotes = normalizePutRows(
      [{ expiry: '2026-11-20', row: { strike: 330, bid: -1, ask: 'x', impliedVolatility: 0.3 } }],
      { underlying: 336, multiplier: 100, strikeLo: 0.5, strikeHi: 1.15 },
    );
    expect(quotes[0]).toMatchObject({ bid: null, ask: null });
    expect(finite('abc')).toBeNull();
  });
});

describe('calendar events', () => {
  it('AAPL earnings and ex-dividend dates', async () => {
    const cal = normalizeCalendar(await client.calendar('AAPL'), 'US');
    expect(cal.earnings).toEqual([{ date: '2026-11-02', confirmed: true }]);
    expect(cal.exDividend).toBe('2026-08-10');
  });

  it('a two-date earnings range is an estimate: earliest date, unconfirmed', () => {
    const cal = normalizeCalendar(
      {
        earningsDates: ['2026-10-20T08:00:00Z', '2026-10-25T08:00:00Z'],
        earningsIsEstimate: true,
        exDividendDate: null,
      },
      'HK',
    );
    expect(cal.earnings).toEqual([{ date: '2026-10-20', confirmed: false }]);
  });
});

describe('failure fixtures (provider contract)', () => {
  it('Yahoo "Not Found" surfaces as a ProviderError with code not_found', async () => {
    const dir = overlayDir();
    writeReplayFixture(dir, {
      url: 'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&events=div|split|earn&useYfid=true',
      status: 404,
      body: JSON.stringify({
        chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
      }),
    });
    const c = new YahooClient({ fetch: createReplayFetch([dir, BASE]) });
    await expect(c.chart('AAPL', '2016-10-10', '2026-10-11')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'not_found',
    });
  });

  it('a 429 crumb/rate-limit outage surfaces as code rate_limit', async () => {
    const dir = overlayDir();
    writeReplayFixture(dir, {
      url: 'https://query2.finance.yahoo.com/v8/finance/chart/MSFT?interval=1d&events=div|split|earn&useYfid=true',
      status: 429,
      contentType: 'text/plain',
      body: 'Too Many Requests',
    });
    const c = new YahooClient({ fetch: createReplayFetch([dir, BASE]) });
    const err = await c.chart('MSFT', '2016-10-10', '2026-10-11').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('rate_limit');
  });
});
