import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScanView, ValueView } from '../../src/server/api-types';
import { startApp, type TestApp } from '../helpers/app';
import { bootstrap, withDbs } from './harness';

const LIVE = '2026-10-09';
const { fresh, tmp } = withDbs();

describe('app e2e 2: positions, journal, chains, events, fair values and data status', () => {
  let t: TestApp;

  beforeAll(async () => {
    const db = await fresh();
    await bootstrap(db);
    t = await startApp(db, { tmp: tmp() });
  });
  afterAll(async () => {
    await t.close();
  });

  it('starts with no positions and says marks are not available', async () => {
    const r = (await t.get('/api/positions')).json;
    expect(r.open).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.marksAvailable).toBe(false);
    expect(r.journal).toMatchObject({ trades: 0, winRatePct: null });
  });

  it('records a put by hand: validates, then excludes the name from new ideas and counts the collateral', async () => {
    const before = (await t.get('/api/scan?allowStale=1')).json as ScanView;
    const hadAapl = before.ideas.some((i) => i.symbol === 'AAPL');
    const bad = await t.post('/api/positions', {
      symbol: 'AAPL',
      strike: 200,
      expiry: '2026-11-21',
      contracts: 2,
      price: 3.5,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/not an option expiry day/);
    expect(
      (await t.post('/api/positions', { symbol: 'AAPL', strike: -1, expiry: '2026-11-20', contracts: 2, price: 3.5 }))
        .json.error.code,
    ).toBe('validation');
    expect(
      (await t.post('/api/positions', { symbol: 'ZZZZ', strike: 10, expiry: '2026-11-20', contracts: 1, price: 1 }))
        .json.error.code,
    ).toBe('unknown_stock');
    const ok = await t.post('/api/positions', {
      symbol: 'AAPL',
      strike: 200,
      expiry: '2026-11-20',
      contracts: 2,
      price: 3.5,
      date: LIVE,
      fees: 3,
      spot: 255,
    });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json).toMatchObject({
      symbol: 'AAPL',
      market: 'US',
      status: 'open',
      quantity: 2,
      multiplier: 100,
      credit: 700,
      collateral: 40_000,
      dte: 41,
      watching: true,
    });
    expect(ok.json.collateralBase).toBeGreaterThan(40_000 * 7);

    const after = (await t.get('/api/scan?allowStale=1')).json as ScanView;
    expect(after.ideas.some((i) => i.symbol === 'AAPL')).toBe(false);
    if (hadAapl || after.openNames.length > 0) expect(after.openNames.map((o) => o.symbol)).toContain('AAPL');
    expect(after.openNames.find((o) => o.symbol === 'AAPL')?.contracts).toBe(2);

    const pos = (await t.get('/api/positions')).json;
    expect(pos.open).toHaveLength(1);
    expect(pos.open[0].spot).toBeGreaterThan(0);
    expect(pos.deployed.US.amountBase).toBeGreaterThan(0);
    expect(pos.deployed.US.pctOfEquity).toBeGreaterThan(0);
    const o = (await t.get('/api/overview')).json;
    expect(o.deployed.US.amountBase).toBeCloseTo(pos.deployed.US.amountBase, 2);
  });

  it('closes it three ways with exact P&L, and refuses a second close', async () => {
    const id = (await t.get('/api/positions')).json.open[0].id;
    const closed = await t.post(`/api/positions/${id}/close`, { kind: 'bought_back', price: 1, fees: 3, date: LIVE });
    expect(closed.status).toBe(200);
    expect(closed.json).toMatchObject({ status: 'closed', closePrice: 1 });
    // (3.5 - 1.0) x 100 x 2 = 500, minus 3 open fees and 3 close fees
    expect(closed.json.realizedPnl).toBeCloseTo(494, 2);
    expect((await t.post(`/api/positions/${id}/close`, { kind: 'expired' })).json.error.message).toMatch(
      /already closed/,
    );
    expect((await t.post('/api/positions/99999/close', { kind: 'expired' })).status).toBe(404);
    expect((await t.post(`/api/positions/${id}/close`, { kind: 'bought_back' })).status).toBe(400);

    const mk = async (strike: number): Promise<number> => {
      const r = await t.post('/api/positions', {
        symbol: 'MSFT',
        strike,
        expiry: '2026-11-20',
        contracts: 1,
        price: 4,
        date: LIVE,
      });
      expect(r.status, r.text).toBe(201);
      return r.json.id;
    };
    const expired = await t.post(`/api/positions/${await mk(400)}/close`, { kind: 'expired' });
    expect(expired.json).toMatchObject({ status: 'expired', realizedPnl: 400 });
    const assigned = await t.post(`/api/positions/${await mk(400)}/close`, { kind: 'assigned', underlyingClose: 390 });
    // credit 4 less intrinsic loss 10 = -6 per share x 100
    expect(assigned.json).toMatchObject({ status: 'assigned', realizedPnl: -600 });

    const pos = (await t.get('/api/positions')).json;
    expect(pos.open).toEqual([]);
    expect(pos.closed).toHaveLength(3);
    expect(pos.journal).toMatchObject({ trades: 3, wins: 2 });
    expect(pos.journal.realised.USD).toBeCloseTo(494 + 400 - 600, 2);
    const scan = (await t.get('/api/scan?allowStale=1')).json as ScanView;
    expect(scan.openNames).toEqual([]);
  });

  it('imports a journal CSV, idempotently, and rejects a bad file with line numbers', async () => {
    const csv = readFileSync('tests/fixtures/e2e/journal.csv', 'utf8');
    const first = await t.post('/api/journal/import', { csv });
    expect(first.status).toBe(200);
    expect(first.json.ok, JSON.stringify(first.json.errors)).toBe(true);
    expect(first.json.imported).toBeGreaterThan(0);
    expect(first.json.totals.join('\n')).toMatch(/HK|US/);
    const again = (await t.post('/api/journal/import', { csv })).json;
    expect(again.imported).toBe(0);
    expect(again.skippedExisting).toBe(first.json.imported);
    const bad = (await t.post('/api/journal/import', { csv: 'open_date,symbol\n2026-01-01,AAPL' })).json;
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    const pos = (await t.get('/api/positions')).json;
    expect(pos.journal.trades).toBeGreaterThan(3);
  });

  it('pastes an HK chain: rejects a crossed quote with its line, stores a good one and prices from it', async () => {
    const crossed = readFileSync('tests/fixtures/chains/hk-crossed.csv', 'utf8');
    const bad = (
      await t.post('/api/chains/import', { symbol: '0700', market: 'HK', csv: crossed, spot: 420, date: LIVE })
    ).json;
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/line 12: chain\.crossed bid 5\.06 > ask 4\.86/);
    expect(
      (await t.post('/api/chains/import', { symbol: '0700', market: 'HK', csv: crossed, spot: -1, date: LIVE })).json
        .error.code,
    ).toBe('validation');
    const good = readFileSync('tests/fixtures/chains/hk-valid.csv', 'utf8');
    const ok = await t.post('/api/chains/import', { symbol: '0700', market: 'HK', csv: good, spot: 420, date: LIVE });
    expect(ok.json.ok, JSON.stringify(ok.json.errors)).toBe(true);
    expect(ok.json.stored).toBeGreaterThan(5);
    expect(ok.json.expiries.length).toBeGreaterThan(0);
    const scan = (await t.get('/api/scan?allowStale=1')).json as ScanView;
    const hk = scan.ideas.find((i) => i.symbol === '0700');
    if (hk) expect(hk.contract.priceSource).toBe('csv');
    expect(scan.pasteChainsFor.map((p) => p.symbol)).not.toContain('0700');
  });

  it('records a results date and shows it as the next earnings', async () => {
    expect((await t.post('/api/events', { symbol: 'MSFT', type: 'earnings', date: '2026-10-20' })).json.ok).toBe(true);
    expect(
      (await t.post('/api/events', { symbol: 'MSFT', type: 'nonsense', date: '2026-10-20' })).json.error.code,
    ).toBe('validation');
    expect((await t.post('/api/events', { symbol: 'MSFT', type: 'earnings', date: '3 Nov' })).json.error.code).toBe(
      'validation',
    );
    const w = (await t.get('/api/watchlist')).json as {
      symbol: string;
      nextEarnings: { date: string; confirmed: boolean; source: string } | null;
    }[];
    expect(w.find((e) => e.symbol === 'MSFT')?.nextEarnings).toMatchObject({
      date: '2026-10-20',
      confirmed: true,
      source: 'manual',
    });
  });

  it('imports fair values for watched US names only and uses them in the intrinsic value', async () => {
    const csv =
      'rank,ticker,name,close_price,fair_value,upside_pct,star_rating,moat,uncertainty\n1,MSFT,Microsoft,430,520,20.9,3,Wide,Medium\n2,KSS,Kohl,11.7,41,250,,None,\n3,AAPL,Apple,255,300,17,3,Wide,Medium\n';
    const r = (await t.post('/api/fair-values/import', { csv, asOf: LIVE })).json;
    expect(r).toMatchObject({ matched: 2, unmatched: ['KSS'], asOf: LIVE });
    expect((await t.post('/api/fair-values/import', { csv: 'a,b\n1,2' })).json.error.code).toBe('invalid_csv');
    const v = (await t.get('/api/stocks/US/MSFT/value')).json as ValueView;
    expect(v.fairValue).toMatchObject({ value: 520, moat: 'Wide', uncertainty: 'Medium', source: 'morningstar_csv' });
    expect(v.intrinsic?.methods.map((m) => m.id)).toContain('fair_value');
  });

  it('stores per-stock valuation overrides, marks them as overrides, and clears them', async () => {
    const base = (await t.get('/api/stocks/US/MSFT/value')).json as ValueView;
    const set = await t.put('/api/stocks/US/MSFT/valuation', {
      growthPct: [14, 9, 3],
      targetPe: [30, 24, 18],
      requiredReturnPct: 9,
    });
    expect(set.status, set.text).toBe(200);
    const v = set.json as ValueView;
    expect(v.overrides).toEqual({ growthPct: [14, 9, 3], targetPe: [30, 24, 18], requiredReturnPct: 9 });
    expect(v.intrinsic?.assumptions.growthPct.map((g) => g.source)).toEqual(['override', 'override', 'override']);
    expect(v.intrinsic?.requiredReturnPct).toBe(9);
    expect(v.intrinsic?.scenarios.find((s) => s.name === 'Base')?.growthPct).toBe(9);
    expect((await t.put('/api/stocks/US/MSFT/valuation', { growthPct: [1, 2] })).json.error.code).toBe('validation');
    expect((await t.put('/api/stocks/US/MSFT/valuation', { growthPct: [100, 2, 3] })).json.error.code).toBe(
      'invalid_overrides',
    );
    const cleared = (await t.put('/api/stocks/US/MSFT/valuation', null)).json as ValueView;
    expect(cleared.overrides).toBeNull();
    expect(cleared.intrinsic?.base).toBeCloseTo(base.intrinsic?.base ?? 0, 6);
  });

  it('reports per-stock data status, providers and files', async () => {
    const d = (await t.get('/api/data/status')).json;
    expect(d.names).toHaveLength(10);
    const aapl = d.names.find((n: { symbol: string }) => n.symbol === 'AAPL');
    expect(aapl.lastBar).toBe(LIVE);
    expect(aapl.fundamentals.annual).toBeGreaterThanOrEqual(2);
    expect(d.providers.map((p: { id: string }) => p.id)).toEqual(['yahoo', 'stooq', 'opend', 'vhsi']);
    expect(d.files.boardLots.rows).toBeGreaterThan(30);
    const hk = d.names.find((n: { symbol: string }) => n.symbol === '0700');
    expect(hk.chain).toMatchObject({ source: 'csv', date: LIVE });
  });

  it('settings view exposes the environment checks, never the database password', async () => {
    const s = (await t.get('/api/settings')).json;
    expect(s.skills).toMatchObject({ executor: 'fake', rootFound: true });
    expect(s.database.name).toMatch(/^ot_t_/);
    expect(JSON.stringify(s)).not.toMatch(/postgres:\/\/|password/i);
  });
});
