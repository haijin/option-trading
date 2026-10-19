/**
 * Scheduled jobs (docs/02 section 4, docs/06 Phase 3). Each job is a plain async function over a CliContext, so the
 * scheduler, the CLI (`jobs run <name>`) and the app's "Mark now" button run exactly the same code. Every run records a
 * `job_runs` row. All jobs are idempotent: running one twice changes nothing the second time.
 */
import { and, like, sql } from 'drizzle-orm';
import { defaultAsOf } from '../cli/asof';
import type { CliContext } from '../cli/context';
import { executeRun } from '../cli/pipeline';
import type { Alert } from '../core/alerts';
import { isTradingDay, type Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import { summarisePnl, tierCrossed } from '../core/governor';
import { briefSessionDue, canonicalUrl, isHttpUrl, type NewsSession, newsFetchDue, newsHash } from '../core/news';
import type { Currency, DegearTier, GovernorSettings, PnlLedger } from '../core/types';
import { loadLedger, loadPortfolio } from '../db/history';
import { latestMarks, type MarkRunResult, markOpenPositions } from '../db/marks';
import { insertNewsItems, type NewNewsItem } from '../db/news';
import { finishJob, getSettings, listOpenPositions, listWatchlist, loadParams, startJob } from '../db/repos';
import { saveScanRun } from '../db/scan-store';
import { jobRuns } from '../db/schema';
import { futuFromEnv } from '../providers/futu';
import { type IngestStep, runIngest } from '../providers/ingest';
import { collectNews, type NewsName } from '../providers/news';
import { YahooClient } from '../providers/yahoo/client';
import { runLeadersScan, yahooEarningsPort } from './leaders-scan';
import type { Notifier } from './notifier';

export interface JobDeps {
  ctx: CliContext;
  notifier: Notifier | null;
  log(line: string): void;
  /** The reminders digest, supplied by the API server (see RemindersJobPorts). */
  reminders?: RemindersJobPorts;
  /** The model-bound news steps, supplied by the API server (see NewsJobPorts). */
  news?: NewsJobPorts;
  /** The model-bound Leaders step, supplied by the API server (see LeadersJobPorts). */
  leaders?: LeadersJobPorts;
}

export interface JobOutcome {
  status: 'ok' | 'partial' | 'failed';
  rows: number;
  detail: string;
  /** Ids of what the job stored, for a job that queues a follow-up (the Leaders scan queues its brief). */
  runIds?: number[];
  /** Extra fields stored in the job_runs row's meta next to `detail` (what a rerun must not repeat). */
  meta?: Record<string, unknown>;
}

/** Wraps a job body: records the run, turns a throw into a `failed` row, never lets one job's error escape the scheduler. */
export async function recorded(
  deps: JobDeps,
  job: string,
  meta: unknown,
  body: () => Promise<JobOutcome>,
): Promise<JobOutcome> {
  const db = deps.ctx.db().db;
  const id = await startJob(db, job, meta);
  try {
    const out = await body();
    await finishJob(db, id, { status: out.status, rowsWritten: out.rows, meta: { detail: out.detail, ...out.meta } });
    deps.log(`job ${job}: ${out.status}; ${out.detail}`);
    return out;
  } catch (err) {
    const message = (err as Error).message;
    await finishJob(db, id, { status: 'failed', error: message });
    deps.log(`job ${job} failed: ${message}`);
    return { status: 'failed', rows: 0, detail: message };
  }
}

// ------------------------------------------------------------------------------------------------ mark-positions
/** Alerts present now that were not in the position's previous mark: the only ones worth a push. */
export function newAlerts(
  previous: Map<number, { alertCodes: string[] }>,
  marked: MarkRunResult['marked'],
): { positionId: number; symbol: string; alert: Alert }[] {
  const out: { positionId: number; symbol: string; alert: Alert }[] = [];
  for (const m of marked) {
    const before = new Set(previous.get(m.positionId)?.alertCodes ?? []);
    for (const a of m.alerts)
      if (!before.has(a.code)) out.push({ positionId: m.positionId, symbol: m.symbol, alert: a });
  }
  return out;
}

/**
 * The drawdown governor's own alert (trade-skills T3): fires once, on the day the portfolio's drawdown enters a deeper
 * de-gear tier than it sat in on the previous ledger day (the latest close or mark before `asOf`). Pure over the ledger.
 */
export function drawdownTierAlert(i: {
  ledger: PnlLedger;
  governor: GovernorSettings;
  asOf: ISODate;
  equity: number | null;
  baseCurrency: Currency;
  fxToBase: (from: Currency) => number | null;
}): { alert: Alert; tier: DegearTier } | null {
  if (i.governor.degearTiers.length === 0) return null;
  const today = summarisePnl(i.ledger, i.asOf, i.equity, i.fxToBase);
  const days = [
    ...i.ledger.positions.map((p) => p.closeDate).filter((d): d is ISODate => d !== null),
    ...i.ledger.marks.map((m) => m.day),
  ].filter((d) => d < i.asOf);
  const prevDay = days.length ? days.reduce((a, b) => (a > b ? a : b)) : null;
  const previous = prevDay ? summarisePnl(i.ledger, prevDay, i.equity, i.fxToBase) : null;
  const tier = tierCrossed(i.governor.degearTiers, previous, today);
  if (!tier) return null;
  return {
    tier,
    alert: {
      level: tier.multiplier === 0 ? 'fail' : 'warn',
      code: 'drawdown_tier',
      text: `portfolio drawdown ${today.drawdownPct?.toFixed(1)}% of equity (${Math.round(today.drawdown).toLocaleString('en-US')} ${i.baseCurrency} under the P&L peak) crossed the ${tier.drawdownPct}% tier: new puts sized x${tier.multiplier.toFixed(2)}`,
    },
  };
}

/** True when a mark job already reported a tier crossing for this day (a rerun must not push it twice). */
async function tierAlreadyReported(db: Parameters<typeof startJob>[0], asOf: ISODate): Promise<boolean> {
  const rows = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(like(jobRuns.job, 'mark-positions%'), sql`${jobRuns.meta}->>'drawdownTierAsOf' = ${asOf}`))
    .limit(1);
  return rows.length > 0;
}

const MARKET_TZ: Record<Market, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong' };

/** The calendar date it is in the market's own time zone (the HK mark job runs a day ahead of New York). */
export function dateInMarketTz(now: Date, market: Market): ISODate {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TZ[market], year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Marks open puts. With `market` set (the scheduled per-market jobs) only that market's puts are marked and the date is
 * that market's own today: at 18:15 Hong Kong time the HK session is complete, while New York's "last completed session"
 * would still be the day before.
 */
export async function runMarkJob(deps: JobDeps, opts: { asOf?: ISODate; market?: Market } = {}): Promise<JobOutcome> {
  const { ctx } = deps;
  const asOf = opts.asOf ?? (opts.market === 'HK' ? dateInMarketTz(ctx.now(), 'HK') : defaultAsOf(ctx.now()));
  const markets = opts.market ? [opts.market] : undefined;
  const name = opts.market ? `mark-positions-${opts.market.toLowerCase()}` : 'mark-positions';
  return recorded(deps, name, { asOf }, async () => {
    const db = ctx.db().db;
    const { params } = await loadParams(db);
    const ids = (await listOpenPositions(db))
      .filter((p) => !markets || markets.includes(p.market))
      .map((p) => p.positionId);
    const before = await latestMarks(db, ids);
    const res = await markOpenPositions(db, {
      asOf,
      params,
      knownThrough: ctx.now().toISOString().slice(0, 10),
      ...(markets ? { markets } : {}),
    });
    const fresh = newAlerts(before, res.marked);
    // the governor reads today's marks: a tier crossed today is one alert for the whole portfolio
    const settings = await getSettings(db);
    const portfolio = await loadPortfolio(db, asOf);
    const crossed = drawdownTierAlert({
      ledger: await loadLedger(db),
      governor: settings.governor,
      asOf,
      equity: settings.equity,
      baseCurrency: settings.baseCurrency,
      fxToBase: portfolio.fxToBase,
    });
    const tierAlert = crossed && !(await tierAlreadyReported(db, asOf)) ? crossed : null;
    const lines = [
      ...fresh.map((f) => `${f.symbol}: ${f.alert.text}`),
      ...(tierAlert ? [`portfolio: ${tierAlert.alert.text}`] : []),
    ];
    if (deps.notifier && lines.length > 0) {
      await deps.notifier.send({
        title: `Option Trading: ${lines.length} new alert${lines.length === 1 ? '' : 's'} (${asOf})`,
        lines,
      });
    }
    const skipped = res.skipped.length
      ? `, ${res.skipped.length} skipped (${res.skipped.map((s) => s.symbol).join(', ')})`
      : '';
    return {
      status: res.skipped.length > 0 ? 'partial' : 'ok',
      rows: res.marked.length,
      detail: `${res.marked.length} marked, ${lines.length} new alerts${tierAlert ? ' (drawdown tier crossed)' : ''}${skipped}`,
      ...(tierAlert ? { meta: { drawdownTierAsOf: asOf, drawdownTier: tierAlert.tier.drawdownPct } } : {}),
    };
  });
}

// -------------------------------------------------------------------------------------------------------- ingest
export interface IngestJobOptions {
  market?: 'US' | 'HK';
  steps?: IngestStep[];
}

export async function runIngestJob(deps: JobDeps, opts: IngestJobOptions = {}): Promise<JobOutcome> {
  const { ctx } = deps;
  const name = opts.market ? `ingest-${opts.market.toLowerCase()}` : 'ingest';
  return recorded(deps, name, opts, async () => {
    const db = ctx.db().db;
    const only = opts.market
      ? (await listWatchlist(db, { activeOnly: true })).filter((w) => w.market === opts.market).map((w) => w.symbol)
      : undefined;
    if (only && only.length === 0) return { status: 'ok', rows: 0, detail: `no active ${opts.market} names` };
    const futu = futuFromEnv(process.env);
    try {
      const summary = await runIngest(
        {
          db,
          client: new YahooClient({ fetch: ctx.fetch }),
          futu: futu ?? undefined,
          fetch: ctx.fetch,
          now: ctx.now(),
          dataDir: ctx.dataDir,
          readFile: (p) => ctx.readFile(p),
          fileExists: (p) => ctx.fileExists(p),
          log: deps.log,
        },
        { ...(opts.steps ? { steps: opts.steps } : {}), ...(only ? { only } : {}) },
      );
      return {
        status: summary.failed > 0 ? 'partial' : 'ok',
        rows: summary.rowsWritten,
        detail: `${summary.items.length} steps, ${summary.failed} failed, ${summary.rowsWritten} rows`,
      };
    } finally {
      futu?.close();
    }
  });
}

// ------------------------------------------------------------------------------------------------------ daily scan
export async function runScanJob(deps: JobDeps): Promise<JobOutcome> {
  const { ctx } = deps;
  return recorded(deps, 'daily-scan', {}, async () => {
    const asOf = defaultAsOf(ctx.now());
    const started = ctx.now();
    const { report, params } = await executeRun(ctx, {
      asOf,
      mode: 'scan',
      gate: 'enforce',
      allowStale: false,
      requireEquity: true,
    });
    await saveScanRun(ctx.db().db, params, report, started);
    const ranked = report.shortlist.US.length + report.shortlist.HK.length;
    return { status: 'ok', rows: ranked, detail: `${asOf}: ${ranked} ideas shortlisted` };
  });
}

// ------------------------------------------------------------------------------------------------------------ news
/**
 * What the news jobs need from the model side. `src/jobs` may not import `server`, so the API process hands these in
 * (src/server/services/news-service.ts); without them (the CLI) the model-bound jobs say so and do nothing.
 */
export interface NewsJobPorts {
  /** False when the schedule must not call the model: `OT_AI_AUTO=off`, or no executor on this machine. */
  auto: boolean;
  classify?(): Promise<{ rows: number; failed: boolean; detail: string }>;
  brief?(session: NewsSession): Promise<{ rows: number; failed: boolean; detail: string }>;
}

/** Fetches every feed for the active watchlist plus the market-wide feeds and stores the stories not seen before. */
export async function runNewsFetchJob(deps: JobDeps, opts: { scheduled?: boolean } = {}): Promise<JobOutcome> {
  const { ctx } = deps;
  if (opts.scheduled && !newsFetchDue(ctx.now()))
    return { status: 'ok', rows: 0, detail: 'off-hours tick: the feeds are fetched hourly outside market hours' };
  return recorded(deps, 'news-fetch', {}, async () => {
    const db = ctx.db().db;
    const watch = await listWatchlist(db, { activeOnly: true });
    const byKey = new Map<string, number>(watch.map((w) => [`${w.market}:${w.symbol}`, w.id]));
    const names: NewsName[] = watch.map((w) => {
      const y = w.providerSymbols.yahoo;
      return { market: w.market, symbol: w.symbol, ...(typeof y === 'string' && y ? { yahoo: y } : {}) };
    });
    // A name that was paused after a put was opened still needs its news.
    for (const p of await listOpenPositions(db)) {
      const key = `${p.market}:${p.symbol}`;
      if (byKey.has(key)) continue;
      byKey.set(key, p.instrumentId);
      names.push({ market: p.market, symbol: p.symbol });
    }
    const now = ctx.now();
    const res = await collectNews({ fetch: ctx.fetch, now, names });
    const seen = new Set<string>();
    const rows: NewNewsItem[] = [];
    for (const s of res.items) {
      const instrumentId = s.target ? (byKey.get(`${s.target.market}:${s.target.symbol}`) ?? null) : null;
      if (s.target && instrumentId === null) continue;
      if (!isHttpUrl(s.url)) continue;
      const hash = newsHash(s.url);
      const key = `${instrumentId ?? 'm'}|${hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        instrumentId,
        source: s.source,
        url: canonicalUrl(s.url),
        title: s.title.slice(0, 500),
        snippet: s.snippet,
        publishedAt: s.publishedAt,
        fetchedAt: now,
        hash,
      });
    }
    const inserted = await insertNewsItems(db, rows);
    const failedFeeds = res.errors.length;
    const sample = res.errors.slice(0, 3).join(' | ');
    return {
      status: failedFeeds === 0 ? 'ok' : failedFeeds >= res.feeds ? 'failed' : 'partial',
      rows: inserted,
      detail: `${inserted} new of ${rows.length} stories from ${res.feeds - failedFeeds}/${res.feeds} feeds${sample ? `; failed: ${sample}` : ''}`,
    };
  });
}

/** Judges new stories against each name's standing (a model call per story, capped and budgeted). */
export async function runNewsClassifyJob(deps: JobDeps, opts: { scheduled?: boolean } = {}): Promise<JobOutcome> {
  const news = deps.news;
  const classify = news?.classify;
  if (!news || !classify)
    return { status: 'ok', rows: 0, detail: 'no model attached to this process (the API server provides it)' };
  if (opts.scheduled && !news.auto)
    return { status: 'ok', rows: 0, detail: 'automatic classification is off (OT_AI_AUTO=off or no AI executor)' };
  return recorded(deps, 'news-classify', {}, async () => {
    const r = await classify.call(news);
    return { status: r.failed ? 'partial' : 'ok', rows: r.rows, detail: r.detail };
  });
}

/** Writes the market brief for one session, on a trading day of that session's market. */
export async function runNewsBriefJob(
  deps: JobDeps,
  session: 'hk_open' | 'us_open',
  opts: { scheduled?: boolean } = {},
): Promise<JobOutcome> {
  const news = deps.news;
  const brief = news?.brief;
  if (!news || !brief)
    return { status: 'ok', rows: 0, detail: 'no model attached to this process (the API server provides it)' };
  if (opts.scheduled && !news.auto)
    return { status: 'ok', rows: 0, detail: 'automatic briefs are off (OT_AI_AUTO=off or no AI executor)' };
  if (opts.scheduled && !briefSessionDue(session, deps.ctx.now()))
    return { status: 'ok', rows: 0, detail: `not a ${session === 'hk_open' ? 'Hong Kong' : 'US'} trading day` };
  return recorded(deps, 'news-brief', { session }, async () => {
    const r = await brief.call(news, session);
    return { status: r.failed ? 'failed' : 'ok', rows: r.rows, detail: r.detail };
  });
}

// ------------------------------------------------------------------------------------------------------ reminders
/**
 * What the reminders digest needs from the service side. `src/jobs` may not import `server`, so the API process hands
 * this in; without it (the CLI) the digest step says so and does nothing.
 */
export interface RemindersJobPorts {
  digest(today: ISODate): Promise<{ items: number; detail: string; failed: boolean }>;
}

/** Sends a morning summary of today's reminders via the notifier. */
export async function runRemindersDigestJob(deps: JobDeps, opts: { today?: ISODate } = {}): Promise<JobOutcome> {
  const reminders = deps.reminders;
  if (!reminders)
    return { status: 'ok', rows: 0, detail: 'no reminders service attached (the API server provides it)' };
  const today = opts.today ?? dateInMarketTz(deps.ctx.now(), 'HK');
  return recorded(deps, 'reminders-digest', { today }, async () => {
    const r = await reminders.digest(today);
    if (deps.notifier && r.items > 0)
      await deps.notifier.send({
        title: `Option Trading: ${r.items} reminder${r.items === 1 ? '' : 's'} (${today})`,
        lines: [r.detail],
      });
    return { status: r.failed ? 'partial' : 'ok', rows: r.items, detail: r.detail };
  });
}

// --------------------------------------------------------------------------------------------------------- leaders
/**
 * What the Leaders jobs need from the model side. `src/jobs` may not import `server`, so the API process hands this in
 * (src/server/services/leaders-service.ts); without it (the CLI) the brief step says so and does nothing.
 */
export interface LeadersJobPorts {
  /** False when the schedule must not call the model: `OT_AI_AUTO=off`, or no executor on this machine. */
  auto: boolean;
  brief?(runIds: number[]): Promise<{ rows: number; failed: boolean; detail: string }>;
}

/** The daily scan of one market (the schedule runs it after that market's universe bars are in). No model call. */
export async function runLeadersScanJob(
  deps: JobDeps,
  opts: { market: Market; asOf?: ISODate; scheduled?: boolean },
): Promise<JobOutcome> {
  const { ctx } = deps;
  if (opts.scheduled && !isTradingDay(opts.market, dateInMarketTz(ctx.now(), opts.market)))
    return { status: 'ok', rows: 0, detail: `not a ${opts.market} trading day` };
  return recorded(deps, 'leaders-scan', { market: opts.market, asOf: opts.asOf ?? null }, async () => {
    const out = await runLeadersScan(
      {
        db: ctx.db().db,
        now: ctx.now,
        log: deps.log,
        earnings: yahooEarningsPort(new YahooClient({ fetch: ctx.fetch })),
      },
      { market: opts.market, ...(opts.asOf ? { asOf: opts.asOf } : {}) },
    );
    return {
      status: out.status,
      rows: out.shortlisted,
      detail: `${out.market} ${out.asOf}: ${out.screened} screened, ${out.leaders} leaders, ${out.consolidating} consolidating, ${out.shortlisted} listed (${out.setups} setup, ${out.watches} watch) in ${out.durationMs} ms`,
      runIds: [out.runId],
    };
  });
}

/** Writes the model's lead and one-line texts for the given runs (stage L4). Skips when no model is attached. */
export async function runLeadersBriefJob(
  deps: JobDeps,
  runIds: number[],
  opts: { scheduled?: boolean } = {},
): Promise<JobOutcome> {
  const leaders = deps.leaders;
  const brief = leaders?.brief;
  if (!leaders || !brief)
    return { status: 'ok', rows: 0, detail: 'no model attached to this process (the API server provides it)' };
  if (opts.scheduled && !leaders.auto)
    return { status: 'ok', rows: 0, detail: 'automatic briefs are off (OT_AI_AUTO=off or no AI executor)' };
  if (runIds.length === 0) return { status: 'ok', rows: 0, detail: 'no run to write a brief for' };
  return recorded(deps, 'leaders-brief', { runIds }, async () => {
    const r = await brief.call(leaders, runIds);
    return { status: r.failed ? 'partial' : 'ok', rows: r.rows, detail: r.detail };
  });
}
