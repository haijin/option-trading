/**
 * Daily bars for the Leaders universe. Universe names that are not on the ACTIVE watchlist get bars only (no
 * fundamentals, events or chains), through the same Yahoo chart call and `writeBars` the watchlist ingest uses. The
 * names on the watchlist are left to `runIngest`.
 *
 * A name whose newest stored bar is already the as-of session is skipped without a request, so a warm run makes no HTTP
 * call at all. First load is 450 calendar days; afterwards the window starts 10 days before the newest bar, which
 * picks up a restated adjusted close (dividend, split) without refetching the history.
 */
import type { Market } from '../../core/calendar';
import { addDays, type ISODate, toISO } from '../../core/dates';
import { yahooSymbol } from '../../core/symbols';
import type { Db } from '../../db/client';
import { lastBarDay } from '../../db/repos';
import { listUniverseInstruments, type UniverseInstrument } from '../../db/universe';
import { writeBars } from '../../db/writers';
import { ProviderError, type YahooClient } from '../yahoo/client';
import { normalizeChartBars } from '../yahoo/normalize';

export const FIRST_LOAD_DAYS = 450;
export const INCREMENTAL_OVERLAP_DAYS = 10;

export interface UniverseIngestDeps {
  db: Db;
  client: Pick<YahooClient, 'chart'>;
  now: Date;
  log?(line: string): void;
  /** Called after every name (fetched, skipped, failed), so a UI can show progress. */
  onItem?(item: UniverseIngestItem): void;
  /** Pause before the one retry of a rate-limited request (default 1500 ms; tests pass 0). */
  retryDelayMs?: number;
}

export interface UniverseIngestOptions {
  market: Market;
  /** The last completed session of the market: names whose newest bar is on or after it are skipped. */
  asOf: ISODate;
  concurrency?: number;
}

export interface UniverseIngestItem {
  symbol: string;
  status: 'fetched' | 'skipped' | 'failed' | 'not_found';
  detail: string;
}

export interface UniverseIngestResult {
  /** Universe names of the market that are not on the active watchlist. */
  names: number;
  fetched: number;
  skipped: number;
  failed: number;
  notFound: number;
  /** Bar rows inserted or restated. */
  rows: number;
  /** One line per failed name. */
  failures: string[];
}

const providerSymbolOf = (i: UniverseInstrument): string => {
  const given = i.providerSymbols.yahoo;
  return typeof given === 'string' && given ? given : yahooSymbol(i.market, i.symbol);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function ingestUniverseBars(
  deps: UniverseIngestDeps,
  opts: UniverseIngestOptions,
): Promise<UniverseIngestResult> {
  const names = (await listUniverseInstruments(deps.db, opts.market)).filter((i) => !i.onWatchlist);
  const result: UniverseIngestResult = {
    names: names.length,
    fetched: 0,
    skipped: 0,
    failed: 0,
    notFound: 0,
    rows: 0,
    failures: [],
  };
  const today = toISO(deps.now);
  const to = addDays(today, 1);
  const retryDelay = deps.retryDelayMs ?? 1500;
  const report = (item: UniverseIngestItem): void => deps.onItem?.(item);

  async function fetchChart(symbol: string, from: ISODate) {
    try {
      return await deps.client.chart(symbol, from, to);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'rate_limit' || retryDelay < 0) throw err;
      await sleep(retryDelay);
      return deps.client.chart(symbol, from, to);
    }
  }

  async function one(inst: UniverseInstrument): Promise<void> {
    const last = await lastBarDay(deps.db, inst.id);
    if (last !== null && last >= opts.asOf) {
      result.skipped++;
      report({ symbol: inst.symbol, status: 'skipped', detail: `bars to ${last}` });
      return;
    }
    const from = last === null ? addDays(today, -FIRST_LOAD_DAYS) : addDays(last, -INCREMENTAL_OVERLAP_DAYS);
    try {
      const bars = normalizeChartBars(await fetchChart(providerSymbolOf(inst), from), 'yahoo');
      if (bars.length === 0 && last === null)
        throw new ProviderError('yahoo', inst.symbol, 'no bars returned', 'not_found');
      const w = await writeBars(deps.db, inst.id, bars);
      result.fetched++;
      result.rows += w.inserted + w.updated;
      report({
        symbol: inst.symbol,
        status: 'fetched',
        detail: `${bars.length} bars to ${bars[bars.length - 1]?.day ?? last}, ${w.inserted} new, ${w.updated} restated`,
      });
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : `${inst.symbol}: ${(err as Error).message}`;
      if (err instanceof ProviderError && err.code === 'not_found') {
        result.notFound++;
        report({ symbol: inst.symbol, status: 'not_found', detail: message });
      } else {
        result.failed++;
        result.failures.push(message);
        report({ symbol: inst.symbol, status: 'failed', detail: message });
      }
    }
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const inst = names[next++];
      if (!inst) return;
      await one(inst);
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, names.length));
  await Promise.all(Array.from({ length: workers }, worker));
  deps.log?.(
    `universe bars ${opts.market} as of ${opts.asOf}: ${result.names} names, ${result.fetched} fetched, ${result.skipped} up to date, ${result.failed} failed, ${result.notFound} not found, ${result.rows} rows`,
  );
  return result;
}
