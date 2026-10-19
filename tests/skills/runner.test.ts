import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params';
import type { OpenPosition } from '../../src/core/types';
import { type RunOptions, runPipeline } from '../../src/skills/runner';
import type { OptionSelectPayload } from '../../src/skills/s4-option-select';
import type { SizingPayload } from '../../src/skills/s6-size-position';
import { statement } from '../helpers/history';
import { buildWorld, memoryPorts, type NameSpec, type World } from '../helpers/world';

const opts = (w: World, over: Partial<RunOptions> = {}): RunOptions => ({
  asOf: w.asOf,
  params: defaultParams(),
  mode: 'scan',
  gate: 'enforce',
  allowStale: false,
  portfolio: w.portfolio,
  ...over,
});

const US_TWO: NameSpec[] = [
  {
    id: 1,
    market: 'US',
    symbol: 'AAA',
    sector: 'Technology',
    seed: 2,
    drift: 0.0006,
    chain: 'bs',
    chainSigma: 0.42,
    earnings: '2026-12-15',
  },
  {
    id: 2,
    market: 'US',
    symbol: 'BBB',
    sector: 'Technology',
    seed: 5,
    drift: 0.0006,
    chain: 'bs',
    chainSigma: 0.42,
    earnings: '2026-12-10',
  },
];

/** F-score <= 3: the fundamental gate FAILs. */
const sick = () => [
  statement('2024-12-31'),
  statement('2025-12-31', {
    netIncome: -50,
    cfo: -60,
    longTermDebt: 700,
    currentAssets: 500,
    currentLiabilities: 700,
    sharesDiluted: 140,
    grossProfit: 300,
    revenue: 900,
    totalAssets: 2100,
  }),
];

const byId = (r: Awaited<ReturnType<typeof runPipeline>>, sym: string) =>
  r.names.find((n) => n.instrument.symbol === sym);

describe('T4: scan vs full mode', () => {
  it('scan short-circuits a name whose fundamental gate FAILs; full runs S2-S4 so explain is complete', async () => {
    const w = buildWorld({ specs: US_TWO });
    (w.histories.get(1) as { statements: unknown }).statements = sick();
    const scan = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const a = byId(scan, 'AAA');
    expect(a?.status).toBe('failed');
    expect(a?.shortCircuited).toBe(true);
    expect(Object.keys(a?.results ?? {}).sort()).toEqual(['explain.narrative', 'fundamental.gate', 'market.regime']);
    expect(a?.binding).toMatchObject({ skillId: 'fundamental.gate', reason: { rule: 'fundamentals.fScore' } });

    const full = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { mode: 'full' }));
    const f = byId(full, 'AAA');
    expect(f?.shortCircuited).toBe(false);
    for (const id of ['technical.timing', 'volatility.edge', 'option.select', 'rank.composite', 'explain.narrative'])
      expect(f?.results[id], id).toBeDefined();
    expect(f?.results['rank.composite']?.verdict).toBe('FAIL');
    expect(f?.status).toBe('failed'); // still not ranked
    expect(full.shortlist.US.map((n) => n.instrument.symbol)).not.toContain('AAA');
  });

  it('a market regime crash guard also short-circuits in scan mode', async () => {
    const w = buildWorld({ specs: US_TWO.slice(0, 1) });
    const h = w.histories.get(1) as { volIndexBars: { close: number }[] };
    for (const b of h.volIndexBars) b.close = 55;
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.names[0]?.shortCircuited).toBe(true);
    expect(r.names[0]?.binding?.reason.rule).toBe('regime.crashGuard');
  });
});

describe('caching: params-hash keys, S5-S7 never cached (T9, T14)', () => {
  it('second run is all cache hits; only S0-S4 are ever stored; changed params recompute', async () => {
    const w = buildWorld({ specs: US_TWO });
    const m = memoryPorts(w.histories);
    const r1 = await runPipeline(m.ports, w.instruments, opts(w));
    expect(r1.stats.cacheHits).toBe(0);
    expect(r1.stats.computed).toBe(10); // 5 cacheable skills x 2 names
    const r2 = await runPipeline(m.ports, w.instruments, opts(w));
    expect(r2.stats.cacheHits).toBe(10);
    expect(r2.stats.computed).toBe(0);
    expect(JSON.stringify(r2.names.map((n) => n.composite))).toBe(JSON.stringify(r1.names.map((n) => n.composite)));
    const stored = new Set(m.puts.map((p) => p.skillId));
    expect([...stored].sort()).toEqual([
      'fundamental.gate',
      'market.regime',
      'option.select',
      'technical.timing',
      'volatility.edge',
    ]);
    for (const id of ['rank.composite', 'size.position', 'explain.narrative']) expect(stored.has(id)).toBe(false);

    const changed = defaultParams();
    changed['option.select'].deltaMax = 0.25;
    const r3 = await runPipeline(m.ports, w.instruments, opts(w, { params: changed }));
    expect(r3.stats.computed).toBe(10);
    expect(r3.paramsHash).not.toBe(r1.paramsHash);
  });

  it('T14: positions added between runs change the shortlist with every skill result still served from cache', async () => {
    const w = buildWorld({ specs: US_TWO });
    const m = memoryPorts(w.histories);
    const r1 = await runPipeline(m.ports, w.instruments, opts(w));
    expect(r1.shortlist.US.map((n) => n.instrument.symbol)).toContain('AAA');
    const open: OpenPosition = {
      instrumentId: 1,
      symbol: 'AAA',
      market: 'US',
      sector: 'Technology',
      currency: 'USD',
      strike: 50,
      multiplier: 100,
      quantity: 1,
      expiry: '2026-11-20',
    };
    const r2 = await runPipeline(
      m.ports,
      w.instruments,
      opts(w, { portfolio: { ...w.portfolio, openPositions: [open] } }),
    );
    expect(r2.stats.computed).toBe(0); // no ingest, no recompute of S0-S4
    expect(byId(r2, 'AAA')?.status).toBe('excluded');
    expect(r2.shortlist.US.map((n) => n.instrument.symbol)).not.toContain('AAA');
    // and the excluded name's scores are still there for explain
    expect(byId(r2, 'AAA')?.composite).not.toBeNull();
  });

  it("T9: each instrument's history is loaded exactly once per run", async () => {
    const w = buildWorld();
    const m = memoryPorts(w.histories);
    await runPipeline(m.ports, w.instruments, opts(w));
    expect([...m.loads.values()]).toEqual([1, 1, 1, 1]);
  });
});

describe('T3: freshness gate per source', () => {
  it('bars one session stale: the name is dropped with data.stale naming the input and its date; --allow-stale ranks it tagged STALE', async () => {
    const specs: NameSpec[] = [{ ...(US_TWO[0] as NameSpec), staleBy: 1 }, US_TWO[1] as NameSpec];
    const w = buildWorld({ specs });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const a = byId(r, 'AAA');
    expect(a?.status).toBe('dropped_stale');
    expect(a?.binding?.reason).toMatchObject({ rule: 'data.stale', level: 'FAIL' });
    expect(a?.binding?.reason.value).toMatch(/^bars 2026-10-08$/);
    expect(a?.stale).toEqual([{ input: 'bars', actual: '2026-10-08', required: '2026-10-09' }]);
    expect(a?.results).toEqual({});
    expect(byId(r, 'BBB')?.status).not.toBe('dropped_stale');

    const allowed = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { allowStale: true }));
    const a2 = byId(allowed, 'AAA');
    expect(a2?.staleTagged).toBe(true);
    expect(a2?.status).not.toBe('dropped_stale');
    expect(a2?.stale).toHaveLength(1);
  });

  it('explain (gate: report) analyses a stale name and only reports the finding', async () => {
    const w = buildWorld({ specs: [{ ...(US_TWO[0] as NameSpec), staleBy: 2 }] });
    const r = await runPipeline(
      memoryPorts(w.histories).ports,
      w.instruments,
      opts(w, { mode: 'full', gate: 'report' }),
    );
    expect(r.names[0]?.staleTagged).toBe(true);
    expect(r.names[0]?.results['option.select']).toBeDefined();
  });

  it('weekend asOf expects the previous Friday session, not the Saturday', async () => {
    const w = buildWorld({ asOf: '2026-10-10', specs: US_TWO.slice(0, 1) });
    // the world ends bars on trading days <= asOf, i.e. Friday 2026-10-09
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { asOf: '2026-10-10' }));
    expect(r.names[0]?.stale).toEqual([]);
  });

  it('a pasted CSV chain 2 days old passes; one older than chainMaxAgeDays is ignored (synthetic) and the HK name joins the paste block', async () => {
    const hk = (age: number): NameSpec => ({
      id: 3,
      market: 'HK',
      symbol: '0700',
      sector: 'Communication Services',
      seed: 3,
      drift: 0.0006,
      chain: 'csv',
      chainAgeDays: age,
      chainSigma: 0.4,
      earnings: '2026-12-20',
    });
    const w2 = buildWorld({ specs: [hk(2)] });
    const r2 = await runPipeline(memoryPorts(w2.histories).ports, w2.instruments, opts(w2));
    expect(r2.names[0]?.freshChain).toBe(true);
    expect(r2.names[0]?.stale).toEqual([]);
    expect((r2.names[0]?.results['option.select']?.payload as OptionSelectPayload | undefined)?.tier).toBe('real');
    expect(r2.pasteList).toEqual([]);

    const w5 = buildWorld({ specs: [hk(5)] });
    const r5 = await runPipeline(memoryPorts(w5.histories).ports, w5.instruments, opts(w5));
    expect(r5.names[0]?.stale).toEqual([]); // an old paste is not "stale": the name is simply priced synthetically
    expect(r5.names[0]?.freshChain).toBe(false);
    expect((r5.names[0]?.results['option.select']?.payload as OptionSelectPayload | undefined)?.tier).toBe('synthetic');
    expect(r5.pasteList.map((n) => n.instrument.symbol)).toEqual(['0700']);
  });

  it('an automated (Yahoo) chain from an earlier session is stale and drops the name naming the chain input', async () => {
    const w = buildWorld({ specs: [{ ...(US_TWO[0] as NameSpec), chainAgeDays: 1 }] });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.names[0]?.status).toBe('dropped_stale');
    expect(r.names[0]?.stale.map((s) => s.input)).toEqual(['chain']);
  });

  it('FX older than the last session drops US names in an HKD book but not HK names', async () => {
    const w = buildWorld();
    for (const h of w.histories.values())
      h.fx = { USDHKD: [{ day: '2026-10-05', rate: 7.8 }], CNYHKD: [{ day: '2026-10-05', rate: 1.17 }] };
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(byId(r, 'AAA')?.stale.map((s) => s.input)).toEqual(['fx']);
    expect(byId(r, 'AAA')?.status).toBe('dropped_stale');
    expect(byId(r, '0700')?.stale).toEqual([]);
  });

  it('the vol index is exempt when none exists (regime.noVolIndex): the name is analysed, not dropped', async () => {
    const w = buildWorld({
      specs: [
        {
          id: 3,
          market: 'HK',
          symbol: '0700',
          sector: 'Communication Services',
          seed: 3,
          volIndex: false,
          chain: 'csv',
          earnings: '2026-12-20',
        },
      ],
    });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.names[0]?.status).not.toBe('dropped_stale');
    expect(r.names[0]?.results['market.regime']?.reasons.some((x) => x.rule === 'regime.noVolIndex')).toBe(true);
  });

  it('a vol index that exists and is stale (but within the 5-day lag S0 tolerates) drops the name naming volIndex', async () => {
    const w = buildWorld({ specs: US_TWO.slice(0, 1) });
    const h = w.histories.get(1) as { volIndexBars: unknown[] };
    h.volIndexBars = h.volIndexBars.slice(0, -1);
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.names[0]?.stale.map((s) => s.input)).toEqual(['volIndex']);
  });
});

describe('ranking, caps and sizing across the shortlist', () => {
  it('two tables: names are ranked by composite within their own market', async () => {
    const w = buildWorld();
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    for (const market of ['US', 'HK'] as const) {
      const rows = r.shortlist[market];
      for (let i = 1; i < rows.length; i++)
        expect((rows[i - 1]?.composite as number) >= (rows[i]?.composite as number)).toBe(true);
      for (const [i, n] of rows.entries()) expect(n.rank).toBe(i + 1);
      for (const n of rows) expect(n.instrument.market).toBe(market);
    }
  });

  it('maxPerSector cuts the lower-ranked name with the reason; topN cuts the tail', async () => {
    const w = buildWorld({ specs: US_TWO });
    const p = defaultParams();
    p.runner.maxPerSector = 1;
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { params: p }));
    const statuses = r.names.map((n) => n.status).sort();
    expect(statuses).toEqual(['cut', 'ranked']);
    expect(r.names.find((n) => n.status === 'cut')?.cutReason).toContain('sector limit');
    const p2 = defaultParams();
    p2.runner.topN = 1;
    const r2 = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { params: p2 }));
    expect(r2.shortlist.US).toHaveLength(1);
    expect(r2.names.find((n) => n.status === 'cut')?.cutReason).toBe('below the top 1');
  });

  it("S6 runs down the ranking: names ranked earlier consume the market's deployment cap", async () => {
    const w = buildWorld({ specs: US_TWO, equity: 10_000_000 });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const [first, second] = r.shortlist.US;
    const z1 = first?.results['size.position']?.payload as SizingPayload;
    const z2 = second?.results['size.position']?.payload as SizingPayload;
    expect(z1.contracts).toBeGreaterThan(0);
    expect(z2.regimeRemainingBase).toBeCloseTo((z1.regimeRemainingBase as number) - z1.collateralBaseCcy, 2);
  });

  it('HK paste block: only HK names without a fresh chain, by composite, capped at pasteTopN', async () => {
    const specs: NameSpec[] = Array.from({ length: 4 }, (_, i) => ({
      id: 10 + i,
      market: 'HK' as const,
      symbol: `00${70 + i}`,
      sector: `S${i}`,
      seed: 30 + i,
      drift: 0.0006,
      chain: 'none' as const,
      earnings: '2026-12-20',
    }));
    const w = buildWorld({ specs });
    const p = defaultParams();
    p.runner.pasteTopN = 2;
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { params: p }));
    expect(r.pasteList).toHaveLength(2);
    expect((r.pasteList[0]?.composite as number) >= (r.pasteList[1]?.composite as number)).toBe(true);
  });
});

describe('robustness', () => {
  it('a skill that throws becomes a skill.error FAIL for that name; the scan continues and nothing is cached for it', async () => {
    const w = buildWorld({ specs: US_TWO });
    (w.histories.get(1) as { statements: unknown }).statements = [
      { periodEnd: '2025-12-31', periodType: 'annual', reportedAt: 12345 },
    ];
    const m = memoryPorts(w.histories);
    const r = await runPipeline(m.ports, w.instruments, opts(w));
    expect(byId(r, 'AAA')?.status).toBe('failed');
    expect(byId(r, 'AAA')?.binding?.reason.rule).toBe('skill.error');
    expect(byId(r, 'BBB')?.status).not.toBe('failed');
    expect(m.puts.filter((p) => p.instrumentId === 1 && p.skillId === 'fundamental.gate')).toHaveLength(0);
  });
});

describe('knownThrough: live scans know what ingest saw today', () => {
  const late = '2026-10-10T08:00:00.000Z'; // learned on Saturday, after the Friday as-of
  const lateEarnings = (): NameSpec[] => [{ ...(US_TWO[0] as NameSpec), earnings: null }];

  it('an event first seen after the as-of date is invisible to a replay but visible to a live scan', async () => {
    const w = buildWorld({ specs: lateEarnings() });
    (w.histories.get(1) as { events: unknown[] }).events = [
      { type: 'earnings', date: '2026-12-15', confirmed: true, source: 'yahoo', knownAt: late, details: null },
    ];
    const replay = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(
      (replay.names[0]?.results['fundamental.gate']?.payload as { nextEarnings?: string | null } | undefined)
        ?.nextEarnings,
    ).toBeNull();
    const live = await runPipeline(
      memoryPorts(w.histories).ports,
      w.instruments,
      opts(w, { knownThrough: '2026-10-10' }),
    );
    expect(
      (live.names[0]?.results['fundamental.gate']?.payload as { nextEarnings?: string | null } | undefined)
        ?.nextEarnings,
    ).toBe('2026-12-15');
  });

  it('the cache key separates them, so a live result never masquerades as a point-in-time one', async () => {
    const w = buildWorld({ specs: lateEarnings() });
    const m = memoryPorts(w.histories);
    const a = await runPipeline(m.ports, w.instruments, opts(w));
    const b = await runPipeline(m.ports, w.instruments, opts(w, { knownThrough: '2026-10-10' }));
    expect(a.paramsHash).not.toBe(b.paramsHash);
    expect(b.stats.cacheHits).toBe(0);
  });

  it('knownThrough earlier than the as-of date changes nothing (the as-of is always known)', async () => {
    const w = buildWorld({ specs: lateEarnings() });
    const a = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const b = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { knownThrough: '2026-01-01' }));
    expect(JSON.stringify(b.names.map((n) => n.results))).toBe(JSON.stringify(a.names.map((n) => n.results)));
  });
});

describe('T11 verify: an HK name with no chain and no vol index', () => {
  it('gets a null volatility score (iv.unscored) while the composite is still computed over the other skills', async () => {
    const hk: NameSpec = {
      id: 3,
      market: 'HK',
      symbol: '0700',
      sector: 'Communication Services',
      seed: 3,
      drift: 0.0006,
      volIndex: false,
      chain: 'none',
      earnings: '2026-12-20',
    };
    const w = buildWorld({ specs: [hk] });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w, { mode: 'full' }));
    const n = r.names[0];
    const vol = n?.results['volatility.edge'];
    expect(vol?.score).toBeNull();
    expect(vol?.verdict).toBe('NA');
    expect(vol?.reasons.map((x) => x.rule)).toEqual(expect.arrayContaining(['iv.rvOnly', 'iv.unscored']));
    const s5 = n?.results['rank.composite']?.payload as {
      composite: number | null;
      scores: { vol: number | null };
      weightsUsed: Record<string, number>;
    };
    expect(s5.scores.vol).toBeNull();
    expect(s5.composite).not.toBeNull();
    expect(Object.keys(s5.weightsUsed)).not.toContain('vol');
    expect(Object.values(s5.weightsUsed).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  });
});

describe('T3: the drawdown governor and the IV-floor gate in the pipeline', () => {
  const halted = (w: World) => {
    // one losing close booked on the as-of day, past a daily loss limit
    const ledger = {
      positions: [
        { positionId: 1, currency: 'HKD' as const, openDate: '2026-09-01', closeDate: w.asOf, realizedPnl: -60_000 },
      ],
      marks: [],
    };
    for (const h of w.histories.values()) h.ledger = ledger;
    w.portfolio.governor = { dailyLossLimit: 50_000, consecutiveLossHalt: null, degearTiers: [] };
  };

  it('with default settings every name is sized exactly as before and no governor reason appears', async () => {
    const w = buildWorld({ specs: US_TWO, equity: 10_000_000 });
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.shortlist.US).toHaveLength(2);
    for (const n of r.shortlist.US) {
      const z = n.results['size.position']?.payload as SizingPayload;
      expect(z.contracts).toBeGreaterThan(0);
      expect(z.governor).toMatchObject({ multiplier: 1, tier: null, halt: null });
      expect(n.results['size.position']?.reasons.map((x) => x.rule)).not.toContain('size.drawdownTier');
    }
  });

  it('a daily-loss halt makes every idea wait: the shortlist empties and each name carries size.dailyLossHalt', async () => {
    const w = buildWorld({ specs: US_TWO, equity: 10_000_000 });
    halted(w);
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    expect(r.shortlist.US).toHaveLength(0);
    for (const sym of ['AAA', 'BBB']) {
      const n = byId(r, sym);
      expect(n?.status).toBe('failed');
      expect(n?.rank).toBeNull();
      expect(n?.binding).toMatchObject({ skillId: 'size.position', reason: { rule: 'size.dailyLossHalt' } });
      expect((n?.results['size.position']?.payload as SizingPayload | undefined)?.contracts).toBe(0);
    }
  });

  it('a de-gear tier scales the contracts and is shown as size.drawdownTier', async () => {
    const w = buildWorld({ specs: US_TWO, equity: 10_000_000 });
    const plain = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const before =
      (plain.shortlist.US[0]?.results['size.position']?.payload as SizingPayload | undefined)?.contracts ?? 0;
    // a 12% drawdown: a 1,500,000 HKD loss closed last month against a 300,000 peak
    for (const h of w.histories.values())
      h.ledger = {
        positions: [
          { positionId: 1, currency: 'HKD', openDate: '2026-07-01', closeDate: '2026-08-01', realizedPnl: 300_000 },
          { positionId: 2, currency: 'HKD', openDate: '2026-08-01', closeDate: '2026-09-15', realizedPnl: -1_500_000 },
        ],
        marks: [],
      };
    w.portfolio.governor = {
      dailyLossLimit: null,
      consecutiveLossHalt: null,
      degearTiers: [{ drawdownPct: 10, multiplier: 0.5 }],
    };
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const z = r.shortlist.US[0]?.results['size.position']?.payload as SizingPayload;
    expect(z.governor).toMatchObject({ drawdownPct: 15, multiplier: 0.5, tier: { drawdownPct: 10, multiplier: 0.5 } });
    expect(z.sizeFactor).toBe(0.5);
    expect(z.contracts).toBe(Math.floor(before / 2));
    expect(
      r.shortlist.US[0]?.results['size.position']?.reasons.find((x) => x.rule === 'size.drawdownTier')?.level,
    ).toBe('WARN');
  });

  it('vol.ivFloorRamp is a WARN that the gate treats as a block: the name is "failed" with that binding reason', async () => {
    const w = buildWorld({ specs: US_TWO });
    const h = w.histories.get(1);
    if (!h) throw new Error('no history');
    // a year of stored IV far above the 42% chain: percentile 0; results 45 days out
    h.ivPoints = h.bars.slice(-300).map((b) => ({ day: b.day, iv30: 0.9, tier: 'real' as const, skew25d: null }));
    h.events = [
      {
        type: 'earnings',
        date: '2026-11-23',
        confirmed: true,
        source: 'manual',
        knownAt: '2026-08-01T00:00:00.000Z',
        details: null,
      },
    ];
    const r = await runPipeline(memoryPorts(w.histories).ports, w.instruments, opts(w));
    const a = byId(r, 'AAA');
    expect(a?.status).toBe('failed');
    expect(a?.binding).toMatchObject({
      skillId: 'volatility.edge',
      reason: { rule: 'vol.ivFloorRamp', level: 'WARN' },
    });
    expect(a?.results['volatility.edge']?.verdict).toBe('WARN');
    expect(r.shortlist.US.map((n) => n.instrument.symbol)).toEqual(['BBB']);
  });
});
