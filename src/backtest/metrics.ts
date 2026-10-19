/**
 * Backtest metrics. Pure functions over trade records and equity curves: no DB, no clock, no global randomness
 * (bootstrap resampling uses a seeded mulberry32 PRNG, so results are reproducible).
 *
 * Undefined statistics are returned as `null`, never NaN or Infinity. Money fields (pnl, collateral) are in the
 * base currency. See docs/05-backtest-design.md section 4.
 */

import { diffDays } from '../core/dates';
import { mean, median, stdev } from '../indicators/stats';

export type DataTier = 'real' | 'proxy' | 'synthetic';

export interface TradeRecord {
  instrumentId: number;
  symbol?: string;
  entryDate: string;
  exitDate: string;
  /** Realised P&L in base currency. */
  pnl: number;
  /** Return on collateral for the trade (pnl / collateral). */
  roc: number;
  annualizedRoc: number;
  daysHeld: number;
  exitReason: string;
  tier: DataTier;
  /** Full notional locked for the trade (strike x multiplier), base currency. */
  collateral: number;
  /** Largest mark-to-market loss while open, as a positive magnitude. null when unknown. */
  maxAdverseExcursion: number | null;
  entryDelta?: number | null;
  scores?: Record<string, unknown>;
}

export interface EquityPoint {
  day: string;
  equity: number;
  deployedPct: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface TradeSummary {
  n: number;
  winRate: number | null;
  avgPnl: number | null;
  medianPnl: number | null;
  avgRoc: number | null;
  /** sum(pnl) / sum(collateral * daysHeld / 365): return per unit of capital-time. */
  annualizedRocOnCollateral: number | null;
  /** Gross profit / gross loss; null when there are no losing trades. */
  profitFactor: number | null;
  avgDaysHeld: number | null;
  exitReasonMix: Record<string, number>;
  /** Share of trades whose exit reason is 'assigned' or 'assignment'. */
  assignmentRate: number | null;
  mae: { p50: number; p90: number; max: number } | null;
  worst5: TradeRecord[];
  /** Student t of mean pnl against zero; null for n < 2 or zero dispersion. */
  tStat: number | null;
}

export interface TradeMetrics extends TradeSummary {
  winRateCI: Interval | null;
  avgRocCI: Interval | null;
  byTier: Partial<Record<DataTier, TradeSummary>>;
}

const ASSIGNMENT_REASONS: ReadonlySet<string> = new Set(['assigned', 'assignment']);
const TIERS: readonly DataTier[] = ['real', 'proxy', 'synthetic'];
const DEFAULT_RESAMPLES = 1000;
const DEFAULT_SEED = 12345;

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile (p in [0, 1]) of a pre-sorted ascending array. null when empty. */
function percentileSorted(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

function meanOrNull(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : finiteOrNull(mean(xs));
}

function summarize(trades: readonly TradeRecord[]): TradeSummary {
  const n = trades.length;
  const exitReasonMix: Record<string, number> = {};
  for (const t of trades) exitReasonMix[t.exitReason] = (exitReasonMix[t.exitReason] ?? 0) + 1;
  if (n === 0) {
    return {
      n: 0,
      winRate: null,
      avgPnl: null,
      medianPnl: null,
      avgRoc: null,
      annualizedRocOnCollateral: null,
      profitFactor: null,
      avgDaysHeld: null,
      exitReasonMix,
      assignmentRate: null,
      mae: null,
      worst5: [],
      tStat: null,
    };
  }

  const pnls = trades.map((t) => t.pnl);
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let capitalTime = 0;
  let assigned = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      wins++;
      grossWin += t.pnl;
    } else if (t.pnl < 0) {
      grossLoss += -t.pnl;
    }
    capitalTime += (t.collateral * t.daysHeld) / 365;
    if (ASSIGNMENT_REASONS.has(t.exitReason)) assigned++;
  }
  const sumPnl = pnls.reduce((a, b) => a + b, 0);

  const maes = trades
    .map((t) => t.maxAdverseExcursion)
    .filter((x): x is number => x !== null && Number.isFinite(x))
    .sort((a, b) => a - b);
  const mae =
    maes.length === 0
      ? null
      : { p50: percentileSorted(maes, 0.5)!, p90: percentileSorted(maes, 0.9)!, max: maes[maes.length - 1]! };

  const sd = n >= 2 ? stdev(pnls) : Number.NaN;
  const avgPnl = mean(pnls);
  const tStat = n >= 2 && Number.isFinite(sd) && sd > 0 ? finiteOrNull(avgPnl / (sd / Math.sqrt(n))) : null;

  return {
    n,
    winRate: wins / n,
    avgPnl: finiteOrNull(avgPnl),
    medianPnl: finiteOrNull(median(pnls)),
    avgRoc: meanOrNull(trades.map((t) => t.roc)),
    annualizedRocOnCollateral: capitalTime > 0 ? finiteOrNull(sumPnl / capitalTime) : null,
    profitFactor: grossLoss > 0 ? finiteOrNull(grossWin / grossLoss) : null,
    avgDaysHeld: meanOrNull(trades.map((t) => t.daysHeld)),
    exitReasonMix,
    assignmentRate: assigned / n,
    mae,
    worst5: [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 5),
    tStat,
  };
}

/** Percentile bootstrap 95% CI of a statistic computed over resampled (with replacement) trades. */
function bootstrapCI(
  trades: readonly TradeRecord[],
  stat: (sample: readonly TradeRecord[]) => number,
  resamples: number,
  rand: () => number,
): Interval | null {
  const n = trades.length;
  if (n === 0 || resamples < 1) return null;
  const stats: number[] = [];
  const sample: TradeRecord[] = new Array<TradeRecord>(n);
  for (let r = 0; r < resamples; r++) {
    for (let k = 0; k < n; k++) sample[k] = trades[Math.min(n - 1, Math.floor(rand() * n))]!;
    stats.push(stat(sample));
  }
  stats.sort((a, b) => a - b);
  return { lo: percentileSorted(stats, 0.025)!, hi: percentileSorted(stats, 0.975)! };
}

/** Trade-level metrics: pooled summary, bootstrap CIs (win rate, mean ROC) and the same summary per data tier. */
export function tradeMetrics(
  trades: readonly TradeRecord[],
  opts: { seed?: number; resamples?: number } = {},
): TradeMetrics {
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const rand = mulberry32(opts.seed ?? DEFAULT_SEED);
  const winRateCI = bootstrapCI(trades, (s) => s.filter((t) => t.pnl > 0).length / s.length, resamples, rand);
  const avgRocCI = bootstrapCI(trades, (s) => mean(s.map((t) => t.roc)), resamples, rand);
  const byTier: Partial<Record<DataTier, TradeSummary>> = {};
  for (const tier of TIERS) {
    const subset = trades.filter((t) => t.tier === tier);
    if (subset.length > 0) byTier[tier] = summarize(subset);
  }
  return { ...summarize(trades), winRateCI, avgRocCI, byTier };
}

// ---------------------------------------------------------------------------------------------------------------
// Equity curve
// ---------------------------------------------------------------------------------------------------------------

export interface EquityMetrics {
  cagr: number | null;
  annualVol: number | null;
  sharpe: number | null;
  sortino: number | null;
  /** Most negative peak-to-trough fraction (<= 0). */
  maxDrawdown: number | null;
  /** Longest peak-to-recovery (or peak-to-end if never recovered) span, in calendar days. */
  maxDrawdownDays: number | null;
  calmar: number | null;
  avgDeployedPct: number | null;
  monthlyReturns: { month: string; ret: number }[];
  totalReturn: number | null;
}

const TRADING_DAYS = 252;

/**
 * Portfolio metrics from a daily equity curve (ascending by day). Returns are simple daily returns between
 * consecutive points; annualised with sqrt(252). Fewer than 2 points, or a non-positive starting equity,
 * yields nulls.
 */
export function equityMetrics(curve: readonly EquityPoint[], opts: { riskFree?: number } = {}): EquityMetrics {
  const empty: EquityMetrics = {
    cagr: null,
    annualVol: null,
    sharpe: null,
    sortino: null,
    maxDrawdown: null,
    maxDrawdownDays: null,
    calmar: null,
    avgDeployedPct: curve.length === 0 ? null : meanOrNull(curve.map((p) => p.deployedPct)),
    monthlyReturns: [],
    totalReturn: null,
  };
  if (curve.length < 2) return empty;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (!(first.equity > 0)) return empty;

  const rfDaily = (opts.riskFree ?? 0) / TRADING_DAYS;
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    returns.push(prev > 0 ? curve[i]!.equity / prev - 1 : 0);
  }

  const totalReturn = last.equity / first.equity - 1;
  const calDays = diffDays(last.day, first.day);
  const cagr =
    calDays > 0 && last.equity > 0 ? finiteOrNull((last.equity / first.equity) ** (365 / calDays) - 1) : null;

  const sd = stdev(returns);
  const annualVol = Number.isFinite(sd) ? sd * Math.sqrt(TRADING_DAYS) : null;
  const meanExcess = mean(returns) - rfDaily;
  const sharpe = Number.isFinite(sd) && sd > 0 ? finiteOrNull((meanExcess / sd) * Math.sqrt(TRADING_DAYS)) : null;
  const downside = Math.sqrt(returns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / returns.length);
  const sortino = downside > 0 ? finiteOrNull((meanExcess / downside) * Math.sqrt(TRADING_DAYS)) : null;

  let peak = first.equity;
  let peakDay = first.day;
  let underwater = false;
  let maxDrawdown = 0;
  let maxDdDays = 0;
  for (const p of curve) {
    if (p.equity >= peak) {
      if (underwater) maxDdDays = Math.max(maxDdDays, diffDays(p.day, peakDay));
      underwater = false;
      peak = p.equity;
      peakDay = p.day;
    } else {
      underwater = true;
      maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1);
    }
  }
  // Still under water at the end: the drawdown lasts until the last observation.
  if (underwater) maxDdDays = Math.max(maxDdDays, diffDays(last.day, peakDay));

  const calmar = maxDrawdown < 0 && cagr !== null ? finiteOrNull(cagr / Math.abs(maxDrawdown)) : null;

  return {
    cagr,
    annualVol,
    sharpe,
    sortino,
    maxDrawdown,
    maxDrawdownDays: maxDdDays,
    calmar,
    avgDeployedPct: meanOrNull(curve.map((p) => p.deployedPct)),
    monthlyReturns: monthlyReturns(curve),
    totalReturn: finiteOrNull(totalReturn),
  };
}

function monthlyReturns(curve: readonly EquityPoint[]): { month: string; ret: number }[] {
  const out: { month: string; ret: number }[] = [];
  let prevEnd = curve[0]!.equity;
  let curMonth = curve[0]!.day.slice(0, 7);
  let curEnd = prevEnd;
  const flush = () => {
    if (prevEnd > 0) out.push({ month: curMonth, ret: curEnd / prevEnd - 1 });
    prevEnd = curEnd;
  };
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i]!;
    const m = p.day.slice(0, 7);
    if (m !== curMonth) {
      flush();
      curMonth = m;
    }
    curEnd = p.equity;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-stock cards and rule attribution
// ---------------------------------------------------------------------------------------------------------------

export interface StockCard {
  n: number;
  winRate: number;
  avgRoc: number;
  /** Max drawdown of the cumulative pnl series (starting from 0) as a fraction of mean collateral; <= 0. */
  maxDD: number;
  /** Fraction of the stock's trades per data tier (sums to 1). */
  tierMix: { real: number; proxy: number; synthetic: number };
  from: string;
  to: string;
}

/** One card per instrument; trades are ordered by exit date (then entry date) for the drawdown series. */
export function perStockCards(trades: readonly TradeRecord[], from: string, to: string): Record<number, StockCard> {
  const groups = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    const g = groups.get(t.instrumentId);
    if (g) g.push(t);
    else groups.set(t.instrumentId, [t]);
  }
  const out: Record<number, StockCard> = {};
  for (const [id, ts] of groups) {
    const n = ts.length;
    const ordered = [...ts].sort((a, b) =>
      a.exitDate === b.exitDate ? a.entryDate.localeCompare(b.entryDate) : a.exitDate.localeCompare(b.exitDate),
    );
    const meanCollateral = mean(ts.map((t) => t.collateral));
    let cum = 0;
    let peak = 0;
    let worst = 0;
    for (const t of ordered) {
      cum += t.pnl;
      peak = Math.max(peak, cum);
      worst = Math.min(worst, cum - peak);
    }
    const maxDD = meanCollateral > 0 ? worst / meanCollateral : 0;
    const count = (tier: DataTier) => ts.filter((t) => t.tier === tier).length / n;
    out[id] = {
      n,
      winRate: ts.filter((t) => t.pnl > 0).length / n,
      avgRoc: mean(ts.map((t) => t.roc)),
      maxDD: maxDD === 0 ? 0 : maxDD,
      tierMix: { real: count('real'), proxy: count('proxy'), synthetic: count('synthetic') },
      from,
      to,
    };
  }
  return out;
}

export interface RuleSide {
  n: number;
  winRate: number | null;
  avgRoc: number | null;
}

export interface RuleAttribution {
  rule: string;
  passed: RuleSide;
  failed: RuleSide;
}

function ruleSide(ts: readonly TradeRecord[]): RuleSide {
  if (ts.length === 0) return { n: 0, winRate: null, avgRoc: null };
  return {
    n: ts.length,
    winRate: ts.filter((t) => t.pnl > 0).length / ts.length,
    avgRoc: meanOrNull(ts.map((t) => t.roc)),
  };
}

function entryRules(t: TradeRecord): Record<string, boolean> | null {
  const rules = t.scores?.rules;
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rules)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

/**
 * Win rate / average ROC of trades where each rule passed versus failed at entry, read from
 * `trade.scores.rules` (rule id -> passed). Trades without that record are ignored. Sorted by rule id.
 */
export function attributionByRule(trades: readonly TradeRecord[]): RuleAttribution[] {
  const passed = new Map<string, TradeRecord[]>();
  const failed = new Map<string, TradeRecord[]>();
  const ids = new Set<string>();
  for (const t of trades) {
    const rules = entryRules(t);
    if (!rules) continue;
    for (const [id, ok] of Object.entries(rules)) {
      ids.add(id);
      const bucket = ok ? passed : failed;
      const list = bucket.get(id);
      if (list) list.push(t);
      else bucket.set(id, [t]);
    }
  }
  return [...ids]
    .sort()
    .map((rule) => ({ rule, passed: ruleSide(passed.get(rule) ?? []), failed: ruleSide(failed.get(rule) ?? []) }));
}

/**
 * Overfitting flag: out-of-sample Sharpe below half of a positive in-sample Sharpe. A missing in-sample value
 * (or one <= 0) never warns; a missing out-of-sample value with a positive in-sample Sharpe does.
 */
export function overfitWarning(inSampleSharpe: number | null, outOfSampleSharpe: number | null): boolean {
  if (inSampleSharpe === null || !Number.isFinite(inSampleSharpe) || inSampleSharpe <= 0) return false;
  if (outOfSampleSharpe === null || !Number.isFinite(outOfSampleSharpe)) return true;
  return outOfSampleSharpe < 0.5 * inSampleSharpe;
}
