import type { Market } from '../../core/calendar';
import type { RegimeView } from '../api-types';
import { firstRegime } from '../views';
import type { ScanService } from './scan-service';

/** Regime caps for the capital meters, from the scan result when one is cached (never forces a scan). */
export async function regimeCaps(scan: ScanService): Promise<Partial<Record<Market, RegimeView>>> {
  const report = scan.report();
  const out: Partial<Record<Market, RegimeView>> = {};
  if (!report) return out;
  for (const m of ['US', 'HK'] as const) {
    const r = firstRegime(report.names, m);
    if (r) out[m] = r;
  }
  return out;
}
