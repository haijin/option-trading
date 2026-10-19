/**
 * The two reproduction checks of docs/05 section 6, runnable on any single-name price history (the plan uses SPY):
 *
 *  1. monthly at-the-money put-writing, fully cash-secured and held to expiry (the Cboe PUT index recipe): lower
 *     volatility than the underlying, a shallower drawdown, lagging in strong bull stretches;
 *  2. the tastylive-style 16-delta, 45-DTE put managed at 50% profit and 21 DTE: a win rate of roughly 75-90%.
 *
 * Tolerances are loose on purpose and the direction must match; a large deviation means the synthetic pricer or the
 * exit logic is wrong. Pure: callers pass bars and get findings back.
 */
import { diffDays } from '../core/dates';
import { realizedVol } from '../indicators/volatility';
import { targetExpiries } from '../skills/s4-option-select';
import { type EngineConfig, type EntryCandidate, type EntrySource, runEngine, type Underlying } from './engine';
import { equityMetrics, tradeMetrics } from './metrics';
import { createNaiveSource, NAIVE_DEFAULTS } from './naive-source';
import { entryCredit, syntheticPut } from './pricer';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export function validationConfig(days: string[], over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    from: days[0] as string,
    to: days[days.length - 1] as string,
    initialCapital: 1_000_000,
    fxToBase: () => 1,
    riskFree: { US: 0.03, HK: 0.03 },
    cashRate: 0.03,
    takeProfitPct: 0.5,
    dteExit: 21,
    stopMultiple: 1e9,
    haircuts: { US: { slippage: 0.1, modelRisk: 0.05 }, HK: { slippage: 0.15, modelRisk: 0.05 } },
    feePerContract: { US: 0, HK: 0 },
    scanEveryDays: 1,
    maxOpen: 5,
    tierPolicy: 'synthetic_only',
    sigmaMultiplier: 1,
    ...over,
  };
}

/** Sells one at-the-money put per month with all the collateral: the Cboe PUT methodology. */
export function monthlyAtmSource(u: Underlying): EntrySource {
  const rv = realizedVol(
    u.bars.map((b) => b.adjClose),
    30,
  );
  const index = new Map(u.bars.map((b, i) => [b.day, i]));
  let lastMonth = '';
  return {
    async candidates(day, view) {
      const month = day.slice(0, 7);
      if (month === lastMonth || view.openPositions.length > 0) return [];
      const i = index.get(day);
      const vol = i === undefined ? null : rv[i];
      if (i === undefined || vol === null || vol === undefined) return [];
      const expiry = targetExpiries(u.market, day, 20, 40).at(-1);
      if (!expiry) return [];
      lastMonth = month;
      const spot = (u.bars[i] as { close: number }).close;
      const strike = Math.round(spot);
      const p = syntheticPut({ spot, strike, dte: diffDays(expiry, day), rate: 0.03, q: u.divYield }, vol * 1.15, 0.02);
      const c: EntryCandidate = {
        instrumentId: u.instrumentId,
        strike,
        expiry,
        fillPrice: entryCredit(p.mid, { slippage: 0.1, modelRisk: 0.05 }),
        delta: p.delta,
        iv: p.sigma,
        contracts: Math.floor((view.equity * 0.98) / (strike * u.multiplier)),
        score: 1,
        tier: 'synthetic',
      };
      return [c];
    },
  };
}

export async function putWriteChecks(u: Underlying): Promise<Check[]> {
  const days = u.bars.map((b) => b.day);
  const r = await runEngine(validationConfig(days, { takeProfitPct: 5, dteExit: 0 }), [u], monthlyAtmSource(u));
  const put = equityMetrics(r.equity);
  const first = (u.bars[0] as { adjClose: number }).adjClose;
  const hold = equityMetrics(
    u.bars.map((b) => ({ day: b.day, equity: (1_000_000 * b.adjClose) / first, deployedPct: 1 })),
  );
  const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
  const checks: Check[] = [];
  checks.push({
    name: 'put-writing volatility is below the index',
    pass: put.annualVol !== null && hold.annualVol !== null && put.annualVol < hold.annualVol,
    detail: `put-write ${pct(put.annualVol)} vs index ${pct(hold.annualVol)} a year`,
  });
  checks.push({
    name: 'put-writing drawdown is shallower than the index',
    pass:
      put.maxDrawdown !== null && hold.maxDrawdown !== null && Math.abs(put.maxDrawdown) < Math.abs(hold.maxDrawdown),
    detail: `put-write ${pct(put.maxDrawdown)} vs index ${pct(hold.maxDrawdown)}`,
  });
  // the index's own best 252-day stretch: the collateralised put-writer should lag it
  const eq = r.equity.map((e) => e.equity);
  let bestIdx = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 252 < u.bars.length; i++) {
    const g = (u.bars[i + 252] as { adjClose: number }).adjClose / (u.bars[i] as { adjClose: number }).adjClose;
    if (g > best) {
      best = g;
      bestIdx = i;
    }
  }
  const bullPut = (eq[bestIdx + 252] as number) / (eq[bestIdx] as number) - 1;
  checks.push({
    name: 'put-writing lags the index in its strongest year',
    pass: bullPut < best - 1,
    detail: `put-write ${pct(bullPut)} vs index ${pct(best - 1)}`,
  });
  return checks;
}

export async function managedPutChecks(u: Underlying): Promise<Check[]> {
  const days = u.bars.map((b) => b.day);
  const source = createNaiveSource([u], { ...NAIVE_DEFAULTS, deltaTarget: 0.16, dteTarget: 45, maxPerNamePct: 0.25 });
  const r = await runEngine(validationConfig(days, { scanEveryDays: 1 }), [u], source);
  const m = tradeMetrics(r.trades);
  const win = m.winRate;
  return [
    {
      name: '16-delta 45-DTE put managed at 50% / 21 DTE wins roughly 70-94% of the time',
      pass: m.n >= 30 && win !== null && win >= 0.7 && win <= 0.94,
      detail: `${m.n} trades, win rate ${win === null ? '-' : `${(win * 100).toFixed(1)}%`} (documented band 75-90%)`,
    },
    {
      name: 'managed trades leave early',
      pass: m.avgDaysHeld !== null && m.avgDaysHeld < 35,
      detail: `average ${m.avgDaysHeld === null ? '-' : m.avgDaysHeld.toFixed(1)} days held`,
    },
  ];
}
