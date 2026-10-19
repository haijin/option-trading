import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRunStore, loadChainAsOf, loadPortfolio } from '../../src/db/history';
import { setSettings } from '../../src/db/repos';
import { writeBars, writeFxRates, writeOptionChain } from '../../src/db/writers';
import type { SkillResult } from '../../src/skills/contract';
import { bar, indexInstrument, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: { id: number };
let msft: { id: number };
let tencent: { id: number };

const bars = (n: number, start = 100) =>
  Array.from({ length: n }, (_, i) => bar(`2026-09-${String(i + 1).padStart(2, '0')}`, start + i));

beforeAll(async () => {
  db = await createTestDb();
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  msft = await seedInstrument(db.db, 'US', 'MSFT');
  tencent = await seedInstrument(db.db, 'HK', '0700', { boardLot: 100 });
  for (const i of [aapl, msft, tencent]) await writeBars(db.db, i.id, bars(25));
  for (const [m, s] of [
    ['US', 'SPY'],
    ['US', 'VIX'],
    ['HK', '2800'],
    ['HK', 'HSI'],
  ] as const) {
    await writeBars(db.db, (await indexInstrument(db.db, m, s)).id, bars(25, 400));
  }
});
afterAll(async () => {
  await db.drop();
});

describe('T9: one bars query per instrument per run', () => {
  it('each instrument and each index series is read from price_bars exactly once, however many skills ask', async () => {
    const store = createRunStore(db.db);
    const spy = vi.spyOn(db.pool, 'query');
    const calls = () =>
      spy.mock.calls.filter((c) => /from "price_bars"/.test(String((c[0] as { text?: string })?.text ?? c[0]))).length;

    await store.loadHistory(aapl.id);
    expect(calls()).toBe(3); // AAPL + SPY + VIX
    await store.loadHistory(msft.id);
    expect(calls()).toBe(4); // MSFT only: the US index series are shared across the run
    await store.loadHistory(aapl.id);
    await store.loadHistory(msft.id);
    expect(calls()).toBe(4); // repeats are served from memory
    await store.loadHistory(tencent.id);
    expect(calls()).toBe(8); // 0700 + the HK index series: 2800 tracker, HSI (the fresher one is used) and VHSI (empty, still one query)
    expect(store.barQueries()).toBe(8);
    spy.mockRestore();
  });

  it('the loaded history is complete and ascending', async () => {
    const h = await createRunStore(db.db).loadHistory(aapl.id);
    expect(h.bars).toHaveLength(25);
    expect(h.bars.map((b) => b.day)).toEqual([...h.bars.map((b) => b.day)].sort());
    expect(h.indexSymbol).toBe('SPY');
    expect(h.volIndexSymbol).toBe('VIX');
    expect(h.indexBars).toHaveLength(25);
  });
});

describe('chains versus journal fills', () => {
  it('a journal fill (bid = ask = price) is never returned as a chain; the latest real snapshot on or before asOf is', async () => {
    const q = (strike: number, bidv: number, askv: number) => ({
      expiry: '2026-10-16',
      strike,
      right: 'P' as const,
      bid: bidv,
      ask: askv,
      last: null,
      volume: null,
      openInterest: 10,
      iv: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      multiplier: 100,
    });
    await writeOptionChain(
      db.db,
      aapl.id,
      {
        snapshotDate: '2026-09-10',
        underlyingPrice: 120,
        source: 'csv',
        tier: 'real',
        quotes: [q(100, 1, 1.2), q(105, 2, 2.2)],
      },
      new Date('2026-09-10T20:00:00Z'),
    );
    await writeOptionChain(
      db.db,
      aapl.id,
      { snapshotDate: '2026-09-12', underlyingPrice: 121, source: 'journal', tier: 'real', quotes: [q(100, 1.5, 1.5)] },
      new Date('2026-09-12T20:00:00Z'),
    );
    const c = await loadChainAsOf(db.db, aapl.id, '2026-09-20');
    expect(c?.snapshotDate).toBe('2026-09-10');
    expect(c?.source).toBe('csv');
    expect(c?.quotes).toHaveLength(2);
    expect(await loadChainAsOf(db.db, aapl.id, '2026-09-09')).toBeNull();
  });

  it('a journal-tier quote never overwrites a real chain quote for the same contract and day', async () => {
    const q = {
      expiry: '2026-10-16',
      strike: 100,
      right: 'P' as const,
      bid: 9,
      ask: 9,
      last: null,
      volume: null,
      openInterest: null,
      iv: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      multiplier: 100,
    };
    await writeOptionChain(
      db.db,
      aapl.id,
      { snapshotDate: '2026-09-10', underlyingPrice: 120, source: 'journal', tier: 'real', quotes: [q] },
      new Date(),
    );
    const c = await loadChainAsOf(db.db, aapl.id, '2026-09-10');
    expect(c?.quotes.find((x) => x.strike === 100)?.bid).toBe(1);
  });
});

describe('skill-run cache and portfolio state', () => {
  const result: SkillResult = {
    skillId: 'technical.timing',
    version: '1.0.0',
    score: 61.25,
    verdict: 'WARN',
    reasons: [{ rule: 'trend.belowSma200', value: 'x', passed: false, level: 'WARN', kind: 'rule' }],
    payload: { support: 91.5, nested: { a: [1, 2] } },
    dataQuality: { tier: 'proxy', missing: ['sma200'] },
  };

  it('round-trips a result exactly, keyed by (instrument, asOf, skill, version, params hash)', async () => {
    const { ports } = createRunStore(db.db);
    await ports.cachePut(aapl.id, '2026-09-24', 'h1', result, 12);
    expect(await ports.cacheGet(aapl.id, '2026-09-24', 'technical.timing', '1.0.0', 'h1')).toEqual(result);
    expect(await ports.cacheGet(aapl.id, '2026-09-24', 'technical.timing', '1.0.0', 'h2')).toBeNull();
    expect(await ports.cacheGet(aapl.id, '2026-09-24', 'technical.timing', '1.0.1', 'h1')).toBeNull();
    expect(await ports.cacheGet(aapl.id, '2026-09-23', 'technical.timing', '1.0.0', 'h1')).toBeNull();
    await ports.cachePut(aapl.id, '2026-09-24', 'h1', { ...result, score: 1 }, 3); // duplicate key: the first row stands
    expect((await ports.cacheGet(aapl.id, '2026-09-24', 'technical.timing', '1.0.0', 'h1'))?.score).toBe(61.25);
  });

  it('loadPortfolio carries equity, base currency and FX to the base currency as of the date', async () => {
    await setSettings(db.db, { equity: 5_000_000, baseCurrency: 'HKD' });
    await writeFxRates(db.db, [
      { day: '2026-09-23', pair: 'USDHKD', rate: 7.79, source: 'yahoo' },
      { day: '2026-09-25', pair: 'USDHKD', rate: 7.81, source: 'yahoo' },
      { day: '2026-09-25', pair: 'CNYHKD', rate: 1.17, source: 'yahoo' },
    ]);
    const p = await loadPortfolio(db.db, '2026-09-24');
    expect(p.equity).toBe(5_000_000);
    expect(p.baseCurrency).toBe('HKD');
    expect(p.fxToBase('USD')).toBeCloseTo(7.79, 6); // the 25th is after the as-of date
    expect(p.fxToBase('HKD')).toBe(1);
    expect(p.openPositions).toEqual([]);
    expect(p.fxToBase('CNY' as never)).toBeNull(); // no CNY rate on or before the 24th
  });
});
