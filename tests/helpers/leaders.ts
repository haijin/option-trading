/** Synthetic run-up / base / turn-up bars and a one-call runner for the leaders skill tests. */
import type { LeadersPayload } from '../../src/core/leaders';
import type { defaultParams } from '../../src/core/params';
import type { CorporateEvent, DailyBar } from '../../src/core/types';
import type { SkillContext, SkillResult } from '../../src/skills/contract';
import { marketRegime } from '../../src/skills/s0-market-regime';
import {
  LEADERS_EARNINGS_KEY,
  LEADERS_RANKS_KEY,
  type LeadersEarningsInput,
  type LeadersRankInput,
  leadersPullback,
} from '../../src/skills/s8-leaders-pullback';
import { ctxFor, END, linear, makeHistory, portfolio, tradingDaysEnding } from './history';

/**
 * A run-up, a shallow base and a turn-up bar. Index 0..A: closes climb from 30 to 100 (A = n - 1 - BASE_LEN); the base
 * dips about 7% under the range high and the last bar is a green bar that closes back above the 21-EMA.
 */
export const N = 200;
export const BASE_LEN = 14;
export const A = N - 1 - BASE_LEN;

export interface Shape {
  /** Closes of the base bars (indexes A+1 .. N-1). */
  base?: number[];
  /** Override of the last bar: open, low, close. */
  last?: { open?: number; low?: number; close?: number; high?: number };
  /** Volume multiplier for the last bar. */
  lastVolume?: number;
}

export const BASE_CLOSES = [99.6, 98.8, 98.0, 97.2, 96.5, 96.0, 95.6, 95.3, 95.1, 95.0, 95.2, 95.1, 95.0];

export function leaderBars(shape: Shape = {}, market: 'US' | 'HK' = 'US', end = END): DailyBar[] {
  const days = tradingDaysEnding(market, end, N);
  const baseCloses = shape.base ?? BASE_CLOSES;
  // the closes up to the second-to-last bar, then the last bar
  const closes: number[] = [];
  for (let i = 0; i <= A; i++) closes.push(30 + (70.5 * i) / A);
  for (const c of baseCloses) closes.push(c);
  const lastClose = shape.last?.close ?? 96.8;
  closes.push(lastClose);
  return closes.map((c, i) => {
    const prev = i > 0 ? (closes[i - 1] as number) : c;
    const isLast = i === N - 1;
    const open = isLast ? (shape.last?.open ?? 95.1) : prev;
    let high = Math.max(open, c) * 1.004;
    let low = Math.min(open, c) * 0.996;
    if (isLast) {
      if (shape.last?.low !== undefined) low = shape.last.low;
      if (shape.last?.high !== undefined) high = shape.last.high;
    }
    const baseVol = i <= A ? 1_000_000 : 700_000 - (i - A) * 10_000;
    return {
      day: days[i] as string,
      open,
      high,
      low,
      close: c,
      adjClose: c,
      volume: isLast ? Math.round(1_400_000 * (shape.lastVolume ?? 1)) : baseVol,
      source: 'yahoo',
    };
  });
}

export const RANKS: LeadersRankInput = { rank1m: 80, rank3m: 90, rank6m: 95, screened: 500 };

export async function regimeFor(
  h: ReturnType<typeof makeHistory>,
  asOf: string,
  vol = 15,
): Promise<Map<string, SkillResult>> {
  const priors = new Map<string, SkillResult>();
  const h2 = { ...h };
  h2.volIndexBars = h.volIndexBars.map((b) => ({ ...b, close: vol }));
  const r = await marketRegime.run(ctxFor(h2, asOf));
  priors.set('market.regime', r);
  return priors;
}

export async function run(
  opts: {
    shape?: Shape;
    market?: 'US' | 'HK';
    instrument?: NonNullable<Parameters<typeof makeHistory>[0]>['instrument'];
    asOf?: string;
    bars?: DailyBar[];
    ranks?: LeadersRankInput | null;
    earnings?: LeadersEarningsInput;
    events?: CorporateEvent[];
    vol?: number;
    equity?: number | null;
    params?: ReturnType<typeof defaultParams>;
  } = {},
): Promise<SkillResult<LeadersPayload>> {
  const market = opts.market ?? 'US';
  const bars = opts.bars ?? leaderBars(opts.shape, market);
  const h = makeHistory({
    bars,
    instrument: {
      market,
      ...(market === 'HK' ? { currency: 'HKD' as const, multiplier: 500 } : {}),
      ...opts.instrument,
    },
    indexCloses: linear(400, 520, 600),
    ...(opts.events ? { events: opts.events } : {}),
  });
  const asOf = opts.asOf ?? (bars[bars.length - 1] as DailyBar).day;
  const priors = await regimeFor(h, asOf, opts.vol ?? 15);
  const base: SkillContext = ctxFor(h, asOf, {
    priors,
    ...(opts.params ? { params: opts.params } : {}),
    portfolio: portfolio(opts.equity === undefined ? {} : { equity: opts.equity }),
  });
  const extras: Record<string, unknown> = {};
  if (opts.ranks !== null) extras[LEADERS_RANKS_KEY] = opts.ranks ?? RANKS;
  if (opts.earnings) extras[LEADERS_EARNINGS_KEY] = opts.earnings;
  return leadersPullback.run({ ...base, extras });
}
