/**
 * docs/05 section 6, as far as it can be checked without market data: the engine and the pricer on simulated SPY-like
 * paths must show the documented behaviour of put-writing. The real-data reproduction (SPY against the Cboe PUT index)
 * runs with `pnpm cli backtest validate` once the history is ingested; this file guards the mechanics.
 */
import { describe, expect, it } from 'vitest';
import type { Underlying } from '../../src/backtest/engine';
import { mulberry32 } from '../../src/backtest/metrics';
import { managedPutChecks, putWriteChecks } from '../../src/backtest/validation';

function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Daily closes with a volatility regime per block: [days, annual drift, annual vol]. Seeded, Box-Muller. */
function path(blocks: [number, number, number][], seed: number): number[] {
  const rnd = mulberry32(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const out = [100];
  for (const [n, mu, sigma] of blocks)
    for (let i = 0; i < n; i++) {
      const prev = out[out.length - 1] as number;
      out.push(prev * Math.exp((mu - 0.5 * sigma * sigma) / 252 + (sigma / Math.sqrt(252)) * gauss()));
    }
  return out.slice(1);
}

function spy(from: string, closes: number[]): Underlying {
  const days = weekdays(from, closes.length);
  return {
    instrumentId: 1,
    symbol: 'SPY',
    market: 'US',
    currency: 'USD',
    sector: null,
    multiplier: 100,
    divYield: 0.015,
    bars: days.map((day, i) => ({
      day,
      close: closes[i] as number,
      adjClose: closes[i] as number,
      low: closes[i] as number,
    })),
  };
}

describe('validation 1: monthly ATM put-writing behaves like the Cboe PUT index', () => {
  // calm bull, a 2008-style crash with a vol spike, a rebound, a long bull, a 2022-style bear, another bull
  const closes = path(
    [
      [504, 0.09, 0.13],
      [252, -0.35, 0.38],
      [252, 0.28, 0.22],
      [1260, 0.14, 0.14],
      [252, -0.16, 0.24],
      [756, 0.16, 0.15],
      [1260, 0.1, 0.16],
    ],
    2008,
  );

  it('passes every put-writing check on a simulated 17-year path', async () => {
    const checks = await putWriteChecks(spy('2010-01-04', closes));
    for (const c of checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    expect(checks).toHaveLength(3);
  });
});

describe('validation 2: a 16-delta, 45-DTE put managed at 50% and 21 DTE', () => {
  it('lands in the documented win-rate band and exits early', async () => {
    const checks = await managedPutChecks(spy('2015-01-02', path([[2520, 0.08, 0.16]], 16)));
    for (const c of checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
  });
});
