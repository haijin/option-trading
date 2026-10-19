import { defaultAsOf } from '../../cli/asof';
import { listWatchlistAll, recentCloses } from '../../db/app-repos';
import type { TechnicalPayload } from '../../skills/s2-technical-timing';
import type { VolatilityPayload } from '../../skills/s3-volatility-edge';
import { priceBadge } from '../../valuation';
import type { ValueView, WatchBoardView, WatchEntryView } from '../api-types';
import type { ServerDeps } from '../deps';
import { buildBoardRow, compareBoardRows, SPARKLINE_BARS } from '../watch-board';
import type { ScanService } from './scan-service';
import type { AppState } from './state';
import type { StockService } from './stock-service';
import type { ValueService } from './value-service';
import type { WatchService } from './watch-service';

/** Names are read this many at a time: each read is a cached per-stock run, the first (cold) one costs a pipeline pass. */
const CONCURRENCY = 4;

async function inPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/**
 * The watchlist board: every watched stock with price, KPIs, a highlight line and the scan's verdict in plain words.
 * It reads what Today and Research already compute (the scan, the per-stock explain run, the valuation view), all cached
 * per data version, and adds no number of its own except the daily change from the stored closes.
 */
export class WatchBoardService {
  private cache: { version: number; view: WatchBoardView } | null = null;
  private inflight: { version: number; run: Promise<WatchBoardView> } | null = null;

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly watch: WatchService,
    private readonly scan: ScanService,
    private readonly stocks: StockService,
    private readonly values: ValueService,
  ) {}

  async board(): Promise<WatchBoardView> {
    const version = this.state.version;
    if (this.cache && this.cache.version === version) return this.cache.view;
    if (this.inflight && this.inflight.version === version) return this.inflight.run;
    const run = this.compute();
    this.inflight = { version, run };
    try {
      const view = await run;
      this.cache = { version, view };
      return view;
    } finally {
      if (this.inflight?.run === run) this.inflight = null;
    }
  }

  private async compute(): Promise<WatchBoardView> {
    const asOf = defaultAsOf(this.deps.now());
    const entries = (await this.watch.list()).filter((e) => e.active);
    const instruments = new Map((await listWatchlistAll(this.deps.db)).map((r) => [`${r.market}|${r.symbol}`, r]));
    let scan = this.scan.peek();
    if (!scan) {
      try {
        scan = await this.scan.get();
      } catch {
        scan = null; // no equity yet: the rows still show prices and KPIs, every action says it needs data
      }
    }
    const ideas = new Map((scan?.ideas ?? []).map((i) => [`${i.market}|${i.symbol}`, i]));
    const rejects = new Map((scan?.rejected ?? []).map((r) => [`${r.market}|${r.symbol}`, r]));
    const ids = entries.flatMap((e) => instruments.get(`${e.market}|${e.symbol}`)?.id ?? []);
    const closes = await recentCloses(this.deps.db, ids, asOf, SPARKLINE_BARS);

    const rows = await inPool(entries, CONCURRENCY, async (entry: WatchEntryView) => {
      const key = `${entry.market}|${entry.symbol}`;
      const inst = instruments.get(key);
      const bars = inst ? (closes.get(inst.id) ?? []) : [];
      let technical: TechnicalPayload | undefined;
      let vol: VolatilityPayload | undefined;
      let value: ValueView | null = null;
      if (inst && bars.length > 0) {
        try {
          const run = await this.stocks.explainRun(inst);
          technical = run.results['technical.timing']?.payload as TechnicalPayload | undefined;
          vol = run.results['volatility.edge']?.payload as VolatilityPayload | undefined;
        } catch {
          // the row is still useful without the timing and volatility numbers
        }
        try {
          value = await this.values.view(entry.market, entry.symbol);
        } catch {
          // ... and without the fundamentals
        }
      }
      const reject = rejects.get(key);
      return buildBoardRow({
        entry,
        asOf,
        closes: bars,
        technical: technical
          ? { support: technical.support, trendState: technical.trendState, rsi14: technical.rsi14 }
          : null,
        ivRank: vol?.ivRank ?? null,
        kpis: value?.hasFundamentals ? value.kpis : null,
        value: value?.intrinsic ? priceBadge(value.intrinsic) : null,
        screen: value?.hasFundamentals ? value.screen.verdict : null,
        idea: ideas.get(key) ?? null,
        binding: reject ? { skillId: reject.skillId, rule: reject.bindingRule, detail: reject.detail } : null,
        staleLastBar: reject?.staleLastBar ?? null,
      });
    });
    rows.sort(compareBoardRows);
    return {
      asOf,
      generatedAt: this.deps.now().toISOString(),
      rows,
      scored: scan !== null,
    };
  }
}
