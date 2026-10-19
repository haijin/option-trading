import { describe, expect, it } from 'vitest';
import {
  type EngineConfig,
  type EntryCandidate,
  type EntrySource,
  runEngine,
  type Underlying,
} from '../../src/backtest/engine';
import { createNaiveSource } from '../../src/backtest/naive-source';

function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function underlying(
  id: number,
  days: string[],
  price: (i: number) => number,
  extra: Partial<Underlying> = {},
): Underlying {
  return {
    instrumentId: id,
    symbol: `S${id}`,
    market: 'US',
    currency: 'USD',
    sector: null,
    multiplier: 100,
    divYield: 0,
    bars: days.map((day, i) => ({ day, close: price(i), adjClose: price(i), low: price(i) })),
    ...extra,
  };
}

const baseCfg = (days: string[], over: Partial<EngineConfig> = {}): EngineConfig => ({
  from: days[0] as string,
  to: days[days.length - 1] as string,
  initialCapital: 1_000_000,
  fxToBase: () => 1,
  riskFree: { US: 0.04, HK: 0.035 },
  cashRate: 0,
  takeProfitPct: 0.5,
  dteExit: 21,
  stopMultiple: 2,
  haircuts: { US: { slippage: 0.1, modelRisk: 0.05 }, HK: { slippage: 0.15, modelRisk: 0.05 } },
  feePerContract: { US: 1, HK: 0 },
  scanEveryDays: 1000, // one scan, on the first day
  maxOpen: 10,
  tierPolicy: 'real_then_synthetic',
  sigmaMultiplier: 1,
  ...over,
});

function once(c: EntryCandidate[]): EntrySource {
  return { candidates: async () => c };
}
const cand = (over: Partial<EntryCandidate> = {}): EntryCandidate => ({
  instrumentId: 1,
  strike: 90,
  expiry: '2026-02-20',
  fillPrice: 1,
  delta: -0.2,
  iv: 0.3,
  contracts: 2,
  score: 50,
  tier: 'synthetic',
  ...over,
});

describe('runEngine', () => {
  const days = weekdays('2026-01-05', 60);

  it('takes profit at the next close, never on the bar that triggered it', async () => {
    // a calm tape far above the strike: the put decays, 50% captured long before 21 DTE
    const u = underlying(1, days, (i) => 100 + (i % 2) * 0.2);
    const r = await runEngine(baseCfg(days), [u], once([cand({ expiry: '2026-03-20', contracts: 2 })]));
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t?.exitReason).toBe('take_profit');
    expect(t?.entryDate).toBe(days[0]);
    expect((t?.daysHeld ?? 0) > 1).toBe(true);
    // credit 1.00 x 100 x 2 = 200; fees 2 + 2; buy back near zero
    expect(t?.pnl).toBeGreaterThan(150);
    expect(t?.pnl).toBeLessThan(200);
    // filled one bar after the first bar where the mark hit the target
    const fillIdx = days.indexOf(t?.exitDate as string);
    expect(fillIdx).toBeGreaterThan(1);
  });

  it('settles an in-the-money expiry as assigned at intrinsic, and an out-of-the-money one as expired', async () => {
    const crash = underlying(1, days, (i) => (i < 20 ? 100 : 80));
    const r1 = await runEngine(
      baseCfg(days, { dteExit: 0, takeProfitPct: 5, stopMultiple: 1000 }),
      [crash],
      once([cand({ strike: 95, expiry: '2026-02-20', fillPrice: 1.5, contracts: 1 })]),
    );
    const t = r1.trades[0];
    expect(t?.exitReason).toBe('assigned');
    expect(t?.exitDate >= '2026-02-20').toBe(true);
    // (1.5 - 15) x 100 - 2 fees
    expect(t?.pnl).toBeCloseTo((1.5 - 15) * 100 - 2, 6);
    expect(t?.exitUnderlying).toBe(80);

    const calm = underlying(1, days, () => 100);
    const r2 = await runEngine(
      baseCfg(days, { dteExit: 0, takeProfitPct: 5, stopMultiple: 1000 }),
      [calm],
      once([cand({ strike: 95, expiry: '2026-02-20', fillPrice: 1.5, contracts: 1 })]),
    );
    expect(r2.trades[0]?.exitReason).toBe('expired_otm');
    expect(r2.trades[0]?.pnl).toBeCloseTo(1.5 * 100 - 2, 6);
  });

  it('stops out when the loss reaches twice the credit, filled at the following close', async () => {
    // slide into the strike: the put mark explodes
    const slide = underlying(1, days, (i) => (i < 5 ? 100 : Math.max(60, 100 - (i - 4) * 2.5)));
    const r = await runEngine(
      baseCfg(days, { dteExit: 0 }),
      [slide],
      once([cand({ strike: 96, expiry: '2026-03-20', fillPrice: 1, contracts: 1 })]),
    );
    const t = r.trades[0];
    expect(t?.exitReason).toBe('stop_loss');
    expect((t?.exitDebit ?? 0) >= 3).toBe(true);
    expect((t?.pnl ?? 0) < 0).toBe(true);
    expect((t?.maxAdverseExcursion ?? 0) > 0).toBe(true);
  });

  it('is cash-secured: contracts are cut to what the free cash can carry at full notional', async () => {
    const u = underlying(1, days, () => 100);
    // 90 x 100 = 9,000 per contract; 20,000 of capital carries 2 of the 10 asked for
    const r = await runEngine(baseCfg(days, { initialCapital: 20_000 }), [u], once([cand({ contracts: 10 })]));
    expect(r.trades[0]?.contracts).toBe(2);
    const none = await runEngine(baseCfg(days, { initialCapital: 5_000 }), [u], once([cand({ contracts: 10 })]));
    expect(none.trades).toHaveLength(0);
    expect(none.skipped.no_cash).toBe(1);
  });

  it('never opens a second put on a name that already has one, and honours the tier policy', async () => {
    const u = underlying(1, days, () => 100);
    const r = await runEngine(baseCfg(days), [u], once([cand(), cand({ strike: 85 })]));
    expect(r.trades).toHaveLength(1);
    expect(r.skipped.already_open).toBe(1);
    const real = await runEngine(baseCfg(days, { tierPolicy: 'real_only' }), [u], once([cand()]));
    expect(real.trades).toHaveLength(0);
    expect(real.skipped.tier_policy).toBe(1);
  });

  it('shadow trades are tracked but never touch cash or equity', async () => {
    const u = underlying(1, days, (i) => 100 + (i % 2) * 0.2);
    const base = await runEngine(baseCfg(days), [u], once([]));
    const withShadow = await runEngine(
      baseCfg(days),
      [u],
      once([cand({ shadow: true, rules: { 'fundamental.fScore': false } })]),
    );
    expect(withShadow.trades).toHaveLength(1);
    expect(withShadow.trades[0]?.shadow).toBe(true);
    expect(withShadow.trades[0]?.scores).toMatchObject({ rules: { 'fundamental.fScore': false } });
    expect(withShadow.equity.map((e) => e.equity)).toEqual(base.equity.map((e) => e.equity));
  });

  it('final equity equals the starting capital plus the sum of trade P&L (no interest, USD only)', async () => {
    const u1 = underlying(1, days, (i) => 100 + Math.sin(i / 3) * 4);
    const u2 = underlying(2, days, (i) => 50 - i * 0.3);
    const r = await runEngine(
      baseCfg(days),
      [u1, u2],
      once([cand(), cand({ instrumentId: 2, strike: 48, fillPrice: 0.8, expiry: '2026-03-20' })]),
    );
    const total = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.equity[r.equity.length - 1]?.equity).toBeCloseTo(1_000_000 + total, 4);
    expect(r.trades.every((t) => t.exitDate > t.entryDate)).toBe(true);
  });

  it('closes what is still open at the end of the test', async () => {
    const short = weekdays('2026-01-05', 6);
    const u = underlying(1, short, () => 100);
    const r = await runEngine(baseCfg(short), [u], once([cand({ expiry: '2026-06-19', fillPrice: 4 })]));
    expect(r.trades[0]?.exitReason).toBe('end_of_test');
    expect(r.equity[r.equity.length - 1]?.deployedPct).toBe(0);
  });

  it('a higher sigma multiplier lowers the P&L of a synthetic short put (pricing sensitivity)', async () => {
    const u = underlying(1, days, (i) => 100 + Math.sin(i / 2) * 3);
    const c = cand({ strike: 95, expiry: '2026-03-20', iv: 0.25, fillPrice: 1.2, contracts: 1 });
    const lo = await runEngine(baseCfg(days, { sigmaMultiplier: 0.8 }), [u], once([c]));
    const hi = await runEngine(baseCfg(days, { sigmaMultiplier: 1.2 }), [u], once([c]));
    expect(lo.trades[0]?.entryCredit).toBeLessThan(hi.trades[0]?.entryCredit ?? 0);
  });
});

describe('naive source', () => {
  const days = weekdays('2025-06-02', 260);
  const walk = (seed: number) => {
    let x = 100;
    let s = seed;
    return (i: number) => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      x *= 1 + ((s / 4294967296 - 0.5) * 0.03 + 0.0003);
      return i === 0 ? 100 : x;
    };
  };
  const series = (seed: number): number[] => {
    const f = walk(seed);
    return days.map((_, i) => f(i));
  };

  it('proposes a 30-delta-ish put on every name and never looks at later bars', async () => {
    const p = series(7);
    const a = underlying(1, days, (i) => p[i] as number);
    const view = { day: days[100] as string, equity: 1_000_000, openPositions: [], fxToBase: () => 1 };
    const before = await createNaiveSource([a]).candidates(days[100] as string, view);
    expect(before.length).toBe(1);
    expect(before[0]?.strike).toBeLessThan((a.bars[100] as { close: number }).close);
    expect(Math.abs(before[0]?.delta ?? 0)).toBeGreaterThan(0.2);
    expect(Math.abs(before[0]?.delta ?? 0)).toBeLessThan(0.4);
    // wreck every bar after day 100: the proposal on day 100 must not move
    const b = underlying(1, days, (i) => (i <= 100 ? (p[i] as number) : 1));
    const after = await createNaiveSource([b]).candidates(days[100] as string, view);
    expect(after).toEqual(before);
  });

  it('runs 60 names over a year inside the loop budget', async () => {
    const us = Array.from({ length: 60 }, (_, k) => {
      const p = series(k + 1);
      return underlying(k + 1, days, (i) => p[i] as number);
    });
    const t0 = performance.now();
    const r = await runEngine(
      baseCfg(days, { scanEveryDays: 5, maxOpen: 60, initialCapital: 50_000_000 }),
      us,
      createNaiveSource(us),
    );
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect(r.trades.length).toBeGreaterThan(60);
    const total = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.equity[r.equity.length - 1]?.equity).toBeCloseTo(50_000_000 + total, 3);
  });
});
