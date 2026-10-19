import { eq } from 'drizzle-orm';
import { type BacktestRequest, queueBacktest, runQueuedBacktest } from '../../backtest/run';
import {
  failOrphanedBacktests,
  getBacktest,
  isBacktestId,
  listBacktests,
  listBacktestTrades,
  summaryOf,
  tradesToCsv,
} from '../../backtest/store';
import { studiesFor } from '../../backtest/studies';
import { findInstrument, loadParams } from '../../db/repos';
import { backtestRuns } from '../../db/schema';
import type {
  BacktestDetailView,
  BacktestRequestInput,
  BacktestSummaryView,
  BacktestTradeView,
  EventStudyView,
  Market,
} from '../api-types';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest, notFound } from '../errors';
import type { AppState } from './state';

const MAX_ACTIVE_RUNS = 3;

/** What the scheduler offers: queue a named job. Without one the service runs a backtest in this process. */
export interface JobLauncher {
  trigger(name: string, data?: Record<string, unknown>): Promise<string | null>;
}

/**
 * Backtests are long and CPU-heavy, so they run one at a time in the background: `start` validates the request, stores a
 * queued row and returns at once; the UI polls the run for progress. Cancelling stops the run between trading days.
 */
export class BacktestService {
  private readonly cancelled = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private launcher: JobLauncher | null = null;
  private readonly ready: Promise<unknown>;

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
  ) {
    // A run left "running" by a process that died would be polled forever.
    this.ready = failOrphanedBacktests(deps.db, 'the server restarted while this backtest was running');
  }

  /** Called when the scheduler starts: queued runs then go through pg-boss (its handler calls `execute`). */
  attachScheduler(launcher: JobLauncher | null): void {
    this.launcher = launcher;
  }

  /** Resolves when every queued run has finished (tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.tail;
  }

  async list(): Promise<BacktestSummaryView[]> {
    await this.ready;
    return listBacktests(this.deps.db);
  }

  async get(id: string): Promise<BacktestDetailView> {
    const r = await getBacktest(this.deps.db, id);
    if (!r) throw notFound(`no backtest with id ${id}`);
    return r;
  }

  async trades(id: string, shadow: boolean): Promise<BacktestTradeView[]> {
    await this.get(id);
    return listBacktestTrades(this.deps.db, id, { shadow });
  }

  async csv(id: string): Promise<string> {
    return tradesToCsv(await this.trades(id, false));
  }

  async start(input: BacktestRequestInput): Promise<BacktestSummaryView> {
    await this.ready;
    // Each run is minutes of CPU on a single-process server: cap the backlog so a double tap or a script cannot bury it.
    const active = (await listBacktests(this.deps.db, 100)).filter(
      (r) => r.status === 'queued' || r.status === 'running',
    ).length;
    if (active >= MAX_ACTIVE_RUNS)
      throw new ApiError(
        429,
        'too_many_runs',
        `${active} backtests are already queued or running; wait for one to finish`,
      );
    const id = await queueBacktest(this.deps.db, input as BacktestRequest);
    this.state.bump();
    if (this.launcher) {
      const queued = await this.launcher.trigger('run-backtest', { runId: id });
      if (queued === null) void this.enqueue(id);
    } else void this.enqueue(id);
    return this.summary(id);
  }

  /** The job body: runs one queued backtest to completion (also the pg-boss `run-backtest` handler). */
  async execute(id: string): Promise<void> {
    await this.enqueue(id);
  }

  private enqueue(id: string): Promise<void> {
    this.tail = this.tail.then(async () => {
      try {
        if (this.cancelled.has(id)) return;
        await runQueuedBacktest(this.deps.db, id, { shouldCancel: () => this.cancelled.has(id) });
      } catch (err) {
        // runBacktest has already stored the failure on the row; the log keeps the stack for the operator.
        this.deps.log(`backtest ${id} failed: ${(err as Error).message}`);
      } finally {
        this.cancelled.delete(id);
        this.state.bump();
      }
    });
    return this.tail;
  }

  async cancel(id: string): Promise<BacktestSummaryView> {
    const r = await this.summary(id);
    if (r.status === 'queued' || r.status === 'running') {
      this.cancelled.add(id);
      if (r.status === 'queued')
        await this.deps.db
          .update(backtestRuns)
          .set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled before it started' })
          .where(eq(backtestRuns.id, id));
    }
    return this.summary(id);
  }

  private async summary(id: string): Promise<BacktestSummaryView> {
    if (!isBacktestId(id)) throw notFound(`no backtest with id ${id}`);
    const [row] = await this.deps.db.select().from(backtestRuns).where(eq(backtestRuns.id, id));
    if (!row) throw notFound(`no backtest with id ${id}`);
    return summaryOf(row);
  }

  /** Signal-level event studies for one stock: what each entry rule has historically been followed by. */
  async studies(market: Market, symbol: string): Promise<EventStudyView> {
    const inst = await findInstrument(this.deps.db, market, symbol);
    if (!inst) throw badRequest('unknown_stock', `${market}:${symbol} is not in the database`);
    const { params } = await loadParams(this.deps.db);
    return studiesFor(this.deps.db, inst, {
      riskFree: market === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS,
      ivRvRatio: params['volatility.edge'].ivRvRatioDefault[market],
    });
  }
}
