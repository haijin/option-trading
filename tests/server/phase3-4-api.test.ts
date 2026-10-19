import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EntryCandidate, EntrySource } from '../../src/backtest/engine';
import { entryCredit, syntheticPut } from '../../src/backtest/pricer';
import { runBacktest } from '../../src/backtest/run';
import { diffDays } from '../../src/core/dates';
import type { Instrument } from '../../src/core/types';
import { addToWatchlist, setSettings } from '../../src/db/repos';
import { writeBars } from '../../src/db/writers';
import { targetExpiries } from '../../src/skills/s4-option-select';
import { startApp, type TestApp } from '../helpers/app';
import { rng, tradingDaysEnding } from '../helpers/history';
import { bar, indexInstrument, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let tmp: string;
let t: TestApp;
let aapl: Instrument;
let closes: Map<string, number>;
let doneRun: string;

function scripted(instrumentId: number): EntrySource {
  return {
    async candidates(day, view) {
      if (view.openPositions.length > 0) return [];
      const spot = closes.get(day);
      const expiry = targetExpiries('US', day, 30, 45).at(-1);
      if (!spot || !expiry) return [];
      const strike = Math.round(spot * 0.94);
      const p = syntheticPut({ spot, strike, dte: diffDays(expiry, day), rate: 0.04 }, 0.28, 0.02);
      const c: EntryCandidate = {
        instrumentId,
        strike,
        expiry,
        fillPrice: entryCredit(p.mid, { slippage: 0.1, modelRisk: 0.05 }),
        delta: p.delta,
        iv: p.sigma,
        contracts: 1,
        score: 1,
        tier: 'synthetic',
      };
      return [c];
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'ot-p34-'));
  await setSettings(db.db, { baseCurrency: 'USD' });
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  await addToWatchlist(db.db, aapl.id);
  const days = tradingDaysEnding('US', '2026-03-13', 700);
  const r = rng(5);
  let x = 150;
  closes = new Map();
  await writeBars(
    db.db,
    aapl.id,
    days.map((d) => {
      x *= 1 + (r() - 0.48) * 0.025;
      closes.set(d, Math.round(x * 100) / 100);
      return bar(d, closes.get(d) as number);
    }),
  );
  const spy = await indexInstrument(db.db, 'US', 'SPY');
  await writeBars(
    db.db,
    spy.id,
    days.map((d, i) => bar(d, 400 + i * 0.2)),
  );
  t = await startApp(db, { tmp });
  doneRun = await runBacktest(
    db.db,
    {
      from: '2025-01-02',
      to: '2026-03-13',
      tierPolicy: 'synthetic_only',
      initialCapital: 500_000,
      name: 'api fixture',
    },
    { source: scripted(aapl.id) },
  );
});
afterAll(async () => {
  await t.close();
  await db.drop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('marks and the wheel over the API', () => {
  let putId: number;

  it('has no marks before the job runs, then marks open puts and shows P&L and alerts', async () => {
    const add = await t.post('/api/positions', {
      symbol: 'AAPL',
      market: 'US',
      strike: 150,
      expiry: '2026-04-17',
      contracts: 2,
      price: 4,
      date: '2026-03-02',
    });
    expect(add.status).toBe(201);
    putId = add.json.id;
    const before = await t.get('/api/positions');
    expect(before.json.marksAvailable).toBe(false);
    expect(before.json.open[0].mark).toBeNull();

    const run = await t.post('/api/positions/marks/run', { asOf: '2026-03-13' });
    expect(run.status).toBe(200);
    expect(run.json.marked).toBe(1);

    const after = await t.get('/api/positions');
    expect(after.json.marksAvailable).toBe(true);
    const p = after.json.open[0];
    expect(p.mark.tier).toBe('synthetic');
    expect(typeof p.mark.unrealizedPnl).toBe('number');
    expect(p.mark.day).toBe('2026-03-13');
  });

  it('rejects a malformed asOf', async () => {
    expect((await t.post('/api/positions/marks/run', { asOf: 'tomorrow' })).status).toBe(400);
  });

  it('an assigned put leaves a lot that can be sold once', async () => {
    const closed = await t.post(`/api/positions/${putId}/close`, {
      kind: 'assigned',
      underlyingClose: 140,
      date: '2026-04-17',
    });
    expect(closed.status).toBe(200);
    const lots = await t.get('/api/lots?status=open');
    expect(lots.json).toHaveLength(1);
    const lot = lots.json[0];
    expect(lot).toMatchObject({ symbol: 'AAPL', shares: 200, costBasis: 140, status: 'open' });
    expect(lot.effectiveCost).toBeCloseTo(146, 6); // strike 150 less the 4.00 premium
    const view = await t.get('/api/positions');
    expect(view.json.lots).toHaveLength(1);

    const sold = await t.post(`/api/lots/${lot.id}/sell`, { price: 150, date: '2026-05-01', fees: 3 });
    expect(sold.status).toBe(200);
    expect(sold.json.realizedPnl).toBeCloseTo((150 - 140) * 200 - 3, 6);
    expect((await t.post(`/api/lots/${lot.id}/sell`, { price: 150 })).status).toBe(400);
    expect((await t.get('/api/lots?status=nonsense')).status).toBe(400);
  });
});

describe('backtests over the API', () => {
  it('lists and shows a finished run with metrics, curve and caveats', async () => {
    const list = await t.get('/api/backtests');
    expect(list.status).toBe(200);
    expect(list.json.some((r: { id: string }) => r.id === doneRun)).toBe(true);
    const d = await t.get(`/api/backtests/${doneRun}`);
    expect(d.status).toBe(200);
    expect(d.json.status).toBe('done');
    expect(d.json.metrics.trades.n).toBeGreaterThan(3);
    expect(d.json.metrics.caveats.length).toBeGreaterThan(0);
    expect(d.json.equityCurve.length).toBeGreaterThan(100);
    expect(d.json.headline.trades).toBe(d.json.metrics.trades.n);
  });

  it('returns trades as JSON and as a safe CSV', async () => {
    const trades = await t.get(`/api/backtests/${doneRun}/trades`);
    expect(trades.json.length).toBeGreaterThan(3);
    expect(trades.json[0]).toMatchObject({ symbol: 'AAPL', tier: 'synthetic', shadow: false });
    const csv = await t.get(`/api/backtests/${doneRun}/trades.csv`);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toContain('symbol,market,entryDate');
    expect(lines).toHaveLength(trades.json.length + 1);
  });

  it('404s an unknown or malformed id', async () => {
    expect((await t.get('/api/backtests/not-a-uuid')).status).toBe(404);
    expect((await t.get('/api/backtests/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('starts a run in the background, reports it, and finishes', async () => {
    const start = await t.post('/api/backtests', {
      from: '2025-06-02',
      to: '2026-03-13',
      tierPolicy: 'synthetic_only',
      initialCapital: 300_000,
      benchmarks: false,
      sensitivity: false,
    });
    expect(start.status).toBe(202);
    expect(['queued', 'running', 'done']).toContain(start.json.status);
    await t.app.services.backtests.idle();
    const done = await t.get(`/api/backtests/${start.json.id}`);
    expect(done.json.status).toBe('done');
    expect(done.json.request.symbols).toEqual([{ market: 'US', symbol: 'AAPL' }]);
  }, 120_000);

  it('rejects bad requests with a clear message', async () => {
    const bad = (body: unknown) => t.post('/api/backtests', body);
    expect((await bad({ from: '2025-01-01', to: '2025-06-01' })).status).toBe(400); // no tierPolicy
    expect(
      (await bad({ from: '2008-01-02', to: '2012-01-02', tierPolicy: 'synthetic_only' })).json.error.message,
    ).toMatch(/calendar/);
    expect(
      (await bad({ from: '2025-01-02', to: '2025-06-02', tierPolicy: 'synthetic_only', surprise: 1 })).status,
    ).toBe(400);
    expect(
      (
        await bad({
          from: '2025-01-02',
          to: '2025-06-02',
          tierPolicy: 'synthetic_only',
          paramsOverride: { 'option.select': { deltaMax: 'high' } },
        })
      ).json.error.message,
    ).toMatch(/paramsOverride/);
  });

  it('cancelling a finished run changes nothing', async () => {
    const r = await t.post(`/api/backtests/${doneRun}/cancel`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('done');
  });

  it('serves event studies for a stock with bars', async () => {
    const r = await t.get('/api/stocks/US/AAPL/studies');
    expect(r.status).toBe(200);
    expect(r.json.bars).toBeGreaterThan(300);
    expect(r.json.rules.length).toBeGreaterThanOrEqual(5);
    expect(r.json.rules[0].byHorizon).toHaveLength(2);
    expect((await t.get('/api/stocks/US/NOPE/studies')).status).toBe(400);
  });
});

describe('the login gate covers the new routes', () => {
  it('answers 401 without a session', async () => {
    const guarded = await startApp(db, { tmp, auth: {} });
    try {
      for (const [method, url] of [
        ['get', '/api/backtests'],
        ['get', `/api/backtests/${doneRun}`],
        ['get', `/api/backtests/${doneRun}/trades.csv`],
        ['post', '/api/backtests'],
        ['post', '/api/positions/marks/run'],
        ['get', '/api/lots'],
        ['get', '/api/stocks/US/AAPL/studies'],
        ['get', '/%61pi/backtests'],
      ] as const) {
        const r = method === 'get' ? await guarded.get(url) : await guarded.post(url, {});
        expect(r.status, `${method} ${url}`).toBe(401);
      }
    } finally {
      await guarded.close();
    }
  });
});

describe('settings: the drawdown governor (T3)', () => {
  it('is off by default, round-trips through PUT /api/settings and clears with nulls', async () => {
    const before = (await t.get('/api/settings')).json;
    expect(before.governor).toEqual({ dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: [] });
    const set = await t.put('/api/settings', {
      governor: {
        dailyLossLimit: 25_000,
        consecutiveLossHalt: 3,
        degearTiers: [
          { drawdownPct: 10, multiplier: 0.5 },
          { drawdownPct: 5, multiplier: 0.75 },
        ],
      },
    });
    expect(set.status).toBe(200);
    // tiers come back shallowest first
    expect(set.json.governor).toEqual({
      dailyLossLimit: 25_000,
      consecutiveLossHalt: 3,
      degearTiers: [
        { drawdownPct: 5, multiplier: 0.75 },
        { drawdownPct: 10, multiplier: 0.5 },
      ],
    });
    // a patch of one field leaves the others
    const partial = await t.put('/api/settings', { governor: { consecutiveLossHalt: null } });
    expect(partial.json.governor).toMatchObject({ dailyLossLimit: 25_000, consecutiveLossHalt: null });
    expect(partial.json.governor.degearTiers).toHaveLength(2);
    const cleared = await t.put('/api/settings', { governor: { dailyLossLimit: null, degearTiers: [] } });
    expect(cleared.json.governor).toEqual({ dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: [] });
  });

  it('rejects a non-positive limit, a fractional halt count and a tier outside its range', async () => {
    expect((await t.put('/api/settings', { governor: { dailyLossLimit: 0 } })).status).toBe(400);
    expect((await t.put('/api/settings', { governor: { consecutiveLossHalt: 1.5 } })).status).toBe(400);
    expect(
      (await t.put('/api/settings', { governor: { degearTiers: [{ drawdownPct: 10, multiplier: 2 }] } })).status,
    ).toBe(400);
    expect(
      (await t.put('/api/settings', { governor: { degearTiers: [{ drawdownPct: 0, multiplier: 0.5 }] } })).status,
    ).toBe(400);
  });
});
