import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextTradingDay } from '../../src/core/calendar';
import type { DailyBar } from '../../src/core/types';
import { listCandidates } from '../../src/db/leaders';
import { listWatchlist } from '../../src/db/repos';
import { writeBars, writeFundamentals, writeOptionChain } from '../../src/db/writers';
import { runLeadersScan } from '../../src/jobs/leaders-scan';
import { startApp, type TestApp } from '../helpers/app';
import { bsChain, END, statement } from '../helpers/history';
import { type LeadersWorld, seedLeadersWorld } from '../helpers/leaders-world';
import { createTestDb, type TestDb } from '../helpers/test-db';

const NOW = new Date('2026-10-10T00:00:00Z');
let db: TestDb;
let tmp: string;
let t: TestApp;
let world: LeadersWorld;

const scanDeps = () => ({ db: db.db, now: () => NOW, log: () => {} });

beforeAll(async () => {
  db = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'ot-leaders-'));
  world = await seedLeadersWorld(db.db);
  t = await startApp(db, { tmp, now: NOW });
});
afterAll(async () => {
  await t.close();
  rmSync(tmp, { recursive: true, force: true });
  await db.drop();
});

describe('before any scan', () => {
  it('answers an empty page, flagged stale, with zero counts', async () => {
    const r = await t.get('/api/leaders');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      asOf: null,
      today: null,
      isArchive: false,
      candidates: [],
      dropped: [],
      regime: null,
      brief: null,
      funnel: { screened: { total: 0 }, leaders: 0, shortlist: 0 },
      status: { stale: true, equityMissing: false, refreshing: false },
    });
    expect((await t.get('/api/leaders/days?month=2026-10')).json).toMatchObject({ days: [], today: null });
    expect((await t.get('/api/leaders/record')).json).toMatchObject({
      window: '60',
      setups: 0,
      avgR: null,
      best: null,
      watchToSetup: { became: 0, of: 0 },
    });
    expect((await t.get('/api/overview')).json.leaders).toBeNull();
  });
});

describe('after a scan', () => {
  let setupId = 0;
  let watchId = 0;
  let deepId = 0;

  beforeAll(async () => {
    await runLeadersScan(scanDeps(), { market: 'US', asOf: END });
    const rows = await listCandidates(db.db, [1]);
    setupId = rows.find((r) => r.symbol === 'LEAD1')?.id as number;
    watchId = rows.find((r) => r.symbol === 'LEAD2')?.id as number;
    deepId = rows.find((r) => r.symbol === 'LEAD3')?.id as number;
  });

  it('GET /api/leaders is the combined list: the Setup first, the plan sized, the sparkline aligned, units in percent', async () => {
    const r = await t.get('/api/leaders');
    expect(r.status).toBe(200);
    const v = r.json;
    expect(v).toMatchObject({
      asOf: END,
      today: END,
      isArchive: false,
      prevDay: null,
      nextDay: null,
      stage: 'shortlist',
      funnel: {
        screened: { total: world.all.length, US: world.all.length, HK: 0 },
        leaders: 3,
        consolidating: 2,
        shortlist: 2,
        setup: 1,
        watch: 1,
        newToday: 0,
        dropped: 0,
        shortlistByMarket: { US: 2, HK: 0 },
      },
      status: { stale: false, equityMissing: false },
    });
    expect(v.regime.label).toBe('Bull · calm');
    expect(v.regime.postureText).toBe('Entries allowed');
    expect(v.regime.line).toMatch(/^Bull · calm · VIX 16\.0 · SPY above 200d/);
    expect(v.runs.US).toMatchObject({ market: 'US', asOf: END, status: 'ok', shortlisted: 2, regime: 'bull_calm' });
    expect(v.runs.HK).toBeNull();
    expect(v.candidates.map((c: { symbol: string }) => c.symbol)).toEqual(['LEAD1', 'LEAD2']);

    const [setup, watch] = v.candidates;
    expect(setup).toMatchObject({
      id: setupId,
      rank: 1,
      market: 'US',
      state: 'setup',
      currency: 'USD',
      watched: false,
      hasChain: false,
      hasStatements: false,
      isNew: false,
      researchReports: 0,
      outcome: null,
    });
    expect(setup.price).toBeCloseTo(96.8, 2);
    // percentages, not fractions
    expect(setup.ret6mPct).toBeGreaterThan(50);
    expect(setup.ret6mPct).toBeLessThan(80);
    expect(setup.rank6m).toBeGreaterThan(95);
    expect(setup.plan.stopPct).toBeGreaterThan(1);
    expect(setup.plan.stopPct).toBeLessThan(3);
    expect(setup.stopPct).toBeCloseTo(setup.plan.stopPct, 2);
    expect(setup.plan).toMatchObject({ lot: 1, lotAssumed: false, lotTooBig: false });
    expect(setup.plan.shares).toBeGreaterThan(0);
    expect(setup.plan.r3).toBeGreaterThan(setup.plan.entry);
    expect(setup.base.depthRatio).toBeGreaterThan(0.04);
    expect(setup.why).toHaveLength(3);
    expect(setup.levels.filter((l: { inPlay: boolean }) => l.inPlay)).toHaveLength(1);
    expect(setup.flags.some((f: { text: string }) => f.text === 'Earnings date unknown')).toBe(true);
    // the sparkline: 70 aligned bars, the stop for a Setup, the anchor inside the window
    expect(setup.spark.closes).toHaveLength(70);
    expect(setup.spark.ema21).toHaveLength(70);
    expect(setup.spark.ema50).toHaveLength(70);
    expect(setup.spark.avwap).toHaveLength(70);
    expect(setup.spark.stop).toBe(setup.plan.stop);
    expect(setup.spark.anchorIndex).toBeGreaterThanOrEqual(0);
    expect(setup.spark.avwap[setup.spark.anchorIndex]).not.toBeNull();
    expect(setup.spark.avwap[setup.spark.anchorIndex - 1] ?? null).toBeNull();
    expect(setup.spark.closes.at(-1)).toBeCloseTo(setup.price, 2);
    // a Watch: no plan, no stop line
    expect(watch).toMatchObject({ rank: 2, state: 'watch', plan: null, outcome: null });
    expect(watch.spark.stop).toBeNull();
  });

  it('a funnel stage lists the names that stopped there, with the rule they failed', async () => {
    const leaders = (await t.get('/api/leaders?stage=leaders')).json;
    expect(leaders.stage).toBe('leaders');
    expect(leaders.candidates).toHaveLength(1);
    expect(leaders.candidates[0]).toMatchObject({ id: deepId, symbol: 'LEAD3', state: 'excluded', rank: null });
    expect(leaders.candidates[0].reason).toMatch(/^base \d+% deep, limit 25%/);
    const cons = (await t.get('/api/leaders?stage=consolidating')).json;
    expect(cons.candidates).toEqual([]);
    const screened = (await t.get('/api/leaders?stage=screened')).json;
    expect(screened.candidates).toEqual([]);
    expect(screened.stageNote).toMatch(/not stored/);
    // the funnel always describes the whole day
    expect(screened.funnel.leaders).toBe(3);
  });

  it('market and state narrow the listing only', async () => {
    expect((await t.get('/api/leaders?market=HK')).json.candidates).toEqual([]);
    expect((await t.get('/api/leaders?state=watch')).json.candidates.map((c: { symbol: string }) => c.symbol)).toEqual([
      'LEAD2',
    ]);
    expect((await t.get('/api/leaders?market=US&state=setup')).json.funnel.shortlist).toBe(2);
  });

  it('rejects a bad date, stage or month, and an unknown candidate', async () => {
    expect((await t.get('/api/leaders?date=10-13-2026')).status).toBe(400);
    expect((await t.get('/api/leaders?stage=everything')).status).toBe(400);
    expect((await t.get('/api/leaders/days?month=2026-13')).status).toBe(400);
    expect((await t.get('/api/leaders/record?window=7')).status).toBe(400);
    expect((await t.post('/api/leaders/candidates/999999/mute', {})).status).toBe(404);
    expect((await t.post('/api/leaders/candidates/abc/mute', {})).status).toBe(400);
    expect((await t.post(`/api/leaders/candidates/${watchId}/mute`, { days: 0 })).status).toBe(400);
    expect((await t.post(`/api/leaders/candidates/${watchId}/mute`, { days: 61 })).status).toBe(400);
    expect((await t.post(`/api/leaders/candidates/${watchId}/mute`, { nonsense: true })).status).toBe(400);
  });

  it('dismiss mutes the name for ten trading days; undo clears it', async () => {
    const m = await t.post(`/api/leaders/candidates/${watchId}/mute`, {});
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ days: 10, reason: 'dismissed' });
    // 10 trading days after Sat 2026-10-10 (Mon 12th .. Fri 23rd, none of them a US holiday)
    expect(m.json.until).toBe('2026-10-23');
    const custom = await t.post(`/api/leaders/candidates/${watchId}/mute`, { days: 3, reason: 'too extended for me' });
    expect(custom.json).toMatchObject({ days: 3, reason: 'too extended for me', until: '2026-10-14' });
    expect((await t.del(`/api/leaders/candidates/${watchId}/mute`)).json).toEqual({ ok: true });
  });

  it('add to watchlist puts the instrument on the normal ingest; a second call changes nothing', async () => {
    const r = await t.post(`/api/leaders/candidates/${setupId}/watch`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, market: 'US', symbol: 'LEAD1' });
    const watch = await listWatchlist(db.db);
    const row = watch.find((w) => w.symbol === 'LEAD1');
    expect(row?.active).toBe(true);
    // a followed name gets the full ingest, so it is no longer stored as option-less
    expect(row?.hasListedOptions).toBe(true);
    expect((await t.post(`/api/leaders/candidates/${setupId}/watch`)).json).toEqual({
      ok: true,
      market: 'US',
      symbol: 'LEAD1',
    });
    const v = (await t.get('/api/leaders')).json;
    const c = v.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD1');
    expect(c.watched).toBe(true);
    expect(c.flags).toContainEqual({ level: 'ok', text: 'On watchlist' });
  });

  it('a followed name with a stored chain gets the put angle: the nearest monthly put at or below the stop', async () => {
    const before = (await t.get('/api/leaders')).json.candidates.find((c: { symbol: string }) => c.symbol === 'LEAD1');
    expect(before.put).toBeNull();
    await writeOptionChain(
      db.db,
      world.setup.id,
      bsChain({ spot: 96.8, snapshotDate: END, sigma: 0.35, expiries: ['2026-11-20', '2026-10-30'], multiplier: 100 }),
      NOW,
    );
    const c = (await t.get('/api/leaders')).json.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD1');
    expect(c.hasChain).toBe(true);
    expect(c.flags).toContainEqual({ level: 'ok', text: 'Chain stored' });
    // 2026-11-20 is the third Friday and 42 days out; 2026-10-30 is a weekly, never offered
    expect(c.put.expiry).toBe('2026-11-20');
    expect(c.put.strike).toBeLessThanOrEqual(c.plan.stop);
    expect(c.put.strike).toBeGreaterThan(c.plan.stop - 3);
    expect(c.put.rocPct).toBeGreaterThan(0);
    expect(c.put.delta).toBeGreaterThan(0.05);
    expect(c.put.delta).toBeLessThan(0.5);
    expect(c.put.belowStopPct).toBeCloseTo(((c.plan.stop - c.put.strike) / c.plan.stop) * 100, 0);
    // nothing about it reaches the recommendations
    const rec = await db.db.execute(sql`select count(*)::int as n from recommendations`);
    expect((rec.rows[0] as { n: number }).n).toBe(0);
    // an unwatched name never gets one, chain or not
    expect(
      (await t.get('/api/leaders')).json.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD2').put,
    ).toBeNull();
  });

  it('Investigate fetches the statements first when a name has none, and not when it has them', async () => {
    const logs: string[] = [];
    const prev = t.deps.log;
    t.deps.log = (l) => logs.push(l);
    try {
      const r = await t.post('/api/research/runs', { symbol: 'LEAD2', market: 'US', skillIds: ['quality-screen'] });
      expect(r.status).toBe(202);
      expect(r.json).toHaveLength(1);
      expect(r.json[0]).toMatchObject({ skillId: 'quality-screen', symbol: 'LEAD2' });
      // the replayed HTTP has no recording for it: the fetch is attempted, fails, and the run still starts
      expect(logs.some((l) => l.includes('statements for US:LEAD2') || l.includes('LEAD2'))).toBe(true);
      expect(
        (await t.get('/api/leaders')).json.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD2')
          .hasStatements,
      ).toBe(false);
      await writeFundamentals(
        db.db,
        world.watch.id,
        'US',
        [{ ...statement('2025-12-31'), reportedAtActual: null }],
        NOW,
      );
      logs.length = 0;
      const again = await t.post('/api/research/runs', { symbol: 'LEAD2', market: 'US', skillIds: ['quality-screen'] });
      expect(again.status).toBe(202);
      expect(logs.filter((l) => l.includes('LEAD2'))).toEqual([]);
      expect(
        (await t.get('/api/leaders')).json.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD2')
          .hasStatements,
      ).toBe(true);
      // the leader preset is in the catalogue the sheet reads
      const cat = (await t.get('/api/skills')).json;
      expect(cat.presets.find((p: { id: string }) => p.id === 'leader')).toMatchObject({
        name: 'Leader check',
        skillIds: ['quality-screen', 'news-pulse', 'thesis-tracker'],
      });
    } finally {
      t.deps.log = prev;
    }
  });

  it('the Today card counts the Setups of the latest lists', async () => {
    const o = (await t.get('/api/overview')).json;
    expect(o.leaders).toEqual({ asOf: END, setups: 1, newToday: 0, shortlisted: 2, posture: 'entries' });
  });

  it('the calendar has a dot for the day, with its Setup and Watch counts', async () => {
    const d = (await t.get('/api/leaders/days?month=2026-10')).json;
    expect(d).toEqual({ month: '2026-10', days: [{ day: END, setups: 1, watch: 1 }], today: END, earliest: END });
    expect((await t.get('/api/leaders/days?month=2026-09')).json.days).toEqual([]);
  });
});

describe('the archive and the dropped row', () => {
  const nextDay = nextTradingDay('US', END);
  let archivedSetupId = 0;

  beforeAll(async () => {
    // the next session: LEAD1 trades up through 3R, LEAD2 collapses out of the leader group; every other name is flat
    const rows = await listCandidates(db.db, [1]);
    const plan = rows.find((r) => r.symbol === 'LEAD1')?.payload.plan;
    archivedSetupId = rows.find((r) => r.symbol === 'LEAD1')?.id as number;
    if (!plan) throw new Error('LEAD1 should be a Setup');
    const r = plan.entry - plan.stop;
    for (const i of world.all) {
      const last = (await db.db.query.priceBars.findFirst({
        where: (b, { eq }) => eq(b.instrumentId, i.id),
        orderBy: (b, { desc }) => desc(b.day),
      })) as { close: string };
      const c = Number(last.close);
      const bar = (o: number, h: number, l: number, cl: number): DailyBar => ({
        day: nextDay,
        open: o,
        high: h,
        low: l,
        close: cl,
        adjClose: cl,
        volume: 700_000,
        source: 'yahoo',
      });
      if (i.id === world.setup.id) await writeBars(db.db, i.id, [bar(c, c + 3.4 * r, c - 0.2 * r, c + 2 * r)]);
      else if (i.id === world.watch.id) await writeBars(db.db, i.id, [bar(c * 0.6, c * 0.61, c * 0.59, c * 0.6)]);
      else await writeBars(db.db, i.id, [bar(c, c * 1.002, c * 0.998, c)]);
    }
    await runLeadersScan(scanDeps(), { market: 'US', asOf: nextDay });
  });

  it('today is the newest run; the day before is an archive stamped with what happened afterwards', async () => {
    const today = (await t.get('/api/leaders')).json;
    expect(today).toMatchObject({ asOf: nextDay, isArchive: false, prevDay: END, nextDay: null });
    const old = (await t.get(`/api/leaders?date=${END}`)).json;
    expect(old).toMatchObject({ asOf: END, isArchive: true, prevDay: null, nextDay });
    const c = old.candidates.find((x: { symbol: string }) => x.symbol === 'LEAD1');
    // stored candidates, not a recomputation: the plan is the one of that evening, and the outcome is stamped on it
    expect(c.id).toBe(archivedSetupId);
    expect(c.plan.entry).toBeCloseTo(96.8, 2);
    expect(c.outcome).toMatchObject({ hit3r: true, stopped: false, daysTo3r: 1, asOf: nextDay });
    expect(c.outcome.maxR).toBeGreaterThanOrEqual(3);
    expect(c.price).toBeCloseTo(96.8, 2);
    // an archive day has no run of its own market on a date with none
    expect((await t.get('/api/leaders?date=2026-10-08')).json).toMatchObject({
      asOf: '2026-10-08',
      isArchive: true,
      candidates: [],
      runs: { US: null, HK: null },
    });
  });

  it('a name that fell out of the leader group is on the dropped row with the reason', async () => {
    const today = (await t.get('/api/leaders')).json;
    const dropped = today.dropped.find((d: { symbol: string }) => d.symbol === 'LEAD2');
    expect(dropped).toMatchObject({ market: 'US', muted: false });
    expect(dropped.reason).toMatch(/^Not a leader/);
    expect(today.funnel.dropped).toBe(today.dropped.length);
    // the NEW badge: a name listed now that was not on the previous list
    expect(today.candidates.every((c: { isNew: boolean }) => c.isNew === false)).toBe(true);
  });

  it('the record counts the Setup that reached 3R, with the best result and the watch rows that never became one', async () => {
    const r = (await t.get('/api/leaders/record?window=all')).json;
    expect(r).toMatchObject({ window: 'all', hit3r: 1, stopped: 0, since: END });
    expect(r.setups).toBeGreaterThanOrEqual(1);
    expect(r.avgR).toBeGreaterThan(0);
    expect(r.best).toMatchObject({ symbol: 'LEAD1', day: END });
    expect(r.best.r).toBeGreaterThanOrEqual(3);
    expect(r.worst).toBeNull();
    expect(r.medianDaysTo3r).toBe(1);
    expect(r.watchToSetup.of).toBeGreaterThanOrEqual(1);
    expect((await t.get('/api/leaders/record?window=60')).json.window).toBe('60');
  });
});

describe('refresh', () => {
  it('runs the scan of both markets in this process, then is debounced for 30 minutes', async () => {
    const record = (await t.get('/api/leaders/record?window=all')).json;
    const days = (await t.get('/api/leaders/days?month=2026-10')).json;
    const first = await t.post('/api/leaders/refresh');
    expect(first.status).toBe(202);
    expect(first.json.queued).toBe(true);
    await t.app.services.leaders.idle();
    const second = await t.post('/api/leaders/refresh');
    expect(second.json.queued).toBe(false);
    expect(second.json.message).toMatch(/Scanned a moment ago/);
    const v = (await t.get('/api/leaders')).json;
    expect(v.status.refreshing).toBe(false);
    // the refresh scanned HK too (no HK names here, so an empty run) and US again for the same day
    expect(v.runs.HK).toMatchObject({ market: 'HK', screened: 0 });
    expect((await t.get('/api/leaders')).json.runs.US.id).toBe(2);
    // the same day scanned a second time is not counted twice: the record and the calendar are unchanged
    expect((await t.get('/api/leaders/record?window=all')).json).toEqual(record);
    expect((await t.get('/api/leaders/days?month=2026-10')).json).toEqual(days);
  });
});
