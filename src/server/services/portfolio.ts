import { defaultAsOf } from '../../cli/asof';
import type { Market } from '../../core/calendar';
import { loadPortfolio } from '../../db/history';
import { listOpenPositions } from '../../db/repos';
import type { Currency, DeployView, RegimeView } from '../api-types';
import type { ServerDeps } from '../deps';

/** Collateral of open puts per market in the base currency (full notional), with the regime cap when a scan is known. */
export async function deploymentFor(
  deps: ServerDeps,
  regime: Partial<Record<Market, RegimeView>>,
): Promise<{
  deployed: Record<Market, DeployView>;
  equity: number | null;
  baseCurrency: Currency;
  fxUsdHkd: number | null;
}> {
  const asOf = defaultAsOf(deps.now());
  const pf = await loadPortfolio(deps.db, asOf);
  const open = await listOpenPositions(deps.db);
  const sums: Record<Market, number> = { US: 0, HK: 0 };
  for (const p of open) {
    const fx = pf.fxToBase(p.currency) ?? 0;
    sums[p.market] += p.strike * p.multiplier * p.quantity * fx;
  }
  const equity = pf.equity;
  const view = (m: Market): DeployView => {
    const capPct = regime[m]?.deployCapPct ?? 0;
    return {
      amountBase: sums[m],
      pctOfEquity: equity && equity > 0 ? (sums[m] / equity) * 100 : 0,
      capPct,
      allowedBase: equity ? (capPct / 100) * equity : 0,
    };
  };
  return {
    deployed: { US: view('US'), HK: view('HK') },
    equity,
    baseCurrency: pf.baseCurrency,
    fxUsdHkd: pf.fxToBase('USD' as never) && pf.baseCurrency === 'HKD' ? pf.fxToBase('USD' as never) : null,
  };
}
