import { desc, inArray } from 'drizzle-orm';
import { isTradingDay } from '../../core/calendar';
import { type ISODate, isWeekend, startOfNextMonth } from '../../core/dates';
import { hkDayOf, hkDayStart, type NewsImpact, type NewsSession, newsWindow } from '../../core/news';
import {
  aiSpendSince,
  type BriefRow,
  briefDaysBetween,
  countUnclassified,
  earliestBriefDay,
  earliestNewsDay,
  lastNewsFetchAt,
  listBriefsForDay,
  listNewsItems,
  type NewsItemRow,
  newsImpactsByDay,
  searchNewsItems,
} from '../../db/news';
import { jobRuns } from '../../db/schema';
import { type JobDeps, type NewsJobPorts, runNewsFetchJob } from '../../jobs/jobs';
import type {
  NewsBriefDayView,
  NewsBriefView,
  NewsDaysView,
  NewsGroupView,
  NewsItemView,
  NewsRefreshView,
  NewsScope,
  NewsSearchView,
  NewsStatusView,
  NewsView,
} from '../api-types';
import { cliContextOf, type ServerDeps } from '../deps';
import { writeBrief } from '../news/brief';
import { classifyDetail, classifyPending } from '../news/classify';
import { type NewsConfig, newsConfigFromEnv } from '../news/config';
import { inScope, type NameState, resolveNames } from '../news/standing';
import { FakeExecutor } from '../research/executor';
import type { AppState } from './state';

/** What the scheduler offers: queue a named job. Without one a refresh runs in this process. */
export interface NewsLauncher {
  trigger(name: string, data?: Record<string, unknown>): Promise<string | null>;
}

const SEVERITY: Record<NewsImpact | 'none', number> = { blocks: 0, caution: 1, supports: 2, neutral: 3, none: 4 };
/** What one model-bound step reports back to a job. */
interface StepResult {
  rows: number;
  failed: boolean;
  detail: string;
}

/** A refresh that was queued but never started (the scheduler went away) stops counting after this long. */
const PENDING_STALE_MS = 20 * 60_000;

function itemView(r: NewsItemRow): NewsItemView {
  return {
    id: r.id,
    source: r.source,
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    publishedAt: r.publishedAt.toISOString(),
    day: hkDayOf(r.publishedAt),
    impact: r.impact,
    summary: r.impact ? r.summary : null,
    rules: r.impact ? (r.rules ?? []) : [],
    standingThen: r.impact ? r.standing : null,
    judgedAt: r.impact ? (r.knownAt?.toISOString() ?? null) : null,
    confidence: r.impact ? r.confidence : null,
    model: r.impact ? r.model : null,
  };
}

function briefView(b: BriefRow): NewsBriefView {
  return {
    id: b.id,
    session: b.session,
    asOf: b.asOf.toISOString(),
    lead: b.lead,
    bullets: b.bullets,
    forPuts: b.forPuts,
    tape: b.tape,
    sources: b.citations,
    model: b.model,
  };
}

/**
 * The News page: stories that touch the shortlist, the open puts and the rest of the watchlist, a market brief, and a
 * day navigator over everything kept. Display only: nothing here is read by a skill or changes the scan.
 */
export class NewsService {
  readonly config: NewsConfig;
  private launcher: NewsLauncher | null = null;
  private pendingSince: number | null = null;
  private active: Promise<void> = Promise.resolve();
  private classifying: Promise<StepResult> | null = null;
  private briefing: Promise<StepResult> | null = null;
  /** Cost of briefs that were rejected (no row carries it), per Hong Kong day, so the day's budget still counts it. */
  private readonly rejectedSpend = new Map<string, number>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
  ) {
    this.config = { ...newsConfigFromEnv(process.env), ...(deps.news ?? {}) };
  }

  /** Called when the scheduler starts: a refresh then goes through pg-boss (its `news-refresh` handler calls `runRefresh`). */
  attachScheduler(launcher: NewsLauncher | null): void {
    this.launcher = launcher;
  }

  /** Resolves when the refresh running in this process has finished (tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.active;
  }

  private get db() {
    return this.deps.db;
  }

  /** A model can answer news prompts: the claude CLI, or a fake that is scripted to write answers (the demo fake cannot). */
  get aiAvailable(): boolean {
    const r = this.deps.research;
    if (r.executorKind === 'none') return false;
    return !(r.executor instanceof FakeExecutor) || r.executor.scripted;
  }

  private extraSpentUsd(): number {
    return this.rejectedSpend.get(hkDayOf(this.deps.now())) ?? 0;
  }

  private addRejectedSpend(usd: number): void {
    const day = hkDayOf(this.deps.now());
    this.rejectedSpend.set(day, (this.rejectedSpend.get(day) ?? 0) + usd);
    for (const k of this.rejectedSpend.keys()) if (k !== day) this.rejectedSpend.delete(k);
  }

  private jobDeps(): JobDeps {
    return { ctx: cliContextOf(this.deps), notifier: null, log: this.deps.log };
  }

  // ------------------------------------------------------------------------------------------------------- reads
  async view(q: { scope: NewsScope; date?: ISODate; days: number; hideNeutral: boolean }): Promise<NewsView> {
    const now = this.deps.now();
    const today = hkDayOf(now);
    const date = q.date && q.date < today ? q.date : today;
    const names = await resolveNames(this.db, now);
    const scoped = inScope(names, q.scope);
    const win = newsWindow(date, q.days, now);
    const rows = await listNewsItems(this.db, {
      from: win.from,
      to: win.to,
      instrumentIds: scoped.map((n) => n.instrumentId),
    });
    const { groups, quiet, total } = this.group(scoped, rows, q.hideNeutral);
    return {
      scope: q.scope,
      date,
      today,
      days: q.days,
      rolling: win.rolling,
      hideNeutral: q.hideNeutral,
      counts: {
        shortlist: inScope(names, 'shortlist').length,
        positions: inScope(names, 'positions').length,
        all: names.length,
      },
      groups,
      quiet,
      total,
      status: await this.status(now),
    };
  }

  async days(q: { month: string; scope: NewsScope; hideNeutral: boolean }): Promise<NewsDaysView> {
    const now = this.deps.now();
    const today = hkDayOf(now);
    const first = `${q.month}-01`;
    const next = startOfNextMonth(first);
    const names = inScope(await resolveNames(this.db, now), q.scope);
    const [impacts, briefs, earliestItem, earliestBrief] = await Promise.all([
      newsImpactsByDay(this.db, {
        from: hkDayStart(first),
        to: hkDayStart(next),
        instrumentIds: names.map((n) => n.instrumentId),
        hideNeutral: q.hideNeutral,
      }),
      briefDaysBetween(this.db, first, next),
      earliestNewsDay(this.db),
      earliestBriefDay(this.db),
    ]);
    const keys = new Set<ISODate>([...impacts.keys(), ...[...briefs].filter((d) => d < next)]);
    const days = [...keys]
      .filter((d) => d >= first && d < next && d <= today)
      .sort()
      .map((day) => ({
        day,
        impacts: ([...(impacts.get(day) ?? [])] as (NewsImpact | 'none')[]).sort((a, b) => SEVERITY[a] - SEVERITY[b]),
        brief: briefs.has(day),
      }));
    const earliest = [earliestItem, earliestBrief].filter((d): d is ISODate => d !== null).sort()[0] ?? null;
    return { month: q.month, scope: q.scope, days, today, earliest };
  }

  async search(q: { q: string; scope: NewsScope }): Promise<NewsSearchView> {
    const now = this.deps.now();
    const scoped = inScope(await resolveNames(this.db, now), q.scope);
    const rows = await searchNewsItems(this.db, { q: q.q, instrumentIds: scoped.map((n) => n.instrumentId) });
    const { groups, total } = this.group(scoped, rows, false);
    return { q: q.q, scope: q.scope, total, groups };
  }

  async briefs(date: ISODate): Promise<NewsBriefDayView> {
    const today = hkDayOf(this.deps.now());
    const [rows, first] = await Promise.all([listBriefsForDay(this.db, date), earliestBriefDay(this.db)]);
    let none: NewsBriefDayView['none'] = null;
    if (rows.length === 0) {
      if (date > today) none = 'not_yet';
      else if (first !== null && date < first) none = 'before_start';
      else if (isWeekend(date)) none = 'weekend';
      else if (!this.anyMarketOpen(date)) none = 'holiday';
      else none = 'not_written';
    }
    return { date, briefs: rows.map(briefView), none, firstBriefDay: first };
  }

  private anyMarketOpen(day: ISODate): boolean {
    try {
      return isTradingDay('HK', day) || isTradingDay('US', day);
    } catch {
      return true; // outside the calendar tables: do not claim a holiday
    }
  }

  /** Groups stories by name: the most severe impact first, then the newest story. Names with no story are the quiet row. */
  private group(
    names: readonly NameState[],
    rows: readonly NewsItemRow[],
    hideNeutral: boolean,
  ): { groups: NewsGroupView[]; quiet: NewsView['quiet']; total: number } {
    const byId = new Map<number, NewsItemRow[]>();
    for (const r of rows) {
      if (r.instrumentId === null) continue;
      if (hideNeutral && r.impact === 'neutral') continue;
      const list = byId.get(r.instrumentId) ?? [];
      list.push(r);
      byId.set(r.instrumentId, list);
    }
    const groups: (NewsGroupView & { rank: number; newest: number })[] = [];
    const quiet: NewsView['quiet'] = [];
    let total = 0;
    for (const n of names) {
      const items = byId.get(n.instrumentId);
      if (!items || items.length === 0) {
        quiet.push({ market: n.market, symbol: n.symbol });
        continue;
      }
      total += items.length;
      groups.push({
        market: n.market,
        symbol: n.symbol,
        name: n.name,
        price: n.price,
        changePct: n.changePct,
        standing: n.standing,
        hasOpenPosition: n.hasOpenPosition,
        items: items.map(itemView),
        rank: Math.min(...items.map((i) => SEVERITY[i.impact ?? 'none'])),
        newest: Math.max(...items.map((i) => i.publishedAt.getTime())),
      });
    }
    groups.sort((a, b) => a.rank - b.rank || b.newest - a.newest);
    return { groups: groups.map(({ rank: _r, newest: _n, ...g }) => g), quiet, total };
  }

  async status(now: Date): Promise<NewsStatusView> {
    const [fetchedAt, unclassified, spent, earliest, jobs] = await Promise.all([
      lastNewsFetchAt(this.db),
      countUnclassified(this.db, new Date(now.getTime() - this.config.lookbackDays * 86_400_000)),
      aiSpendSince(this.db, hkDayStart(hkDayOf(now))),
      earliestNewsDay(this.db),
      this.db
        .select()
        .from(jobRuns)
        .where(inArray(jobRuns.job, ['news-fetch', 'news-classify', 'news-brief']))
        .orderBy(desc(jobRuns.startedAt))
        .limit(12),
    ]);
    const lastFetch = jobs.find((j) => j.job === 'news-fetch' && j.status !== 'running');
    const staleBefore = now.getTime() - PENDING_STALE_MS;
    const running = jobs.some((j) => j.status === 'running' && j.startedAt.getTime() > staleBefore);
    const pending = this.pendingSince !== null && this.pendingSince > staleBefore;
    const available = this.aiAvailable;
    return {
      fetchedAt: fetchedAt?.toISOString() ?? null,
      refreshing: running || pending,
      lastFetch: lastFetch
        ? {
            status: lastFetch.status,
            finishedAt: lastFetch.finishedAt?.toISOString() ?? null,
            detail: ((lastFetch.meta as { detail?: string } | null)?.detail ?? lastFetch.error) || null,
          }
        : null,
      unclassified,
      ai: {
        available,
        auto: available && this.config.auto,
        model: this.config.model,
        budgetUsd: this.config.dailyBudgetUsd,
        spentTodayUsd: Number((spent + this.extraSpentUsd()).toFixed(4)),
      },
      earliestDay: earliest,
    };
  }

  // -------------------------------------------------------------------------------------------------- model steps
  /** Judges the stories waiting for the model. One run at a time: a second caller joins the one in flight. */
  classify(): Promise<StepResult> {
    if (!this.aiAvailable) return Promise.resolve({ rows: 0, failed: false, detail: 'no AI executor on this machine' });
    this.classifying ??= (async () => {
      try {
        const r = await classifyPending({
          db: this.db,
          executor: this.deps.research.executor,
          config: this.config,
          now: this.deps.now,
          log: this.deps.log,
          extraSpentUsd: () => this.extraSpentUsd(),
        });
        return { rows: r.judged, failed: r.aborted || r.failed > 0, detail: classifyDetail(r, this.config) };
      } finally {
        this.classifying = null;
        this.state.bump();
      }
    })();
    return this.classifying;
  }

  /** Writes the market brief for a session. One at a time: a second caller joins the one in flight. */
  brief(session: NewsSession): Promise<StepResult> {
    if (!this.aiAvailable) return Promise.resolve({ rows: 0, failed: false, detail: 'no AI executor on this machine' });
    this.briefing ??= (async () => {
      try {
        const r = await writeBrief(
          {
            db: this.db,
            executor: this.deps.research.executor,
            config: this.config,
            now: this.deps.now,
            log: this.deps.log,
            extraSpentUsd: () => this.extraSpentUsd(),
            onRejectedCost: (usd) => this.addRejectedSpend(usd),
          },
          session,
        );
        return { rows: r.written ? 1 : 0, failed: r.failed, detail: r.detail };
      } finally {
        this.briefing = null;
        this.state.bump();
      }
    })();
    return this.briefing;
  }

  /** What the scheduled jobs call into: the model-bound steps (src/jobs may not import this module). */
  jobPorts(): NewsJobPorts {
    return {
      auto: this.aiAvailable && this.config.auto,
      classify: () => this.classify(),
      brief: (session) => this.brief(session),
    };
  }

  // ----------------------------------------------------------------------------------------------------- refresh
  /** Queues a fetch of every feed (and, when a model is available, classification and a brief). Returns at once. */
  async refresh(): Promise<NewsRefreshView> {
    const now = this.deps.now().getTime();
    if (this.pendingSince !== null && now - this.pendingSince < PENDING_STALE_MS)
      return { queued: false, message: 'A refresh is already running.' };
    this.pendingSince = now;
    if (this.launcher) {
      const id = await this.launcher.trigger('news-refresh', {});
      if (id !== null) return { queued: true, message: 'Refresh queued.' };
    }
    this.active = this.runRefresh();
    return { queued: true, message: 'Refresh started.' };
  }

  /** The refresh body: fetch, then classify, then the brief. Also the pg-boss `news-refresh` handler. */
  async runRefresh(): Promise<void> {
    this.pendingSince = this.deps.now().getTime();
    try {
      const out = await runNewsFetchJob(this.jobDeps());
      if (out.status === 'failed') this.deps.log(`news refresh: fetch failed: ${out.detail}`);
    } catch (err) {
      this.deps.log(`news refresh failed: ${(err as Error).message}`);
    }
    try {
      await this.classify();
    } catch (err) {
      this.deps.log(`news refresh: classification failed: ${(err as Error).message}`);
    }
    try {
      await this.brief('manual');
    } catch (err) {
      this.deps.log(`news refresh: brief failed: ${(err as Error).message}`);
    } finally {
      this.pendingSince = null;
      this.state.bump();
    }
  }
}
