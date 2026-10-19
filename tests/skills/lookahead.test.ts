/**
 * T16: future-perturbation lookahead test (docs/05 section 3, docs/02 section 8).
 * Change EVERY data row dated after D and assert every skill result at D is byte-identical. Run against the full
 * pipeline (S0-S7) over US and HK names with chains, statements, events, IV history, FX, calibration and journal data,
 * and against a copy of the history truncated at D (the strongest form: results cannot depend on the future existing).
 */
import { describe, expect, it } from 'vitest';
import { addDays, type ISODate } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type { OptionChainSnapshot } from '../../src/core/types';
import type { InstrumentHistory } from '../../src/skills/data-access';
import { runPipeline } from '../../src/skills/runner';
import { bsChain, rng, statement } from '../helpers/history';
import { buildWorld, DEFAULT_NAMES, memoryPorts, type NameSpec } from '../helpers/world';

const D: ISODate = '2026-08-14'; // a Friday and a trading day in both markets
const FUTURE_BARS = 40;

const SPECS: NameSpec[] = DEFAULT_NAMES.map((s) => ({
  ...s,
  futureBars: FUTURE_BARS,
  earnings: s.earnings === null ? null : '2026-10-20',
}));

/** Adds data on both sides of D to every history (the world builder only creates the as-of chain and FX). */
function enrich(h: InstrumentHistory): void {
  const inst = h.instrument;
  const spot = h.bars.filter((b) => b.day <= D).at(-1)?.close ?? 100;
  const atD = bsChain({ spot, snapshotDate: D, sigma: 0.38, expiries: [], multiplier: inst.multiplier });
  void atD;
  // two future chain snapshots with very different surfaces
  const base = h.chainAsOf;
  const futureChains: OptionChainSnapshot[] = [
    bsChain({
      spot: spot * 0.5,
      snapshotDate: addDays(D, 3),
      sigma: 1.4,
      expiries: [addDays(D, 40)],
      multiplier: inst.multiplier,
    }),
    bsChain({
      spot: spot * 2,
      snapshotDate: addDays(D, 9),
      sigma: 0.05,
      expiries: [addDays(D, 40)],
      multiplier: inst.multiplier,
    }),
  ];
  h.chainAsOf = async (d) => {
    const real = await base(d);
    const fut = futureChains.filter((c) => c.snapshotDate <= d);
    return (
      [real, ...fut]
        .filter((c): c is OptionChainSnapshot => c !== null)
        .sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))[0] ?? null
    );
  };
  const r = rng(inst.id * 17);
  h.ivPoints = [
    ...Array.from({ length: 90 }, (_, i) => ({
      day: addDays(D, -(i + 1)),
      iv30: 0.25 + 0.2 * r(),
      tier: 'real' as const,
      skew25d: 0.005 + 0.02 * r(),
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      day: addDays(D, i + 1),
      iv30: 0.9,
      tier: 'real' as const,
      skew25d: 0.5,
    })),
  ];
  h.calibration = [
    ...Array.from({ length: 14 }, (_, i) => ({
      day: addDays(D, -(i + 1)),
      bucket: i % 2 ? '10-20' : '20-30',
      ratio: 0.8 + 0.1 * r(),
      ivRvRatio: 1.1 + 0.1 * r(),
      source: 'csv',
    })),
    ...Array.from({ length: 14 }, (_, i) => ({
      day: addDays(D, i + 1),
      bucket: i % 2 ? '10-20' : '20-30',
      ratio: 0.1,
      ivRvRatio: 5,
      source: 'csv',
    })),
  ];
  h.journal = [
    { openDate: addDays(D, -80), closeDate: addDays(D, -50), pnl: 200, collateral: 10_000 },
    { openDate: addDays(D, -40), closeDate: addDays(D, -10), pnl: -300, collateral: 10_000 },
    { openDate: addDays(D, -5), closeDate: addDays(D, 20), pnl: 5_000, collateral: 10_000 },
  ];
  h.statements = [
    ...h.statements,
    statement('2026-06-30', {
      periodType: 'semiannual',
      currency: inst.currency,
      reportedAt: `${addDays(D, 6)}T00:00:00.000Z`,
      revenue: 1,
      netIncome: -9999,
    }),
  ];
  h.events = [
    ...h.events,
    {
      type: 'rights_issue',
      date: addDays(D, 30),
      confirmed: true,
      source: 'manual',
      knownAt: `${addDays(D, 5)}T00:00:00.000Z`,
      details: null,
    },
    {
      type: 'earnings',
      date: addDays(D, 7),
      confirmed: true,
      source: 'manual',
      knownAt: `${addDays(D, 2)}T12:00:00.000Z`,
      details: null,
    },
  ];
  h.fx = {
    USDHKD: [...(h.fx.USDHKD ?? []), ...Array.from({ length: 10 }, (_, i) => ({ day: addDays(D, i + 1), rate: 99 }))],
    CNYHKD: [...(h.fx.CNYHKD ?? []), ...Array.from({ length: 10 }, (_, i) => ({ day: addDays(D, i + 1), rate: 0.01 }))],
  };
}

/** Everything on or before D, nothing after. */
function truncate(h: InstrumentHistory): InstrumentHistory {
  const base = h.chainAsOf;
  const eod = (d: string) => `${addDays(D, 1)}T00:00:00.000Z` > d;
  return {
    ...h,
    bars: h.bars.filter((b) => b.day <= D),
    indexBars: h.indexBars.filter((b) => b.day <= D),
    volIndexBars: h.volIndexBars.filter((b) => b.day <= D),
    statements: h.statements.filter((s) => eod(s.reportedAt)),
    events: h.events.filter((e) => eod(e.knownAt)),
    ivPoints: h.ivPoints.filter((p) => p.day <= D),
    chainAsOf: async (d) => base(d < D ? d : D),
    fx: Object.fromEntries(Object.entries(h.fx).map(([k, v]) => [k, (v ?? []).filter((p) => p.day <= D)])),
    calibration: h.calibration.filter((c) => c.day <= D),
    journal: h.journal.filter((j) => j.closeDate <= D),
  };
}

/** Scrambles every row dated after D (values, and extra rows), leaving everything on or before D untouched. */
function perturb(h: InstrumentHistory, seed: number): InstrumentHistory {
  const r = rng(seed);
  const wild = () => 0.2 + 4 * r();
  const scrambleBars = (bars: InstrumentHistory['bars']) =>
    bars.map((b) => {
      if (b.day <= D) return b;
      const f = wild();
      return {
        ...b,
        open: b.open * f,
        high: b.high * f * 1.5,
        low: b.low * f * 0.5,
        close: b.close * f,
        adjClose: b.close * f,
        volume: Math.round(b.volume * wild() * 10),
      };
    });
  const base = h.chainAsOf;
  return {
    ...h,
    bars: scrambleBars(h.bars),
    indexBars: scrambleBars(h.indexBars),
    volIndexBars: scrambleBars(h.volIndexBars),
    statements: h.statements.map((s) =>
      s.reportedAt.slice(0, 10) > D
        ? { ...s, revenue: (s.revenue ?? 1) * wild(), netIncome: -1e6 * r(), totalAssets: 1 }
        : s,
    ),
    events: h.events.map((e) =>
      e.knownAt.slice(0, 10) > D
        ? {
            ...e,
            date: addDays(D, 1 + Math.floor(r() * 60)),
            type: r() > 0.5 ? ('earnings' as const) : ('spin_off' as const),
          }
        : e,
    ),
    ivPoints: h.ivPoints.map((p) => (p.day > D ? { ...p, iv30: 0.01 + 3 * r(), skew25d: r() } : p)),
    chainAsOf: async (d) => {
      const c = await base(d);
      if (!c || c.snapshotDate <= D) return c;
      return {
        ...c,
        underlyingPrice: c.underlyingPrice * wild(),
        quotes: c.quotes.map((q) => ({ ...q, bid: (q.bid ?? 0) * wild(), iv: 0.02 + r() })),
      };
    },
    fx: Object.fromEntries(
      Object.entries(h.fx).map(([k, v]) => [k, (v ?? []).map((p) => (p.day > D ? { ...p, rate: 0.1 + 20 * r() } : p))]),
    ),
    calibration: h.calibration.map((c) => (c.day > D ? { ...c, ratio: 0.01 + 3 * r(), ivRvRatio: 0.1 + 9 * r() } : c)),
    journal: h.journal.map((j) => (j.closeDate > D ? { ...j, pnl: -1e6 * r() } : j)),
  };
}

async function results(
  world: ReturnType<typeof buildWorld>,
  histories: Map<number, InstrumentHistory>,
  mode: 'scan' | 'full',
) {
  const m = memoryPorts(histories);
  const rep = await runPipeline(m.ports, world.instruments, {
    asOf: D,
    params: defaultParams(),
    mode,
    gate: 'enforce',
    allowStale: false,
    portfolio: world.portfolio,
  });
  return JSON.stringify({
    hash: rep.paramsHash,
    names: rep.names.map((n) => ({
      s: n.instrument.symbol,
      status: n.status,
      rank: n.rank,
      composite: n.composite,
      stale: n.stale,
      binding: n.binding,
      results: n.results,
    })),
    shortlist: Object.fromEntries(
      Object.entries(rep.shortlist).map(([k, v]) => [k, v.map((n) => n.instrument.symbol)]),
    ),
    paste: rep.pasteList.map((n) => n.instrument.symbol),
  });
}

describe('T16: future-perturbation lookahead guard', () => {
  const world = buildWorld({ asOf: D, specs: SPECS });
  for (const h of world.histories.values()) enrich(h);

  it('the fixture really contains data after D for every kind of input', () => {
    for (const h of world.histories.values()) {
      expect(h.bars.some((b) => b.day > D)).toBe(true);
      expect(h.indexBars.some((b) => b.day > D)).toBe(true);
      expect(h.volIndexBars.some((b) => b.day > D)).toBe(true);
      expect(h.statements.some((s) => s.reportedAt.slice(0, 10) > D)).toBe(true);
      expect(h.events.some((e) => e.knownAt.slice(0, 10) > D)).toBe(true);
      expect(h.ivPoints.some((p) => p.day > D)).toBe(true);
      expect(h.calibration.some((c) => c.day > D)).toBe(true);
      expect(h.journal.some((j) => j.closeDate > D)).toBe(true);
    }
  });

  it('the as-of results are meaningful (names rank, sized, with narrative), so identity is not vacuous', async () => {
    const out = JSON.parse(await results(world, world.histories, 'full')) as {
      names: { status: string; results: Record<string, unknown> }[];
      shortlist: Record<string, string[]>;
    };
    expect(out.shortlist.US.length + out.shortlist.HK.length).toBeGreaterThan(0);
    expect(out.names.some((n) => Object.keys(n.results).length === 8)).toBe(true);
  });

  for (const mode of ['scan', 'full'] as const) {
    it(`${mode}: truncating every row after D changes no skill result (byte-identical)`, async () => {
      const full = await results(world, world.histories, mode);
      const cut = new Map([...world.histories].map(([id, h]) => [id, truncate(h)]));
      expect(await results(world, cut, mode)).toBe(full);
    });

    it.each([1, 2, 3, 4, 5])(
      `${mode}: perturbing every row after D (seed %i) changes no skill result (byte-identical)`,
      async (seed) => {
        const base = await results(world, world.histories, mode);
        const wildWorld = new Map([...world.histories].map(([id, h]) => [id, perturb(h, seed * 1000 + id)]));
        expect(await results(world, wildWorld, mode)).toBe(base);
      },
    );
  }

  it('control: perturbing data ON or BEFORE D does change results (the test can fail)', async () => {
    const base = await results(world, world.histories, 'full');
    const hit = new Map(
      [...world.histories].map(([id, h]) => [
        id,
        {
          ...h,
          bars: h.bars.map((b) =>
            b.day <= D && b.day > addDays(D, -30)
              ? {
                  ...b,
                  close: b.close * 0.7,
                  low: b.low * 0.7,
                  high: b.high * 0.7,
                  open: b.open * 0.7,
                  adjClose: b.close * 0.7,
                }
              : b,
          ),
        },
      ]),
    );
    expect(await results(world, hit, 'full')).not.toBe(base);
  });
});
