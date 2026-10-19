import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScanView, WatchBoardView, WatchEntryView } from '../../src/server/api-types';
import { startApp, type TestApp, waitIngest } from '../helpers/app';
import { WATCHLIST, withDbs } from './harness';

/** A past session where both markets rank names and several FAIL with named rules (same date the CLI e2e uses). */
const REPLAY = '2026-09-04';
const { fresh, tmp } = withDbs();

function allNumbers(x: unknown, path = '$'): string[] {
  if (typeof x === 'number') return Number.isFinite(x) ? [] : [path];
  if (Array.isArray(x)) return x.flatMap((v, i) => allNumbers(v, `${path}[${i}]`));
  if (x && typeof x === 'object') return Object.entries(x).flatMap(([k, v]) => allNumbers(v, `${path}.${k}`));
  return [];
}

describe('app e2e 1: setup, watchlist, ingest and scan through the HTTP API', () => {
  let t: TestApp;
  let scan: ScanView;

  beforeAll(async () => {
    t = await startApp(await fresh(), { tmp: tmp() });
  });
  afterAll(async () => {
    await t.close();
  });

  it('answers /api/health and an overview of an empty database', async () => {
    const h = await t.get('/api/health');
    expect(h.status).toBe(200);
    expect(h.json.ok).toBe(true);
    expect(h.json.database.connected).toBe(true);
    const o = await t.get('/api/overview');
    expect(o.status).toBe(200);
    expect(o.json.equity).toBeNull();
    expect(o.json.watchlist.watching).toBe(0);
    expect(o.json.disclaimer).toMatch(/never places orders/);
  });

  it('refuses a scan until equity is set, with a stable error code', async () => {
    const r = await t.get('/api/scan');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('equity_not_set');
  });

  it('sets equity and rejects nonsense', async () => {
    expect((await t.put('/api/settings', { equity: -5 })).status).toBe(400);
    const r = await t.put('/api/settings', { equity: 20_000_000, baseCurrency: 'HKD' });
    expect(r.status).toBe(200);
    expect(r.json.equity).toBe(20_000_000);
    expect(r.json.params.name).toBe('default');
    expect(r.json.perNameCapPct).toBe(5);
    expect(JSON.stringify(r.json)).not.toMatch(/password|postgres:\/\//i);
  });

  it('previews symbols with the command-line rules and the HK board-lot file', async () => {
    const hk = (await t.get('/api/watchlist/preview?raw=700')).json;
    expect(hk).toMatchObject({
      ok: true,
      market: 'HK',
      symbol: '0700',
      boardLot: 100,
      lotSource: 'seed_file',
      yahooSymbol: '0700.HK',
    });
    expect(hk.name).toBe('Tencent');
    expect((await t.get('/api/watchlist/preview?raw=0005.HK')).json).toMatchObject({ symbol: '0005', boardLot: 400 });
    expect((await t.get('/api/watchlist/preview?raw=brk-b')).json).toMatchObject({
      market: 'US',
      symbol: 'BRK.B',
      boardLot: 100,
      lotSource: 'us_default',
    });
    expect((await t.get('/api/watchlist/preview?raw=9999')).json).toMatchObject({
      ok: true,
      boardLot: null,
      lotSource: 'missing',
    });
    const bad = (await t.get('/api/watchlist/preview?raw=AAPL.HK')).json;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid HK symbol/);
    expect((await t.get('/api/watchlist/preview?raw=12abc&market=US')).json.ok).toBe(false);
  });

  it('adds the ten names; validation errors are specific; duplicates conflict', async () => {
    for (const w of WATCHLIST) {
      const r = await t.post('/api/watchlist', {
        symbol: w.symbol,
        market: w.market,
        solvencyModel: w.solvency,
        conviction: 3,
      });
      expect(r.status, `${w.symbol}: ${r.text}`).toBe(201);
      expect(r.json.status.kind).toBe('pending_first_ingest');
      expect(r.json.solvencyInferred).toBe(false);
    }
    expect((await t.post('/api/watchlist', { symbol: 'AAPL' })).json.error.code).toBe('already_watching');
    expect((await t.post('/api/watchlist', { symbol: 'AAPL.HK', market: 'HK' })).json.error.code).toBe(
      'invalid_symbol',
    );
    expect((await t.post('/api/watchlist', { symbol: '9999', market: 'HK' })).json.error.code).toBe(
      'board_lot_required',
    );
    expect((await t.post('/api/watchlist', { symbol: 'KO', conviction: 9 })).json.error.code).toBe(
      'invalid_conviction',
    );
    expect((await t.post('/api/watchlist', { symbol: 'KO', maxCollateralPct: 150 })).json.error.code).toBe(
      'invalid_max_collateral',
    );
    expect((await t.post('/api/watchlist', { symbol: '' })).json.error.code).toBe('validation');
    const list = (await t.get('/api/watchlist')).json;
    expect(list).toHaveLength(10);
    const tencent = list.find((e: { symbol: string }) => e.symbol === '0700');
    expect(tencent).toMatchObject({ market: 'HK', boardLot: 100, reportingFrequency: 'semiannual', currency: 'HKD' });
    // a name outside the lot file, added with its lot, then paused so the ingest below skips it
    const extra = await t.post('/api/watchlist', { symbol: '9999', market: 'HK', boardLot: 500, notes: 'test name' });
    expect(extra.status).toBe(201);
    expect(extra.json.boardLot).toBe(500);
    expect((await t.patch('/api/watchlist/HK/9999', { active: false })).json.active).toBe(false);
  });

  it('ingests from the recorded fixtures, skipping paused names, one job at a time', async () => {
    const a = await t.post('/api/ingest', {});
    expect(a.status).toBe(202);
    const b = await t.post('/api/ingest', {});
    expect(b.status).toBe(409);
    expect(b.json.error.code).toBe('ingest_running');
    const done = await waitIngest(t, a.json.id);
    expect(done.json.status).toBe('done');
    expect(done.json.summary.failed, done.json.log.join('\n')).toBe(0);
    expect(done.json.summary.ok).toBeGreaterThan(20);
    expect(done.json.pausedSkipped).toEqual(['9999']);
    expect(done.json.log.join('\n')).toMatch(/skipped: 9999/);
    expect((await t.get('/api/ingest/not-a-job')).status).toBe(404);
  });

  it('scans a past session: ranked ideas per market, rejects with binding rules, finite numbers everywhere', async () => {
    const r = await t.get(`/api/scan?asOf=${REPLAY}`);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    scan = r.json;
    expect(scan.asOf).toBe(REPLAY);
    expect(scan.paramsLabel).toMatch(/^params default v3 \[[0-9a-f]{8}\]$/);
    expect(allNumbers(scan)).toEqual([]);
    expect(scan.ideas.length).toBeGreaterThanOrEqual(5);
    for (const m of ['US', 'HK'] as const) {
      const ranked = scan.ideas.filter((i) => i.market === m);
      expect(ranked.length, `${m} ideas`).toBeGreaterThanOrEqual(2);
      expect(ranked.map((i) => i.rank)).toEqual(ranked.map((_, i) => i + 1));
      const scores = ranked.map((i) => i.composite);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
    for (const i of scan.ideas) {
      expect(i.contract.collateral, `${i.symbol} collateral is strike x multiplier`).toBeCloseTo(
        i.contract.strike * i.contract.multiplier,
        2,
      );
      expect(i.contract.credit).toBeCloseTo(i.contract.premium * i.contract.multiplier, 2);
      expect(i.contract.annRocPct).toBeGreaterThan(0);
      expect(['real', 'proxy', 'synthetic']).toContain(i.tier);
      expect(i.reasons.length).toBeGreaterThan(5);
      expect(i.reasons.every((r) => r.group && r.skillId)).toBe(true);
      expect(i.skills.map((s) => s.skillId)).toContain('option.select');
      expect(i.narrative?.headline).toMatch(/^.+sell/i);
      if (i.market === 'HK') expect(i.contract.multiplier).not.toBe(1);
    }
    expect(scan.rejected.length).toBeGreaterThan(0);
    for (const j of scan.rejected) {
      expect(j.bindingRule, j.symbol).toBeTruthy();
      expect(j.detail.length).toBeGreaterThan(0);
    }
    expect(scan.savedRunId).toBeNull();
  });

  it('the live scan of the latest session answers too, and POST /api/scan/run stores a run', async () => {
    const live = await t.get('/api/scan?allowStale=1');
    expect(live.status).toBe(200);
    expect(live.json.asOf).toBe('2026-10-09');
    const saved = await t.post('/api/scan/run?allowStale=1');
    expect(saved.status).toBe(200);
    expect(saved.json.savedRunId).toMatch(/^[0-9a-f-]{36}$/);
    const o = (await t.get('/api/overview')).json;
    expect(o.lastScan.id).toBe(saved.json.savedRunId);
    expect(o.watchlist).toMatchObject({ watching: 10, paused: 1 });
    expect(Object.keys(o.regime).length).toBeGreaterThanOrEqual(1);
    expect(o.regime.US?.deployCapPct).toBeGreaterThan(0);
  });

  it('the watchlist board lists every watched name with price, KPIs, highlights and a recommendation', async () => {
    const r = await t.get('/api/watchlist/board');
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const board = r.json as WatchBoardView;
    expect(allNumbers(board)).toEqual([]);
    expect(board.scored).toBe(true);
    expect(board.rows).toHaveLength(10);
    expect(board.rows.map((x) => x.symbol)).not.toContain('9999');
    expect(board.rows.filter((x) => x.market === 'US')).toHaveLength(5);
    expect(board.rows.filter((x) => x.market === 'HK')).toHaveLength(5);
    const list = (await t.get('/api/watchlist')).json as WatchEntryView[];
    for (const row of board.rows) {
      const entry = list.find((e) => e.market === row.market && e.symbol === row.symbol) as WatchEntryView;
      expect(row.price, row.symbol).toBeGreaterThan(0);
      expect(row.closes.length, row.symbol).toBeGreaterThan(20);
      expect(row.closes.at(-1)).toBe(row.price);
      expect(row.highlights.length).toBeLessThanOrEqual(3);
      // a sentence a person can read: never empty, never a bare rule id such as "volatility.edge: ..."
      expect(row.action.reason, row.symbol).toMatch(/^[A-Z0-9]/);
      expect(row.action.reason, row.symbol).not.toMatch(/\b[a-z]+\.[a-zA-Z]+:/);
      // the recommendation is the scan's verdict, the same one the status chip on Today and the old list showed
      expect(row.action.kind === 'sell_put', row.symbol).toBe(entry.status.kind === 'idea');
      expect(row.action.kind === 'hold', row.symbol).toBe(entry.status.kind === 'open_put');
      if (row.action.kind === 'sell_put') {
        expect(row.put?.strike, row.symbol).toBeGreaterThan(0);
        expect(row.rank).toBeGreaterThan(0);
      } else {
        expect(row.put).toBeNull();
      }
    }
    // US names have statements in the fixtures: their KPIs and price-vs-IV are filled
    const us = board.rows.filter((x) => x.market === 'US');
    expect(us.some((x) => x.roePct !== null && x.fcfYieldPct !== null && x.pe !== null)).toBe(true);
    expect(us.some((x) => x.value !== null)).toBe(true);
    expect(us.some((x) => x.rsi14 !== null && x.trend !== null)).toBe(true);
    // sell ideas come first, ranked
    const kinds = board.rows.map((x) => x.action.kind);
    const lastSell = kinds.lastIndexOf('sell_put');
    expect(kinds.slice(0, lastSell + 1).every((k) => k === 'sell_put')).toBe(true);
  });

  it('a paused name leaves the board and comes back when it is resumed', async () => {
    const before = (await t.get('/api/watchlist/board')).json as WatchBoardView;
    const pick = before.rows[0] as WatchBoardView['rows'][number];
    await t.patch(`/api/watchlist/${pick.market}/${pick.symbol}`, { active: false });
    const during = (await t.get('/api/watchlist/board')).json as WatchBoardView;
    expect(during.rows.map((x) => x.symbol)).not.toContain(pick.symbol);
    expect(during.rows).toHaveLength(9);
    await t.patch(`/api/watchlist/${pick.market}/${pick.symbol}`, { active: true });
    const after = (await t.get('/api/watchlist/board')).json as WatchBoardView;
    expect(after.rows.map((x) => x.symbol)).toContain(pick.symbol);
    expect(after.rows).toHaveLength(10);
  });

  it('per-stock endpoints: explain, chart, value and KPIs for an idea', async () => {
    const idea = scan.ideas.find((i) => i.market === 'US') as ScanView['ideas'][number];
    const ex = (await t.get(`/api/stocks/US/${idea.symbol}/explain`)).json;
    expect(ex.skills.map((s: { skillId: string }) => s.skillId)).toEqual(
      expect.arrayContaining(['market.regime', 'fundamental.gate', 'technical.timing']),
    );
    expect(ex.reasons.length).toBeGreaterThan(5);
    expect(allNumbers(ex)).toEqual([]);

    const ch = (await t.get(`/api/stocks/US/${idea.symbol}/chart?bars=120`)).json;
    expect(ch.bars).toHaveLength(120);
    expect(ch.sma50).toHaveLength(120);
    expect(ch.sma200).toHaveLength(120);
    expect(ch.sma200[119]).not.toBeNull();
    expect(ch.last).toBeGreaterThan(0);

    const v = (await t.get(`/api/stocks/US/${idea.symbol}/value`)).json;
    expect(v.hasFundamentals).toBe(true);
    expect(v.kpis).toHaveLength(25);
    expect(v.screen.rows).toHaveLength(7);
    expect(['PASS', 'EXEMPT-PASS', 'EXCLUDED', 'INCOMPLETE']).toContain(v.screen.verdict);
    expect(v.intrinsic.assumptions.requiredReturnPct.value).toBe(8);
    expect(allNumbers(v)).toEqual([]);
    const v10 = (await t.get(`/api/stocks/US/${idea.symbol}/value?rate=10`)).json;
    if (v.intrinsic.base !== null && v10.intrinsic.base !== null)
      expect(v10.intrinsic.base).toBeLessThan(v.intrinsic.base);
    expect((await t.get(`/api/stocks/US/${idea.symbol}/value?rate=2`)).json.error.code).toBe('invalid_rate');
    expect((await t.get('/api/stocks/US/NOPE/explain')).status).toBe(404);
    expect((await t.get('/api/stocks/XX/AAPL/explain')).json.error.code).toBe('invalid_market');
  });

  it('pausing a name removes it from the scan and its status; resuming brings it back', async () => {
    const idea = scan.ideas[0] as ScanView['ideas'][number];
    const before = (await t.get(`/api/scan?asOf=${REPLAY}`)).json as ScanView;
    expect(before.ideas.some((i) => i.symbol === idea.symbol)).toBe(true);
    const paused = await t.patch(`/api/watchlist/${idea.market}/${idea.symbol}`, { active: false });
    expect(paused.json.status.kind).toBe('paused');
    const after = (await t.get(`/api/scan?asOf=${REPLAY}`)).json as ScanView;
    expect(after.ideas.some((i) => i.symbol === idea.symbol)).toBe(false);
    expect(after.rejected.some((i) => i.symbol === idea.symbol)).toBe(false);
    const back = await t.patch(`/api/watchlist/${idea.market}/${idea.symbol}`, { active: true });
    expect(back.json.active).toBe(true);
    const again = (await t.get(`/api/scan?asOf=${REPLAY}`)).json as ScanView;
    expect(again.ideas.map((i) => i.symbol)).toContain(idea.symbol);
  });

  it('editing a board lot invalidates cached results and changes the contract size', async () => {
    const hk = scan.ideas.find((i) => i.market === 'HK') as ScanView['ideas'][number];
    const lot = hk.contract.multiplier;
    const patched = await t.patch(`/api/watchlist/HK/${hk.symbol}`, { boardLot: lot * 2 });
    expect(patched.json.boardLot).toBe(lot * 2);
    expect(patched.json.solvencyInferred).toBe(false);
    const re = (await t.get(`/api/scan?asOf=${REPLAY}`)).json as ScanView;
    const same = re.ideas.find((i) => i.symbol === hk.symbol);
    if (same) expect(same.contract.multiplier).toBe(lot * 2);
    await t.patch(`/api/watchlist/HK/${hk.symbol}`, { boardLot: lot });
    expect((await t.patch('/api/watchlist/US/AAPL', { boardLot: 200 })).json.error.code).toBe('invalid_board_lot');
  });

  it('paste import previews, applies and never guesses a board lot', async () => {
    const preview = await t.post('/api/watchlist/paste', { text: 'KO, 3690\nAAPL 00001 12abc 4444', apply: false });
    const by = Object.fromEntries(preview.json.rows.map((r: { raw: string; result: string }) => [r.raw, r.result]));
    expect(by).toMatchObject({
      KO: 'new',
      '3690': 'new',
      AAPL: 'already_watching',
      '00001': 'new',
      '12abc': 'invalid',
      '4444': 'lot_unknown',
    });
    expect(preview.json.added).toBe(0);
    const applied = await t.post('/api/watchlist/paste', { text: 'KO, 3690\nAAPL 4444', apply: true });
    expect(applied.json).toMatchObject({ added: 2, skipped: 2 });
    const list = (await t.get('/api/watchlist')).json as { symbol: string; boardLot: number }[];
    // data/hk-board-lots.csv holds option contract sizes: Meituan's is 500
    expect(list.find((e) => e.symbol === '3690')?.boardLot).toBe(500);
    expect(list.some((e) => e.symbol === '4444')).toBe(false);
    const csv = await t.get('/api/watchlist/export.csv');
    expect(csv.text.split('\n')[0]).toBe(
      'symbol,market,watching,board_lot,solvency_model,reporting,conviction,max_collateral_pct,notes',
    );
    expect(csv.text).toMatch(/^0700,HK,yes,100,altman,semiannual,3,,""/m);
  });
});

describe('app e2e 1b: the API only answers the local user', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(await fresh(), { tmp: tmp() });
  });
  afterAll(async () => {
    await t.close();
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const r = await t.get('/api/health', { host: 'evil.example.com' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden_host');
  });

  it('rejects cross-origin requests and accepts same-origin ones', async () => {
    const bad = await t.get('/api/health', { origin: 'http://evil.example.com' });
    expect(bad.status).toBe(403);
    expect(bad.json.error.code).toBe('forbidden_origin');
    expect((await t.get('/api/health', { origin: 'http://127.0.0.1:4317' })).status).toBe(200);
    expect((await t.get('/api/health', { origin: 'null' })).status).toBe(403);
  });

  it('requires application/json on every write', async () => {
    const r = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: '127.0.0.1:4317', 'content-type': 'text/plain' },
      payload: '{"equity":1}',
    });
    expect(r.statusCode).toBe(415);
    const form = await t.app.inject({
      method: 'POST',
      url: '/api/watchlist',
      headers: { host: '127.0.0.1:4317', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'symbol=AAPL',
    });
    expect(form.statusCode).toBe(415);
    const broken = await t.app.inject({
      method: 'POST',
      url: '/api/watchlist',
      headers: { host: '127.0.0.1:4317', 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(broken.statusCode).toBe(400);
  });

  it('sets hardening headers and never caches the API', async () => {
    const r = await t.get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await t.get('/api/nope')).json.error.code).toBe('not_found');
  });
});

describe('app e2e 1c: the built UI is served next to the API', () => {
  let t: TestApp;
  let web: string;
  beforeAll(async () => {
    web = join(tmp(), 'web-dist');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(
      join(web, 'index.html'),
      '<!doctype html><title>Option Trading</title><script type="module" src="./assets/app.js"></script>',
    );
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    t = await startApp(await fresh(), { tmp: tmp(), webDir: web });
  });
  afterAll(async () => {
    await t.close();
  });

  it('serves index.html at / and assets, with a strict content security policy', async () => {
    const r = await t.get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>Option Trading</title>');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    const js = await t.get('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.text).toBe('console.log(1)');
    expect((await t.get('/no-such-file.txt')).status).toBe(404);
    expect((await t.get('/api/health')).json.ok).toBe(true);
  });

  it('serves assets built after the server started (a rebuild needs no restart)', async () => {
    writeFileSync(join(web, 'assets', 'app.rebuilt.js'), 'console.log(2)');
    const js = await t.get('/assets/app.rebuilt.js');
    expect(js.status).toBe(200);
    expect(js.text).toBe('console.log(2)');
    expect((await t.get('/api/still-no-such-endpoint')).json.error.code).toBe('not_found');
  });

  it('does not serve the UI to a foreign Host either', async () => {
    expect((await t.get('/', { host: 'evil.example.com' })).status).toBe(403);
  });
});
