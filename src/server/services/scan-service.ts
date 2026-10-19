import { defaultAsOf } from '../../cli/asof';
import { executeRun } from '../../cli/pipeline';
import { dataStatusFor } from '../../db/app-repos';
import { listOpenPositions } from '../../db/repos';
import { saveScanRun } from '../../db/scan-store';
import type { RunReport } from '../../skills/runner';
import type { ScanView } from '../api-types';
import { cliContextOf, type ServerDeps } from '../deps';
import { ideaView, isWaitingForData, openNameView, rejectView } from '../views';
import type { AppState } from './state';
import type { ValueService } from './value-service';

interface Cached {
  version: number;
  view: ScanView;
  report: RunReport;
}

/** Runs the real pipeline and maps it to a ScanView; results are cached until any write bumps the data version. */
export class ScanService {
  private cache = new Map<string, Cached>();
  private inflight = new Map<string, Promise<Cached>>();

  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly values: () => ValueService,
  ) {}

  /** The cached view when it is still valid, else null. Never runs the pipeline. */
  peek(allowStale = false, asOf?: string): ScanView | null {
    const c = this.cache.get(this.key(allowStale, asOf));
    return c && c.version === this.state.version ? c.view : null;
  }

  private key(allowStale: boolean, asOf?: string): string {
    return `${allowStale ? 'stale' : 'fresh'}|${asOf ?? 'live'}`;
  }

  async get(opts: { allowStale?: boolean; save?: boolean; asOf?: string } = {}): Promise<ScanView> {
    const allowStale = !!opts.allowStale;
    const key = this.key(allowStale, opts.asOf);
    if (!opts.save) {
      const hit = this.cache.get(key);
      if (hit && hit.version === this.state.version) return hit.view;
      const running = this.inflight.get(key);
      if (running) return (await running).view;
    }
    const run = this.compute(allowStale, !!opts.save, opts.asOf);
    this.inflight.set(key, run);
    try {
      const c = await run;
      this.cache.set(key, c);
      return c.view;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** The report behind the latest successful run (used by the stock endpoints to read skill payloads cheaply). */
  report(allowStale = false, asOf?: string): RunReport | null {
    const c = this.cache.get(this.key(allowStale, asOf));
    return c && c.version === this.state.version ? c.report : null;
  }

  private async compute(allowStale: boolean, save: boolean, asOfOverride?: string): Promise<Cached> {
    const version = this.state.version;
    const started = this.deps.now();
    const ctx = cliContextOf(this.deps);
    const asOf = asOfOverride ?? defaultAsOf(this.deps.now());
    const { report, params } = await executeRun(ctx, {
      asOf,
      mode: 'scan',
      gate: 'enforce',
      allowStale,
      requireEquity: true,
    });
    const savedRunId = save ? await saveScanRun(this.deps.db, params, report, started) : null;

    const names = report.names;
    const open = await listOpenPositions(this.deps.db);
    const contractsByInstrument = new Map<number, number>();
    for (const p of open)
      contractsByInstrument.set(p.instrumentId, (contractsByInstrument.get(p.instrumentId) ?? 0) + p.quantity);

    const ideas = [...report.shortlist.US, ...report.shortlist.HK]
      .map((n) => ideaView(n))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const waiting = names.filter(isWaitingForData);
    const rejected = names
      .filter(
        (n) =>
          ['dropped_stale', 'failed', 'cut', 'no_contract'].includes(n.status) &&
          !isWaitingForData(n) &&
          !contractsByInstrument.has(n.instrument.id),
      )
      .map((n) => rejectView(n));
    const openNames = names
      // every watched name with an open put, whatever else the pipeline concluded about it
      .filter((n) => contractsByInstrument.has(n.instrument.id))
      .map((n) => openNameView(n, contractsByInstrument.get(n.instrument.id) ?? 0));

    // Next results dates come from stored events (the pipeline only exposes the date).
    const ids = [...new Set(names.map((n) => n.instrument.id))];
    const status = await dataStatusFor(this.deps.db, ids, asOf);
    const idOf = new Map(names.map((n) => [`${n.instrument.market}|${n.instrument.symbol}`, n.instrument.id]));
    for (const i of ideas) {
      const raw = status.get(idOf.get(`${i.market}|${i.symbol}`) ?? -1);
      i.nextEarnings = raw?.nextEarnings ?? null;
    }

    const view: ScanView = {
      asOf,
      generatedAt: this.deps.now().toISOString(),
      paramsLabel: `params ${params.name} v${params.version} [${report.paramsHash.slice(0, 8)}]`,
      stats: {
        cacheHits: report.stats.cacheHits,
        computed: report.stats.computed,
        durationMs: this.deps.now().getTime() - started.getTime(),
      },
      ideas,
      rejected,
      openNames,
      pasteChainsFor: report.pasteList.map((n) => ({
        symbol: n.instrument.symbol,
        market: n.instrument.market,
        composite: n.composite ?? 0,
      })),
      savedRunId,
      waitingForData: waiting.map((n) => ({ symbol: n.instrument.symbol, market: n.instrument.market })),
    };
    await this.values().attachBadges(view, report);
    return { version, view, report };
  }
}
