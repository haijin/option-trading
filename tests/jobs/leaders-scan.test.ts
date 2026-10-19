import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextTradingDay } from '../../src/core/calendar';
import type { DailyBar } from '../../src/core/types';
import {
  activeMutes,
  candidatesAwaitingOutcome,
  clearMute,
  getRun,
  listCandidates,
  setMute,
} from '../../src/db/leaders';
import { writeBars } from '../../src/db/writers';
import { leadersAsOf, runLeadersScan, stampOutcomes } from '../../src/jobs/leaders-scan';
import { END } from '../helpers/history';
import { type LeadersWorld, seedLeadersWorld } from '../helpers/leaders-world';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let world: LeadersWorld;
const logs: string[] = [];
const deps = () => ({
  db: db.db,
  now: () => new Date('2026-10-10T00:00:00Z'),
  log: (l: string) => logs.push(l),
});

beforeAll(async () => {
  db = await createTestDb();
  world = await seedLeadersWorld(db.db);
});
afterAll(async () => {
  await db.drop();
});

describe('leadersAsOf: the last completed session of a market', () => {
  it('uses the market date from 17:00 local, the day before earlier, and skips weekends', () => {
    // Fri 2026-10-09 18:45 New York = 22:45 UTC
    expect(leadersAsOf('US', new Date('2026-10-09T22:45:00Z'))).toBe('2026-10-09');
    // Fri 2026-10-09 10:00 New York: the session is not over, so Thursday
    expect(leadersAsOf('US', new Date('2026-10-09T14:00:00Z'))).toBe('2026-10-08');
    // Sat 2026-10-10 in Hong Kong: Friday
    expect(leadersAsOf('HK', new Date('2026-10-10T04:00:00Z'))).toBe('2026-10-09');
    // Mon 2026-10-12 09:00 Hong Kong: still Friday's session
    expect(leadersAsOf('HK', new Date('2026-10-12T01:00:00Z'))).toBe('2026-10-09');
  });
});

describe('runLeadersScan: one market, one day', () => {
  it('ranks the market, keeps the leaders, stores one run and one row per name that reached the leader test', async () => {
    const out = await runLeadersScan(deps(), { market: 'US', asOf: world.asOf });
    expect(out.status).toBe('ok');
    expect(out.names).toBe(world.all.length);
    expect(out.screened).toBe(world.all.length);
    expect(out.regime).toBe('bull_calm');
    expect(out.posture).toBe('entries');
    expect(out.coverage).toEqual({ withBar: world.all.length, names: world.all.length });

    const run = await getRun(db.db, out.runId);
    expect(run).toMatchObject({
      market: 'US',
      asOf: END,
      status: 'ok',
      screened: out.screened,
      leaders: out.leaders,
      consolidating: out.consolidating,
      shortlisted: out.shortlisted,
      regime: 'bull_calm',
      posture: 'entries',
    });
    expect(run?.skillVersion).toBe('1.0.0');
    expect(run?.finishedAt).not.toBeNull();
    expect(((run as { detail: unknown }).detail as { funnel: { setup: number } }).funnel.setup).toBe(out.setups);
    expect(((run as { detail: unknown }).detail as { regimeInfo: { regime: string } }).regimeInfo.regime).toBe(
      'bull_calm',
    );

    const rows = await listCandidates(db.db, [out.runId]);
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    // the three scripted leaders are leaders; the crowd (no drift to speak of) is not
    expect(out.leaders).toBe(3);
    expect(rows).toHaveLength(3);
    expect(bySymbol.get('LEAD1')?.state).toBe('setup');
    expect(bySymbol.get('LEAD2')?.state).toBe('watch');
    expect(bySymbol.get('LEAD3')?.state).toBe('excluded');
    expect(bySymbol.get('LEAD3')?.payload.reason).toMatch(/^base \d+% deep, limit 25%/);
    // the market's own list: the Setup first, then the Watch; the excluded name has no rank
    expect(bySymbol.get('LEAD1')?.rank).toBe(1);
    expect(bySymbol.get('LEAD2')?.rank).toBe(2);
    expect(bySymbol.get('LEAD3')?.rank).toBeNull();
    expect(out.shortlisted).toBe(2);
    expect(out.consolidating).toBe(2);
    expect(out.setups).toBe(1);
    expect(out.watches).toBe(1);
    // the payload is the skill's, with the plan on the Setup only
    const setup = bySymbol.get('LEAD1');
    expect(setup?.payload.plan?.shares).toBeGreaterThan(0);
    expect(setup?.payload.rank3m).toBeGreaterThan(90);
    expect(bySymbol.get('LEAD2')?.payload.plan).toBeNull();
    expect(Number(setup?.score)).toBeGreaterThan(Number(bySymbol.get('LEAD2')?.score));
    // no outcome yet: nothing has happened after the close it was shown
    expect(setup?.hit3r).toBeNull();
    expect(setup?.outcomeAsOf).toBeNull();
  });

  it('a name that was on the last list and is no longer a leader still gets a row, with the reason', async () => {
    // the first run listed LEAD1 and LEAD2; the next day LEAD2 loses its trend and falls out of the leader group
    const nextDay = nextTradingDay('US', END);
    const flat = (base: number): DailyBar => ({
      day: nextDay,
      open: base,
      high: base * 1.002,
      low: base * 0.998,
      close: base,
      adjClose: base,
      volume: 700_000,
      source: 'yahoo',
    });
    // every name gets a flat next-day bar so coverage stays whole; LEAD2 collapses 40%
    for (const i of world.all) {
      const bars = await db.db.query.priceBars.findMany({
        where: (t, { eq }) => eq(t.instrumentId, i.id),
        limit: 1,
        orderBy: (t, { desc }) => desc(t.day),
      });
      const last = Number(bars[0]?.close);
      await writeBars(db.db, i.id, [flat(i.id === world.watch.id ? last * 0.6 : last)]);
    }
    const out = await runLeadersScan(deps(), { market: 'US', asOf: nextDay });
    const rows = await listCandidates(db.db, [out.runId]);
    const lost = rows.find((r) => r.symbol === 'LEAD2');
    expect(lost?.state).toBe('excluded');
    expect(lost?.rank).toBeNull();
    expect(lost?.payload.reason).toMatch(/^(not a leader|closed below|base)/);
  });

  it('a muted name is skipped by the next scan; a lapsed mute is not', async () => {
    await setMute(db.db, world.watch.id, '2026-10-20', 'dismissed');
    const out = await runLeadersScan(deps(), { market: 'US', asOf: world.asOf });
    const rows = await listCandidates(db.db, [out.runId]);
    expect(rows.map((r) => r.symbol).sort()).toEqual(['LEAD1', 'LEAD3']);
    expect(out.names).toBe(world.all.length - 1);
    expect((await activeMutes(db.db, '2026-10-09')).has(world.watch.id)).toBe(true);
    expect((await activeMutes(db.db, '2026-10-21')).has(world.watch.id)).toBe(false);
    expect(await clearMute(db.db, world.watch.id)).toBe(true);
    expect(await clearMute(db.db, world.watch.id)).toBe(false);
  });
});

describe('outcomes: stamped from the bars that arrive after the day a Setup was shown', () => {
  interface Scripted {
    symbol: string;
    id: number;
    entry: number;
    stop: number;
    r: number;
  }
  let scripted: Scripted[] = [];
  let sub: TestDb;
  let subWorld: LeadersWorld;
  let runId = 0;

  beforeAll(async () => {
    // a fresh database: three Setups (same shape, three symbols) so each can be given its own future
    sub = await createTestDb();
    subWorld = await seedLeadersWorld(sub.db, { crowd: 40 });
    const { writeBars: wb } = await import('../../src/db/writers');
    const { seedInstrument } = await import('../helpers/seed');
    const { leaderBars } = await import('../helpers/leaders');
    const { universeMembers } = await import('../../src/db/schema');
    for (const s of ['SETA', 'SETB', 'SETC']) {
      const inst = await seedInstrument(sub.db, 'US', s, { name: s, hasListedOptions: false });
      await wb(sub.db, inst.id, leaderBars());
      await sub.db.insert(universeMembers).values({ instrumentId: inst.id, indexCode: 'SPX', addedAt: '2026-01-01' });
    }
    const out = await runLeadersScan(
      { db: sub.db, now: () => new Date('2026-10-10T00:00:00Z'), log: () => {} },
      { market: 'US', asOf: END },
    );
    runId = out.runId;
    const rows = await listCandidates(sub.db, [runId]);
    scripted = rows
      .filter((r) => ['SETA', 'SETB', 'SETC'].includes(r.symbol))
      .map((r) => {
        const plan = r.payload.plan;
        if (!plan) throw new Error(`${r.symbol} is not a Setup: ${r.state} ${r.payload.reason}`);
        return { symbol: r.symbol, id: r.instrumentId, entry: plan.entry, stop: plan.stop, r: plan.entry - plan.stop };
      });
  });
  afterAll(async () => {
    await sub.drop();
  });

  const day = (k: number): string => {
    let d = END;
    for (let i = 0; i < k; i++) d = nextTradingDay('US', d);
    return d;
  };
  const bar = (k: number, o: number, h: number, l: number, c: number): DailyBar => ({
    day: day(k),
    open: o,
    high: h,
    low: l,
    close: c,
    adjClose: c,
    volume: 800_000,
    source: 'yahoo',
  });

  it('waits for a bar: nothing is stamped on the day shown', async () => {
    const waiting = await candidatesAwaitingOutcome(sub.db, 'US');
    expect(waiting.map((w) => w.asOf)).toEqual([END, END, END, END].slice(0, waiting.length));
    expect(waiting.length).toBeGreaterThanOrEqual(3);
    expect(await stampOutcomes(sub.db, 'US')).toBe(0);
  });

  it('a Setup that reaches 3R first, one that is stopped, and one that gaps through the stop', async () => {
    const [a, b, c] = scripted as [Scripted, Scripted, Scripted];
    const { writeBars: wb } = await import('../../src/db/writers');
    // A: day 1 trades up to 3.2R without touching the stop; B: day 1 trades through the stop; C: opens below the stop
    await wb(sub.db, a.id, [bar(1, a.entry, a.entry + 3.2 * a.r, a.entry - 0.2 * a.r, a.entry + 2 * a.r)]);
    await wb(sub.db, b.id, [bar(1, b.entry, b.entry + 0.5 * b.r, b.stop - 0.1, b.stop + 0.2)]);
    await wb(sub.db, c.id, [bar(1, c.stop - 0.5 * c.r, c.stop - 0.4 * c.r, c.stop - 0.7 * c.r, c.stop - 0.6 * c.r)]);
    const written = await stampOutcomes(sub.db, 'US');
    expect(written).toBeGreaterThanOrEqual(3);
    const rows = await listCandidates(sub.db, [runId]);
    const of = (sym: string) => rows.find((r) => r.symbol === sym);
    const A = of(a.symbol);
    const B = of(b.symbol);
    const C = of(c.symbol);
    expect(A).toMatchObject({ hit3r: true, stopped: false, daysTo3r: 1, outcomeAsOf: day(1) });
    expect(A?.maxR).toBeGreaterThanOrEqual(3);
    expect(B).toMatchObject({ hit3r: false, stopped: true, maxR: -1 });
    expect(C).toMatchObject({ hit3r: false, stopped: true });
    // a gap through the stop exits at the open: worse than -1R
    expect(C?.maxR).toBeLessThan(-1);
    expect(C?.maxR).toBeCloseTo(-1.5, 2);
    // a hit or a stop is final: decided rows leave the waiting list
    const waiting = (await candidatesAwaitingOutcome(sub.db, 'US')).map((w) => w.instrumentId);
    expect(waiting).not.toContain(a.id);
    expect(waiting).not.toContain(b.id);
    expect(waiting).not.toContain(c.id);
    void subWorld;
  });

  it('a Setup that does neither stays open and gets its forward returns as bars arrive', async () => {
    const { seedInstrument } = await import('../helpers/seed');
    const { leaderBars } = await import('../helpers/leaders');
    const { writeBars: wb } = await import('../../src/db/writers');
    const { universeMembers } = await import('../../src/db/schema');
    const inst = await seedInstrument(sub.db, 'US', 'SETD', { name: 'SETD', hasListedOptions: false });
    await wb(sub.db, inst.id, leaderBars());
    await sub.db.insert(universeMembers).values({ instrumentId: inst.id, indexCode: 'SPX', addedAt: '2026-01-01' });
    const out = await runLeadersScan(
      { db: sub.db, now: () => new Date('2026-10-10T00:00:00Z'), log: () => {} },
      { market: 'US', asOf: END },
    );
    const row = (await listCandidates(sub.db, [out.runId])).find((r) => r.symbol === 'SETD');
    const plan = row?.payload.plan;
    if (!row || !plan) throw new Error('SETD is not a Setup');
    // 25 quiet sessions around the entry, never touching the stop or 3R
    const quiet: DailyBar[] = [];
    for (let k = 1; k <= 25; k++)
      quiet.push(
        bar(
          k,
          plan.entry,
          plan.entry + 0.3 * (plan.entry - plan.stop),
          plan.entry - 0.3 * (plan.entry - plan.stop),
          plan.entry * (1 + 0.001 * k),
        ),
      );
    await wb(sub.db, inst.id, quiet.slice(0, 7));
    await stampOutcomes(sub.db, 'US');
    let r = (await listCandidates(sub.db, [out.runId])).find((x) => x.symbol === 'SETD');
    expect(r).toMatchObject({ hit3r: false, stopped: false });
    expect(r?.fwd5).toBeCloseTo(0.005, 4);
    expect(r?.fwd10).toBeNull();
    expect(r?.outcomeAsOf).toBe(day(7));
    // still open: it stays on the waiting list until the window has passed
    expect((await candidatesAwaitingOutcome(sub.db, 'US')).map((w) => w.instrumentId)).toContain(inst.id);
    await wb(sub.db, inst.id, quiet.slice(7));
    await stampOutcomes(sub.db, 'US');
    r = (await listCandidates(sub.db, [out.runId])).find((x) => x.symbol === 'SETD');
    expect(r?.fwd10).toBeCloseTo(0.01, 4);
    expect(r?.fwd20).toBeCloseTo(0.02, 4);
    expect(r?.outcomeAsOf).toBe(day(20));
  });
});
