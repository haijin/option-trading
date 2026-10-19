/**
 * Walk-forward orchestrator (docs/05-backtest-design.md section 3): optimise on a training window, test the chosen
 * parameters on the following window, roll forward. Pure: the caller supplies `evaluate` (which runs the engine);
 * dates are ISO strings with calendar-month arithmetic, no clock. Only out-of-sample numbers are results.
 */

import { addDays, assertISODate, daysInMonth, ymd } from '../core/dates';
import { overfitWarning } from './metrics';

export const MAX_GRID = 24;

export interface EvalResult {
  sharpe: number | null;
  totalReturn: number | null;
  n: number;
}

export interface WalkForwardOptions<P> {
  from: string;
  to: string;
  /** Training window length in months (design default 36). */
  trainMonths: number;
  /** Test window length in months (design default 12). */
  testMonths: number;
  /** Roll step in months; defaults to testMonths so test windows tile without overlap. */
  stepMonths?: number;
  /** Candidate parameter sets; at most 24. */
  grid: readonly P[];
  /** Run the backtest for `params` over the inclusive [from, to] range. */
  evaluate: (params: P, from: string, to: string) => Promise<EvalResult>;
  /** Scores a training result; higher is better. Default: sharpe, or -Infinity when null. */
  objective?: (r: EvalResult) => number;
}

export interface WalkForwardWindow<P> {
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  bestParams: P;
  inSample: EvalResult;
  outOfSample: EvalResult;
}

export interface WalkForwardResult<P> {
  windows: WalkForwardWindow<P>[];
  aggregate: {
    meanInSampleSharpe: number | null;
    meanOutOfSampleSharpe: number | null;
    overfitting: boolean;
    pooledOutOfSampleN: number;
  };
}

/** Adds calendar months to an ISO date, clamping the day to the target month's length (Jan 31 + 1 -> Feb 28/29). */
export function addMonths(date: string, months: number): string {
  assertISODate(date);
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

function defaultObjective(r: EvalResult): number {
  return r.sharpe ?? Number.NEGATIVE_INFINITY;
}

function meanOfFinite(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

function requirePositiveInt(x: number, name: string): void {
  if (!Number.isInteger(x) || x < 1) throw new RangeError(`${name} must be a positive integer, got ${x}`);
}

/**
 * Train windows are [trainFrom, trainTo], test windows [testFrom, testTo], both inclusive, with
 * testFrom = trainTo + 1 day, so they never overlap. Window k starts k * stepMonths after `from`; windows whose
 * test range would end after `to` are dropped. Candidates are evaluated sequentially (deterministic order);
 * ties on the objective keep the earliest grid entry.
 */
export async function walkForward<P>(opts: WalkForwardOptions<P>): Promise<WalkForwardResult<P>> {
  assertISODate(opts.from, 'from');
  assertISODate(opts.to, 'to');
  requirePositiveInt(opts.trainMonths, 'trainMonths');
  requirePositiveInt(opts.testMonths, 'testMonths');
  const step = opts.stepMonths ?? opts.testMonths;
  requirePositiveInt(step, 'stepMonths');
  if (opts.grid.length === 0) throw new RangeError('grid must contain at least one parameter set');
  if (opts.grid.length > MAX_GRID) {
    throw new RangeError(`grid has ${opts.grid.length} combinations; the limit is ${MAX_GRID} (overfitting guard)`);
  }
  const objective = opts.objective ?? defaultObjective;

  const windows: WalkForwardWindow<P>[] = [];
  for (let k = 0; ; k++) {
    const offset = k * step;
    const trainFrom = addMonths(opts.from, offset);
    const testFromExclusive = addMonths(opts.from, offset + opts.trainMonths);
    const trainTo = addDays(testFromExclusive, -1);
    const testTo = addDays(addMonths(opts.from, offset + opts.trainMonths + opts.testMonths), -1);
    if (testTo > opts.to) break;

    let best: { params: P; result: EvalResult; score: number } | null = null;
    for (const params of opts.grid) {
      const result = await opts.evaluate(params, trainFrom, trainTo);
      const raw = objective(result);
      const score = Number.isNaN(raw) ? Number.NEGATIVE_INFINITY : raw;
      if (best === null || score > best.score) best = { params, result, score };
    }
    // grid is non-empty, so best is always set.
    const chosen = best!;
    const outOfSample = await opts.evaluate(chosen.params, testFromExclusive, testTo);
    windows.push({
      trainFrom,
      trainTo,
      testFrom: testFromExclusive,
      testTo,
      bestParams: chosen.params,
      inSample: chosen.result,
      outOfSample,
    });
  }

  const meanIs = meanOfFinite(windows.map((w) => w.inSample.sharpe));
  const meanOos = meanOfFinite(windows.map((w) => w.outOfSample.sharpe));
  return {
    windows,
    aggregate: {
      meanInSampleSharpe: meanIs,
      meanOutOfSampleSharpe: meanOos,
      overfitting: windows.length > 0 && overfitWarning(meanIs, meanOos),
      pooledOutOfSampleN: windows.reduce((a, w) => a + w.outOfSample.n, 0),
    },
  };
}
