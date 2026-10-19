import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/context';
import type { Alert } from '../../src/core/alerts';
import type { Instrument } from '../../src/core/types';
import { openManualPosition } from '../../src/db/position-ops';
import { setSettings } from '../../src/db/repos';
import { jobRuns, positionMarks } from '../../src/db/schema';
import { writeBars } from '../../src/db/writers';
import { drawdownTierAlert, type JobDeps, newAlerts, runMarkJob } from '../../src/jobs/jobs';
import { type Notification, type Notifier, notifierFromEnv, TelegramNotifier } from '../../src/jobs/notifier';
import { JOB_DEFS, startScheduler } from '../../src/jobs/scheduler';
import { bar, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let aapl: Instrument;
const NOW = new Date('2026-03-13T22:30:00Z'); // 18:30 ET on a Friday: the 2026-03-13 session is complete

class Sink implements Notifier {
  readonly kind = 'sink';
  sent: Notification[] = [];
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
  }
}

function ctxFor(handle: TestDb): CliContext {
  return {
    out: () => {},
    err: () => {},
    now: () => NOW,
    db: () => handle,
    fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch,
    dataDir: '',
    readFile: async () => '',
    fileExists: async () => false,
  };
}

beforeAll(async () => {
  db = await createTestDb();
  aapl = await seedInstrument(db.db, 'US', 'AAPL');
  const bars = [];
  const d = new Date('2025-12-01T00:00:00Z');
  for (let i = 0; i < 120; i++) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      bars.push(bar(d.toISOString().slice(0, 10), 100 + Math.sin(i) * 1.5));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  await writeBars(db.db, aapl.id, bars);
});
afterAll(async () => {
  await db.drop();
});

describe('newAlerts', () => {
  const a = (code: Alert['code']): Alert => ({ level: 'warn', code, text: code });
  const marked = (alerts: Alert[]) =>
    [{ positionId: 1, symbol: 'US:AAPL', alerts }] as unknown as Parameters<typeof newAlerts>[1];

  it('reports only alerts absent from the previous mark', () => {
    const prev = new Map([[1, { alertCodes: ['dte21'] }]]);
    const out = newAlerts(prev, marked([a('dte21'), a('profit50')]));
    expect(out.map((o) => o.alert.code)).toEqual(['profit50']);
  });

  it('reports everything for a position that was never marked', () => {
    expect(newAlerts(new Map(), marked([a('itm'), a('near_strike')]))).toHaveLength(2);
  });
});

describe('notifiers', () => {
  it('Telegram posts the text to the bot API and does not put the token in an error', async () => {
    const calls: { url: string; body: string }[] = [];
    const ok = new TelegramNotifier('SECRET-TOKEN', '42', (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    await ok.send({ title: 'T', lines: ['a', 'b'] });
    expect(calls[0]?.url).toBe('https://api.telegram.org/botSECRET-TOKEN/sendMessage');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ chat_id: '42', text: 'T\na\nb' });

    const bad = new TelegramNotifier(
      'SECRET-TOKEN',
      '42',
      (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
    );
    await expect(bad.send({ title: 'T', lines: [] })).rejects.toThrow(/HTTP 401/);
    await bad.send({ title: 'T', lines: [] }).catch((e: Error) => expect(e.message).not.toContain('SECRET-TOKEN'));
  });

  it('is off unless a channel is configured', () => {
    expect(notifierFromEnv({}, fetch, () => {})).toBeNull();
    expect(notifierFromEnv({ TELEGRAM_BOT_TOKEN: 'x' }, fetch, () => {})).toBeNull();
    expect(notifierFromEnv({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' }, fetch, () => {})?.kind).toBe('telegram');
  });
});

describe('mark-positions job', () => {
  it('marks, records a job_runs row, and notifies only new alerts on a rerun', async () => {
    // strike 125 against ~100: in the money, so itm fires immediately
    await openManualPosition(db.db, {
      instrument: aapl,
      strike: 125,
      expiry: '2026-04-17',
      contracts: 1,
      price: 3,
      date: '2026-03-02',
    });
    const sink = new Sink();
    const deps: JobDeps = { ctx: ctxFor(db), notifier: sink, log: () => {} };
    const first = await runMarkJob(deps);
    expect(first.status).toBe('ok');
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.lines.join('\n')).toContain('US:AAPL');

    const again = await runMarkJob(deps);
    expect(again.status).toBe('ok');
    expect(sink.sent).toHaveLength(1); // same alerts as yesterday's mark: no second push

    const runs = await db.db.select().from(jobRuns).where(eq(jobRuns.job, 'mark-positions'));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'ok' && r.finishedAt !== null)).toBe(true);
    expect(await db.db.select().from(positionMarks)).toHaveLength(1);
  });

  it('lets an unreachable database surface as an error, so pg-boss retries the job', async () => {
    const broken: CliContext = {
      ...ctxFor(db),
      db: () => {
        throw new Error('database unavailable');
      },
    };
    await expect(runMarkJob({ ctx: broken, notifier: null, log: () => {} })).rejects.toThrow('database unavailable');
  });
});

describe('schedule', () => {
  it('has unique names and valid five-field cron expressions in a real time zone', () => {
    expect(new Set(JOB_DEFS.map((j) => j.name)).size).toBe(JOB_DEFS.length);
    for (const j of JOB_DEFS) {
      // a job another job queues (news-classify) has no schedule of its own
      if (j.cron) expect(j.cron.split(' ')).toHaveLength(5);
      for (const extra of j.also ?? []) expect(extra.cron.split(' ')).toHaveLength(5);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: j.tz })).not.toThrow();
    }
  });

  it('the Leaders jobs are scheduled as designed: weekly refresh, daily universe bars, one scan with two schedules, a queue-only brief', () => {
    const def = (name: string) => JOB_DEFS.find((j) => j.name === name);
    expect(def('universe-refresh')).toMatchObject({ cron: '30 8 * * 6', tz: 'Asia/Hong_Kong' });
    expect(def('ingest-universe-hk')).toMatchObject({ cron: '45 17 * * 1-5', tz: 'Asia/Hong_Kong' });
    expect(def('ingest-universe-us')).toMatchObject({ cron: '45 17 * * 1-5', tz: 'America/New_York' });
    expect(def('leaders-scan')).toMatchObject({ cron: '45 18 * * 1-5', tz: 'Asia/Hong_Kong', data: { market: 'HK' } });
    expect(def('leaders-scan')?.also).toEqual([
      { key: 'us', cron: '45 18 * * 1-5', tz: 'America/New_York', data: { market: 'US' } },
    ]);
    // the brief has no schedule of its own: the scan queues it
    expect(def('leaders-brief')?.cron).toBeNull();
  });

  it('pg-boss registers every job of the real schedule, the Leaders ones included, with their time zones', async () => {
    const deps: JobDeps = { ctx: ctxFor(db), notifier: null, log: () => {} };
    const scheduler = await startScheduler({ connectionString: db.url, deps, defs: JOB_DEFS });
    try {
      const rows = (
        await db.db.execute(
          sql`select name, key, cron, timezone from pgboss.schedule where name like 'leaders%' or name like '%universe%' order by name, key`,
        )
      ).rows as { name: string; key: string; cron: string; timezone: string }[];
      expect(rows).toEqual([
        { name: 'ingest-universe-hk', key: '', cron: '45 17 * * 1-5', timezone: 'Asia/Hong_Kong' },
        { name: 'ingest-universe-us', key: '', cron: '45 17 * * 1-5', timezone: 'America/New_York' },
        { name: 'leaders-scan', key: '', cron: '45 18 * * 1-5', timezone: 'Asia/Hong_Kong' },
        { name: 'leaders-scan', key: 'us', cron: '45 18 * * 1-5', timezone: 'America/New_York' },
        { name: 'universe-refresh', key: '', cron: '30 8 * * 6', timezone: 'Asia/Hong_Kong' },
      ]);
      const queues = (await db.db.execute(sql`select name from pgboss.queue where name like 'leaders%' order by name`))
        .rows as {
        name: string;
      }[];
      expect(queues.map((q) => q.name)).toEqual(['leaders-brief', 'leaders-scan']);
    } finally {
      await scheduler.stop();
    }
  }, 60_000);

  it('runs a queued job through pg-boss against the database', async () => {
    const deps: JobDeps = { ctx: ctxFor(db), notifier: null, log: () => {} };
    const ran: string[] = [];
    const scheduler = await startScheduler({
      connectionString: db.url,
      deps,
      defs: [
        {
          name: 'test-mark',
          cron: '0 0 1 1 *',
          tz: 'UTC',
          description: 'test',
          run: async (d) => {
            ran.push('test-mark');
            return runMarkJob(d);
          },
        },
      ],
      extra: {
        'test-extra': async (data) => {
          ran.push(`extra:${String(data.x)}`);
        },
      },
    });
    try {
      await scheduler.trigger('test-mark');
      await scheduler.trigger('test-extra', { x: 7 });
      const deadline = Date.now() + 20_000;
      while (ran.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(ran.sort()).toEqual(['extra:7', 'test-mark']);
    } finally {
      await scheduler.stop();
    }
  }, 40_000);
});

describe('drawdown tier alert (T3)', () => {
  const fx = (c: string) => (c === 'HKD' ? 1 : c === 'USD' ? 7.8 : null);
  const tiers = [
    { drawdownPct: 5, multiplier: 0.75 },
    { drawdownPct: 10, multiplier: 0.5 },
  ];
  const ledger = {
    positions: [
      { positionId: 1, currency: 'HKD' as const, openDate: '2026-02-01', closeDate: '2026-03-02', realizedPnl: 20_000 },
      {
        positionId: 2,
        currency: 'HKD' as const,
        openDate: '2026-02-01',
        closeDate: '2026-03-12',
        realizedPnl: -40_000,
      },
      { positionId: 3, currency: 'HKD' as const, openDate: '2026-03-01', closeDate: null, realizedPnl: null },
    ],
    marks: [
      { positionId: 3, day: '2026-03-12', unrealizedPnl: -10_000 },
      { positionId: 3, day: '2026-03-13', unrealizedPnl: -90_000 },
    ],
  };
  const base = { ledger, equity: 1_000_000, baseCurrency: 'HKD' as const, fxToBase: fx };

  it('fires on the day the drawdown enters a deeper tier, naming the tier and the multiplier', () => {
    // 2026-03-12: peak 20,000, now -30,000: drawdown 5% (tier 5 entered); 2026-03-13: -110,000: 11% (tier 10)
    const governor = { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: tiers };
    const first = drawdownTierAlert({ ...base, governor, asOf: '2026-03-12' });
    expect(first?.tier.drawdownPct).toBe(5);
    expect(first?.alert).toMatchObject({ code: 'drawdown_tier', level: 'warn' });
    const second = drawdownTierAlert({ ...base, governor, asOf: '2026-03-13' });
    expect(second?.tier.drawdownPct).toBe(10);
    expect(second?.alert.text).toContain('crossed the 10% tier: new puts sized x0.50');
    expect(second?.alert.text).toContain('13.0%');
  });

  it('is silent inside a tier, without tiers, and on the way back up', () => {
    const governor = { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: tiers };
    const inside = {
      ...ledger,
      marks: [...ledger.marks, { positionId: 3, day: '2026-03-16', unrealizedPnl: -95_000 }],
    };
    expect(drawdownTierAlert({ ...base, ledger: inside, governor, asOf: '2026-03-16' })).toBeNull();
    const recovering = {
      ...ledger,
      marks: [...ledger.marks, { positionId: 3, day: '2026-03-16', unrealizedPnl: -5_000 }],
    };
    expect(drawdownTierAlert({ ...base, ledger: recovering, governor, asOf: '2026-03-16' })).toBeNull();
    expect(drawdownTierAlert({ ...base, governor: { ...governor, degearTiers: [] }, asOf: '2026-03-13' })).toBeNull();
  });

  it('the mark job pushes the portfolio line once; a rerun of the same day does not repeat it', async () => {
    // equity 20,000 USD in a USD book; the AAPL 125 put (bars ~100) marks about -2,200: an 11% drawdown
    await setSettings(db.db, {
      baseCurrency: 'USD',
      equity: 20_000,
      governor: {
        dailyLossLimit: null,
        consecutiveLossHalt: null,
        degearTiers: [{ drawdownPct: 10, multiplier: 0.5 }],
      },
    });
    const sink = new Sink();
    const deps: JobDeps = { ctx: ctxFor(db), notifier: sink, log: () => {} };
    const first = await runMarkJob(deps, { asOf: '2026-03-12' });
    expect(first.detail).toContain('drawdown tier crossed');
    const portfolioLines = sink.sent.flatMap((n) => n.lines).filter((l) => l.startsWith('portfolio:'));
    expect(portfolioLines).toHaveLength(1);
    expect(portfolioLines[0]).toContain('crossed the 10% tier');
    const again = await runMarkJob(deps, { asOf: '2026-03-12' });
    expect(again.detail).not.toContain('drawdown tier crossed');
    expect(sink.sent.flatMap((n) => n.lines).filter((l) => l.startsWith('portfolio:'))).toHaveLength(1);
    const runs = await db.db.select().from(jobRuns).where(eq(jobRuns.job, 'mark-positions'));
    expect(
      runs.filter((r) => (r.meta as { drawdownTierAsOf?: string } | null)?.drawdownTierAsOf === '2026-03-12'),
    ).toHaveLength(1);
    await setSettings(db.db, { governor: { degearTiers: [] } });
  });
});
