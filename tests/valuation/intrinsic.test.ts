import { describe, expect, it } from 'vitest';
import type { Currency, FundamentalStatement } from '../../src/core/types';
import {
  dcfValue,
  defaultAssumptions,
  type Facts,
  impliedGrowth,
  intrinsicValue,
  priceBadge,
  scenarioValue,
  starsFor,
  type ValuationInput,
} from '../../src/valuation';
import { assertNoNaN, factsFor, flat, stmt, yearlyBars } from './helpers';

/**
 * Five annual statements with EPS 2.00, 2.20, 2.42, 2.662, 2.9282 (+10% a year), dividends per share 1.0 ... 1.4641,
 * FCF per share 1.5 ... 1.8233 (+5% a year), and year-end P/Es of exactly 15 every year. Latest EPS 2.9282.
 */
const simpleStatements = (): FundamentalStatement[] =>
  flat(5, (i) => ({
    epsDiluted: 2 * 1.1 ** i,
    netIncome: 200 * 1.1 ** i,
    sharesDiluted: 100,
    dividendsPaid: -(100 * 1.1 ** i),
    fcf: 150 * 1.05 ** i,
  }));
const simpleBars = (scale = 1) =>
  yearlyBars(
    { 2021: 30 * scale, 2022: 33 * scale, 2023: 36.3 * scale, 2024: 39.93 * scale, 2025: 43.923 * scale },
    '2020-12-28',
  );
const simple = (extra: Partial<ValuationInput> = {}): Facts =>
  factsFor({ statements: simpleStatements(), bars: simpleBars(), price: 40, ...extra });

const EPS = 2.9282;
const FCF_PS = 1.5 * 1.05 ** 4;
const fairValue = (value: number) => ({
  value,
  asOf: '2026-09-30',
  moat: 'Wide',
  uncertainty: 'Low',
  source: 'morningstar',
});
/** No statements: the only method is the fair value, so intrinsic value is exactly `value`. */
const fvOnly = (price: number, value = 100): Facts => factsFor({ statements: [], price, fairValue: fairValue(value) });

describe('scenarioValue (hand-computed)', () => {
  // EPS 2.00, dividends 1.00, growth 10%, target P/E 15, required return 8%:
  //   EPS in 3 years 2 x 1.1^3 = 2.662; price in 3 years 2.662 x 15 = 39.93; discounted 39.93 / 1.08^3 = 31.69772
  //   dividends 1.1/1.08 + 1.21/1.08^2 + 1.331/1.08^3 = 1.01852 + 1.03738 + 1.05656 = 3.11249
  it('EPS grown 3 years x target P/E, discounted, plus the discounted dividends of years 1 to 3', () => {
    const s = scenarioValue('Base', 2, 1, 10, 15, 8);
    expect(s.name).toBe('Base');
    expect(s.growthPct).toBe(10);
    expect(s.targetPe).toBe(15);
    expect(s.eps3y).toBeCloseTo(2.662, 9);
    expect(s.price3y).toBeCloseTo(39.93, 9);
    expect(s.dividends3y).toBeCloseTo(3.112489, 5);
    expect(s.presentValue).toBeCloseTo(34.810211, 5);
    expect(s.presentValue).toBeCloseTo(31.69772138 + 3.1124892, 5);
  });

  it('zero growth, zero dividends: price in 3 years discounted three years', () => {
    expect(scenarioValue('Bear', 3, 0, 0, 10, 10).presentValue).toBeCloseTo(30 / 1.1 ** 3, 10);
  });

  it('with no growth and no discounting the value is the 3-year price plus three years of dividends', () => {
    expect(scenarioValue('Bull', 2, 1, 0, 10, 0).presentValue).toBeCloseTo(20 + 3, 10);
  });
});

describe('dcfValue', () => {
  it('equals the closed-form constant-growth value when growth equals the terminal growth', () => {
    for (const [f0, r] of [
      [2, 0.08],
      [1, 0.06],
      [10, 0.12],
    ] as const) {
      expect(dcfValue(f0, 0.03, r)).toBeCloseTo((f0 * 1.03) / (r - 0.03), 8);
    }
    expect(dcfValue(2, 0.03, 0.08)).toBeCloseTo(41.2, 8);
  });

  it('adds up the specified growth path: 5 years at g, a linear fade to 3% by year 10, a Gordon terminal value', () => {
    // fcf0 = 1, g = 5%, r = 8%: growth 5, 5, 5, 5, 5, 4.6, 4.2, 3.8, 3.4, 3.0 percent.
    const growth = [0.05, 0.05, 0.05, 0.05, 0.05, 0.046, 0.042, 0.038, 0.034, 0.03];
    let cash = 1;
    let pv = 0;
    growth.forEach((g, i) => {
      cash *= 1 + g;
      pv += cash / 1.08 ** (i + 1);
    });
    expect(cash).toBeCloseTo(1.5378041, 6); // the year-10 cash flow
    const terminal = (cash * 1.03) / (0.08 - 0.03) / 1.08 ** 10;
    expect(dcfValue(1, 0.05, 0.08)).toBeCloseTo(pv + terminal, 9);
    expect(dcfValue(1, 0.05, 0.08)).toBeCloseTo(23.16407, 5);
  });

  it('is proportional to the starting cash flow and rises with growth', () => {
    expect(dcfValue(3, 0.05, 0.08)).toBeCloseTo(3 * dcfValue(1, 0.05, 0.08), 9);
    expect(dcfValue(1, 0.08, 0.1)).toBeGreaterThan(dcfValue(1, 0.04, 0.1));
  });
});

describe('impliedGrowth (reverse DCF)', () => {
  it('round-trips: the growth that produced a DCF value is recovered from that value', () => {
    for (const g of [-0.1, 0, 0.03, 0.06, 0.12, 0.3]) {
      const price = dcfValue(2, g, 0.09);
      expect(impliedGrowth(price, 2, 0.09)).toBeCloseTo(g, 8);
    }
  });

  it('and the DCF at the implied growth equals the price', () => {
    const g = impliedGrowth(55, 1.8, 0.08) as number;
    expect(dcfValue(1.8, g, 0.08)).toBeCloseTo(55, 6);
  });

  it('is null when no growth between -20% and 50% reproduces the price', () => {
    expect(impliedGrowth(1e9, 2, 0.08)).toBeNull();
    expect(impliedGrowth(0.001, 2, 0.08)).toBeNull();
  });
});

describe('starsFor', () => {
  it.each([
    [0.01, 5],
    [0.5, 5],
    [0.5000001, 4],
    [0.7, 4],
    [0.7000001, 3],
    [1.0, 3],
    [1.0000001, 2],
    [1.2, 2],
    [1.2000001, 1],
    [3, 1],
  ] as const)('price / value %s is %s stars', (ratio, stars) => {
    expect(starsFor(ratio)).toBe(stars);
  });

  it('through intrinsicValue: boundaries at 50, 70, 100 and 120 against a fair value of 100', () => {
    const stars = (price: number) => intrinsicValue(fvOnly(price), { requiredReturnPct: 8 }).stars;
    expect(stars(50)).toBe(5);
    expect(stars(50.01)).toBe(4);
    expect(stars(70)).toBe(4);
    expect(stars(70.01)).toBe(3);
    expect(stars(100)).toBe(3);
    expect(stars(100.01)).toBe(2);
    expect(stars(120)).toBe(2);
    expect(stars(120.01)).toBe(1);
  });
});

describe('defaultAssumptions: derived from data', () => {
  const a = defaultAssumptions(simple());

  it('latest per-share figures, labelled as data', () => {
    expect(a.eps).toMatchObject({ source: 'data' });
    expect(a.eps.value).toBeCloseTo(EPS, 9);
    expect(a.dividendPerShare.value).toBeCloseTo(1.4641, 9);
    expect(a.fcfPerShare.value).toBeCloseTo(FCF_PS, 9);
  });

  it('growth: base = EPS CAGR (10%), bull = base + 4, bear = base - 5', () => {
    expect(a.growthPct.map((p) => p.value)).toEqual([
      expect.closeTo(14, 9),
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
    ]);
    expect(a.growthPct.every((p) => p.source === 'data')).toBe(true);
    expect(a.growthPct[1]?.note).toBe('EPS CAGR 10.0% a year over 4 years');
  });

  it('target P/E: base = median of the year-end P/Es (15), bull x 1.15, bear x 0.8', () => {
    expect(a.targetPe.map((p) => p.value)).toEqual([
      expect.closeTo(17.25, 9),
      expect.closeTo(15, 9),
      expect.closeTo(12, 9),
    ]);
    expect(a.targetPe[1]?.note).toMatch(/median of 5 year-end P\/E points/);
  });

  it('DCF growth = FCF per share CAGR (5%); terminal growth 3; required return 8 by default', () => {
    expect(a.dcfGrowthPct.value).toBeCloseTo(5, 9);
    expect(a.dcfGrowthPct.source).toBe('data');
    expect(a.terminalGrowthPct).toBe(3);
    expect(a.requiredReturnPct).toEqual({ value: 8, source: 'default', note: 'default 8%' });
  });

  it('every parameter carries a note', () => {
    for (const p of [
      a.eps,
      a.dividendPerShare,
      a.fcfPerShare,
      ...a.growthPct,
      ...a.targetPe,
      a.dcfGrowthPct,
      a.requiredReturnPct,
    ]) {
      expect(typeof p.note).toBe('string');
    }
  });

  it('base growth is clamped to 0 to 12%', () => {
    const fast = defaultAssumptions(
      simple({ statements: flat(5, (i) => ({ epsDiluted: 2 * 1.2 ** i, netIncome: 200 })) }),
    );
    expect(fast.growthPct.map((p) => p.value)).toEqual([expect.closeTo(16, 9), 12, expect.closeTo(7, 9)]);
    expect(fast.growthPct[1]?.note).toMatch(/clamped/);
    const slow = defaultAssumptions(
      simple({ statements: flat(5, (i) => ({ epsDiluted: 2 * 0.9 ** i, netIncome: 200 })) }),
    );
    expect(slow.growthPct.map((p) => p.value)).toEqual([4, 0, -5]);
  });

  it('target P/E is clamped to 8 to 30', () => {
    const rich = defaultAssumptions(simple({ bars: simpleBars(3) })); // year-end P/E 45
    expect(rich.targetPe[1]?.value).toBe(30);
    expect(rich.targetPe[0]?.value).toBeCloseTo(34.5, 9);
    expect(rich.targetPe[2]?.value).toBeCloseTo(24, 9);
    expect(rich.targetPe[1]?.note).toMatch(/clamped/);
    const cheap = defaultAssumptions(simple({ bars: simpleBars(0.2) })); // year-end P/E 3
    expect(cheap.targetPe[1]?.value).toBe(8);
  });

  it('target P/E falls back to the current P/E, clamped, when fewer than 3 year-end points exist', () => {
    const f = simple({ bars: [], price: 40 }); // no bars: no year-end prices
    const a2 = defaultAssumptions(f);
    expect(a2.targetPe[1]?.value).toBeCloseTo(40 / EPS, 9);
    expect(a2.targetPe[1]?.note).toMatch(/only 0 year-end P\/E points: using the current P\/E 13\.7x/);
    expect(defaultAssumptions(simple({ bars: [], price: 200 })).targetPe[1]?.value).toBe(30);
  });

  it('DCF growth is clamped to -2 to 10%', () => {
    const fcf = (g: number) =>
      simple({ statements: flat(5, (i) => ({ ...simpleStatements()[i], fcf: 100 * g ** i })) });
    expect(defaultAssumptions(fcf(1.25)).dcfGrowthPct.value).toBe(10);
    expect(defaultAssumptions(fcf(0.8)).dcfGrowthPct.value).toBe(-2);
  });

  it('a CAGR with a zero or negative first value is not computed: base growth falls back to 3% with a note', () => {
    const f = simple({ statements: flat(5, (i) => ({ epsDiluted: i === 0 ? 0 : 2 })) });
    const a2 = defaultAssumptions(f);
    expect(a2.growthPct.map((p) => p.value)).toEqual([7, 3, -2]);
    expect(a2.growthPct.every((p) => p.source === 'default')).toBe(true);
    expect(a2.growthPct[1]?.note).toMatch(/EPS CAGR is not defined/);
    const iv = intrinsicValue(f, { requiredReturnPct: 8 });
    expect(iv.warnings.join(' ')).toMatch(/EPS CAGR is not defined/);
  });

  it('DCF growth falls back to the base growth when the FCF per share CAGR is not defined', () => {
    const f = simple({ statements: flat(5, (i) => ({ ...simpleStatements()[i], fcf: i === 0 ? -10 : 100 })) });
    const a2 = defaultAssumptions(f);
    expect(a2.dcfGrowthPct.value).toBeCloseTo(10, 9);
    expect(a2.dcfGrowthPct.source).toBe('default');
    expect(a2.dcfGrowthPct.note).toMatch(/using the base EPS growth/);
  });
});

describe('defaultAssumptions: overrides', () => {
  const ov = {
    growthPct: [20, 12, 3] as [number, number, number],
    targetPe: [25, 18, 10] as [number, number, number],
    dcfGrowthPct: 6,
    requiredReturnPct: 9,
  };

  it('replace the matching values and label them "override"', () => {
    const a = defaultAssumptions(simple(), ov);
    expect(a.growthPct.map((p) => [p.value, p.source])).toEqual([
      [20, 'override'],
      [12, 'override'],
      [3, 'override'],
    ]);
    expect(a.targetPe.map((p) => [p.value, p.source])).toEqual([
      [25, 'override'],
      [18, 'override'],
      [10, 'override'],
    ]);
    expect(a.dcfGrowthPct).toMatchObject({ value: 6, source: 'override' });
    expect(a.requiredReturnPct).toMatchObject({ value: 9, source: 'override' });
    expect(a.eps.source).toBe('data'); // per-share starting points are never overridden
  });

  it('a partial override leaves the rest derived from data', () => {
    const a = defaultAssumptions(simple(), { dcfGrowthPct: 2 });
    expect(a.dcfGrowthPct).toMatchObject({ value: 2, source: 'override' });
    expect(a.growthPct.every((p) => p.source === 'data')).toBe(true);
    expect(a.requiredReturnPct.source).toBe('default');
  });

  it('the required return: an explicit argument beats a saved override, which beats the default', () => {
    expect(defaultAssumptions(simple(), { requiredReturnPct: 9 }).requiredReturnPct).toMatchObject({
      value: 9,
      source: 'override',
    });
    expect(defaultAssumptions(simple(), { requiredReturnPct: 9 }, 11).requiredReturnPct).toMatchObject({
      value: 11,
      source: 'override',
    });
    expect(defaultAssumptions(simple(), null, 10).requiredReturnPct).toMatchObject({ value: 10, source: 'override' });
    expect(defaultAssumptions(simple(), null, 8).requiredReturnPct).toMatchObject({ value: 8, source: 'default' });
  });

  it('malformed overrides are ignored and reported, never applied', () => {
    const bad = {
      growthPct: [Number.NaN, 1, 2],
      targetPe: [0, 10, 12],
      dcfGrowthPct: Number.POSITIVE_INFINITY,
      requiredReturnPct: -4,
    } as never;
    const iv = intrinsicValue(simple(), { requiredReturnPct: 8, overrides: bad });
    expect(iv.assumptions.growthPct.every((p) => p.source === 'data')).toBe(true);
    expect(iv.assumptions.targetPe.every((p) => p.source === 'data')).toBe(true);
    expect(iv.assumptions.dcfGrowthPct.source).toBe('data');
    expect(iv.warnings.filter((w) => w.startsWith('Override ignored'))).toHaveLength(4);
    assertNoNaN(iv);
  });
});

describe('intrinsicValue: methods and the median', () => {
  const iv = intrinsicValue(simple(), { requiredReturnPct: 8 });

  it('three scenarios, hand-computed (EPS 2.9282, DPS 1.4641, 8%)', () => {
    expect(iv.scenarios.map((s) => s.name)).toEqual(['Bull', 'Base', 'Bear']);
    expect(iv.scenarios.map((s) => s.growthPct)).toEqual([
      expect.closeTo(14, 9),
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
    ]);
    expect(iv.scenarios.map((s) => s.targetPe)).toEqual([
      expect.closeTo(17.25, 9),
      expect.closeTo(15, 9),
      expect.closeTo(12, 9),
    ]);
    const base = iv.scenarios[1];
    expect(base?.eps3y).toBeCloseTo(3.8974342, 6); // 2.9282 x 1.1^3
    expect(base?.price3y).toBeCloseTo(58.461513, 5);
    expect(base?.dividends3y).toBeCloseTo(4.556995, 5);
    expect(base?.presentValue).toBeCloseTo(50.965629, 5);
    expect(iv.scenarios[0]?.presentValue).toBeCloseTo(64.305044, 5);
    expect(iv.scenarios[2]?.presentValue).toBeCloseTo(36.443557, 5);
  });

  it('owner-earnings DCF (FCF/share 1.8233, 5% for 5 years fading to 3%, 8%)', () => {
    const dcf = iv.methods.find((m) => m.id === 'dcf');
    expect(dcf?.value).toBeCloseTo(42.234108, 5);
    expect(dcf?.label).toBe('Owner-earnings DCF');
    expect(dcf?.note).toBe('FCF/share 1.82, 5.0% a year for 5 years fading to 3%, discounted at 8.0%');
  });

  it('the base case of the scenario method is a method; its note says how it was built', () => {
    const m = iv.methods.find((x) => x.id === 'scenario');
    expect(m?.value).toBeCloseTo(50.965629, 5);
    expect(m?.label).toBe('Three-scenario, base case');
    expect(m?.note).toBe('EPS 2.93 growing 10.0% a year for 3 years x P/E 15.0, plus dividends, discounted at 8.0%');
  });

  it('base = median of the methods; range = min and max over methods and the bear / bull scenarios', () => {
    expect(iv.base).toBeCloseTo((50.965629 + 42.234108) / 2, 5);
    expect(iv.low).toBeCloseTo(36.443557, 5); // bear scenario
    expect(iv.high).toBeCloseTo(64.305044, 5); // bull scenario
    expect(iv.priceRatio).toBeCloseTo(40 / (iv.base as number), 10);
    expect(iv.marginOfSafetyPct).toBeCloseTo((((iv.base as number) - 40) / (iv.base as number)) * 100, 10);
    expect(iv.stars).toBe(3);
    expect(iv.price).toBe(40);
    expect(iv.currency).toBe('USD');
    expect(iv.requiredReturnPct).toBe(8);
    expect(iv.warnings).toEqual([]);
  });

  it('with a fair value there are three methods and the base is their median', () => {
    const withFv = intrinsicValue(simple({ fairValue: fairValue(60) }), { requiredReturnPct: 8 });
    expect(withFv.methods.map((m) => m.id)).toEqual(['scenario', 'dcf', 'fair_value']);
    expect(withFv.methods[2]).toMatchObject({ id: 'fair_value', value: 60, label: 'Morningstar fair value' });
    expect(withFv.methods[2]?.note).toBe('morningstar as of 2026-09-30; moat Wide, uncertainty Low');
    expect(withFv.base).toBeCloseTo(50.965629, 5); // median of 42.23, 50.97, 60
    expect(withFv.low).toBeCloseTo(36.443557, 5);
    expect(withFv.high).toBeCloseTo(64.305044, 5);
    const cheapFv = intrinsicValue(simple({ fairValue: fairValue(30) }), { requiredReturnPct: 8 });
    expect(cheapFv.low).toBeCloseTo(30, 9);
    expect(cheapFv.base).toBeCloseTo(42.234108, 5);
  });

  it('a fair value alone is the base, and the margin of safety follows the price', () => {
    const f = intrinsicValue(fvOnly(80), { requiredReturnPct: 8 });
    expect(f.base).toBe(100);
    expect(f.low).toBe(100);
    expect(f.high).toBe(100);
    expect(f.priceRatio).toBeCloseTo(0.8, 12);
    expect(f.marginOfSafetyPct).toBeCloseTo(20, 9);
    expect(f.stars).toBe(3);
  });

  it('applies overrides to the scenarios and the DCF', () => {
    const o = intrinsicValue(simple(), {
      requiredReturnPct: 9,
      overrides: { growthPct: [20, 12, 3], targetPe: [25, 18, 10], dcfGrowthPct: 6 },
    });
    expect(o.requiredReturnPct).toBe(9);
    expect(o.scenarios[1]?.presentValue).toBeCloseTo(61.819027, 5); // 12%, P/E 18, 9%
    expect(o.scenarios[0]?.presentValue).toBeCloseTo(103.019819, 5);
    expect(o.scenarios[2]?.presentValue).toBeCloseTo(28.633979, 5);
    expect(o.methods.find((m) => m.id === 'dcf')?.value).toBeCloseTo(37.143484, 5);
    expect(o.assumptions.growthPct[1]).toMatchObject({ value: 12, source: 'override' });
  });
});

describe('intrinsicValue: the required return', () => {
  it('lowers every method and the base as the required return rises', () => {
    const f = simple();
    const rates = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const views = rates.map((r) => intrinsicValue(f, { requiredReturnPct: r }));
    for (let i = 1; i < views.length; i++) {
      const prev = views[i - 1];
      const cur = views[i];
      expect(cur?.base as number, `base at ${rates[i]}%`).toBeLessThan(prev?.base as number);
      expect(cur?.low as number).toBeLessThan(prev?.low as number);
      expect(cur?.high as number).toBeLessThan(prev?.high as number);
      for (const id of ['scenario', 'dcf'] as const) {
        const a = cur?.methods.find((m) => m.id === id)?.value as number;
        const b = prev?.methods.find((m) => m.id === id)?.value as number;
        expect(a, `${id} at ${rates[i]}%`).toBeLessThan(b);
      }
    }
  });

  it('hand-computed values at 7%, 8% and 12%', () => {
    const at = (r: number) => intrinsicValue(simple(), { requiredReturnPct: r });
    expect(at(7).methods[0]?.value).toBeCloseTo(52.365242, 5);
    expect(at(7).methods[1]?.value).toBeCloseTo(52.959163, 5);
    expect(at(12).methods[0]?.value).toBeCloseTo(45.849041, 5);
    expect(at(12).methods[1]?.value).toBeCloseTo(23.202538, 5);
  });

  it('skips the DCF when the required return is not above the terminal growth, and says so', () => {
    const iv = intrinsicValue(simple(), { requiredReturnPct: 3 });
    expect(iv.methods.map((m) => m.id)).toEqual(['scenario']);
    expect(iv.warnings.join(' ')).toMatch(
      /Owner-earnings DCF skipped: the required return \(3\.0%\) must exceed the terminal growth \(3%\)/,
    );
    assertNoNaN(iv);
  });

  it('a non-positive or non-numeric rate is replaced by the saved or default rate, with a warning', () => {
    const iv = intrinsicValue(simple(), { requiredReturnPct: Number.NaN, overrides: { requiredReturnPct: 10 } });
    expect(iv.requiredReturnPct).toBe(10);
    expect(iv.warnings.join(' ')).toMatch(/not a positive number/);
    expect(intrinsicValue(simple(), { requiredReturnPct: 0 }).requiredReturnPct).toBe(8);
  });
});

describe('intrinsicValue: reverse DCF', () => {
  // EPS CAGR is 10%, so the price is "demanding" above 14% implied FCF growth and "undemanding" below 7%.
  const at = (impliedPct: number) => {
    const price = dcfValue(FCF_PS, impliedPct / 100, 0.08);
    return intrinsicValue(simple({ price }), { requiredReturnPct: 8 }).reverse;
  };

  it('recovers the growth the price implies, next to the EPS history', () => {
    const r = at(10);
    expect(r?.impliedGrowthPct).toBeCloseTo(10, 6);
    expect(r?.historicalEpsCagrPct).toBeCloseTo(10, 9);
    expect(r?.verdict).toBe('in line');
  });

  it('demanding above history x 1.3 + 1 points', () => {
    expect(at(14.5)?.verdict).toBe('demanding');
    expect(at(13.5)?.verdict).toBe('in line');
  });

  it('undemanding below history x 0.7', () => {
    expect(at(6.5)?.verdict).toBe('undemanding');
    expect(at(7.5)?.verdict).toBe('in line');
  });

  it('is "in line" when there is no history to compare with', () => {
    const f = simple({
      statements: flat(5, (i) => ({ ...simpleStatements()[i], epsDiluted: i === 0 ? 0 : 2.5 })),
      price: 50,
    });
    const r = intrinsicValue(f, { requiredReturnPct: 8 }).reverse;
    expect(r?.historicalEpsCagrPct).toBeNull();
    expect(r?.verdict).toBe('in line');
  });

  it('is null, with a warning, when the price implies growth outside -20% to 50%', () => {
    const iv = intrinsicValue(simple({ price: 1_000_000 }), { requiredReturnPct: 8 });
    expect(iv.reverse).toBeNull();
    expect(iv.warnings.join(' ')).toMatch(/Reverse DCF: the price implies free-cash-flow growth outside -20% to 50%/);
  });
});

describe('intrinsicValue: proposed put', () => {
  it('strike and net cost against the base', () => {
    const iv = intrinsicValue(fvOnly(95), { requiredReturnPct: 8, proposedPut: { strike: 90, premium: 3 } });
    expect(iv.proposedPut).toEqual({ strike: 90, breakeven: 87, strikeRatio: 0.9, costRatio: 0.87 });
  });

  it('is null when no put is proposed or when there is no base to compare with', () => {
    expect(intrinsicValue(fvOnly(95), { requiredReturnPct: 8 }).proposedPut).toBeNull();
    expect(intrinsicValue(fvOnly(95), { requiredReturnPct: 8, proposedPut: null }).proposedPut).toBeNull();
    const none = intrinsicValue(factsFor({ statements: [] }), {
      requiredReturnPct: 8,
      proposedPut: { strike: 90, premium: 3 },
    });
    expect(none.proposedPut).toBeNull();
  });
});

describe('intrinsicValue: financial names', () => {
  it('have no DCF and no reverse DCF, only earnings-based methods', () => {
    const iv = intrinsicValue(simple({ solvencyModel: 'financial' }), { requiredReturnPct: 8 });
    expect(iv.methods.map((m) => m.id)).toEqual(['scenario']);
    expect(iv.reverse).toBeNull();
    expect(iv.base).toBeCloseTo(50.965629, 5);
    expect(iv.warnings.join(' ')).toMatch(/Owner-earnings DCF skipped: banks and insurers/);
  });
});

describe('intrinsicValue: currency conversion', () => {
  it('converts statement-currency per-share figures to the trading currency', () => {
    // HKD trading, CNY statements at 1.1 HKD per CNY; bars scaled by 1.1 keep the year-end P/Es at 15.
    const f = simple({
      currency: 'HKD',
      market: 'HK',
      statements: simpleStatements().map((s) => ({ ...s, currency: 'CNY' as unknown as Currency })),
      bars: simpleBars(1.1),
      price: 44,
      fxToTrading: (c) => (c === 'CNY' ? 1.1 : c === 'HKD' ? 1 : null),
    });
    const iv = intrinsicValue(f, { requiredReturnPct: 8 });
    expect(iv.currency).toBe('HKD');
    expect(iv.assumptions.eps.value).toBeCloseTo(EPS * 1.1, 9);
    expect(iv.assumptions.eps.note).toMatch(/CNY converted at 1\.1/);
    expect(iv.scenarios[1]?.presentValue).toBeCloseTo(56.062192, 5); // 1.1 x 50.965629
    expect(iv.methods.find((m) => m.id === 'dcf')?.value).toBeCloseTo(46.457519, 5); // 1.1 x 42.234108
    expect(iv.assumptions.growthPct[1]?.value).toBeCloseTo(10, 9); // growth is a ratio: unchanged
  });

  it('without an FX rate the per-share methods are skipped with a warning, not guessed', () => {
    const f = simple({
      currency: 'HKD',
      statements: simpleStatements().map((s) => ({ ...s, currency: 'CNY' as unknown as Currency })),
      fxToTrading: () => null,
    });
    const iv = intrinsicValue(f, { requiredReturnPct: 8 });
    expect(iv.base).toBeNull();
    expect(iv.methods).toEqual([]);
    expect(iv.scenarios).toEqual([]);
    expect(iv.warnings.join(' ')).toMatch(/No FX rate CNY to HKD/);
    expect(iv.warnings.join(' ')).toMatch(/Three-scenario method skipped: EPS is unavailable/);
    assertNoNaN(iv);
  });

  it('an HK name that reports twice a year is valued from its summed half-years', () => {
    const half = (periodEnd: string, eps: number) =>
      stmt(periodEnd, {
        periodType: 'semiannual',
        currency: 'HKD',
        epsDiluted: eps,
        netIncome: eps * 100,
        fcf: 50,
        dividendsPaid: -20,
      });
    const f = factsFor({
      currency: 'HKD',
      market: 'HK',
      price: 30,
      statements: [half('2024-06-30', 0.8), half('2024-12-31', 1), half('2025-06-30', 0.9), half('2025-12-31', 1.1)],
    });
    expect(f.annual.map((a) => a.epsStmt)).toEqual([expect.closeTo(1.8, 9), expect.closeTo(2.0, 9)]);
    const iv = intrinsicValue(f, { requiredReturnPct: 8 });
    expect(iv.assumptions.eps.value).toBeCloseTo(2, 9);
    expect(iv.base).not.toBeNull();
    expect(iv.warnings.join(' ')).toMatch(/sum of 2 pairs of half-year statements/);
    expect(iv.warnings.join(' ')).toMatch(/EPS history is 2 years/);
  });
});

describe('intrinsicValue: missing data degrades to null and warnings, never NaN', () => {
  it('no statements and no fair value: no base, no stars, every skipped method explained', () => {
    const iv = intrinsicValue(factsFor({ statements: [] }), { requiredReturnPct: 8 });
    expect(iv.base).toBeNull();
    expect(iv.low).toBeNull();
    expect(iv.high).toBeNull();
    expect(iv.priceRatio).toBeNull();
    expect(iv.marginOfSafetyPct).toBeNull();
    expect(iv.stars).toBeNull();
    expect(iv.methods).toEqual([]);
    expect(iv.scenarios).toEqual([]);
    expect(iv.reverse).toBeNull();
    expect(iv.warnings.join('|')).toMatch(/Three-scenario method skipped: needs at least 2 annual statements, have 0/);
    expect(iv.warnings.join('|')).toMatch(/Owner-earnings DCF skipped: free cash flow per share is unavailable/);
    expect(iv.warnings.join('|')).toMatch(/No valuation method could be computed/);
    expect(priceBadge(iv)).toBeNull();
    assertNoNaN(iv);
    for (const p of [iv.assumptions.eps, iv.assumptions.dividendPerShare, iv.assumptions.fcfPerShare])
      expect(p.value).toBeNull();
  });

  it('one annual statement: the scenario method needs two', () => {
    const iv = intrinsicValue(factsFor({ statements: flat(1) }), { requiredReturnPct: 8 });
    expect(iv.scenarios).toEqual([]);
    expect(iv.warnings.join('|')).toMatch(/Three-scenario method skipped: needs at least 2 annual statements, have 1/);
    expect(iv.warnings.join('|')).toMatch(/EPS history is 1 year /);
    assertNoNaN(iv);
  });

  it('a loss-making company is not valued on earnings, but its free cash flow still can be', () => {
    const iv = intrinsicValue(factsFor({ statements: flat(5, { epsDiluted: -1, netIncome: -100 }) }), {
      requiredReturnPct: 8,
    });
    expect(iv.methods.map((m) => m.id)).toEqual(['dcf']);
    expect(iv.warnings.join('|')).toMatch(/Three-scenario method skipped: the latest EPS \(-1\.00\) is not positive/);
    assertNoNaN(iv);
  });

  it('negative free cash flow skips the DCF', () => {
    const iv = intrinsicValue(factsFor({ statements: flat(5, { fcf: -10 }) }), { requiredReturnPct: 8 });
    expect(iv.methods.map((m) => m.id)).toEqual(['scenario']);
    expect(iv.warnings.join('|')).toMatch(
      /Owner-earnings DCF skipped: free cash flow per share \(-0\.10\) is not positive/,
    );
  });

  it('no dividend figure: scenarios exclude dividends, with a warning', () => {
    const iv = intrinsicValue(factsFor({ statements: flat(5, { dividendsPaid: null }) }), { requiredReturnPct: 8 });
    expect(iv.assumptions.dividendPerShare.value).toBeNull();
    expect(iv.scenarios.every((s) => s.dividends3y === 0)).toBe(true);
    expect(iv.warnings.join('|')).toMatch(/No dividend figure stored/);
  });

  it('no price: no ratio, no stars, no reverse DCF, but the methods still compute', () => {
    const iv = intrinsicValue(factsFor({ price: 0 }), { requiredReturnPct: 8 });
    expect(iv.base).not.toBeNull();
    expect(iv.priceRatio).toBeNull();
    expect(iv.stars).toBeNull();
    expect(iv.reverse).toBeNull();
    expect(priceBadge(iv)).toBeNull();
    expect(iv.warnings.join('|')).toMatch(/No valid price/);
    assertNoNaN(iv);
  });

  it('a short history is flagged', () => {
    const iv = intrinsicValue(factsFor({ statements: flat(3) }), { requiredReturnPct: 8 });
    expect(iv.warnings.join('|')).toMatch(/EPS history is 3 years \(fewer than 5\)/);
  });

  it('every field of every view is finite for odd inputs', () => {
    const odd = flat(4, {
      epsDiluted: 0,
      netIncome: 0,
      revenue: 0,
      totalEquity: 0,
      sharesDiluted: 0,
      fcf: 0,
      dividendsPaid: 0,
    });
    const iv = intrinsicValue(factsFor({ statements: odd, price: 0.01 }), { requiredReturnPct: 8 });
    assertNoNaN(iv);
    assertNoNaN(defaultAssumptions(factsFor({ statements: odd })));
  });
});

describe('priceBadge', () => {
  it('is base, price / base, net cost / base and the stars', () => {
    const iv = intrinsicValue(fvOnly(60), { requiredReturnPct: 8, proposedPut: { strike: 55, premium: 2 } });
    expect(priceBadge(iv)).toEqual({ base: 100, priceRatio: 0.6, costRatio: 0.53, stars: 4 });
  });

  it('has a null cost ratio without a proposed put', () => {
    expect(priceBadge(intrinsicValue(fvOnly(60), { requiredReturnPct: 8 }))).toEqual({
      base: 100,
      priceRatio: 0.6,
      costRatio: null,
      stars: 4,
    });
  });
});

describe('purity', () => {
  it('same inputs, same outputs; the facts are not mutated', () => {
    const f = simple({ fairValue: fairValue(60) });
    const before = JSON.stringify(f);
    const a = intrinsicValue(f, { requiredReturnPct: 8, proposedPut: { strike: 38, premium: 1 } });
    const b = intrinsicValue(f, { requiredReturnPct: 8, proposedPut: { strike: 38, premium: 1 } });
    expect(a).toEqual(b);
    expect(JSON.stringify(f)).toBe(before);
  });
});
