/**
 * pg-boss scheduling (docs/02 section 4): replaces Windows Task Scheduler once the app runs as a long-lived process.
 * pg-boss keeps its queue in its own `pgboss` schema of the same database, so there is still no Redis. It is opt-in
 * (`OT_JOBS=on`): nothing is created in the database until the scheduler is started.
 *
 * Times are evaluated in each market's own time zone, so daylight saving moves nothing by hand.
 */
import { PgBoss } from 'pg-boss';
import {
  type JobDeps,
  type JobOutcome,
  runIngestJob,
  runLeadersBriefJob,
  runLeadersScanJob,
  runMarkJob,
  runNewsBriefJob,
  runNewsClassifyJob,
  runNewsFetchJob,
  runRemindersDigestJob,
  runScanJob,
} from './jobs';
import { runJournalCleanupJob } from './journal-cleanup';
import { runUniverseIngestJob, runUniverseRefreshJob } from './universe-jobs';

/** What a job may do besides its own work: queue another job, and know whether the schedule (not a person) fired it. */
export interface JobControl {
  trigger(name: string, data?: Record<string, unknown>): Promise<string | null>;
  scheduled: boolean;
  /** The data the schedule or the trigger sent with this run. */
  data: Record<string, unknown>;
}

/** A further schedule of the same job (its own key and data), for a job that runs at two different times. */
export interface JobSchedule {
  key: string;
  cron: string;
  tz: string;
  data: Record<string, unknown>;
}

export interface JobDef {
  name: string;
  /** Five-field cron expression, evaluated in `tz`; null for a job another job queues (it only has a queue and a worker). */
  cron: string | null;
  tz: string;
  description: string;
  /** Data sent with the run the primary `cron` fires. */
  data?: Record<string, unknown>;
  /** More schedules of this job. */
  also?: JobSchedule[];
  run(deps: JobDeps, ctl?: JobControl): Promise<JobOutcome>;
}

const NY = 'America/New_York';
const HK = 'Asia/Hong_Kong';

/** The schedule from docs/02 section 4. Weekdays only for market jobs; the exchange holiday tables make a closed day a no-op. */
export const JOB_DEFS: JobDef[] = [
  {
    name: 'ingest-us',
    cron: '30 17 * * 1-5',
    tz: NY,
    description: 'US prices, fundamentals, events, FX and chains after the close',
    run: (d) => runIngestJob(d, { market: 'US' }),
  },
  {
    name: 'ingest-hk',
    cron: '30 17 * * 1-5',
    tz: HK,
    description: 'HK prices, fundamentals, events and FX after the close',
    run: (d) => runIngestJob(d, { market: 'HK' }),
  },
  {
    name: 'snapshot-chains-us',
    cron: '45 15 * * 1-5',
    tz: NY,
    description: 'US option chains 15 minutes before the close: one snapshot per day is the backtest unit',
    run: (d) => runIngestJob(d, { market: 'US', steps: ['chains'] }),
  },
  {
    name: 'snapshot-chains-hk',
    cron: '45 15 * * 1-5',
    tz: HK,
    description: 'HK option chains (moomoo OpenD) 15 minutes before the close',
    run: (d) => runIngestJob(d, { market: 'HK', steps: ['chains'] }),
  },
  {
    name: 'mark-positions-us',
    cron: '15 18 * * 1-5',
    tz: NY,
    description: 'P&L and alerts for open US puts after the US ingest',
    run: (d) => runMarkJob(d, { market: 'US' }),
  },
  {
    name: 'mark-positions-hk',
    cron: '15 18 * * 1-5',
    tz: HK,
    description: 'P&L and alerts for open HK puts after the HK ingest',
    run: (d) => runMarkJob(d, { market: 'HK' }),
  },
  {
    name: 'daily-scan',
    cron: '30 18 * * 1-5',
    tz: NY,
    description: 'Rank the watchlist after both markets are ingested and store the run',
    run: (d) => runScanJob(d),
  },
  {
    name: 'fundamentals-weekly',
    cron: '0 8 * * 6',
    tz: HK,
    description: 'Statements and corporate events, weekly',
    run: (d) => runIngestJob(d, { steps: ['profile', 'fundamentals', 'events'] }),
  },
  {
    name: 'news-fetch',
    cron: '*/30 * * * *',
    tz: 'UTC',
    description:
      'Headlines, HKEXnews titles and market feeds: every 30 min in market hours, hourly otherwise, every day',
    run: async (d, ctl) => {
      const out = await runNewsFetchJob(d, { scheduled: ctl?.scheduled ?? false });
      // Judge the new stories right after the fetch (a no-op when the schedule must not call the model).
      if (ctl && out.rows > 0 && out.status !== 'failed') await ctl.trigger('news-classify');
      return out;
    },
  },
  {
    name: 'news-classify',
    cron: null,
    tz: 'UTC',
    description: 'Judge new stories against the name standing (queued by news-fetch, no schedule of its own)',
    run: (d, ctl) => runNewsClassifyJob(d, { scheduled: ctl?.scheduled ?? false }),
  },
  {
    name: 'news-brief',
    cron: '30 7 * * *',
    tz: HK,
    data: { session: 'hk_open' },
    also: [
      { key: 'morning', cron: '0 6 * * *', tz: HK, data: { session: 'hk_open' } },
      { key: 'us_open', cron: '0 21 * * *', tz: HK, data: { session: 'us_open' } },
    ],
    description:
      'Market brief at 06:00 (morning read), 07:30 (HK open) and 21:00 (US open) Hong Kong time, on trading days of that market',
    run: (d, ctl) =>
      runNewsBriefJob(d, ctl?.data.session === 'us_open' ? 'us_open' : 'hk_open', {
        scheduled: ctl?.scheduled ?? false,
      }),
  },
  {
    name: 'universe-refresh',
    cron: '30 8 * * 6',
    tz: HK,
    description: 'Leaders universe: constituent lists (S&P 500, Nasdaq-100, S&P 400, Hang Seng indexes), weekly',
    run: (d) => runUniverseRefreshJob(d),
  },
  {
    name: 'ingest-universe-hk',
    cron: '45 17 * * 1-5',
    tz: HK,
    description: 'Leaders universe: daily bars for the HK names that are not on the watchlist',
    run: (d) => runUniverseIngestJob(d, { market: 'HK' }),
  },
  {
    name: 'ingest-universe-us',
    cron: '45 17 * * 1-5',
    tz: NY,
    description: 'Leaders universe: daily bars for the US names that are not on the watchlist',
    run: (d) => runUniverseIngestJob(d, { market: 'US' }),
  },
  {
    name: 'leaders-scan',
    cron: '45 18 * * 1-5',
    tz: HK,
    data: { market: 'HK' },
    also: [{ key: 'us', cron: '45 18 * * 1-5', tz: NY, data: { market: 'US' } }],
    description:
      'Leaders: the pullback-buy screen over each market after its universe bars are in (18:45 Hong Kong, 18:45 New York)',
    run: async (d, ctl) => {
      const market = ctl?.data.market === 'US' ? 'US' : 'HK';
      const out = await runLeadersScanJob(d, { market, scheduled: ctl?.scheduled ?? false });
      // Write the brief right after the scan (a no-op when the schedule must not call the model).
      if (ctl && out.runIds && out.status !== 'failed') await ctl.trigger('leaders-brief', { runIds: out.runIds });
      return out;
    },
  },
  {
    name: 'leaders-brief',
    cron: null,
    tz: 'UTC',
    description:
      'The model-written lead and one-line texts of a Leaders run (queued by leaders-scan, no schedule of its own)',
    run: (d, ctl) =>
      runLeadersBriefJob(d, Array.isArray(ctl?.data.runIds) ? (ctl?.data.runIds as number[]) : [], {
        scheduled: ctl?.scheduled ?? false,
      }),
  },
  {
    name: 'calendar-refresh',
    cron: '0 7 * * *',
    tz: HK,
    description: 'Earnings and ex-dividend dates, daily',
    run: (d) => runIngestJob(d, { steps: ['events'] }),
  },
  {
    name: 'journal-cleanup',
    cron: '30 3 * * *',
    tz: HK,
    description:
      'Daily journal: purge entries deleted over 30 days ago, remove images no entry shows (a day after upload)',
    run: (d) => runJournalCleanupJob(d),
  },
  {
    name: 'reminders-digest',
    cron: '0 8 * * *',
    tz: HK,
    description: "Morning push with today's results dates, ex-dividends, expiries and alerts (08:00 Hong Kong time)",
    run: (d) => runRemindersDigestJob(d),
  },
];

export type ExtraHandler = (data: Record<string, unknown>) => Promise<unknown>;

export interface Scheduler {
  /** Queue a run of a job now (an on-demand job such as `run-backtest`, or a scheduled one by hand). */
  trigger(name: string, data?: Record<string, unknown>): Promise<string | null>;
  stop(): Promise<void>;
}

export async function startScheduler(opts: {
  connectionString: string;
  deps: JobDeps;
  /** On-demand queues beyond the schedule, for example `run-backtest`. */
  extra?: Record<string, ExtraHandler>;
  defs?: JobDef[];
}): Promise<Scheduler> {
  const defs = opts.defs ?? JOB_DEFS;
  const boss = new PgBoss({ connectionString: opts.connectionString, application_name: 'option-trading-jobs' });
  // Backtests run for minutes: no retry (a retry would start a second run) and an expiry far beyond any real duration.
  const trigger = (name: string, data?: Record<string, unknown>): Promise<string | null> =>
    boss.send(name, data ?? {}, { retryLimit: 0, expireInSeconds: 6 * 3600 });
  boss.on('error', (err: Error) => opts.deps.log(`scheduler error: ${err.message}`));
  await boss.start();
  for (const def of defs) {
    await boss.createQueue(def.name);
    // Job functions record their own failures and never throw, so a worker error here is a real fault, not a retry case.
    await boss.work<Record<string, unknown>>(def.name, async (jobs) => {
      for (const job of jobs) await def.run(opts.deps, { trigger, scheduled: true, data: job.data ?? {} });
    });
    if (def.cron) await boss.schedule(def.name, def.cron, def.data ?? null, { tz: def.tz });
    for (const extra of def.also ?? [])
      await boss.schedule(def.name, extra.cron, extra.data, { tz: extra.tz, key: extra.key });
  }
  for (const [name, handler] of Object.entries(opts.extra ?? {})) {
    await boss.createQueue(name);
    await boss.work<Record<string, unknown>>(name, async (jobs) => {
      for (const job of jobs) await handler(job.data ?? {});
    });
  }
  return {
    trigger,
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
