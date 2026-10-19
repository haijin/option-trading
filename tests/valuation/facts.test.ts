import { describe, expect, it } from 'vitest';
import type { Currency, FundamentalStatement } from '../../src/core/types';
import { buildFacts, kpiRows } from '../../src/valuation';
import { AS_OF, acme, assertNoNaN, factsFor, flat, input, stmt, weeklyBars, yearlyBars } from './helpers';

const cny = (over: Partial<FundamentalStatement> = {}): Partial<FundamentalStatement> => ({
  currency: 'CNY' as unknown as Currency,
  ...over,
});

describe('buildFacts: statement selection', () => {
  it('keeps annual statements only, ascending, one per period end (the one reported last)', () => {
    const older = stmt('2025-12-31', { netIncome: 1, reportedAt: '2026-01-01T00:00:00.000Z' });
    const newer = stmt('2025-12-31', { netIncome: 140, reportedAt: '2026-03-01T00:00:00.000Z' });
    const noise = [
      stmt('2026-06-30', { periodType: 'ttm', netIncome: 999 }),
      stmt('2026-06-30', { periodType: 'quarterly', netIncome: 999 }),
    ];
    const shuffled = [newer, ...noise, ...flat(3, {}, 2024).reverse(), older];
    const f = factsFor({ statements: shuffled });
    expect(f.annual.map((a) => a.year)).toEqual([2022, 2023, 2024, 2025]);
    expect(f.latest?.netIncome).toBe(140);
    expect(f.annualFromHalves).toBe(false);
  });

  it('normalises signs and fills per-share figures from the statement', () => {
    const f = factsFor({
      statements: [
        stmt('2025-12-31', {
          capex: -60,
          dividendsPaid: -56,
          buybacks: -7,
          interestExpense: -10,
          epsDiluted: null,
          fcf: null,
          cfo: 154,
          sharesDiluted: 100,
          netIncome: 140,
          totalEquity: 1000,
        }),
      ],
    });
    const a = f.latest;
    expect(a?.capex).toBe(60);
    expect(a?.dividendsPaid).toBe(56);
    expect(a?.buybacks).toBe(7);
    expect(a?.interestExpense).toBe(10);
    expect(a?.epsStmt).toBeCloseTo(1.4, 10); // net income / diluted shares when EPS is not reported
    expect(a?.fcf).toBe(94); // operating cash flow - capex when free cash flow is not reported
    expect(a?.dps).toBeCloseTo(0.56, 10);
    expect(a?.fcfPs).toBeCloseTo(0.94, 10);
    expect(a?.bvps).toBeCloseTo(10, 10);
  });

  it('a name with no statements has no facts and no latest', () => {
    const f = factsFor({ statements: [] });
    expect(f.annual).toEqual([]);
    expect(f.latest).toBeNull();
    expect(f.subPeriods).toEqual([]);
  });

  it('only quarterly statements: no annual figures, and a warning says why', () => {
    const q = [stmt('2025-03-31', { periodType: 'quarterly' }), stmt('2025-06-30', { periodType: 'quarterly' })];
    const f = factsFor({ statements: q });
    expect(f.annual).toEqual([]);
    expect(f.warnings.join(' ')).toMatch(/only quarterly statements/i);
    expect(f.subPeriods).toHaveLength(2);
  });
});

describe('buildFacts: currency conversion', () => {
  it('converts per-share figures to the trading currency with the latest rate and leaves ratios alone', () => {
    const f = buildFacts(
      input({
        currency: 'HKD',
        market: 'HK',
        price: 20,
        statements: flat(10, cny()),
        fxToTrading: (c) => (c === 'CNY' ? 1.08 : c === 'HKD' ? 1 : null),
      }),
    );
    expect(f.latest?.currency).toBe('CNY');
    expect(f.latest?.fx).toBe(1.08);
    expect(f.latest?.eps).toBeCloseTo(1.4 * 1.08, 10);
    expect(f.latest?.fcfPs).toBeCloseTo(0.94 * 1.08, 10);
    expect(f.latest?.bvps).toBeCloseTo(10 * 1.08, 10);
    expect(f.warnings).toEqual([]);

    const rows = Object.fromEntries(kpiRows(f).map((r) => [r.key, r]));
    expect(rows.roe5?.value).toBe(14); // a ratio of two CNY amounts: no FX
    expect(rows.net_margin?.value).toBe(14);
    expect(rows.fcf_yield?.value).toBeCloseTo(((0.94 * 1.08) / 20) * 100, 5);
    expect(rows.pe?.value).toBeCloseTo(20 / (1.4 * 1.08), 5);
    expect(rows.dividend_yield?.value).toBeCloseTo(((0.56 * 1.08) / 20) * 100, 5);
  });

  it('asks for the same-currency rate as 1 even if the lookup returns nothing', () => {
    const f = buildFacts(input({ fxToTrading: () => null }));
    expect(f.latest?.fx).toBe(1);
    expect(f.warnings).toEqual([]);
  });

  it('an unknown rate leaves per-share figures null, records one warning, and ratio rows still work', () => {
    const f = buildFacts(
      input({ currency: 'HKD', market: 'HK', statements: flat(10, cny()), fxToTrading: () => null }),
    );
    expect(f.latest?.fx).toBeNull();
    expect(f.latest?.eps).toBeNull();
    expect(f.latest?.fcfPs).toBeNull();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toMatch(/No FX rate CNY to HKD/);

    const rows = Object.fromEntries(kpiRows(f).map((r) => [r.key, r]));
    for (const key of ['fcf_yield', 'pe', 'pb', 'p_fcf', 'dividend_yield', 'earnings_yield', 'buyback_yield']) {
      expect(rows[key]?.value, key).toBeNull();
      expect(rows[key]?.status, key).toBe('info');
      expect(rows[key]?.text, key).toBe('no FX rate');
    }
    expect(rows.roe5?.value).toBe(14);
    expect(rows.gross_margin?.value).toBe(45);
    expect(rows.interest_cover?.value).toBe(21);
    assertNoNaN(kpiRows(f));
  });

  it('statements in different currencies are flagged, and growth is measured after conversion', () => {
    const f = buildFacts(
      input({
        currency: 'HKD',
        market: 'HK',
        statements: [
          ...flat(2, {}, 2023).map((s) => ({ ...s, currency: 'HKD' as Currency })),
          stmt('2024-12-31', cny({ revenue: 100 })),
        ],
        fxToTrading: (c) => (c === 'CNY' ? 10 : c === 'HKD' ? 1 : null),
      }),
    );
    expect(f.mixedCurrency).toBe(true);
    expect(f.warnings.join(' ')).toMatch(/several currencies/);
    // 2022 and 2023 are 1000 HKD; 2024 is 100 CNY x 10 = 1000 HKD: revenue is flat once converted.
    const rev = kpiRows(f).find((r) => r.key === 'revenue_cagr5');
    expect(rev?.value).toBe(0);
  });
});

describe('buildFacts: semiannual reporters', () => {
  const half = (periodEnd: string, over: Partial<FundamentalStatement> = {}) =>
    stmt(periodEnd, {
      periodType: 'semiannual',
      revenue: 500,
      grossProfit: 200,
      netIncome: 70,
      epsDiluted: 0.7,
      cfo: 80,
      capex: -30,
      fcf: 50,
      dividendsPaid: -28,
      totalEquity: 1000,
      ...over,
    });

  it('adds two half-years into one fiscal year and takes balance-sheet items from the later half', () => {
    const f = factsFor({
      statements: [
        half('2024-06-30', { totalEquity: 900 }),
        half('2024-12-31', { totalEquity: 1000 }),
        half('2025-06-30', { totalEquity: 1100 }),
        half('2025-12-31', { totalEquity: 1200 }),
      ],
    });
    expect(f.annualFromHalves).toBe(true);
    expect(f.annual.map((a) => a.periodEnd)).toEqual(['2024-12-31', '2025-12-31']);
    const a = f.latest;
    expect(a?.fromHalves).toBe(true);
    expect(a?.revenue).toBe(1000);
    expect(a?.netIncome).toBe(140);
    expect(a?.fcf).toBe(100);
    expect(a?.dividendsPaid).toBe(56);
    expect(a?.epsStmt).toBeCloseTo(1.4, 10);
    expect(a?.totalEquity).toBe(1200);
    expect(f.warnings.join(' ')).toMatch(/sum of 2 pairs of half-year/);
    // The half-years also feed the quarter table.
    expect(f.subPeriods.map((s) => s.kind)).toEqual(['semiannual', 'semiannual', 'semiannual', 'semiannual']);
  });

  it('skips a half-year with no partner instead of estimating the year', () => {
    const f = factsFor({
      statements: [half('2023-12-31'), half('2024-06-30'), half('2024-12-31'), half('2025-06-30'), half('2025-12-31')],
    });
    // Pairs from the latest backwards: (2025-06, 2025-12), (2024-06, 2024-12); 2023-12 is alone.
    expect(f.annual.map((a) => a.periodEnd)).toEqual(['2024-12-31', '2025-12-31']);
    expect(f.warnings.join(' ')).toMatch(/1 half-year statement\(s\) had no partner/);
  });

  it('pairs from the latest half-year, so a fresh interim ends the newest 12 months', () => {
    const f = factsFor({
      statements: [half('2024-12-31'), half('2025-06-30'), half('2025-12-31'), half('2026-06-30')],
    });
    expect(f.annual.map((a) => a.periodEnd)).toEqual(['2025-06-30', '2026-06-30']);
  });

  it('a flow missing in one half is missing for the year, never half a year', () => {
    const f = factsFor({
      statements: [half('2025-06-30', { grossProfit: null }), half('2025-12-31')],
    });
    expect(f.latest?.grossProfit).toBeNull();
    expect(f.latest?.revenue).toBe(1000);
  });

  it('half-years more than six months apart, or in different currencies, are not paired', () => {
    const far = factsFor({ statements: [half('2024-12-31'), half('2025-12-31')] });
    expect(far.annual).toEqual([]);
    const mixed = factsFor({ statements: [half('2025-06-30', { currency: 'HKD' }), half('2025-12-31')] });
    expect(mixed.annual).toEqual([]);
  });

  it('annual statements win when both kinds are stored', () => {
    const f = factsFor({ statements: [...flat(3), half('2025-06-30'), half('2025-12-31')] });
    expect(f.annualFromHalves).toBe(false);
    expect(f.annual).toHaveLength(3);
  });
});

describe('buildFacts: prices and the P/E history', () => {
  it('takes the last close on or before each period end; year-end P/E = close / EPS', () => {
    const bars = yearlyBars({ 2023: 14, 2024: 28, 2025: 42 }, '2022-12-26');
    const f = factsFor({ statements: flat(3), bars });
    expect(f.annual.map((a) => a.yearEndPrice)).toEqual([14, 28, 42]);
    expect(f.annual.map((a) => a.yearEndPe?.toFixed(6))).toEqual(['10.000000', '20.000000', '30.000000']);
  });

  it('no year-end price when the bars start later or have a gap of more than 10 days', () => {
    const late = factsFor({ statements: flat(3), bars: weeklyBars('2024-06-03', AS_OF, () => 30) });
    expect(late.annual.map((a) => a.yearEndPrice)).toEqual([null, 30, 30]);
    const gap = factsFor({ statements: flat(1), bars: weeklyBars('2025-12-01', '2025-12-15', () => 30) });
    expect(gap.latest?.yearEndPrice).toBeNull();
    expect(gap.latest?.yearEndPe).toBeNull();
  });

  it('no year-end P/E for a loss', () => {
    const f = factsFor({ statements: flat(2, { epsDiluted: -1, netIncome: -100 }) });
    expect(f.annual.every((a) => a.yearEndPe === null)).toBe(true);
  });

  it('records the span of the bars; null without bars', () => {
    const f = factsFor({ bars: weeklyBars('2020-01-06', '2026-01-05', () => 10) });
    expect(f.barsSpanYears).toBeCloseTo(6, 1);
    expect(factsFor({ bars: [] }).barsSpanYears).toBeNull();
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])('an invalid price (%s) becomes 0 with a warning', (price) => {
    const f = factsFor({ price });
    expect(f.price).toBe(0);
    expect(f.warnings.join(' ')).toMatch(/No valid price/);
    const rows = kpiRows(f);
    for (const k of ['fcf_yield', 'pe', 'pb', 'p_fcf', 'dividend_yield', 'earnings_yield', 'buyback_yield']) {
      expect(rows.find((r) => r.key === k)?.value, k).toBeNull();
    }
  });
});

describe('buildFacts: extras and fair value', () => {
  it('passes extras and the fair value through; junk becomes null', () => {
    const f = factsFor({
      extras: { altmanZ: 3.2, fScore: Number.NaN, netDebtEbitda: null },
      fairValue: { value: 55, asOf: '2026-09-30', moat: 'Wide', uncertainty: 'Low', source: 'morningstar' },
    });
    expect(f.extras).toEqual({ altmanZ: 3.2, fScore: null, netDebtEbitda: null });
    expect(f.fairValue?.value).toBe(55);
    expect(f.warnings).toEqual([]);
  });

  it('ignores a non-positive fair value and flags a stale one', () => {
    const bad = factsFor({ fairValue: { value: 0, asOf: '2026-09-30', moat: null, uncertainty: null, source: 'm' } });
    expect(bad.fairValue).toBeNull();
    expect(bad.warnings.join(' ')).toMatch(/not a positive number/);
    const stale = factsFor({
      fairValue: { value: 50, asOf: '2025-01-01', moat: null, uncertainty: null, source: 'm' },
    });
    expect(stale.fairValue?.value).toBe(50);
    expect(stale.warnings.join(' ')).toMatch(/days old/);
  });

  it('does not mutate its input and is deterministic', () => {
    const inp = input({ statements: acme(6) });
    const before = JSON.stringify(inp);
    const a = buildFacts(inp);
    const b = buildFacts(inp);
    expect(JSON.stringify(inp)).toBe(before);
    expect(a).toEqual(b);
  });
});
