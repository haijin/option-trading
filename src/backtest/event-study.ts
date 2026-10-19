/**
 * Signal-level event study (docs/05-backtest-design.md section 5). For every bar where a rule fired, measure the
 * forward return, whether price touched the put strike before expiry, and the premium capture of a
 * Black-Scholes-priced put sold at the target delta; compare against bars where the rule did not fire.
 *
 * Pure and lookahead-free: a rule's `fires(i)` reads only bars 0..i (the indicators are causal), so perturbing
 * later bars never changes it. The forward window of course looks ahead: that is the outcome being measured.
 */

import { addDays } from '../core/dates';
import { bsPrice } from '../indicators/black-scholes';
import { normInv } from '../indicators/normal';
import { mean, median } from '../indicators/stats';
import { atr, bollinger, rollingMin, rsi, sma } from '../indicators/ta';

export interface StudyRule {
  id: string;
  fires: (i: number) => boolean;
}

export interface RuleBar {
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface StudyBar {
  day: string;
  close: number;
  adjClose: number;
  /** Intraday low; the close is used when absent. */
  low?: number;
}

export interface EventStudyOptions {
  /** Calendar days to expiry for each studied put (default [30, 45]). */
  horizons?: number[];
  /** Target absolute put delta used to pick the strike (default 0.25). */
  strikeDeltaTarget?: number;
  /** Annualised vol to price with at bar i; null skips that bar. */
  sigma: (i: number) => number | null;
  rate: number;
}

export interface OutcomeStats {
  n: number;
  meanFwd: number | null;
  medianFwd: number | null;
  /** Share of events where the low/close touched the strike on a later bar up to expiry. */
  touchRate: number | null;
  /** Mean of (premium - max(K - S_T, 0)) / premium. */
  meanCapture: number | null;
  /** Share of events with capture > 0. */
  winRate: number | null;
}

export interface HorizonStudy {
  horizon: number;
  nFired: number;
  nNotFired: number;
  fired: OutcomeStats;
  notFired: OutcomeStats;
  edge: { winRateDelta: number | null; touchRateDelta: number | null };
}

export interface EventStudyResult {
  rule: string;
  byHorizon: HorizonStudy[];
}

/** Built-in rules over precomputed (causal) indicator series. Warm-up bars never fire. */
export function builtInRules(bars: readonly RuleBar[]): StudyRule[] {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const rsi14 = rsi(closes, 14);
  const sma200 = sma(closes, 200);
  const sma50 = sma(closes, 50);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(highs, lows, closes, 14);
  const low20 = rollingMin(lows, 20);

  return [
    {
      id: 'rsi.pullback',
      fires: (i) => {
        const r = rsi14[i];
        return r != null && r >= 30 && r <= 45;
      },
    },
    {
      id: 'trend.aboveSma200',
      fires: (i) => {
        const s = sma200[i];
        return s != null && closes[i]! > s;
      },
    },
    {
      id: 'bb.lowerTouch',
      fires: (i) => {
        for (let j = Math.max(0, i - 4); j <= i; j++) {
          const lower = bb.lower[j];
          if (lower != null && lows[j]! <= lower) return true;
        }
        return false;
      },
    },
    {
      id: 'sma50.rising',
      fires: (i) => {
        const now = sma50[i];
        const then = i >= 20 ? sma50[i - 20] : null;
        return now != null && then != null && now > then;
      },
    },
    {
      id: 'support.nearLow20',
      fires: (i) => {
        const lo = low20[i];
        const a = atr14[i];
        return lo != null && a != null && closes[i]! - lo <= a;
      },
    },
  ];
}

/**
 * Strike of the put with |delta| = target under Black-Scholes (q = 0). With delta = -N(-d1), d1 = -N^-1(target)
 * and K = S * exp(-d1 * sigma * sqrt(t) + (r + sigma^2 / 2) * t), which is exact (no iteration needed).
 */
export function strikeForPutDelta(spot: number, t: number, rate: number, sigma: number, deltaAbs: number): number {
  const d1 = -normInv(deltaAbs);
  return spot * Math.exp(-d1 * sigma * Math.sqrt(t) + (rate + 0.5 * sigma * sigma) * t);
}

interface Outcome {
  fwd: number;
  touched: boolean;
  capture: number;
}

function stats(xs: readonly Outcome[]): OutcomeStats {
  const n = xs.length;
  if (n === 0) return { n: 0, meanFwd: null, medianFwd: null, touchRate: null, meanCapture: null, winRate: null };
  const fwd = xs.map((x) => x.fwd);
  return {
    n,
    meanFwd: mean(fwd),
    medianFwd: median(fwd),
    touchRate: xs.filter((x) => x.touched).length / n,
    meanCapture: mean(xs.map((x) => x.capture)),
    winRate: xs.filter((x) => x.capture > 0).length / n,
  };
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

export function runEventStudy(bars: readonly StudyBar[], rule: StudyRule, opts: EventStudyOptions): EventStudyResult {
  const horizons = opts.horizons ?? [30, 45];
  const target = opts.strikeDeltaTarget ?? 0.25;
  if (!(target > 0 && target < 1)) throw new RangeError(`strikeDeltaTarget must be in (0, 1), got ${target}`);
  const n = bars.length;
  const lastDay = n > 0 ? bars[n - 1]!.day : '';

  const byHorizon: HorizonStudy[] = horizons.map((horizon) => {
    const t = horizon / 365;
    const fired: Outcome[] = [];
    const notFired: Outcome[] = [];
    let end = 0; // pointer: last index with day <= expiry; monotone because expiry dates ascend with i
    for (let i = 0; i < n; i++) {
      const expiry = addDays(bars[i]!.day, horizon);
      if (expiry > lastDay) break; // forward window exceeds data (and so does every later bar's)
      if (end < i) end = i;
      while (end + 1 < n && bars[end + 1]!.day <= expiry) end++;
      if (end <= i) continue;

      const sigma = opts.sigma(i);
      if (sigma === null || !Number.isFinite(sigma) || sigma < 0) continue;
      const spot = bars[i]!.close;
      if (!(spot > 0)) continue;
      const strike = strikeForPutDelta(spot, t, opts.rate, sigma, target);
      const premium = bsPrice('P', spot, strike, t, opts.rate, sigma);
      if (!(premium > 1e-12)) continue;

      let touched = false;
      for (let k = i + 1; k <= end; k++) {
        const b = bars[k]!;
        if (Math.min(b.low ?? b.close, b.close) <= strike) {
          touched = true;
          break;
        }
      }
      const outcome: Outcome = {
        fwd: bars[end]!.adjClose / bars[i]!.adjClose - 1,
        touched,
        capture: (premium - Math.max(strike - bars[end]!.close, 0)) / premium,
      };
      (rule.fires(i) ? fired : notFired).push(outcome);
    }
    const f = stats(fired);
    const nf = stats(notFired);
    return {
      horizon,
      nFired: f.n,
      nNotFired: nf.n,
      fired: f,
      notFired: nf,
      edge: { winRateDelta: delta(f.winRate, nf.winRate), touchRateDelta: delta(f.touchRate, nf.touchRate) },
    };
  });

  return { rule: rule.id, byHorizon };
}
