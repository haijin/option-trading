/**
 * Intrinsic value per share, in the trading currency (design doc "Intrinsic value"):
 *
 *  - three-scenario: EPS grown 3 years at bull / base / bear growth x a target P/E, plus 3 years of dividends, all
 *    discounted at the required return (Invest-agent `financial_rigor.py three-scenario`);
 *  - owner-earnings DCF: FCF per share, 5 years at the DCF growth, a linear fade to 3% by year 10, a Gordon terminal
 *    value at 3%; not for banks and insurers; plus a reverse DCF (the 5-year growth the price implies);
 *  - the imported Morningstar fair value, when there is one.
 * Intrinsic value is the median of the available methods; the range also takes in the bear and bull scenarios.
 * Every skipped method and data limitation is a warning; nothing is invented to fill a gap.
 */
import { clamp, median } from '../core/util';
import { fixed, isNum } from './math';
import { epsCagr5, fcfPsCagr5, peHistory } from './metrics';
import type {
  AssumptionParam,
  AssumptionsView,
  Facts,
  IntrinsicView,
  MethodView,
  ScenarioView,
  ValuationOverrides,
} from './types';

export const TERMINAL_GROWTH_PCT = 3;
export const DEFAULT_REQUIRED_RETURN_PCT = 8;
/** Base growth when the EPS history gives no usable CAGR: the terminal rate, i.e. no growth edge is assumed. */
const FALLBACK_BASE_GROWTH_PCT = 3;
const BASE_GROWTH_RANGE = [0, 12] as const;
const BULL_GROWTH_STEP = 4;
const BULL_GROWTH_MAX = 20;
const BEAR_GROWTH_STEP = 5;
const BEAR_GROWTH_MIN = -5;
const DCF_GROWTH_RANGE = [-2, 10] as const;
const TARGET_PE_RANGE = [8, 30] as const;
const BULL_PE_FACTOR = 1.15;
const BEAR_PE_FACTOR = 0.8;
const MIN_PE_POINTS = 3;
const SCENARIO_YEARS = 3;
const DCF_YEARS = 10;
const DCF_HIGH_GROWTH_YEARS = 5;
const IMPLIED_GROWTH_BOUNDS = [-0.2, 0.5] as const;

const f1 = (x: number): string => fixed(x, 1);
const f2 = (x: number): string => fixed(x, 2);
const param = (value: number | null, source: AssumptionParam['source'], note: string | null): AssumptionParam => ({
  value,
  source,
  note,
});

// -------------------------------------------------------------------------------------------------------- formulas
/**
 * DCF per share. `g`, `r` and `gT` are fractions. Years 1 to 5 grow at `g`, years 6 to 10 fade linearly to `gT`
 * (growth in year 10 equals `gT`), and the value at year 10 is a Gordon perpetuity at `gT`.
 * With g = gT the result is the constant-growth value fcf0 x (1 + g) / (r - g).
 */
export function dcfValue(
  fcf0: number,
  g: number,
  r: number,
  gT = TERMINAL_GROWTH_PCT / 100,
  years = DCF_YEARS,
): number {
  let value = 0;
  let cash = fcf0;
  for (let t = 1; t <= years; t++) {
    const growth =
      t <= DCF_HIGH_GROWTH_YEARS ? g : g + ((gT - g) * (t - DCF_HIGH_GROWTH_YEARS)) / (years - DCF_HIGH_GROWTH_YEARS);
    cash *= 1 + growth;
    value += cash / (1 + r) ** t;
  }
  return value + (cash * (1 + gT)) / (r - gT) / (1 + r) ** years;
}

/** The 5-year growth (fraction) at which the DCF equals `price`, by bisection; null when no growth in [-20%, 50%] does. */
export function impliedGrowth(price: number, fcf0: number, r: number): number | null {
  let lo: number = IMPLIED_GROWTH_BOUNDS[0];
  let hi: number = IMPLIED_GROWTH_BOUNDS[1];
  if (dcfValue(fcf0, lo, r) > price || dcfValue(fcf0, hi, r) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dcfValue(fcf0, mid, r) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Scenario value: EPS x (1+g)^3 x target P/E, discounted 3 years, plus the discounted dividends of years 1 to 3. */
export function scenarioValue(
  name: ScenarioView['name'],
  eps: number,
  dps: number,
  growthPct: number,
  targetPe: number,
  rPct: number,
): ScenarioView {
  const g = growthPct / 100;
  const r = rPct / 100;
  const eps3y = eps * (1 + g) ** SCENARIO_YEARS;
  const price3y = eps3y * targetPe;
  let dividends3y = 0;
  for (let t = 1; t <= SCENARIO_YEARS; t++) dividends3y += (dps * (1 + g) ** t) / (1 + r) ** t;
  return {
    name,
    growthPct,
    targetPe,
    eps3y,
    price3y,
    dividends3y,
    presentValue: price3y / (1 + r) ** SCENARIO_YEARS + dividends3y,
  };
}

/** Stars from price / intrinsic value (Buffett checklist gate 5). */
export function starsFor(priceRatio: number): 1 | 2 | 3 | 4 | 5 {
  const x = Math.round(priceRatio * 1e9) / 1e9;
  return x <= 0.5 ? 5 : x <= 0.7 ? 4 : x <= 1.0 ? 3 : x <= 1.2 ? 2 : 1;
}

// ------------------------------------------------------------------------------------------------------ assumptions
interface CleanOverrides {
  growth: [number, number, number] | null;
  pe: [number, number, number] | null;
  dcfGrowth: number | null;
  requiredReturn: number | null;
}

function cleanOverrides(o: ValuationOverrides | null | undefined, warnings: string[]): CleanOverrides {
  const out: CleanOverrides = { growth: null, pe: null, dcfGrowth: null, requiredReturn: null };
  if (!o) return out;
  const triple = (t: unknown, positive: boolean): [number, number, number] | null =>
    Array.isArray(t) && t.length === 3 && t.every((x) => isNum(x) && (!positive || x > 0))
      ? [t[0] as number, t[1] as number, t[2] as number]
      : null;
  if (o.growthPct !== undefined) {
    out.growth = triple(o.growthPct, false);
    if (!out.growth) warnings.push('Override ignored: growthPct must be three finite numbers [bull, base, bear]');
  }
  if (o.targetPe !== undefined) {
    out.pe = triple(o.targetPe, true);
    if (!out.pe) warnings.push('Override ignored: targetPe must be three positive numbers [bull, base, bear]');
  }
  if (o.dcfGrowthPct !== undefined) {
    if (isNum(o.dcfGrowthPct)) out.dcfGrowth = o.dcfGrowthPct;
    else warnings.push('Override ignored: dcfGrowthPct must be a finite number');
  }
  if (o.requiredReturnPct !== undefined) {
    if (isNum(o.requiredReturnPct) && o.requiredReturnPct > 0) out.requiredReturn = o.requiredReturnPct;
    else warnings.push('Override ignored: requiredReturnPct must be a positive number');
  }
  return out;
}

interface Resolved {
  view: AssumptionsView;
  eps: number | null;
  dps: number | null;
  fcfPs: number | null;
  histEpsCagrPct: number | null;
  warnings: string[];
}

function resolveAssumptions(
  facts: Facts,
  overrides: ValuationOverrides | null | undefined,
  requiredReturnPct?: number,
): Resolved {
  const warnings: string[] = [];
  const ov = cleanOverrides(overrides, warnings);
  const L = facts.latest;

  // Per-share starting points (data only; never overridden).
  const whyNull = (what: string): string =>
    L === null
      ? 'no annual statement stored'
      : L.fx === null
        ? `no FX rate ${L.currency} to ${facts.currency}`
        : `${what} missing in the latest annual statement`;
  const conv = L && L.currency !== facts.currency && L.fx !== null ? `, ${L.currency} converted at ${L.fx}` : '';
  const eps = L?.eps ?? null;
  const dps = L?.dps ?? null;
  const fcfPs = L?.fcfPs ?? null;
  const epsParam = param(
    eps,
    'data',
    eps === null ? whyNull('diluted EPS') : `latest annual diluted EPS (year to ${L?.periodEnd}${conv})`,
  );
  const dpsParam = param(
    dps,
    'data',
    dps === null
      ? `${whyNull('dividends paid')}: scenario values exclude dividends`
      : `dividends paid / diluted shares (year to ${L?.periodEnd}${conv})`,
  );
  const fcfParam = param(
    fcfPs,
    'data',
    fcfPs === null ? whyNull('free cash flow') : `free cash flow / diluted shares (year to ${L?.periodEnd}${conv})`,
  );

  // EPS growth: bull / base / bear.
  const hist = epsCagr5(facts);
  let growth: [AssumptionParam, AssumptionParam, AssumptionParam];
  if (ov.growth) {
    const note = 'set by you';
    growth = [
      param(ov.growth[0], 'override', note),
      param(ov.growth[1], 'override', note),
      param(ov.growth[2], 'override', note),
    ];
  } else {
    let base: number;
    let baseParam: AssumptionParam;
    if (hist.pct !== null) {
      base = clamp(hist.pct, BASE_GROWTH_RANGE[0], BASE_GROWTH_RANGE[1]);
      const clamped =
        base !== hist.pct ? `, clamped to ${BASE_GROWTH_RANGE[0]}-${BASE_GROWTH_RANGE[1]}% (${f1(base)}%)` : '';
      baseParam = param(
        base,
        'data',
        `EPS CAGR ${f1(hist.pct)}% a year over ${hist.years} year${hist.years === 1 ? '' : 's'}${clamped}`,
      );
    } else {
      base = FALLBACK_BASE_GROWTH_PCT;
      const why = 'EPS CAGR is not defined (fewer than 2 statements, or EPS not positive at an end of the window)';
      baseParam = param(base, 'default', `${why}: using ${FALLBACK_BASE_GROWTH_PCT}%`);
      if (facts.annual.length >= 2) warnings.push(`${why}: base growth defaults to ${FALLBACK_BASE_GROWTH_PCT}%`);
    }
    growth = [
      param(
        Math.min(base + BULL_GROWTH_STEP, BULL_GROWTH_MAX),
        baseParam.source,
        `base + ${BULL_GROWTH_STEP} points, at most ${BULL_GROWTH_MAX}%`,
      ),
      baseParam,
      param(
        Math.max(base - BEAR_GROWTH_STEP, BEAR_GROWTH_MIN),
        baseParam.source,
        `base - ${BEAR_GROWTH_STEP} points, at least ${BEAR_GROWTH_MIN}%`,
      ),
    ];
  }

  // Target P/E in three years: bull / base / bear.
  let targetPe: [AssumptionParam, AssumptionParam, AssumptionParam];
  if (ov.pe) {
    const note = 'set by you';
    targetPe = [
      param(ov.pe[0], 'override', note),
      param(ov.pe[1], 'override', note),
      param(ov.pe[2], 'override', note),
    ];
  } else {
    const pts = peHistory(facts);
    const currentPe = eps !== null && eps > 0 && facts.price > 0 ? facts.price / eps : null;
    let base: number | null = null;
    let note: string;
    if (pts.length >= MIN_PE_POINTS) {
      const m = median(pts) as number;
      base = clamp(m, TARGET_PE_RANGE[0], TARGET_PE_RANGE[1]);
      note = `median of ${pts.length} year-end P/E points (${f1(m)}x)${base !== m ? `, clamped to ${TARGET_PE_RANGE[0]}-${TARGET_PE_RANGE[1]}x` : ''}`;
    } else if (currentPe !== null) {
      base = clamp(currentPe, TARGET_PE_RANGE[0], TARGET_PE_RANGE[1]);
      note = `only ${pts.length} year-end P/E point${pts.length === 1 ? '' : 's'}: using the current P/E ${f1(currentPe)}x${base !== currentPe ? `, clamped to ${TARGET_PE_RANGE[0]}-${TARGET_PE_RANGE[1]}x` : ''}`;
      warnings.push(`Only ${pts.length} year-end P/E points: the target P/E falls back to the current P/E`);
    } else {
      note = 'needs a positive EPS and a price';
    }
    targetPe =
      base === null
        ? [param(null, 'default', note), param(null, 'default', note), param(null, 'default', note)]
        : [
            param(base * BULL_PE_FACTOR, 'data', `base x ${BULL_PE_FACTOR}`),
            param(base, 'data', note),
            param(base * BEAR_PE_FACTOR, 'data', `base x ${BEAR_PE_FACTOR}`),
          ];
  }

  // DCF growth.
  let dcfGrowth: AssumptionParam;
  if (ov.dcfGrowth !== null) dcfGrowth = param(ov.dcfGrowth, 'override', 'set by you');
  else {
    const fg = fcfPsCagr5(facts);
    if (fg.pct !== null) {
      const v = clamp(fg.pct, DCF_GROWTH_RANGE[0], DCF_GROWTH_RANGE[1]);
      dcfGrowth = param(
        v,
        'data',
        `FCF per share CAGR ${f1(fg.pct)}% a year over ${fg.years} year${fg.years === 1 ? '' : 's'}${v !== fg.pct ? `, clamped to ${DCF_GROWTH_RANGE[0]} to ${DCF_GROWTH_RANGE[1]}%` : ''}`,
      );
    } else {
      dcfGrowth = param(growth[1].value, 'default', 'FCF per share CAGR is not defined: using the base EPS growth');
    }
  }

  // Required return: an explicit argument (the slider) wins over a saved override, which wins over the default.
  const explicit = isNum(requiredReturnPct) && requiredReturnPct > 0 ? requiredReturnPct : null;
  const rr = explicit ?? ov.requiredReturn ?? DEFAULT_REQUIRED_RETURN_PCT;
  const rrParam =
    rr === DEFAULT_REQUIRED_RETURN_PCT && ov.requiredReturn === null
      ? param(rr, 'default', `default ${DEFAULT_REQUIRED_RETURN_PCT}%`)
      : param(rr, 'override', 'set by you');

  return {
    view: {
      eps: epsParam,
      dividendPerShare: dpsParam,
      fcfPerShare: fcfParam,
      growthPct: growth,
      targetPe,
      dcfGrowthPct: dcfGrowth,
      terminalGrowthPct: TERMINAL_GROWTH_PCT,
      requiredReturnPct: rrParam,
    },
    eps,
    dps,
    fcfPs,
    histEpsCagrPct: hist.pct,
    warnings,
  };
}

/** The assumptions the valuation would use: derived from data, with per-stock overrides applied and labelled. */
export function defaultAssumptions(
  facts: Facts,
  overrides?: ValuationOverrides | null,
  requiredReturnPct?: number,
): AssumptionsView {
  return resolveAssumptions(facts, overrides, requiredReturnPct).view;
}

// --------------------------------------------------------------------------------------------------- intrinsic value
export function intrinsicValue(
  facts: Facts,
  opts: {
    requiredReturnPct: number;
    overrides?: ValuationOverrides | null;
    proposedPut?: { strike: number; premium: number } | null;
  },
): IntrinsicView {
  const resolved = resolveAssumptions(facts, opts.overrides, opts.requiredReturnPct);
  const warnings: string[] = [...facts.warnings, ...resolved.warnings];
  if (!(isNum(opts.requiredReturnPct) && opts.requiredReturnPct > 0)) {
    warnings.push(
      `The required return ${String(opts.requiredReturnPct)} is not a positive number: using the saved or default rate`,
    );
  }
  const assumptions = resolved.view;
  const rr = assumptions.requiredReturnPct.value as number;
  const r = rr / 100;
  const price = facts.price;
  const n = facts.annual.length;
  const methods: MethodView[] = [];
  let scenarios: ScenarioView[] = [];
  let reverse: IntrinsicView['reverse'] = null;

  const epsYears = facts.annual.filter((a) => a.epsStmt !== null).length;
  if (epsYears > 0 && epsYears < 5) {
    warnings.push(
      `EPS history is ${epsYears} year${epsYears === 1 ? '' : 's'} (fewer than 5): growth and target P/E rest on a short window`,
    );
  }

  // ------------------------------------------------------------------------------------------- three scenarios
  const { eps, dps, fcfPs } = resolved;
  const growthPct = assumptions.growthPct.map((p) => p.value);
  const pes = assumptions.targetPe.map((p) => p.value);
  let scenarioSkip: string | null = null;
  if (n < 2) scenarioSkip = `needs at least 2 annual statements, have ${n}`;
  else if (eps === null) scenarioSkip = 'EPS is unavailable (no statement or no FX rate)';
  else if (eps <= 0) scenarioSkip = `the latest EPS (${f2(eps)}) is not positive`;
  else if (pes.some((p) => p === null) || growthPct.some((g) => g === null))
    scenarioSkip = 'growth or target P/E is unavailable';
  if (scenarioSkip !== null) warnings.push(`Three-scenario method skipped: ${scenarioSkip}`);
  else {
    const names = ['Bull', 'Base', 'Bear'] as const;
    scenarios = names.map((name, i) =>
      scenarioValue(name, eps as number, dps ?? 0, growthPct[i] as number, pes[i] as number, rr),
    );
    if (dps === null) warnings.push('No dividend figure stored: scenario values exclude dividends');
    const baseCase = scenarios[1] as ScenarioView;
    methods.push({
      id: 'scenario',
      label: 'Three-scenario, base case',
      value: baseCase.presentValue,
      note: `EPS ${f2(eps as number)} growing ${f1(baseCase.growthPct)}% a year for ${SCENARIO_YEARS} years x P/E ${f1(baseCase.targetPe)}, plus dividends, discounted at ${f1(rr)}%`,
    });
  }

  // ------------------------------------------------------------------------------------------------------ DCF
  let dcfSkip: string | null = null;
  if (facts.solvencyModel === 'financial')
    dcfSkip = 'banks and insurers (cash flow is not meaningful); earnings-based methods only';
  else if (fcfPs === null) dcfSkip = 'free cash flow per share is unavailable (no statement or no FX rate)';
  else if (fcfPs <= 0) dcfSkip = `free cash flow per share (${f2(fcfPs)}) is not positive`;
  else if (r <= TERMINAL_GROWTH_PCT / 100)
    dcfSkip = `the required return (${f1(rr)}%) must exceed the terminal growth (${TERMINAL_GROWTH_PCT}%)`;
  if (dcfSkip !== null) warnings.push(`Owner-earnings DCF skipped: ${dcfSkip}`);
  else {
    const g = (assumptions.dcfGrowthPct.value as number) / 100;
    methods.push({
      id: 'dcf',
      label: 'Owner-earnings DCF',
      value: dcfValue(fcfPs as number, g, r),
      note: `FCF/share ${f2(fcfPs as number)}, ${f1(g * 100)}% a year for ${DCF_HIGH_GROWTH_YEARS} years fading to ${TERMINAL_GROWTH_PCT}%, discounted at ${f1(rr)}%`,
    });
    if (price > 0) {
      const implied = impliedGrowth(price, fcfPs as number, r);
      if (implied === null) {
        warnings.push(
          `Reverse DCF: the price implies free-cash-flow growth outside ${IMPLIED_GROWTH_BOUNDS[0] * 100}% to ${IMPLIED_GROWTH_BOUNDS[1] * 100}% a year`,
        );
      } else {
        const impliedPct = implied * 100;
        const h = resolved.histEpsCagrPct;
        reverse = {
          impliedGrowthPct: impliedPct,
          historicalEpsCagrPct: h,
          verdict:
            h === null
              ? 'in line'
              : impliedPct > h * 1.3 + 1
                ? 'demanding'
                : impliedPct < h * 0.7
                  ? 'undemanding'
                  : 'in line',
        };
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ fair value
  if (facts.fairValue) {
    const fv = facts.fairValue;
    methods.push({
      id: 'fair_value',
      label: 'Morningstar fair value',
      value: fv.value,
      note: `${fv.source} as of ${fv.asOf.slice(0, 10)}; moat ${fv.moat ?? 'n/a'}, uncertainty ${fv.uncertainty ?? 'n/a'}`,
    });
  }

  // -------------------------------------------------------------------------------------------- combine
  const med = median(methods.map((m) => m.value));
  const base = med !== null && med > 0 ? med : null;
  if (methods.length === 0) warnings.push('No valuation method could be computed');
  const all = [
    ...methods.map((m) => m.value),
    ...(scenarios.length === 3 ? [scenarios[0]?.presentValue, scenarios[2]?.presentValue] : []),
  ].filter(isNum);
  const priceRatio = base !== null && price > 0 ? price / base : null;

  let proposedPut: IntrinsicView['proposedPut'] = null;
  const put = opts.proposedPut;
  if (put && base !== null && isNum(put.strike) && put.strike > 0 && isNum(put.premium)) {
    proposedPut = {
      strike: put.strike,
      breakeven: put.strike - put.premium,
      strikeRatio: put.strike / base,
      costRatio: (put.strike - put.premium) / base,
    };
  }

  return {
    currency: facts.currency,
    price,
    requiredReturnPct: rr,
    base,
    low: base === null ? null : Math.min(...all),
    high: base === null ? null : Math.max(...all),
    priceRatio,
    marginOfSafetyPct: base !== null && price > 0 ? ((base - price) / base) * 100 : null,
    stars: priceRatio === null ? null : starsFor(priceRatio),
    methods,
    scenarios,
    reverse,
    assumptions,
    proposedPut,
    warnings: [...new Set(warnings)],
  };
}

/** The compact figures the scan and data tables show next to a name; null when no intrinsic value exists. */
export function priceBadge(
  iv: IntrinsicView,
): { base: number; priceRatio: number; costRatio: number | null; stars: 1 | 2 | 3 | 4 | 5 } | null {
  if (iv.base === null || iv.priceRatio === null || iv.stars === null) return null;
  return { base: iv.base, priceRatio: iv.priceRatio, costRatio: iv.proposedPut?.costRatio ?? null, stars: iv.stars };
}
