import { describe, expect, it } from 'vitest';
import type { FundamentalStatement } from '../../src/core/types';
import { type Facts, type KpiRowView, kpiRows, quarterRows } from '../../src/valuation';
import { acme, assertNoNaN, factsFor, flat, flatFacts, stmt, yearlyBars } from './helpers';

const KEYS = [
  'roe5',
  'roe10',
  'roic',
  'gross_margin',
  'operating_margin',
  'net_margin',
  'fcf_yield',
  'ocf_ni',
  'capex_revenue',
  'interest_cover',
  'net_debt_ebitda',
  'debt_ni',
  'altman_z',
  'f_score',
  'revenue_cagr3',
  'revenue_cagr5',
  'eps_cagr5',
  'dilution',
  'pe',
  'pb',
  'p_fcf',
  'dividend_yield',
  'earnings_yield',
  'payout',
  'buyback_yield',
];

const row = (f: Facts, key: string): KpiRowView => {
  const r = kpiRows(f).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};

describe('kpiRows: shape', () => {
  it('has the rows in the specified order, grouped, with the specified labels, units and rules', () => {
    const rows = kpiRows(factsFor());
    expect(rows.map((r) => r.key)).toEqual(KEYS);
    expect(rows.map((r) => r.group)).toEqual([
      ...Array(6).fill('Profitability'),
      ...Array(3).fill('Cash quality'),
      ...Array(5).fill('Safety'),
      ...Array(4).fill('Growth'),
      ...Array(5).fill('Valuation'),
      ...Array(2).fill('Shareholder'),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.roe5).toMatchObject({ label: 'ROE, 5-year average', unit: '%', rule: '> 15 good, > 20 great' });
    expect(by.roe10).toMatchObject({ label: 'ROE, 10-year average', unit: '%', rule: 'screen filter 1: >= 8%' });
    expect(by.roic?.label).toBe('Return on invested capital');
    expect(by.gross_margin?.rule).toBe('> 40 pricing power; >= 15 (screen 4)');
    expect(by.net_margin).toMatchObject({ label: 'Net margin, long-run', rule: 'screen filter 6: >= 5%' });
    expect(by.fcf_yield).toMatchObject({ unit: '%', rule: 'scan gate >= 4%' });
    expect(by.ocf_ni).toMatchObject({
      label: 'Operating cash flow / net income',
      unit: 'x',
      rule: 'screen filter 5: >= 0.7',
    });
    expect(by.interest_cover).toMatchObject({ unit: 'x', rule: 'screen filter 3: >= 2x' });
    expect(by.debt_ni).toMatchObject({ label: 'Interest-bearing debt / net income', unit: 'yrs' });
    expect(by.altman_z?.unit).toBe('num');
    expect(by.f_score?.unit).toBe('text');
    expect(by.dilution).toMatchObject({
      label: 'Share count change over the window',
      rule: 'screen filter 7: <= 20%; negative = buybacks',
    });
    expect(by.pe).toMatchObject({ label: 'P/E (trailing)', unit: 'x' });
  });

  it('hand-computed values for a flat company (ROE 14, margins 45/20/14, OCF/NI 1.1, cover 21x ...)', () => {
    const f = flatFacts(10, {}, { price: 20 });
    const v = Object.fromEntries(kpiRows(f).map((r) => [r.key, r.value]));
    expect(v.roe5).toBe(14); // 140 / 1000
    expect(v.roe10).toBe(14);
    expect(v.roic).toBeCloseTo(13.695652, 5); // 210 x 0.75 / (1000 + 300 - 150)
    expect(v.gross_margin).toBe(45);
    expect(v.operating_margin).toBe(20);
    expect(v.net_margin).toBe(14);
    expect(v.fcf_yield).toBeCloseTo(4.7, 6); // 94 / 100 shares = 0.94 per share / 20
    expect(v.ocf_ni).toBeCloseTo(1.1, 6);
    expect(v.capex_revenue).toBe(6);
    expect(v.interest_cover).toBe(21);
    expect(v.net_debt_ebitda).toBe(0.6); // (300 - 150) / 250
    expect(v.debt_ni).toBeCloseTo(2.142857, 5);
    expect(v.revenue_cagr3).toBe(0);
    expect(v.eps_cagr5).toBe(0);
    expect(v.dilution).toBe(0);
    expect(v.pb).toBe(2); // 20 / (1000 / 100)
    expect(v.p_fcf).toBeCloseTo(21.276596, 5);
    expect(v.dividend_yield).toBe(2.8); // 0.56 / 20
    expect(v.earnings_yield).toBe(7);
    expect(v.payout).toBe(40);
    expect(v.buyback_yield).toBe(0.35); // 7 / (20 x 100)
  });

  it('a growing company: 5-year ROE, CAGRs and dilution follow from the statements', () => {
    const f = factsFor();
    const by = Object.fromEntries(kpiRows(f).map((r) => [r.key, r]));
    expect(by.revenue_cagr3?.value).toBe(6);
    expect(by.revenue_cagr5?.value).toBe(6);
    expect(by.eps_cagr5?.value).toBeCloseTo((1.0707070707 - 1) * 100, 3); // 1.06 / 0.99 per year
    expect(by.dilution?.value).toBeCloseTo((0.99 ** 5 - 1) * 100, 4);
    expect(by.roe5?.status).toBe('ok');
    expect(by.ocf_ni?.value).toBe(1.1);
  });
});

type Case = { key: string; label: string; facts: Facts; value: number | null; status: KpiRowView['status'] };

const at = (key: string, label: string, facts: Facts, value: number | null, status: KpiRowView['status']): Case => ({
  key,
  label,
  facts,
  value,
  status,
});

describe('kpiRows: status boundaries (table-driven)', () => {
  const ni = (v: number, n = 10) => flatFacts(n, { netIncome: v });
  const cases: Case[] = [
    // ROE 5y: >= 15 ok, >= 8 warn, else fail (equity 1000, so net income / 10)
    at('roe5', 'exactly 15', ni(150), 15, 'ok'),
    at('roe5', 'just under 15', ni(149.9), 14.99, 'warn'),
    at('roe5', 'great', ni(200), 20, 'ok'),
    at('roe5', 'exactly 8', ni(80), 8, 'warn'),
    at('roe5', 'just under 8', ni(79.9), 7.99, 'fail'),
    // ROE 10y: >= 8.8 ok, >= 8 warn, else fail
    at('roe10', 'exactly 8.8', ni(88), 8.8, 'ok'),
    at('roe10', 'just under 8.8', ni(87.9), 8.79, 'warn'),
    at('roe10', 'exactly 8', ni(80), 8, 'warn'),
    at('roe10', 'just under 8', ni(79), 7.9, 'fail'),
    // gross margin: >= 40 ok, >= 15 warn, else fail
    at('gross_margin', 'exactly 40', flatFacts(10, { grossProfit: 400 }), 40, 'ok'),
    at('gross_margin', 'just under 40', flatFacts(10, { grossProfit: 399 }), 39.9, 'warn'),
    at('gross_margin', 'exactly 15', flatFacts(10, { grossProfit: 150 }), 15, 'warn'),
    at('gross_margin', 'just under 15', flatFacts(10, { grossProfit: 149 }), 14.9, 'fail'),
    // net margin: >= 5.5 ok, >= 5 warn, else fail
    at('net_margin', 'exactly 5.5', ni(55), 5.5, 'ok'),
    at('net_margin', 'just under 5.5', ni(54), 5.4, 'warn'),
    at('net_margin', 'exactly 5', ni(50), 5, 'warn'),
    at('net_margin', 'just under 5', ni(49), 4.9, 'fail'),
    // FCF yield: >= 4 ok else fail (price 20, 100 shares)
    at('fcf_yield', 'exactly 4', flatFacts(10, { fcf: 80 }, { price: 20 }), 4, 'ok'),
    at('fcf_yield', 'just under 4', flatFacts(10, { fcf: 79 }, { price: 20 }), 3.95, 'fail'),
    at('fcf_yield', 'negative', flatFacts(10, { fcf: -20 }, { price: 20 }), -1, 'fail'),
    // OCF / NI: >= 0.77 ok, >= 0.7 warn, else fail (net income 100)
    at('ocf_ni', 'exactly 0.77', flatFacts(10, { netIncome: 100, cfo: 77 }), 0.77, 'ok'),
    at('ocf_ni', 'just under 0.77', flatFacts(10, { netIncome: 100, cfo: 76 }), 0.76, 'warn'),
    at('ocf_ni', 'exactly 0.7', flatFacts(10, { netIncome: 100, cfo: 70 }), 0.7, 'warn'),
    at('ocf_ni', 'just under 0.7', flatFacts(10, { netIncome: 100, cfo: 69 }), 0.69, 'fail'),
    // interest cover: >= 2.2 ok, >= 2 warn, else fail (EBIT 220)
    at('interest_cover', 'exactly 2.2', flatFacts(10, { ebit: 220, interestExpense: 100 }), 2.2, 'ok'),
    at('interest_cover', 'between', flatFacts(10, { ebit: 220, interestExpense: 105 }), 2.095238, 'warn'),
    at('interest_cover', 'exactly 2', flatFacts(10, { ebit: 220, interestExpense: 110 }), 2, 'warn'),
    at('interest_cover', 'just under 2', flatFacts(10, { ebit: 220, interestExpense: 111 }), 1.981982, 'fail'),
    // net debt / EBITDA: <= 3 ok else fail (EBITDA 150, cash 0)
    at('net_debt_ebitda', 'exactly 3', flatFacts(10, { ebitda: 150, totalDebt: 450, cash: 0 }), 3, 'ok'),
    at('net_debt_ebitda', 'just over 3', flatFacts(10, { ebitda: 150, totalDebt: 451, cash: 0 }), 3.006667, 'fail'),
    // debt / net income: < 3 ok else warn (net income 100)
    at('debt_ni', 'under 3', flatFacts(10, { netIncome: 100, totalDebt: 299 }), 2.99, 'ok'),
    at('debt_ni', 'exactly 3', flatFacts(10, { netIncome: 100, totalDebt: 300 }), 3, 'warn'),
    // Altman Z (extras): > 2.99 ok, > 1.81 warn, else fail
    at('altman_z', 'just over 2.99', flatFacts(10, {}, { extras: { altmanZ: 2.991 } }), 2.991, 'ok'),
    at('altman_z', 'exactly 2.99', flatFacts(10, {}, { extras: { altmanZ: 2.99 } }), 2.99, 'warn'),
    at('altman_z', 'just over 1.81', flatFacts(10, {}, { extras: { altmanZ: 1.82 } }), 1.82, 'warn'),
    at('altman_z', 'exactly 1.81', flatFacts(10, {}, { extras: { altmanZ: 1.81 } }), 1.81, 'fail'),
    // Piotroski F (extras): >= 6 ok else fail
    at('f_score', '6', flatFacts(10, {}, { extras: { fScore: 6 } }), 6, 'ok'),
    at('f_score', '5', flatFacts(10, {}, { extras: { fScore: 5 } }), 5, 'fail'),
    // revenue CAGR 3y: >= 0 ok else warn
    at('revenue_cagr3', 'flat', flatFacts(10, {}), 0, 'ok'),
    at(
      'revenue_cagr3',
      'shrinking 1% a year',
      flatFacts(10, (i) => ({ revenue: 1000 * 0.99 ** i })),
      -1,
      'warn',
    ),
    // EPS CAGR over the last six statements (EPS 1.4 -> 1.9, 1.6 -> 1.1 over five years): info, warn when negative
    at(
      'eps_cagr5',
      'growing',
      flatFacts(10, (i) => ({ epsDiluted: 1 + 0.1 * i })),
      ((1.9 / 1.4) ** (1 / 5) - 1) * 100,
      'info',
    ),
    at(
      'eps_cagr5',
      'shrinking',
      flatFacts(10, (i) => ({ epsDiluted: 2 - 0.1 * i })),
      ((1.1 / 1.6) ** (1 / 5) - 1) * 100,
      'warn',
    ),
    // dilution over the last six statements: <= 18 ok, <= 20 warn, else fail
    at(
      'dilution',
      'exactly 18',
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 118 : 100 })),
      18,
      'ok',
    ),
    at(
      'dilution',
      '19',
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 119 : 100 })),
      19,
      'warn',
    ),
    at(
      'dilution',
      'exactly 20',
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 120 : 100 })),
      20,
      'warn',
    ),
    at(
      'dilution',
      '21',
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 121 : 100 })),
      21,
      'fail',
    ),
    at(
      'dilution',
      'buybacks',
      flatFacts(10, (i) => ({ sharesDiluted: i === 9 ? 90 : 100 })),
      -10,
      'ok',
    ),
    // payout: warn above 100, else info
    at('payout', 'exactly 100', flatFacts(10, { dividendsPaid: -140 }), 100, 'info'),
    at('payout', 'above 100', flatFacts(10, { dividendsPaid: -141 }), 100.714286, 'warn'),
    at('payout', 'no dividend', flatFacts(10, { dividendsPaid: 0 }), 0, 'info'),
  ];

  it.each(cases)('$key: $label', ({ key, facts, value, status }) => {
    const r = row(facts, key);
    expect(r.value).not.toBeNull();
    expect(r.value as number).toBeCloseTo(value as number, 4);
    expect(r.status).toBe(status);
  });

  it('info-only rows never carry a status other than info', () => {
    const rows = kpiRows(flatFacts(10, {}, { price: 20 }));
    for (const k of [
      'roic',
      'operating_margin',
      'capex_revenue',
      'revenue_cagr5',
      'pb',
      'p_fcf',
      'dividend_yield',
      'earnings_yield',
      'buyback_yield',
    ]) {
      expect(rows.find((r) => r.key === k)?.status, k).toBe('info');
    }
  });
});

describe('kpiRows: safety rows with special displays', () => {
  it('net cash: value 0 and the text "net cash"', () => {
    const r = row(flatFacts(10, { totalDebt: 100, cash: 300 }), 'net_debt_ebitda');
    expect(r).toMatchObject({ value: 0, text: 'net cash', status: 'ok', unit: 'x' });
  });

  it('uses extras.netDebtEbitda when given (negative means net cash), else computes it', () => {
    const f = (x: number) => flatFacts(10, {}, { extras: { netDebtEbitda: x } });
    expect(row(f(2.5), 'net_debt_ebitda')).toMatchObject({ value: 2.5, status: 'ok', text: null });
    expect(row(f(3.5), 'net_debt_ebitda')).toMatchObject({ value: 3.5, status: 'fail' });
    expect(row(f(-0.4), 'net_debt_ebitda')).toMatchObject({ value: 0, text: 'net cash', status: 'ok' });
    expect(row(flatFacts(10, {}, { extras: { netDebtEbitda: null } }), 'net_debt_ebitda').value).toBe(0.6);
  });

  it('EBITDA not positive: net cash is fine, net debt is a fail with no number', () => {
    expect(row(flatFacts(10, { ebitda: -5, totalDebt: 100, cash: 300 }), 'net_debt_ebitda')).toMatchObject({
      value: 0,
      text: 'net cash',
    });
    expect(row(flatFacts(10, { ebitda: -5, totalDebt: 300, cash: 100 }), 'net_debt_ebitda')).toMatchObject({
      value: null,
      status: 'fail',
      text: 'EBITDA not positive',
    });
  });

  it('F-score shows "n / 9" as text', () => {
    expect(row(flatFacts(10, {}, { extras: { fScore: 7 } }), 'f_score')).toMatchObject({
      value: 7,
      unit: 'text',
      text: '7 / 9',
    });
    expect(row(flatFacts(10), 'f_score')).toMatchObject({ value: null, status: 'info', text: null });
  });

  it('interest cover: zero interest expense is fine, a missing figure is only info', () => {
    expect(row(flatFacts(10, { interestExpense: 0 }), 'interest_cover')).toMatchObject({
      value: null,
      status: 'ok',
      text: 'no interest expense',
    });
    expect(row(flatFacts(10, { interestExpense: null }), 'interest_cover')).toMatchObject({
      value: null,
      status: 'info',
    });
    expect(row(flatFacts(10, { ebit: null, operatingIncome: null }), 'interest_cover')).toMatchObject({
      value: null,
      status: 'info',
    });
  });

  it('interest cover falls back to operating income when EBIT is missing', () => {
    expect(row(flatFacts(10, { ebit: null, operatingIncome: 100, interestExpense: 10 }), 'interest_cover').value).toBe(
      10,
    );
  });

  it('debt / net income: a loss with debt is a warning with no number; no debt is fine', () => {
    expect(row(flatFacts(10, { netIncome: -10, totalDebt: 300 }), 'debt_ni')).toMatchObject({
      value: null,
      status: 'warn',
      text: 'net income not positive',
    });
    expect(row(flatFacts(10, { netIncome: -10, totalDebt: 0 }), 'debt_ni')).toMatchObject({ value: 0, status: 'ok' });
  });
});

describe('kpiRows: financial names (banks and insurers)', () => {
  const fin = flatFacts(10, {}, { solvencyModel: 'financial', price: 20 });
  it('have no gross margin, ROIC, interest cover, net debt / EBITDA or debt / net income', () => {
    for (const k of ['gross_margin', 'roic', 'interest_cover', 'net_debt_ebitda', 'debt_ni']) {
      const r = row(fin, k);
      expect(r.value, k).toBeNull();
      expect(r.status, k).toBe('info');
      expect(r.trend, k).toBeNull();
      expect(r.text, k).toMatch(/banks and insurers/);
    }
  });
  it('keep every other row', () => {
    expect(row(fin, 'roe5').value).toBe(14);
    expect(row(fin, 'net_margin').value).toBe(14);
    expect(row(fin, 'fcf_yield').value).toBeCloseTo(4.7, 6);
    expect(row(fin, 'pe').value).toBeCloseTo(14.285714, 5);
  });
});

describe('kpiRows: data windows', () => {
  const windows = (n: number) => Object.fromEntries(kpiRows(flatFacts(n)).map((r) => [r.key, r.window]));

  it('four annual statements: "4y of 5y" and "4y of 10y" on the rows whose rule wants more', () => {
    const w = windows(4);
    for (const k of ['roe5', 'roic', 'gross_margin', 'ocf_ni', 'revenue_cagr5', 'eps_cagr5', 'dilution'])
      expect(w[k], k).toBe('4y of 5y');
    for (const k of ['roe10', 'net_margin']) expect(w[k], k).toBe('4y of 10y');
    expect(w.revenue_cagr3).toBeNull(); // four statements are enough for a 3-year change
    for (const k of ['operating_margin', 'fcf_yield', 'interest_cover', 'payout', 'pb']) expect(w[k], k).toBeNull();
  });

  it('three statements are not enough for a 3-year revenue CAGR', () => {
    const r = row(flatFacts(3), 'revenue_cagr3');
    expect(r.window).toBe('3y of 4y');
    expect(r.value).toBeNull();
    expect(r.status).toBe('info');
  });

  it('five statements satisfy the 5-year rows only; ten satisfy everything', () => {
    const five = windows(5);
    expect(five.roe5).toBeNull();
    expect(five.roe10).toBe('5y of 10y');
    const ten = windows(10);
    for (const [k, v] of Object.entries(ten)) expect(v, k).toBeNull();
  });

  it('the P/E row says how many yearly P/E points it has when fewer than three', () => {
    const two = row(flatFacts(2), 'pe');
    expect(two.window).toBe('2 yearly P/E points');
    expect(two.status).toBe('info');
    expect(two.text).toBeNull();
    expect(row(flatFacts(10), 'pe').window).toBeNull();
  });

  it('a short history still yields a value over the years that exist', () => {
    const r = row(
      flatFacts(4, (i) => ({ netIncome: 100 + 10 * i })),
      'roe5',
    );
    expect(r.value).toBeCloseTo(11.5, 6); // mean of 10, 11, 12, 13
    expect(r.window).toBe('4y of 5y');
  });
});

describe('kpiRows: trends', () => {
  it('up to five yearly values, oldest first', () => {
    const f = factsFor({ statements: acme(10) });
    const t = row(f, 'roe5').trend as number[];
    expect(t).toHaveLength(5);
    // ROE of FY2021..FY2025: 140 x 1.06^k / (700 x 1.05^k)
    expect(t[0]).toBeCloseTo(((0.14 * 1.06 ** 5) / (0.7 * 1.05 ** 5)) * 100, 4);
    expect(t[4]).toBeCloseTo(((0.14 * 1.06 ** 9) / (0.7 * 1.05 ** 9)) * 100, 4);
  });

  it('null with fewer than two yearly values; the whole short series otherwise', () => {
    expect(row(flatFacts(1), 'roe5').trend).toBeNull();
    expect(row(flatFacts(3), 'roe5').trend).toEqual([14, 14, 14]);
  });

  it('years where a ratio is undefined are left out of the trend', () => {
    const f = flatFacts(5, (i) => ({ netIncome: i === 2 ? -10 : 140 }));
    expect(row(f, 'ocf_ni').trend).toEqual([1.1, 1.1, 1.1, 1.1]);
  });

  it('the year-end P/E series is the P/E trend', () => {
    const bars = yearlyBars({ 2023: 14, 2024: 28, 2025: 42 }, '2022-12-26');
    const r = row(factsFor({ statements: flat(3), bars }), 'pe');
    expect(r.trend).toEqual([10, 20, 30]);
  });
});

describe("kpiRows: P/E percentile of the stock's own history", () => {
  // Year-end P/E points 10, 20, 30 (EPS 1.4).
  const pe = (price: number) => {
    const bars = yearlyBars({ 2023: 14, 2024: 28, 2025: 42 }, '2022-12-26');
    return row(factsFor({ statements: flat(3), bars, price }), 'pe');
  };

  it('<= 33rd percentile is ok', () => {
    const r = pe(21); // P/E 15: one point of three below it = 33.3 -> 33rd
    expect(r.value).toBe(15);
    expect(r.text).toBe('33rd percentile of own history');
    expect(r.status).toBe('ok');
    expect(r.window).toBeNull();
  });

  it('between the 33rd and 66th is info', () => {
    const r = pe(28); // P/E 20: equal to one point -> (1 + 0.5) / 3 = 50th
    expect(r.text).toBe('50th percentile of own history');
    expect(r.status).toBe('info');
  });

  it('above the 66th is a warning', () => {
    const r = pe(35); // P/E 25: two points below = 66.7 -> 67th
    expect(r.text).toBe('67th percentile of own history');
    expect(r.status).toBe('warn');
  });

  it('cheaper than every year-end point is the 0th percentile, dearer than all is the 100th', () => {
    expect(pe(7).text).toBe('0th percentile of own history');
    expect(pe(70).text).toBe('100th percentile of own history');
  });

  it('a loss makes the P/E not meaningful', () => {
    const r = row(
      flatFacts(5, (i) => ({ epsDiluted: i === 4 ? -1 : 1.4 })),
      'pe',
    );
    expect(r).toMatchObject({ value: null, status: 'info', text: 'loss-making: P/E not meaningful' });
  });
});

describe('kpiRows: missing data never invents a number', () => {
  it('no statements at all: every row is null / info and says so in its window', () => {
    const rows = kpiRows(factsFor({ statements: [] }));
    expect(rows).toHaveLength(KEYS.length);
    for (const r of rows) {
      expect(r.value, r.key).toBeNull();
      expect(r.status, r.key).toBe('info');
      expect(r.trend, r.key).toBeNull();
    }
    expect(row(factsFor({ statements: [] }), 'roe5').window).toBe('0y of 5y');
    assertNoNaN(rows);
  });

  it('statements with every field missing: still null / info, never NaN', () => {
    const empty: Partial<FundamentalStatement> = {
      revenue: null,
      grossProfit: null,
      operatingIncome: null,
      ebit: null,
      ebitda: null,
      interestExpense: null,
      netIncome: null,
      epsDiluted: null,
      sharesDiluted: null,
      totalAssets: null,
      currentAssets: null,
      currentLiabilities: null,
      totalLiabilities: null,
      longTermDebt: null,
      totalDebt: null,
      cash: null,
      retainedEarnings: null,
      totalEquity: null,
      cfo: null,
      capex: null,
      fcf: null,
      dividendsPaid: null,
      buybacks: null,
    };
    const f = flatFacts(6, empty);
    const rows = kpiRows(f);
    for (const r of rows) {
      expect(r.value, r.key).toBeNull();
      expect(r.status, r.key).toBe('info');
    }
    assertNoNaN(rows);
  });

  it('zero revenue and zero equity do not divide by zero', () => {
    const rows = kpiRows(flatFacts(5, { revenue: 0, totalEquity: 0, sharesDiluted: 0, ebitda: 0 }));
    assertNoNaN(rows);
    expect(rows.find((r) => r.key === 'gross_margin')?.value).toBeNull();
    expect(rows.find((r) => r.key === 'roe5')?.value).toBeNull();
    expect(rows.find((r) => r.key === 'pb')?.value).toBeNull();
  });

  it('negative equity leaves ROE undefined and P/B without a number', () => {
    const f = flatFacts(5, { totalEquity: -100 }, { price: 20 });
    expect(row(f, 'roe5').value).toBeNull();
    expect(row(f, 'pb')).toMatchObject({ value: null, text: 'negative book value' });
  });

  it('a loss year is skipped in OCF / NI instead of turning the average negative', () => {
    const f = flatFacts(5, (i) => ({ netIncome: i === 0 ? -50 : 100, cfo: 110 }));
    expect(row(f, 'ocf_ni').value).toBeCloseTo(1.1, 6);
  });

  it('negative free cash flow makes P/FCF undefined', () => {
    expect(row(flatFacts(5, { fcf: -10 }), 'p_fcf')).toMatchObject({
      value: null,
      text: 'free cash flow not positive',
    });
  });

  it('a first or last EPS that is not positive leaves the EPS CAGR undefined', () => {
    const r = row(
      flatFacts(6, (i) => ({ epsDiluted: i === 0 ? -1 : 2 })),
      'eps_cagr5',
    );
    expect(r.value).toBeNull();
    expect(r.text).toBe('needs positive EPS at both ends');
  });
});

describe('quarterRows', () => {
  const q = (
    periodEnd: string,
    revenue: number | null,
    grossProfit: number | null = null,
    type: 'quarterly' | 'semiannual' = 'quarterly',
  ) => stmt(periodEnd, { periodType: type, revenue, grossProfit });

  const eight = [
    q('2024-03-31', 100, 40),
    q('2024-06-30', 110, 44),
    q('2024-09-30', 120, 48),
    q('2024-12-31', 130, 52),
    q('2025-03-31', 120, 54),
    q('2025-06-30', 121, 48.4),
    q('2025-09-30', 132, 66),
    q('2025-12-31', 143, 57.2),
  ];

  it('is the last four quarters, oldest first, with revenue growth against the same quarter a year before', () => {
    const rows = quarterRows(factsFor({ statements: [...acme(3), ...eight] }));
    expect(rows.map((r) => r.label)).toEqual(['Q1 25', 'Q2 25', 'Q3 25', 'Q4 25']);
    expect(rows.map((r) => r.revenueYoyPct)).toEqual([20, 10, 10, 10]);
    expect(rows.map((r) => r.grossMarginPct)).toEqual([45, 40, 50, 40]);
    expect(rows.every((r) => r.epsSurprisePct === null)).toBe(true);
  });

  it('growth is null when the year-ago quarter is not stored', () => {
    const rows = quarterRows(factsFor({ statements: eight.slice(-3) }));
    expect(rows.map((r) => r.label)).toEqual(['Q2 25', 'Q3 25', 'Q4 25']);
    expect(rows.map((r) => r.revenueYoyPct)).toEqual([null, null, null]);
  });

  it('is empty without sub-annual statements, and null-safe with missing revenue', () => {
    expect(quarterRows(factsFor({ statements: acme(3) }))).toEqual([]);
    const rows = quarterRows(factsFor({ statements: [q('2025-12-31', null, null)] }));
    expect(rows).toEqual([{ label: 'Q4 25', revenueYoyPct: null, grossMarginPct: null, epsSurprisePct: null }]);
  });

  it('uses the half-years of a semiannual reporter, labelled by month', () => {
    const rows = quarterRows(
      factsFor({
        statements: [
          q('2024-06-30', 500, 200, 'semiannual'),
          q('2024-12-31', 520, 208, 'semiannual'),
          q('2025-06-30', 550, 220, 'semiannual'),
          q('2025-12-31', 572, 229, 'semiannual'),
        ],
      }),
    );
    expect(rows.map((r) => r.label)).toEqual(['6M Jun 24', '6M Dec 24', '6M Jun 25', '6M Dec 25']);
    expect(rows[2]?.revenueYoyPct).toBe(10);
    expect(rows[3]?.revenueYoyPct).toBe(10);
  });

  it('is deterministic and does not NaN on odd data', () => {
    const f = factsFor({ statements: [q('2025-12-31', 0, 5)] });
    assertNoNaN(quarterRows(f));
  });
});
