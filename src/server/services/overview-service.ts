import { defaultAsOf } from '../../cli/asof';
import { dataStatusFor, latestScanRun, listWatchlistAll } from '../../db/app-repos';
import { buildLeadersCard } from '../../leaders/view';
import type { OverviewView, RegimeView } from '../api-types';
import type { ServerDeps } from '../deps';
import type { DataService } from './data-service';
import { deploymentFor } from './portfolio';
import { regimeCaps } from './regime-cache';
import type { ScanService } from './scan-service';

export const DISCLAIMER =
  'Decision support only: statistics about rules you configured, not investment advice. The app never places orders.';

export class OverviewService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly scan: ScanService,
    private readonly data: DataService,
  ) {}

  async view(): Promise<OverviewView> {
    const asOf = defaultAsOf(this.deps.now());
    let regime: Partial<Record<'US' | 'HK', RegimeView>> = {};
    let stale = 0;
    let waiting = 0;
    try {
      const s = this.scan.peek() ?? (await this.scan.get());
      regime = await regimeCaps(this.scan);
      stale = s.rejected.filter((r) => r.status === 'dropped_stale').length;
      waiting = s.waitingForData.length;
    } catch {
      // equity not set, empty watchlist or nothing ingested yet: the overview still answers, without regimes
    }
    const dep = await deploymentFor(this.deps, regime);
    const rows = await listWatchlistAll(this.deps.db);
    const active = rows.filter((r) => r.active);
    const status = await dataStatusFor(
      this.deps.db,
      active.map((r) => r.id),
      asOf,
    );
    const pending = active.filter((r) => !status.get(r.id)?.lastBar).length;
    const last = await latestScanRun(this.deps.db);
    return {
      asOf,
      generatedAt: this.deps.now().toISOString(),
      baseCurrency: dep.baseCurrency,
      equity: dep.equity,
      fxUsdHkd: dep.fxUsdHkd,
      regime,
      deployed: dep.deployed,
      watchlist: {
        watching: active.length,
        paused: rows.length - active.length,
        us: active.filter((r) => r.market === 'US').length,
        hk: active.filter((r) => r.market === 'HK').length,
        pendingFirstIngest: Math.max(pending, waiting),
      },
      data: {
        lastIngest: await this.data.lastIngestSummary(),
        currentNames: Math.max(0, active.length - stale - pending),
        staleNames: stale,
      },
      lastScan: last ? { id: last.id, at: last.startedAt.toISOString(), asOf: last.asOf, ideas: last.ideas } : null,
      leaders: await buildLeadersCard(this.deps.db, this.deps.now()).catch(() => null),
      disclaimer: DISCLAIMER,
    };
  }
}
