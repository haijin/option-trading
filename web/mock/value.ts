import type { AssumptionParam, IntrinsicView, MethodView, ScenarioView, ValueBadge } from '../../src/server/api-types';
import { keyOf, type Profile } from './model';
import { store } from './state';
import { marketCurrency } from './symbols';
import { median, round } from './util';

export const DEFAULT_RATE = 8;
export const TERMINAL_GROWTH_PCT = 3;

/** Owner-earnings DCF: `g` for 5 years, fading linearly to the terminal growth over the next 5, then a Gordon terminal value. */
export function dcfValue(fcf0: number, g: number, r: number, gT = TERMINAL_GROWTH_PCT / 100, years = 10): number {
  let value = 0;
  let fcf = fcf0;
  for (let t = 1; t <= years; t++) {
    const gt = t <= 5 ? g : g + ((gT - g) * (t - 5)) / 5;
    fcf *= 1 + gt;
    value += fcf / (1 + r) ** t;
  }
  return value + (fcf * (1 + gT)) / (r - gT) / (1 + r) ** years;
}

/** Reverse DCF: the 5-year FCF growth that makes the DCF equal the price (bisection). */
export function impliedGrowth(price: number, fcf0: number, r: number): number {
  let lo = -0.2;
  let hi = 0.5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (dcfValue(fcf0, mid, r) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Stars from price / intrinsic value: 5 at half the value or less, 1 above 120%. */
export function starsFor(ratio: number): 1 | 2 | 3 | 4 | 5 {
  if (ratio <= 0.5) return 5;
  if (ratio <= 0.7) return 4;
  if (ratio <= 1.0) return 3;
  if (ratio <= 1.2) return 2;
  return 1;
}

export interface IntrinsicOpts {
  /** Required return from the slider (percent); beats a stored override. */
  rate?: number | null;
  proposed?: { strike: number; breakeven: number } | null;
}

const param = (
  value: number | null,
  source: AssumptionParam['source'],
  note: string | null = null,
): AssumptionParam => ({ value, source, note });

export function intrinsicFor(p: Profile, opts: IntrinsicOpts = {}): IntrinsicView {
  const f = p.fund;
  const key = keyOf(p.market, p.symbol);
  const ov = store.overrides.get(key) ?? {};
  const fair = store.fairValues.get(key) ?? null;
  const rate = opts.rate ?? ov.requiredReturnPct ?? DEFAULT_RATE;
  const r = rate / 100;
  const g = ov.growthPct ?? f.g;
  const pe = ov.targetPe ?? f.pe;
  const dcfG = ov.dcfGrowthPct ?? f.dg ?? f.g[1];
  const price = p.spot;

  const scenarios: ScenarioView[] = (['Bull', 'Base', 'Bear'] as const).map((name, i) => {
    const gr = g[i] / 100;
    const eps3 = f.eps * (1 + gr) ** 3;
    const target = eps3 * pe[i];
    let dividends = 0;
    let dividendsPv = 0;
    for (let t = 1; t <= 3; t++) {
      const d = f.dps * (1 + gr) ** t;
      dividends += d;
      dividendsPv += d / (1 + r) ** t;
    }
    return {
      name,
      growthPct: g[i],
      targetPe: pe[i],
      eps3y: round(eps3),
      price3y: round(target),
      dividends3y: round(dividends),
      presentValue: round(target / (1 + r) ** 3 + dividendsPv),
    };
  });

  const methods: MethodView[] = [
    {
      id: 'scenario',
      label: 'Three-scenario, base case',
      value: scenarios[1].presentValue,
      note: `EPS ${f.eps.toFixed(2)} growing ${g[1]}% a year for 3 years x P/E ${pe[1]}, plus dividends, discounted at ${rate}%`,
    },
  ];
  let reverse: IntrinsicView['reverse'] = null;
  const warnings: string[] = [];
  if (f.fin) {
    warnings.push(
      'Free-cash-flow DCF is skipped for banks and insurers (cash flow is not meaningful): earnings-based methods only.',
    );
  } else {
    methods.push({
      id: 'dcf',
      label: 'Owner-earnings DCF',
      value: round(dcfValue(f.fcfps, dcfG / 100, r)),
      note: `FCF/share ${f.fcfps.toFixed(2)}, ${dcfG}% a year for 5 years fading to ${TERMINAL_GROWTH_PCT}%, discounted at ${rate}%`,
    });
    const implied = impliedGrowth(price, f.fcfps, r) * 100;
    reverse = {
      impliedGrowthPct: round(implied, 1),
      historicalEpsCagrPct: f.ec5,
      verdict: implied > f.ec5 * 1.3 + 1 ? 'demanding' : implied < f.ec5 * 0.7 ? 'undemanding' : 'in line',
    };
    warnings.push(
      'Free data holds about 4 annual statements, so the DCF growth rate is a judgement, not a measurement.',
    );
  }
  if (fair) {
    methods.push({
      id: 'fair_value',
      label: 'Morningstar fair value',
      value: fair.value,
      note: `Moat ${fair.moat ?? 'n/a'}, uncertainty ${fair.uncertainty ?? 'n/a'} (${fair.source}, as of ${fair.asOf})`,
    });
  } else if (p.market === 'US') {
    warnings.push('No Morningstar fair value stored for this name: import one in Data to add a third method.');
  }

  const base = round(median(methods.map((m) => m.value)));
  const all = [...methods.map((m) => m.value), scenarios[0].presentValue, scenarios[2].presentValue];
  const ratio = price / base;
  if (ratio > 1.2)
    warnings.push(
      `The price is ${Math.round((ratio - 1) * 100)}% above intrinsic value at a ${rate}% required return.`,
    );
  if (ov.growthPct && !(g[0] >= g[1] && g[1] >= g[2]))
    warnings.push('Your growth overrides are not ordered bull >= base >= bear.');
  if (ov.targetPe && !(pe[0] >= pe[1] && pe[1] >= pe[2]))
    warnings.push('Your target P/E overrides are not ordered bull >= base >= bear.');
  if (Object.keys(ov).length > 0) warnings.push('Valuation overrides are active for this stock.');

  const rateFromSlider =
    opts.rate !== undefined && opts.rate !== null && opts.rate !== DEFAULT_RATE && ov.requiredReturnPct !== opts.rate;
  const assumedGrowth = (i: number, note: string): AssumptionParam =>
    ov.growthPct ? param(ov.growthPct[i], 'override', 'set by you') : param(f.g[i], i === 1 ? 'data' : 'default', note);
  const assumedPe = (i: number, note: string): AssumptionParam =>
    ov.targetPe ? param(ov.targetPe[i], 'override', 'set by you') : param(f.pe[i], i === 1 ? 'data' : 'default', note);

  return {
    currency: marketCurrency(p.market),
    price,
    requiredReturnPct: rate,
    base,
    low: round(Math.min(...all)),
    high: round(Math.max(...all)),
    priceRatio: round(ratio, 3),
    marginOfSafetyPct: round(((base - price) / base) * 100, 1),
    stars: starsFor(ratio),
    methods,
    scenarios,
    reverse,
    assumptions: {
      eps: param(f.eps, 'data', 'trailing twelve months, diluted'),
      dividendPerShare: param(f.dps, 'data', 'last four dividends'),
      fcfPerShare: param(
        f.fcfps,
        'data',
        f.fin ? 'not used for banks and insurers' : 'operating cash flow minus capex, per share',
      ),
      growthPct: [
        assumedGrowth(0, 'default: base case plus a bull spread'),
        assumedGrowth(1, `near the stored 5y EPS CAGR of ${f.ec5}%`),
        assumedGrowth(2, 'default: base case minus a bear spread'),
      ],
      targetPe: [
        assumedPe(0, 'default: premium to own history'),
        assumedPe(1, `own 5y median P/E ${f.hpe[0]}x`),
        assumedPe(2, 'default: discount to own history'),
      ],
      dcfGrowthPct:
        ov.dcfGrowthPct !== undefined
          ? param(dcfG, 'override', 'set by you')
          : param(
              dcfG,
              f.dg !== undefined ? 'data' : 'default',
              f.dg !== undefined ? 'trailing FCF growth' : 'the base EPS growth',
            ),
      terminalGrowthPct: TERMINAL_GROWTH_PCT,
      requiredReturnPct:
        ov.requiredReturnPct !== undefined && ov.requiredReturnPct === rate
          ? param(rate, 'override', 'stored override')
          : rateFromSlider
            ? param(rate, 'override', 'set with the slider')
            : param(rate, 'default', 'default required return'),
    },
    proposedPut: opts.proposed
      ? {
          strike: opts.proposed.strike,
          breakeven: opts.proposed.breakeven,
          strikeRatio: round(opts.proposed.strike / base, 3),
          costRatio: round(opts.proposed.breakeven / base, 3),
        }
      : null,
    warnings,
  };
}

/** The compact badge shown next to an idea or a data row. */
export function valueBadge(p: Profile, breakeven: number | null): ValueBadge {
  const base = intrinsicFor(p).base ?? p.spot;
  const ratio = p.spot / base;
  return {
    base,
    priceRatio: round(ratio, 3),
    costRatio: breakeven !== null && !p.noCostRatio ? round(breakeven / base, 3) : null,
    stars: starsFor(ratio),
  };
}
