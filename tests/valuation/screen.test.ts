import { describe, expect, it } from 'vitest';
import type { FundamentalStatement } from '../../src/core/types';
import { type Facts, qualityScreen, type ScreenRowView } from '../../src/valuation';
import { AS_OF, assertNoNaN, factsFor, flatFacts, weeklyBars } from './helpers';

const screenOf = (f: Facts) => qualityScreen(f);
const row = (f: Facts, n: number): ScreenRowView => screenOf(f).rows[n - 1] as ScreenRowView;
/** Bars of about 6.8 years: a name listed under 10 years as far as the stored prices can tell. */
const shortBars = () => weeklyBars('2020-01-06', AS_OF, () => 30);

describe('qualityScreen: shape and clean pass', () => {
  it('a high-quality company passes all seven filters', () => {
    const s = screenOf(factsFor());
    expect(s.verdict).toBe('PASS');
    expect(s.borderline).toBe(0);
    expect(s.windowYears).toBe(10);
    expect(s.rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.rows.map((r) => r.status)).toEqual(Array(7).fill('pass'));
    expect(s.rows.map((r) => r.label)).toEqual([
      '10-year average ROE',
      '5-year cumulative free cash flow',
      'Interest cover (EBIT / interest)',
      'Long-run gross margin',
      'Operating cash flow / net income (5y)',
      'Long-run net margin',
      '5-year share count change',
    ]);
    expect(s.rows.map((r) => r.rule)).toEqual([
      '>= 8%',
      'not negative',
      '>= 2x',
      '>= 15%',
      '>= 0.7',
      '>= 5%',
      '<= +20%',
    ]);
    expect(s.rows.map((r) => r.valueText)).toEqual(['20.9%', 'positive', '29.57x', '45.0%', '1.10x', '14.0%', '-4.9%']);
    expect(s.rows.every((r) => r.note === '')).toBe(true);
  });

  it('is deterministic and NaN-free', () => {
    const f = factsFor();
    expect(screenOf(f)).toEqual(screenOf(f));
    assertNoNaN(screenOf(f));
  });
});

describe('qualityScreen: borderline pass', () => {
  // ROE 8.5, cover 2.1, gross margin 16, OCF/NI 0.75, net margin 5.2, dilution +19: each within 10% of its threshold.
  const f = flatFacts(10, (i) => ({
    netIncome: 85,
    revenue: 1635,
    grossProfit: 1635 * 0.16,
    cfo: 63.75,
    ebit: 210,
    interestExpense: 100,
    sharesDiluted: i === 9 ? 119 : 100,
  }));

  it('flags every filter that clears its threshold by less than 10% as borderline, and still passes', () => {
    const s = screenOf(f);
    expect(s.rows.map((r) => r.status)).toEqual(['warn', 'pass', 'warn', 'warn', 'warn', 'warn', 'warn']);
    expect(s.borderline).toBe(6);
    expect(s.verdict).toBe('PASS');
  });

  it('only filter 1 borderline: ROE 8.4 against a threshold of 8', () => {
    const s = screenOf(flatFacts(10, { netIncome: 84 }));
    expect(s.rows[0]).toMatchObject({ valueText: '8.4%', status: 'warn' });
    expect(s.borderline).toBe(1);
    expect(s.verdict).toBe('PASS');
  });
});

describe('qualityScreen: filter boundaries (table-driven)', () => {
  type Case = [label: string, facts: Facts, status: ScreenRowView['status']];
  const table: Record<number, Case[]> = {
    1: [
      ['ROE 8.8', flatFacts(10, { netIncome: 88 }), 'pass'],
      ['ROE 8.79', flatFacts(10, { netIncome: 87.9 }), 'warn'],
      ['ROE 8', flatFacts(10, { netIncome: 80 }), 'warn'],
      ['ROE 7.99', flatFacts(10, { netIncome: 79.9 }), 'fail'],
    ],
    2: [
      ['positive', flatFacts(10, { fcf: 1 }), 'pass'],
      ['exactly zero', flatFacts(10, { fcf: 0 }), 'pass'],
      ['negative', flatFacts(10, { fcf: -1 }), 'fail'],
    ],
    3: [
      ['cover 2.2', flatFacts(10, { ebit: 220, interestExpense: 100 }), 'pass'],
      ['cover 2.095', flatFacts(10, { ebit: 220, interestExpense: 105 }), 'warn'],
      ['cover 2', flatFacts(10, { ebit: 220, interestExpense: 110 }), 'warn'],
      ['cover 1.98', flatFacts(10, { ebit: 220, interestExpense: 111 }), 'fail'],
    ],
    4: [
      ['gross margin 16.5', flatFacts(10, { grossProfit: 165 }), 'pass'],
      ['gross margin 16.4', flatFacts(10, { grossProfit: 164 }), 'warn'],
      ['gross margin 15', flatFacts(10, { grossProfit: 150 }), 'warn'],
      ['gross margin 14.9', flatFacts(10, { grossProfit: 149 }), 'fail'],
    ],
    5: [
      ['OCF/NI 0.77', flatFacts(10, { netIncome: 100, cfo: 77 }), 'pass'],
      ['OCF/NI 0.76', flatFacts(10, { netIncome: 100, cfo: 76 }), 'warn'],
      ['OCF/NI 0.7', flatFacts(10, { netIncome: 100, cfo: 70 }), 'warn'],
      ['OCF/NI 0.69', flatFacts(10, { netIncome: 100, cfo: 69 }), 'fail'],
    ],
    6: [
      ['net margin 5.5', flatFacts(10, { netIncome: 55 }), 'pass'],
      ['net margin 5.4', flatFacts(10, { netIncome: 54 }), 'warn'],
      ['net margin 5', flatFacts(10, { netIncome: 50 }), 'warn'],
      ['net margin 4.9', flatFacts(10, { netIncome: 49 }), 'fail'],
    ],
    7: [
      ['+18%', flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 118 : 100 })), 'pass'],
      ['+19%', flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 119 : 100 })), 'warn'],
      ['+20%', flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 120 : 100 })), 'warn'],
      ['+21%', flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 121 : 100 })), 'fail'],
      ['buybacks', flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 80 : 100 })), 'pass'],
    ],
  };

  for (const [n, cases] of Object.entries(table)) {
    it.each(cases)(`filter ${n}: %s`, (_label, facts, status) => {
      expect(row(facts, Number(n)).status).toBe(status);
    });
  }

  it('shows the value of the cumulative free cash flow as positive / zero / negative', () => {
    expect(row(flatFacts(10, { fcf: 1 }), 2).valueText).toBe('positive');
    expect(row(flatFacts(10, { fcf: 0 }), 2).valueText).toBe('zero');
    expect(row(flatFacts(10, { fcf: -1 }), 2).valueText).toBe('negative');
  });

  it('adds a free-cash-flow figure over five years, not only the latest year', () => {
    // Four lean years and one strong year add up positive.
    const f = flatFacts(10, (i) => ({ fcf: i === 9 ? 500 : -100 }));
    expect(row(f, 2).status).toBe('pass');
    expect(
      row(
        flatFacts(10, (i) => ({ fcf: i === 9 ? 300 : -100 })),
        2,
      ).status,
    ).toBe('fail');
  });

  it('dilution formats the sign', () => {
    expect(
      row(
        flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 118 : 100 })),
        7,
      ).valueText,
    ).toBe('+18.0%');
  });
});

describe('qualityScreen: plain fail', () => {
  it('a thin-margin, low-return company is EXCLUDED, with exemptions A and B reported as not met', () => {
    const s = screenOf(flatFacts(10, { netIncome: 30 }));
    expect(s.rows.map((r) => r.status)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass', 'fail', 'pass']);
    expect(s.verdict).toBe('EXCLUDED');
    expect(s.rows[0]?.note).toMatch(/^Exemption A not met: listed 10 or more years/);
    expect(s.rows[5]?.note).toMatch(
      /^Exemption B not met: net margin is neither above 5% in each of the last 2 years nor rising for 3 years/,
    );
  });

  it('negative cumulative free cash flow, weak interest cover or heavy dilution each exclude', () => {
    expect(screenOf(flatFacts(10, { fcf: -50 })).verdict).toBe('EXCLUDED');
    expect(screenOf(flatFacts(10, { ebit: 150, interestExpense: 100 })).verdict).toBe('EXCLUDED');
    expect(screenOf(flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 125 : 100 }))).verdict).toBe('EXCLUDED');
  });

  it('the dilution note says the skill excludes only non-acquisition dilution, which the data cannot tell', () => {
    const r = row(
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 125 : 100 })),
      7,
    );
    expect(r.status).toBe('fail');
    expect(r.note).toMatch(/acquisition/);
  });
});

describe('qualityScreen: exemption A (strategic investment phase, filter 1)', () => {
  // ROE 5.6%: equity 2500 against net income 140; healthy margins and cash flow.
  const weakRoe: Partial<FundamentalStatement> = { totalEquity: 2500 };

  it('applies when listed under 10 years, gross margin is over 30% and operating cash flow is positive for 2 years', () => {
    const f = flatFacts(10, weakRoe, { bars: shortBars() });
    const s = screenOf(f);
    expect(s.rows[0]?.status).toBe('exempt');
    expect(s.rows[0]?.note).toMatch(
      /^Exemption A: listed under 10 years \(price history spans 6\.\d years; bars are capped at 10 years\)/,
    );
    expect(s.rows[0]?.note).toMatch(/gross margin 45\.0% is over 30%/);
    expect(s.rows[0]?.note).toMatch(/positive in each of the last 2 years/);
    expect(s.verdict).toBe('EXEMPT-PASS');
    expect(s.rows.filter((r) => r.status === 'fail')).toEqual([]);
  });

  it('does not apply when the price history spans the 10-year cap: that means "10 or more"', () => {
    const f = flatFacts(10, weakRoe); // default bars span 10.8 years
    const r = row(f, 1);
    expect(r.status).toBe('fail');
    expect(r.note).toMatch(
      /Exemption A not met: listed 10 or more years \(price history spans 10\.8 years; bars are capped at 10 years, so 10 means "10 or more"\)/,
    );
    expect(screenOf(f).verdict).toBe('EXCLUDED');
  });

  it('a span a hair under 10 years (a missing week) still counts as the cap', () => {
    const f = flatFacts(10, weakRoe, { bars: weeklyBars('2016-10-24', AS_OF, () => 30) }); // 9.96 years
    expect(row(f, 1).status).toBe('fail');
  });

  it('does not apply when gross margin is 30% or less', () => {
    const f = flatFacts(10, { ...weakRoe, grossProfit: 300 }, { bars: shortBars() });
    expect(row(f, 1).status).toBe('fail');
    expect(row(f, 1).note).toMatch(/long-run gross margin 30\.0% is not over 30%/);
  });

  it('does not apply when operating cash flow was negative in either of the last 2 years', () => {
    const f = flatFacts(10, (i) => ({ ...weakRoe, cfo: i === 9 ? -5 : 154 }), { bars: shortBars() });
    expect(row(f, 1).status).toBe('fail');
    expect(row(f, 1).note).toMatch(/operating cash flow not positive in each of the last 2 years/);
  });

  it('cannot be judged without price bars', () => {
    const f = flatFacts(10, weakRoe, { bars: [] });
    expect(row(f, 1).status).toBe('fail');
    expect(row(f, 1).note).toMatch(/listing age unknown/);
  });

  it('is only considered when filter 1 fails', () => {
    const s = screenOf(flatFacts(10, {}, { bars: shortBars() }));
    expect(s.rows[0]?.status).toBe('pass');
    expect(s.rows[0]?.note).toBe('');
  });
});

describe('qualityScreen: exemption B (deliberately thin net margin, filter 6)', () => {
  // Net margin 3% for eight years: 30 on revenue 1000; equity 300 keeps ROE healthy (10%+).
  const margins =
    (last3: [number, number, number]) =>
    (i: number): Partial<FundamentalStatement> => ({
      totalEquity: 300,
      netIncome: i >= 7 ? last3[i - 7] : 30,
    });

  it('applies when gross margin is over 30% and net margin is back above 5% in each of the last 2 years', () => {
    const f = flatFacts(10, margins([30, 55, 55]));
    const s = screenOf(f);
    expect(s.rows[5]?.valueText).toBe('3.5%');
    expect(s.rows[5]?.status).toBe('exempt');
    expect(s.rows[5]?.note).toMatch(
      /^Exemption B: long-run gross margin 45\.0% is over 30% and net margin is back above 5% in each of the last 2 years \(5\.5%, 5\.5%\)/,
    );
    expect(s.verdict).toBe('EXEMPT-PASS');
  });

  it('applies when the net margin has risen three years running', () => {
    const f = flatFacts(10, margins([35, 40, 45]));
    expect(row(f, 6).status).toBe('exempt');
    expect(row(f, 6).note).toMatch(/net margin has risen three years running \(3\.5%, 4\.0%, 4\.5%\)/);
  });

  it('does not apply when the margin is merely flat and low', () => {
    const f = flatFacts(10, margins([30, 30, 30]));
    expect(row(f, 6).status).toBe('fail');
    expect(screenOf(f).verdict).toBe('EXCLUDED');
  });

  it('does not apply when gross margin is not over 30%', () => {
    const f = flatFacts(10, (i) => ({ ...margins([30, 55, 55])(i), grossProfit: 250 }));
    expect(row(f, 4).status).toBe('pass'); // 25% clears filter 4 (15%)
    expect(row(f, 6).status).toBe('fail');
    expect(row(f, 6).note).toMatch(/Exemption B not met: long-run gross margin 25\.0% is not over 30%/);
  });

  it('is only considered when filter 6 fails', () => {
    expect(row(flatFacts(10, {}), 6).note).toBe('');
  });
});

describe('qualityScreen: exemption C is never applied, only pointed out', () => {
  // A Costco-like business: 12% gross margin, 3.5% net margin, ROE 23%, cash conversion 1.3.
  const thin: Partial<FundamentalStatement> = {
    revenue: 1000,
    grossProfit: 120,
    netIncome: 35,
    totalEquity: 150,
    cfo: 45.5,
    capex: -5,
    fcf: 40.5,
  };

  it('says it might apply when filter 4 or 6 fails, ROE over 20% and OCF/NI over 1.0, but stays a fail', () => {
    const f = flatFacts(10, thin);
    const s = screenOf(f);
    expect(s.rows[3]?.status).toBe('fail');
    expect(s.rows[5]?.status).toBe('fail');
    expect(s.verdict).toBe('EXCLUDED');
    for (const i of [3, 5]) {
      expect(s.rows[i]?.note).toMatch(/Exemption C might apply \(a human judgement\)/);
      expect(s.rows[i]?.note).toMatch(/5-year ROE 23\.3% is over 20%/);
      expect(s.rows[i]?.note).toMatch(/operating cash flow \/ net income 1\.30x is over 1\.0/);
    }
    expect(s.rows.some((r) => r.status === 'exempt')).toBe(false);
  });

  it('does not mention it when ROE is 20% or less, or cash conversion is 1.0 or less', () => {
    const lowRoe = screenOf(flatFacts(10, { ...thin, totalEquity: 200 })); // ROE 17.5%
    expect(lowRoe.rows[3]?.note).not.toMatch(/Exemption C/);
    const lowCash = screenOf(flatFacts(10, { ...thin, cfo: 35 })); // OCF/NI 1.0
    expect(lowCash.rows[5]?.note).not.toMatch(/Exemption C/);
  });

  it('does not mention it on a row that passes', () => {
    const s = screenOf(flatFacts(10, { ...thin, grossProfit: 200 })); // gross margin 20%: filter 4 passes, 6 fails
    expect(s.rows[3]?.status).toBe('pass');
    expect(s.rows[3]?.note).not.toMatch(/Exemption C/);
    expect(s.rows[5]?.note).toMatch(/Exemption C might apply/);
  });
});

describe('qualityScreen: banks and insurers (solvency model financial)', () => {
  const fin = (over: Partial<FundamentalStatement> = {}) => flatFacts(10, over, { solvencyModel: 'financial' });

  it('are not tested on interest cover or gross margin: both are n/a, and the rest decide', () => {
    const s = screenOf(fin());
    expect(s.rows[2]).toMatchObject({
      valueText: 'n/a',
      status: 'na',
      note: 'banks and insurers are exempt from this filter',
    });
    expect(s.rows[3]).toMatchObject({ valueText: 'n/a', status: 'na', note: 'not defined for banks and insurers' });
    expect(s.verdict).toBe('PASS');
    expect(s.borderline).toBe(0);
  });

  it('can still be excluded by the other five filters', () => {
    expect(screenOf(fin({ netIncome: 30 })).verdict).toBe('EXCLUDED');
  });

  it('exemption A cannot use a gross margin they do not have', () => {
    const f = flatFacts(10, { totalEquity: 2500 }, { solvencyModel: 'financial', bars: shortBars() });
    expect(row(f, 1).status).toBe('fail');
    expect(row(f, 1).note).toMatch(/gross margin not available/);
  });
});

describe('qualityScreen: INCOMPLETE', () => {
  it('with fewer than two annual statements, whatever the numbers say', () => {
    expect(screenOf(flatFacts(1)).verdict).toBe('INCOMPLETE');
    expect(screenOf(flatFacts(1, { netIncome: -500, fcf: -500 })).verdict).toBe('INCOMPLETE'); // thin data never excludes
    const none = screenOf(factsFor({ statements: [] }));
    expect(none.verdict).toBe('INCOMPLETE');
    expect(none.windowYears).toBe(0);
    expect(none.rows.every((r) => r.status === 'na')).toBe(true);
    assertNoNaN(none);
  });

  it('with two statements it is judged', () => {
    expect(screenOf(flatFacts(2)).verdict).toBe('PASS');
  });

  it('with more than three filters n/a', () => {
    // Financial (filters 3 and 4 n/a) with no operating or free cash flow (2 and 5 n/a): four n/a.
    const four = screenOf(flatFacts(5, { cfo: null, fcf: null }, { solvencyModel: 'financial' }));
    expect(four.rows.filter((r) => r.status === 'na')).toHaveLength(4);
    expect(four.verdict).toBe('INCOMPLETE');
  });

  it('exactly three n/a is still judged', () => {
    const three = screenOf(flatFacts(5, { cfo: null }, { solvencyModel: 'financial' })); // 3, 4, 5 n/a (fcf is stored)
    expect(three.rows.filter((r) => r.status === 'na')).toHaveLength(3);
    expect(three.verdict).toBe('PASS');
  });

  it('missing inputs are n/a with a reason, never a pass or a fail', () => {
    const f = flatFacts(5, {
      netIncome: null,
      grossProfit: null,
      interestExpense: null,
      cfo: null,
      fcf: null,
      sharesDiluted: null,
    });
    const s = screenOf(f);
    expect(s.rows.map((r) => r.status)).toEqual(Array(7).fill('na'));
    expect(s.rows[2]?.note).toMatch(/missing/);
    expect(s.verdict).toBe('INCOMPLETE');
    assertNoNaN(s);
  });
});

describe('qualityScreen: data windows', () => {
  it('four statements: rows carry "data window 4y of N" notes', () => {
    const s = screenOf(flatFacts(4));
    expect(s.windowYears).toBe(4);
    expect(s.rows.map((r) => r.note)).toEqual([
      'data window 4y of 10y',
      'data window 4y of 5y',
      '',
      'data window 4y of 5y',
      'data window 4y of 5y',
      'data window 4y of 10y',
      'data window 4y of 5y',
    ]);
    expect(s.verdict).toBe('PASS');
  });

  it('a note is added to the exemption text, not replaced by it', () => {
    const f = flatFacts(4, { totalEquity: 2500 }, { bars: shortBars() });
    expect(row(f, 1).status).toBe('exempt');
    expect(row(f, 1).note).toMatch(/^data window 4y of 10y; Exemption A:/);
  });

  it('five statements satisfy the 5-year filters only', () => {
    const s = screenOf(flatFacts(5));
    expect(s.rows[1]?.note).toBe('');
    expect(s.rows[0]?.note).toBe('data window 5y of 10y');
  });

  it('a free-cash-flow figure missing in some years is reported', () => {
    const f = flatFacts(10, (i) => ({
      fcf: i >= 8 ? 100 : null,
      cfo: i >= 8 ? 120 : null,
      capex: i >= 8 ? -20 : null,
    }));
    expect(row(f, 2).note).toBe('2 of 5 years have a free cash flow figure');
  });
});
