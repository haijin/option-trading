/**
 * The put angle on a Leaders card (docs/designs/leaders-pullback.md, stage L4): for a name on the watchlist with a stored
 * chain, the premium-collecting version of the same thesis: the nearest monthly put at or below the level the trade plan
 * protects (a Setup's stop, a Watch's support in play), with its delta and return on collateral. Computed here from the stored
 * chain the way S4 reads one (stored delta, else Black-Scholes from the quote's IV); nothing is written to `recommendations`,
 * and the sell-put scan is not involved.
 */
import { dte, hkMonthlyExpiry, type Market, usMonthlyExpiry } from '../core/calendar';
import { diffDays, type ISODate, monthOf, yearOf } from '../core/dates';
import type { StrategyParams } from '../core/params';
import { round } from '../core/util';
import type { Db } from '../db/client';
import { loadChainAsOf } from '../db/history';
import { bsGreeks } from '../indicators';
import type { LeaderPutAngleView } from './types';

/** A chain older than this many calendar days (against the day shown) is not a premium the card should quote. */
const CHAIN_MAX_AGE_DAYS = 3;

function isMonthly(market: Market, expiry: ISODate): boolean {
  try {
    const f = market === 'HK' ? hkMonthlyExpiry : usMonthlyExpiry;
    return f(yearOf(expiry), monthOf(expiry)) === expiry;
  } catch {
    return false;
  }
}

export interface PutAngleInput {
  instrumentId: number;
  market: Market;
  asOf: ISODate;
  /** The price the put should sit at or below: the Setup's stop, or the Watch's support in play. */
  level: number;
  /** True when `level` is a stop, so `belowStopPct` is reported. */
  levelIsStop: boolean;
  params: StrategyParams;
}

export async function putAngle(db: Db, o: PutAngleInput): Promise<LeaderPutAngleView | null> {
  const chain = await loadChainAsOf(db, o.instrumentId, o.asOf);
  if (!chain || diffDays(o.asOf, chain.snapshotDate) > CHAIN_MAX_AGE_DAYS) return null;
  const p = o.params['option.select'];
  const expiries = [...new Set(chain.quotes.filter((q) => q.right === 'P').map((q) => q.expiry))]
    .filter((e) => isMonthly(o.market, e))
    .filter((e) => {
      const d = dte(chain.snapshotDate, e);
      return d >= p.dteMin[o.market] && d <= p.dteMax[o.market];
    })
    .sort();
  const expiry = expiries[0];
  if (!expiry) return null;
  const candidates = chain.quotes
    .filter((q) => q.right === 'P' && q.expiry === expiry && q.strike <= o.level && q.bid !== null && q.bid > 0)
    .sort((a, b) => b.strike - a.strike);
  const q = candidates[0];
  if (!q || q.bid === null) return null;
  const t = Math.max(dte(chain.snapshotDate, expiry), 1) / 365;
  const rf = o.market === 'HK' ? p.riskFreeHK : p.riskFreeUS;
  let delta: number | null = null;
  if (q.delta !== null && Number.isFinite(q.delta)) delta = Math.abs(q.delta);
  else if (q.iv !== null && q.iv > 0) {
    try {
      delta = Math.abs(bsGreeks('P', chain.underlyingPrice, q.strike, t, rf, q.iv).delta);
    } catch {
      delta = null;
    }
  }
  return {
    expiry,
    strike: q.strike,
    delta: delta === null ? null : round(delta, 2),
    rocPct: round((q.bid / q.strike) * 100, 2),
    belowStopPct: o.levelIsStop ? round(((o.level - q.strike) / o.level) * 100, 1) : null,
  };
}
