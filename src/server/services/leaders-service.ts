import { lastTradingDayOnOrBefore, type Market } from '../../core/calendar';
import { addDays, type ISODate } from '../../core/dates';
import { hkDayOf } from '../../core/news';
import {
  clearMute,
  getCandidate,
  getMute,
  listCandidates,
  listWatchlistIds,
  runInFlight,
  setMute,
} from '../../db/leaders';
import { getInstrument, loadParams, upsertInstrument } from '../../db/repos';
import { type JobDeps, type LeadersJobPorts, runLeadersScanJob } from '../../jobs/jobs';
import { type EarningsLookup, leadersAsOf, runLeadersScan, yahooEarningsPort } from '../../jobs/leaders-scan';
import { buildLeadersDays, buildLeadersRecord, buildLeadersView } from '../../leaders/view';
import { ingestUniverseBars } from '../../providers/universe/ingest';
import { YahooClient } from '../../providers/yahoo/client';
import type {
  LeaderMuteInput,
  LeaderMuteView,
  LeaderRecordView,
  LeaderStage,
  LeadersDaysView,
  LeadersRefreshView,
  LeadersView,
  LeaderWatchView,
} from '../api-types';
import { cliContextOf, type ServerDeps } from '../deps';
import { badRequest, notFound } from '../errors';
import { writeLeadersBrief } from '../leaders/brief';
import { type LeadersConfig, leadersConfigFromEnv } from '../leaders/config';
import { FakeExecutor } from '../research/executor';
import type { AppState } from './state';
import type { WatchService } from './watch-service';

/** What the scheduler offers: queue a named job. Without one a refresh runs in this process. */
export interface LeadersLauncher {
  trigger(name: string, data?: Record<string, unknown>): Promise<string | null>;
}

/** What one model-bound step reports back to a job. */
interface StepResult {
  rows: number;
  failed: boolean;
  detail: string;
}

/** A refresh that was queued but never started (the scheduler went away) stops counting after this long. */
const PENDING_STALE_MS = 30 * 60_000;
/** A manual refresh within this long of the last one is not queued again. */
const DEBOUNCE_MS = 30 * 60_000;
const DEFAULT_MUTE_DAYS = 10;
const MAX_MUTE_DAYS = 60;

/**
 * The Leaders page: the combined daily list of the two markets, the funnel, the archive and the app's own record, plus the
 * actions on a name (dismiss, add to the watchlist). Display only: nothing here is read by a skill or changes the scan.
 */
export class LeadersService {
  readonly config: LeadersConfig;
  private launcher: LeadersLauncher | null = null;
  private pendingSince: number | null = null;
  private lastRefreshAt: number | null = null;
  private active: Promise<void> = Promise.resolve();
  /** Replaced in tests; the default fetches the next earnings date from Yahoo's calendar. */
  earnings: ((i: import('../../core/types').Instrument) => Promise<EarningsLookup | null>) | null = null;
  /** Fetches the bars of one market's universe before a manual scan; a warm run makes no call. Replaced in tests. */
  ingestUniverse: (market: Market, asOf: ISODate) => Promise<void> = async (market, asOf) => {
    await ingestUniverseBars(
      { db: this.db, client: new YahooClient({ fetch: this.deps.fetch }), now: this.deps.now(), log: this.deps.log },
      { market, asOf },
    );
  };
  private briefing: Promise<StepResult> | null = null;
  /** Cost of briefs that were rejected (no row carries it), per Hong Kong day, so the day's budget still counts it. */
  private readonly rejectedSpend = new Map<string, number>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly watch: WatchService,
  ) {
    this.config = { ...leadersConfigFromEnv(process.env), ...(deps.leaders ?? {}) };
  }

  /** Called when the scheduler starts: a refresh then goes through pg-boss (its `leaders-refresh` handler calls `runRefresh`). */
  attachScheduler(launcher: LeadersLauncher | null): void {
    this.launcher = launcher;
  }

  /** Resolves when the refresh running in this process has finished (tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.active;
  }

  private get db() {
    return this.deps.db;
  }

  /** A model can answer Leaders prompts: the claude CLI, or a fake that is scripted to write answers. */
  get aiAvailable(): boolean {
    const r = this.deps.research;
    if (r.executorKind === 'none') return false;
    return !(r.executor instanceof FakeExecutor) || r.executor.scripted;
  }

  private jobDeps(): JobDeps {
    return { ctx: cliContextOf(this.deps), notifier: null, log: this.deps.log, leaders: this.jobPorts() };
  }

  // ------------------------------------------------------------------------------------------------------- reads
  async view(q: {
    date?: ISODate;
    stage?: LeaderStage;
    market?: Market;
    state?: 'setup' | 'watch' | 'all';
  }): Promise<LeadersView> {
    const now = this.deps.now();
    const refreshing = await this.isRefreshing(now);
    const view = await buildLeadersView(this.db, {
      now,
      refreshing,
      ai: { available: this.aiAvailable, auto: this.aiAvailable && this.config.auto, model: this.config.model },
      ...(q.date ? { date: q.date } : {}),
      ...(q.stage ? { stage: q.stage } : {}),
    });
    // the funnel and the dropped row always describe the whole day; only the listing is narrowed
    const market = q.market;
    const state = q.state && q.state !== 'all' ? q.state : null;
    if (!market && !state) return view;
    return {
      ...view,
      candidates: view.candidates.filter((c) => (!market || c.market === market) && (!state || c.state === state)),
    };
  }

  days(month: string): Promise<LeadersDaysView> {
    return buildLeadersDays(this.db, month);
  }

  record(window: '60' | 'all'): Promise<LeaderRecordView> {
    return buildLeadersRecord(this.db, window);
  }

  private async isRefreshing(now: Date): Promise<boolean> {
    const stale = now.getTime() - PENDING_STALE_MS;
    if (this.pendingSince !== null && this.pendingSince > stale) return true;
    return runInFlight(this.db, new Date(stale));
  }

  // ----------------------------------------------------------------------------------------------------- refresh
  /** Queues the scan of both markets. Returns at once; a refresh within 30 minutes of the last one is not queued again. */
  async refresh(): Promise<LeadersRefreshView> {
    const now = this.deps.now().getTime();
    if (this.pendingSince !== null && now - this.pendingSince < PENDING_STALE_MS)
      return { queued: false, message: 'A scan is already running.' };
    if (this.lastRefreshAt !== null && now - this.lastRefreshAt < DEBOUNCE_MS) {
      const mins = Math.max(1, Math.ceil((DEBOUNCE_MS - (now - this.lastRefreshAt)) / 60_000));
      return { queued: false, message: `Scanned a moment ago: try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
    }
    this.pendingSince = now;
    this.lastRefreshAt = now;
    if (this.launcher) {
      const id = await this.launcher.trigger('leaders-refresh', {});
      if (id !== null) return { queued: true, message: 'Scan queued for both markets.' };
    }
    this.active = this.runRefresh();
    return { queued: true, message: 'Scan started for both markets.' };
  }

  /** The refresh body: bars (a warm run makes no call), then the scan of each market, then the briefs. Also the pg-boss handler. */
  async runRefresh(): Promise<void> {
    this.pendingSince = this.deps.now().getTime();
    const ids: number[] = [];
    try {
      for (const market of ['HK', 'US'] as Market[]) {
        try {
          const asOf = leadersAsOf(market, this.deps.now());
          try {
            await this.ingestUniverse(market, asOf);
          } catch (err) {
            this.deps.log(`leaders refresh ${market}: bars could not be fetched: ${(err as Error).message}`);
          }
          const out = await runLeadersScan(
            {
              db: this.db,
              now: this.deps.now,
              log: this.deps.log,
              earnings: this.earnings ?? yahooEarningsPort(new YahooClient({ fetch: this.deps.fetch })),
            },
            { market, asOf },
          );
          ids.push(out.runId);
        } catch (err) {
          this.deps.log(`leaders refresh ${market} failed: ${(err as Error).message}`);
        }
      }
      if (ids.length > 0 && this.aiAvailable) {
        try {
          await this.brief(ids);
        } catch (err) {
          this.deps.log(`leaders refresh: brief failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.pendingSince = null;
      this.state.bump();
    }
  }

  private extraSpentUsd(): number {
    return this.rejectedSpend.get(hkDayOf(this.deps.now())) ?? 0;
  }

  private addRejectedSpend(usd: number): void {
    const day = hkDayOf(this.deps.now());
    this.rejectedSpend.set(day, (this.rejectedSpend.get(day) ?? 0) + usd);
    for (const k of this.rejectedSpend.keys()) if (k !== day) this.rejectedSpend.delete(k);
  }

  /** Writes the brief of each given run (one model call each). One at a time: a second caller joins the one in flight. */
  brief(runIds: number[]): Promise<StepResult> {
    if (!this.aiAvailable) return Promise.resolve({ rows: 0, failed: false, detail: 'no AI executor on this machine' });
    this.briefing ??= (async () => {
      try {
        let rows = 0;
        let failed = false;
        const details: string[] = [];
        for (const id of runIds) {
          const r = await writeLeadersBrief(
            {
              db: this.db,
              executor: this.deps.research.executor,
              config: this.config,
              now: this.deps.now,
              log: this.deps.log,
              extraSpentUsd: () => this.extraSpentUsd(),
              onRejectedCost: (usd) => this.addRejectedSpend(usd),
            },
            id,
          );
          if (r.written) rows++;
          if (r.failed) failed = true;
          details.push(r.detail);
        }
        return { rows, failed, detail: details.join('; ') };
      } finally {
        this.briefing = null;
        this.state.bump();
      }
    })();
    return this.briefing;
  }

  /** What the scheduled jobs call into: the model-bound brief (src/jobs may not import this module). */
  jobPorts(): LeadersJobPorts {
    return {
      auto: this.aiAvailable && this.config.auto,
      brief: (runIds) => this.brief(runIds),
    };
  }

  // -------------------------------------------------------------------------------------------------- the actions
  /** "Dismiss": the scan skips the name for `days` trading days. */
  async mute(candidateId: number, input: LeaderMuteInput): Promise<LeaderMuteView> {
    const c = await getCandidate(this.db, candidateId);
    if (!c) throw notFound(`no leaders candidate ${candidateId}`);
    const days = input.days ?? DEFAULT_MUTE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_MUTE_DAYS)
      throw badRequest('invalid_days', `days must be a whole number from 1 to ${MAX_MUTE_DAYS}`);
    const reason = (input.reason ?? 'dismissed').trim().slice(0, 200) || 'dismissed';
    const today = this.deps.now().toISOString().slice(0, 10);
    // trading days of the name's own market, counted from today
    let until = today;
    let left = days;
    while (left > 0) {
      until = addDays(until, 1);
      try {
        if (lastTradingDayOnOrBefore(c.market, until) === until) left--;
      } catch {
        left--;
      }
    }
    await setMute(this.db, c.instrumentId, until, reason);
    this.state.bump();
    return { days, until, reason };
  }

  async unmute(candidateId: number): Promise<{ ok: true }> {
    const c = await getCandidate(this.db, candidateId);
    if (!c) throw notFound(`no leaders candidate ${candidateId}`);
    await clearMute(this.db, c.instrumentId);
    this.state.bump();
    return { ok: true };
  }

  /** "Add to watchlist": the name joins the normal daily ingest and the sell-put scan. */
  async addToWatchlist(candidateId: number): Promise<LeaderWatchView> {
    const c = await getCandidate(this.db, candidateId);
    if (!c) throw notFound(`no leaders candidate ${candidateId}`);
    const inst = await getInstrument(this.db, c.instrumentId);
    if (!inst) throw notFound('the instrument is gone');
    if ((await listWatchlistIds(this.db)).has(inst.id)) return { ok: true, market: inst.market, symbol: inst.symbol };
    // universe names are stored without listed options so the daily ingest leaves them alone; a followed name gets the full ingest
    await upsertInstrument(this.db, { market: inst.market, symbol: inst.symbol, hasListedOptions: true });
    const stockLot = inst.providerSymbols.stockLot;
    await this.watch.add({
      symbol: inst.symbol,
      market: inst.market,
      ...(inst.market === 'HK'
        ? { boardLot: typeof stockLot === 'number' && stockLot > 0 ? stockLot : inst.multiplier }
        : {}),
    });
    this.state.bump();
    return { ok: true, market: inst.market, symbol: inst.symbol };
  }

  /** Used by the brief and the CLI: the candidate rows of the given runs. */
  rowsOf(runIds: number[]) {
    return listCandidates(this.db, runIds);
  }

  async muteOf(instrumentId: number) {
    return getMute(this.db, instrumentId);
  }

  /** The parameters in force (shortlist size etc.), for callers that need them. */
  async params() {
    return (await loadParams(this.db)).params['leaders.pullback'];
  }

  /** In-process run of one market (tests, and the CLI-equivalent path of the server). */
  async scanNow(market: Market) {
    return runLeadersScanJob(this.jobDeps(), { market });
  }
}
