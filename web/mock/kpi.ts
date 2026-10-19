import type {
  KpiGroup,
  KpiRowView,
  QuarterRowView,
  ScreenRowView,
  ScreenView,
  ValueView,
} from '../../src/server/api-types';
import { evaluate } from './engine';
import { keyOf, type Profile, type WatchRow } from './model';
import { store } from './state';
import { marketCurrency } from './symbols';
import { ASOF, fmt2, hash, mulberry, round } from './util';
import { intrinsicFor } from './value';

type Status = KpiRowView['status'];

/** Five yearly values ending at `v`, oldest first, with a gentle slope and noise (deterministic per seed). */
function spark(v: number, slope: number, seed: string): number[] {
  const rnd = mulberry(hash(seed));
  const a = Array.from({ length: 5 }, (_, i) => v * (1 + slope * 0.06 * (i - 4) + (rnd() - 0.5) * 0.05));
  a[4] = v;
  return a.map((x) => round(x, 2));
}

export function kpiRows(p: Profile): KpiRowView[] {
  const f = p.fund;
  const q = p.q;
  const price = p.spot;
  const rows: KpiRowView[] = [];
  const add = (
    group: KpiGroup,
    key: string,
    label: string,
    value: number | null,
    unit: KpiRowView['unit'],
    status: Status,
    rule: string,
    extra: { text?: string; slope?: number; window?: string } = {},
  ) =>
    rows.push({
      group,
      key,
      label,
      value,
      unit,
      text: extra.text ?? null,
      status,
      rule,
      trend: extra.slope !== undefined && value !== null ? spark(value, extra.slope, p.symbol + key) : null,
      window: extra.window ?? null,
    });
  const lvl = (ok: boolean, warn = false): Status => (ok ? 'ok' : warn ? 'warn' : 'fail');
  const na = 'not used for banks and insurers';
  const fcfy = (f.fcfps / price) * 100;
  const improving = (f.roe5 - f.roe10) / Math.max(1, Math.abs(f.roe10));

  add(
    'Profitability',
    'roe5',
    'ROE, 5-year average',
    f.roe5,
    '%',
    f.roe5 >= 15 ? 'ok' : f.roe5 >= 8 ? 'warn' : 'fail',
    '> 15 good, > 20 great',
    { slope: improving, window: '4y of 5y' },
  );
  add(
    'Profitability',
    'roe10',
    'ROE, 10-year average',
    f.roe10,
    '%',
    f.roe10 >= 8.8 ? 'ok' : f.roe10 >= 8 ? 'warn' : 'fail',
    '>= 8% (screen filter 1)',
    { window: '4y of 10y' },
  );
  add(
    'Profitability',
    'roic',
    'Return on invested capital',
    f.roic,
    '%',
    'info',
    'context only',
    f.roic === null ? { text: 'n/a' } : {},
  );
  add(
    'Profitability',
    'gm',
    'Gross margin',
    f.gm,
    '%',
    f.gm === null ? 'info' : f.gm >= 40 ? 'ok' : f.gm >= 15 ? 'warn' : 'fail',
    '> 40 pricing power; >= 15 (screen 4)',
    f.gm === null ? { text: 'not defined for insurers and banks' } : { slope: 0.1 },
  );
  add(
    'Profitability',
    'om',
    'Operating margin',
    f.om,
    '%',
    'info',
    'context only',
    f.om === null ? { text: 'n/a' } : { slope: 0.2 },
  );
  add(
    'Profitability',
    'nm',
    'Net margin, long-run',
    f.nm,
    '%',
    f.nm >= 5.5 ? 'ok' : f.nm >= 5 ? 'warn' : 'fail',
    '>= 5% (screen 6)',
    { slope: -0.1, window: '4y of 10y' },
  );
  add('Cash quality', 'fcfy', 'Free-cash-flow yield', round(fcfy, 1), '%', lvl(fcfy >= 4), '>= 4% (scan gate)', {
    slope: 0.3,
  });
  add(
    'Cash quality',
    'ocf',
    'Operating cash flow / net income',
    f.ocf,
    'x',
    f.ocf >= 0.77 ? 'ok' : f.ocf >= 0.7 ? 'warn' : 'fail',
    '>= 0.7 (screen 5), about 1 ideal',
    { window: '4y of 5y' },
  );
  add('Cash quality', 'capex', 'Capex / revenue', f.capex, '%', 'info', 'lighter is better');
  add(
    'Safety',
    'cov',
    'Interest cover (EBIT / interest)',
    f.fin ? null : f.cov,
    'x',
    f.fin || f.cov === null ? 'info' : f.cov >= 2.2 ? 'ok' : f.cov >= 2 ? 'warn' : 'fail',
    f.fin ? na : '>= 2x (screen 3)',
    f.fin ? { text: 'n/a' } : {},
  );
  if (f.fin) add('Safety', 'nd', 'Net debt / EBITDA', null, 'x', 'info', na, { text: 'n/a' });
  else if (q.nd === null)
    add('Safety', 'nd', 'Net debt / EBITDA', 0, 'text', 'ok', '<= 3 (scan gate)', { text: 'net cash' });
  else add('Safety', 'nd', 'Net debt / EBITDA', q.nd, 'x', lvl(q.nd <= 3), '<= 3 (scan gate)');
  add(
    'Safety',
    'dni',
    'Interest-bearing debt / net income',
    f.fin ? null : f.dni,
    'yrs',
    f.fin || f.dni === null ? 'info' : f.dni < 3 ? 'ok' : 'warn',
    f.fin ? na : '< 3 years (checklist)',
    f.fin ? { text: 'n/a' } : {},
  );
  add(
    'Safety',
    'z',
    'Altman Z',
    q.z,
    'num',
    q.z === null ? 'info' : q.z > 2.99 ? 'ok' : q.z > 1.81 ? 'warn' : 'fail',
    '> 2.99 pass, 1.81 to 2.99 warn',
    q.z === null ? { text: na } : {},
  );
  add('Safety', 'fs', 'Piotroski F-score', q.f, 'num', lvl(q.f >= 6), '>= 6 of 9', { text: `${q.f} / 9` });
  add('Growth', 'rc3', 'Revenue CAGR, 3-year', q.cagr, '%', q.cagr >= 0 ? 'ok' : 'warn', '>= 0%');
  add('Growth', 'rc5', 'Revenue CAGR, 5-year', f.rc5, '%', 'info', 'context only', { window: '4y of 5y' });
  add('Growth', 'ec5', 'EPS CAGR, 5-year', f.ec5, '%', f.ec5 >= 0 ? 'info' : 'warn', 'context only', {
    window: '4y of 5y',
  });
  add(
    'Growth',
    'dil',
    'Share count change, 5-year',
    f.dil,
    '%',
    f.dil <= 18 ? 'ok' : f.dil <= 20 ? 'warn' : 'fail',
    '<= 20% (screen 7); negative = buybacks',
  );
  add(
    'Valuation',
    'pe',
    'P/E (trailing)',
    round(price / f.eps, 1),
    'x',
    f.hpe[1] <= 33 ? 'ok' : f.hpe[1] > 66 ? 'warn' : 'info',
    `own 5y median ${f.hpe[0]}x; now at the ${f.hpe[1]}th percentile of its own history`,
    { slope: 0.4, text: `${f.hpe[1]}th pct` },
  );
  add('Valuation', 'pb', 'P/B', round(price / f.bvps, 2), 'x', 'info', 'context only');
  add('Valuation', 'pfcf', 'Price / free cash flow', round(price / f.fcfps, 1), 'x', 'info', 'context only');
  add('Valuation', 'dy', 'Dividend yield', round((f.dps / price) * 100, 2), '%', 'info', 'context only');
  add('Shareholder', 'pay', 'Payout ratio', f.pay, '%', f.pay > 100 ? 'warn' : 'info', 'above 100% is not sustainable');
  add('Shareholder', 'bb', 'Buyback yield', f.bb, '%', 'info', 'context only');
  return rows;
}

export function quarterRows(p: Profile, semiannual: boolean): QuarterRowView[] {
  const rnd = mulberry(hash(`q${p.symbol}`));
  const labels = semiannual ? ['H2 24', 'H1 25', 'H2 25', 'H1 26'] : ['Q3 25', 'Q4 25', 'Q1 26', 'Q2 26'];
  return labels.map((label, i) => ({
    label,
    revenueYoyPct: round(p.q.cagr + (rnd() - 0.5) * 5 + i * 0.4, 1),
    grossMarginPct: p.fund.gm === null ? null : round(p.fund.gm + (rnd() - 0.5) * 2, 1),
    epsSurprisePct: p.market === 'US' ? round((rnd() - 0.3) * 8, 1) : null,
  }));
}

/** The seven quality filters and their three exemptions. */
export function qualityScreen(p: Profile): ScreenView {
  const f = p.fund;
  const rows: ScreenRowView[] = [];
  const T = (n: number, label: string, valueText: string, rule: string, status: ScreenRowView['status'], note = '') =>
    rows.push({ n, label, valueText, rule, status, note });
  const pct = (x: number) => `${x.toFixed(1)}%`;
  T(
    1,
    '10-year average ROE',
    pct(f.roe10),
    '>= 8%',
    f.roe10 >= 8.8 ? 'pass' : f.roe10 >= 8 ? 'warn' : 'fail',
    'data window 4y of 10y',
  );
  T(
    2,
    '5-year cumulative free cash flow',
    f.fcfps > 0 ? 'positive' : 'negative',
    'not negative',
    f.fcfps > 0 ? 'pass' : 'fail',
    'data window 4y of 5y',
  );
  T(
    3,
    'Interest cover (EBIT / interest)',
    f.cov === null || f.fin ? 'n/a' : `${fmt2(f.cov)}x`,
    '>= 2x',
    f.cov === null || f.fin ? 'na' : f.cov >= 2.2 ? 'pass' : f.cov >= 2 ? 'warn' : 'fail',
    f.fin ? 'banks and insurers are exempt from this filter' : '',
  );
  T(
    4,
    'Long-run gross margin',
    f.gm === null ? 'n/a' : pct(f.gm),
    '>= 15%',
    f.gm === null ? 'na' : f.gm >= 16.5 ? 'pass' : f.gm >= 15 ? 'warn' : 'fail',
    f.gm === null ? 'not defined for insurers and banks' : '',
  );
  T(
    5,
    'Operating cash flow / net income (5y)',
    `${fmt2(f.ocf)}x`,
    '>= 0.7',
    f.ocf >= 0.77 ? 'pass' : f.ocf >= 0.7 ? 'warn' : 'fail',
    'data window 4y of 5y',
  );
  T(
    6,
    'Long-run net margin',
    pct(f.nm),
    '>= 5%',
    f.nm >= 5.5 ? 'pass' : f.nm >= 5 ? 'warn' : 'fail',
    'data window 4y of 10y',
  );
  T(
    7,
    '5-year share count change',
    `${f.dil >= 0 ? '+' : ''}${pct(f.dil)}`,
    '<= +20%',
    f.dil <= 18 ? 'pass' : f.dil <= 20 ? 'warn' : 'fail',
  );
  const row = (n: number) => rows[n - 1];
  const gm = f.gm ?? 0;
  if (row(1).status === 'fail' && f.listed < 10 && gm > 30 && f.ocf > 0) {
    row(1).status = 'exempt';
    row(1).note =
      'Exemption A: listed under 10 years, gross margin over 30%, operating cash flow positive (a business in its investment phase)';
  }
  if (row(6).status === 'fail' && gm > 30 && f.nm >= 5) {
    row(6).status = 'exempt';
    row(6).note = 'Exemption B: gross margin over 30% and net margin back above 5%';
  }
  const verdict = rows.some((r) => r.status === 'fail')
    ? 'EXCLUDED'
    : rows.some((r) => r.status === 'exempt')
      ? 'EXEMPT-PASS'
      : 'PASS';
  return { verdict, rows, borderline: rows.filter((r) => r.status === 'warn').length, windowYears: 4 };
}

export const fundamentalsInfo = (row: WatchRow): ValueView['fundamentals'] =>
  row.profile
    ? { annual: 4, quarterly: row.market === 'US' ? 8 : 4, lastPeriodEnd: '2026-06-30' }
    : { annual: 0, quarterly: 0, lastPeriodEnd: null };

export function buildValueView(row: WatchRow, rate: number | null): ValueView {
  const key = keyOf(row.market, row.symbol);
  const p = row.profile;
  const common = {
    symbol: row.symbol,
    market: row.market,
    asOf: ASOF,
    currency: marketCurrency(row.market),
    overrides: store.overrides.get(key) ?? null,
  };
  if (!p) {
    return {
      ...common,
      hasFundamentals: false,
      fundamentals: fundamentalsInfo(row),
      kpis: [],
      quarters: [],
      screen: { verdict: 'INCOMPLETE', rows: [], borderline: 0, windowYears: 0 },
      intrinsic: null,
      fairValue: store.fairValues.get(key) ?? null,
    };
  }
  const ev = evaluate(row);
  const proposed =
    ev.contract && ev.state === 'idea' && !p.noCostRatio
      ? { strike: ev.contract.strike, breakeven: ev.contract.breakeven }
      : null;
  return {
    ...common,
    hasFundamentals: true,
    fundamentals: fundamentalsInfo(row),
    kpis: kpiRows(p),
    quarters: quarterRows(p, row.reportingFrequency === 'semiannual'),
    screen: qualityScreen(p),
    intrinsic: intrinsicFor(p, { rate, proposed }),
    fairValue: store.fairValues.get(key) ?? null,
  };
}
