/**
 * Daily marks of open short puts (docs/06 Phase 3). One row per (position, day) in `position_marks`.
 *
 * Price source, best first: a stored chain quote for the exact contract on or before `asOf` (mid when both sides are
 * quoted, else last), tier `real`; otherwise the synthetic model (Barone-Adesi-Whaley on the skew-adjusted sigma), tier
 * `synthetic`. Sigma is the stored 30-day IV when it is fresh, else 30-day realised vol times the market's IV/RV ratio.
 * A model mark is a mid with no haircut: it values the position, it does not pretend to be a fill.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { americanPutPrice, syntheticPut } from '../backtest/pricer';
import { type Alert, evaluateAlerts } from '../core/alerts';
import type { Market } from '../core/calendar';
import { addDays, diffDays, type ISODate } from '../core/dates';
import type { StrategyParams } from '../core/params';
import type { DataTier } from '../core/types';
import { realizedVol } from '../indicators/volatility';
import { listPositionsDetailed, type PositionRow } from './app-repos';
import type { DbOrTx } from './client';
import { corporateEvents, ivDaily, optionContracts, optionQuotes, positionMarks, priceBars } from './schema';

/** Quotes older than this many calendar days are not used for a mark. */
export const QUOTE_MAX_AGE_DAYS = 5;
/** A stored IV30 older than this is ignored in favour of realised vol. */
export const IV_MAX_AGE_DAYS = 7;

export interface MarkInput {
  position: Pick<PositionRow, 'strike' | 'expiry' | 'openPrice' | 'quantity' | 'multiplier' | 'openDate'>;
  asOf: ISODate;
  spot: number;
  rate: number;
  /** A stored quote for the contract (price per share) with its age, if any. */
  quote: { price: number; delta: number | null; ageDays: number } | null;
  /** ATM sigma for the model price, or null when none can be derived. */
  sigmaAtm: number | null;
  skewBumpPer10Delta: number;
}

export interface MarkValue {
  mark: number;
  tier: DataTier;
  delta: number | null;
  unrealizedPnl: number;
  pctCaptured: number;
  dte: number;
}

/** Pure: the mark and P&L of one short put, or null when neither a quote nor a sigma exists. */
export function computeMark(i: MarkInput): MarkValue | null {
  const dte = diffDays(i.position.expiry, i.asOf);
  let mark: number;
  let tier: DataTier;
  let delta: number | null = null;
  if (dte < 0) return null;
  if (i.quote && i.quote.ageDays <= QUOTE_MAX_AGE_DAYS) {
    mark = i.quote.price;
    tier = 'real';
    delta = i.quote.delta;
  } else if (i.sigmaAtm !== null && i.sigmaAtm > 0) {
    const pricing = { spot: i.spot, strike: i.position.strike, dte, rate: i.rate };
    if (dte === 0) mark = americanPutPrice(pricing, i.sigmaAtm);
    else {
      const s = syntheticPut(pricing, i.sigmaAtm, i.skewBumpPer10Delta);
      mark = s.mid;
      delta = s.delta;
    }
    tier = 'synthetic';
  } else return null;
  const { openPrice, quantity, multiplier } = i.position;
  return {
    mark,
    tier,
    delta,
    unrealizedPnl: (openPrice - mark) * multiplier * quantity,
    pctCaptured: openPrice > 0 ? (openPrice - mark) / openPrice : 0,
    dte,
  };
}

export interface MarkedPosition {
  positionId: number;
  symbol: string;
  day: ISODate;
  mark: number;
  unrealizedPnl: number;
  pctCaptured: number;
  dte: number;
  spot: number;
  delta: number | null;
  tier: DataTier;
  alerts: Alert[];
}

export interface MarkSkip {
  positionId: number;
  symbol: string;
  reason: string;
}

export interface MarkRunResult {
  asOf: ISODate;
  marked: MarkedPosition[];
  skipped: MarkSkip[];
}

async function lastBars(db: DbOrTx, instrumentId: number, asOf: ISODate, n: number) {
  const rows = await db
    .select({ day: priceBars.day, close: priceBars.close })
    .from(priceBars)
    .where(and(eq(priceBars.instrumentId, instrumentId), lte(priceBars.day, asOf)))
    .orderBy(desc(priceBars.day))
    .limit(n);
  return rows.map((r) => ({ day: r.day, close: Number(r.close) })).reverse();
}

async function storedQuote(db: DbOrTx, p: PositionRow, asOf: ISODate) {
  const rows = await db
    .select({
      day: optionQuotes.snapshotDate,
      bid: optionQuotes.bid,
      ask: optionQuotes.ask,
      last: optionQuotes.last,
      delta: optionQuotes.delta,
    })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionContracts.id, optionQuotes.contractId))
    .where(
      and(
        eq(optionContracts.instrumentId, p.instrument.id),
        eq(optionContracts.right, 'P'),
        eq(optionContracts.expiry, p.expiry),
        sql`${optionContracts.strike} = ${p.strike.toFixed(6)}::numeric`,
        lte(optionQuotes.snapshotDate, asOf),
        // journal fills are real prices but not a market quote on that day: they are not used to mark
        sql`${optionQuotes.source} <> 'journal'`,
      ),
    )
    .orderBy(desc(optionQuotes.snapshotDate))
    .limit(1);
  const q = rows[0];
  if (!q) return null;
  const bid = q.bid === null ? null : Number(q.bid);
  const ask = q.ask === null ? null : Number(q.ask);
  const last = q.last === null ? null : Number(q.last);
  const price = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  if (price === null || !(price >= 0)) return null;
  return { price, delta: q.delta === null ? null : Number(q.delta), ageDays: diffDays(asOf, q.day) };
}

async function sigmaFor(
  db: DbOrTx,
  p: PositionRow,
  asOf: ISODate,
  closes: number[],
  ratio: number,
): Promise<number | null> {
  const [iv] = await db
    .select({ day: ivDaily.day, iv30: ivDaily.iv30 })
    .from(ivDaily)
    .where(
      and(
        eq(ivDaily.instrumentId, p.instrument.id),
        lte(ivDaily.day, asOf),
        gte(ivDaily.day, addDays(asOf, -IV_MAX_AGE_DAYS)),
      ),
    )
    .orderBy(desc(ivDaily.day))
    .limit(1);
  if (iv?.iv30 != null && Number(iv.iv30) > 0) return Number(iv.iv30);
  const rv = realizedVol(closes, 30);
  const last = rv[rv.length - 1];
  return last != null && last > 0 ? last * ratio : null;
}

/**
 * Marks every open put as of `asOf` and stores the rows (idempotent: one row per position and day, replaced on rerun).
 * `knownThrough` bounds which earnings announcements count (default asOf; a live run passes today).
 */
export async function markOpenPositions(
  db: DbOrTx,
  opts: { asOf: ISODate; params: StrategyParams; knownThrough?: ISODate; markets?: Market[] },
): Promise<MarkRunResult> {
  const { asOf, params } = opts;
  const knownThrough = opts.knownThrough ?? asOf;
  const open = (await listPositionsDetailed(db)).filter(
    (p) => p.status === 'open' && (!opts.markets || opts.markets.includes(p.instrument.market)),
  );
  const result: MarkRunResult = { asOf, marked: [], skipped: [] };
  if (open.length === 0) return result;

  const ids = [...new Set(open.map((p) => p.instrument.id))];
  const events = await db
    .select()
    .from(corporateEvents)
    .where(
      and(
        inArray(corporateEvents.instrumentId, ids),
        eq(corporateEvents.eventType, 'earnings'),
        gte(corporateEvents.eventDate, asOf),
      ),
    );

  for (const p of open) {
    const sym = `${p.instrument.market}:${p.instrument.symbol}`;
    const bars = await lastBars(db, p.instrument.id, asOf, 60);
    const last = bars[bars.length - 1];
    if (!last) {
      result.skipped.push({ positionId: p.id, symbol: sym, reason: 'no stored price bar on or before the date' });
      continue;
    }
    const market = p.instrument.market;
    const rate = market === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS;
    const quote = await storedQuote(db, p, asOf);
    const sigma = await sigmaFor(
      db,
      p,
      asOf,
      bars.map((b) => b.close),
      params['volatility.edge'].ivRvRatioDefault[market],
    );
    const v = computeMark({
      position: p,
      asOf,
      spot: last.close,
      rate,
      quote,
      sigmaAtm: sigma,
      skewBumpPer10Delta: params['option.select'].skewBumpPer10Delta,
    });
    const er = events
      .filter((e) => e.instrumentId === p.instrument.id && e.knownAt.toISOString().slice(0, 10) <= knownThrough)
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate))[0];
    const nextEarnings = er ? { date: er.eventDate, knownAt: er.knownAt.toISOString() } : null;
    const alerts = evaluateAlerts({
      strike: p.strike,
      expiry: p.expiry,
      openPrice: p.openPrice,
      openDate: p.openDate,
      today: asOf,
      spot: last.close,
      mark: v?.mark ?? null,
      nextEarnings,
    });
    if (!v) {
      result.skipped.push({
        positionId: p.id,
        symbol: sym,
        reason:
          diffDays(p.expiry, asOf) < 0
            ? `past expiry (${p.expiry}): record how it ended`
            : 'no quote and no volatility to price it with',
      });
      continue;
    }
    const row = {
      positionId: p.id,
      day: asOf,
      mark: v.mark.toFixed(6),
      unrealizedPnl: v.unrealizedPnl.toFixed(6),
      pctOfCreditCaptured: v.pctCaptured.toFixed(4),
      dte: v.dte,
      underlyingPrice: last.close.toFixed(6),
      delta: v.delta === null ? null : v.delta.toFixed(6),
      alerts: alerts.map((a) => a.code),
      tier: v.tier,
    };
    await db
      .insert(positionMarks)
      .values(row)
      .onConflictDoUpdate({
        target: [positionMarks.positionId, positionMarks.day],
        set: {
          mark: row.mark,
          unrealizedPnl: row.unrealizedPnl,
          pctOfCreditCaptured: row.pctOfCreditCaptured,
          dte: row.dte,
          underlyingPrice: row.underlyingPrice,
          delta: row.delta,
          alerts: row.alerts,
          tier: row.tier,
        },
      });
    result.marked.push({
      positionId: p.id,
      symbol: sym,
      day: asOf,
      mark: v.mark,
      unrealizedPnl: v.unrealizedPnl,
      pctCaptured: v.pctCaptured,
      dte: v.dte,
      spot: last.close,
      delta: v.delta,
      tier: v.tier,
      alerts,
    });
  }
  return result;
}

export interface LatestMark {
  positionId: number;
  day: ISODate;
  mark: number;
  unrealizedPnl: number;
  pctCaptured: number | null;
  delta: number | null;
  tier: DataTier;
  alertCodes: string[];
}

/** The most recent stored mark of each given position. */
export async function latestMarks(db: DbOrTx, positionIds: number[]): Promise<Map<number, LatestMark>> {
  const out = new Map<number, LatestMark>();
  if (positionIds.length === 0) return out;
  const rows = await db
    .select()
    .from(positionMarks)
    .where(inArray(positionMarks.positionId, positionIds))
    .orderBy(desc(positionMarks.day));
  for (const r of rows) {
    if (out.has(r.positionId)) continue;
    out.set(r.positionId, {
      positionId: r.positionId,
      day: r.day,
      mark: Number(r.mark),
      unrealizedPnl: Number(r.unrealizedPnl),
      pctCaptured: r.pctOfCreditCaptured === null ? null : Number(r.pctOfCreditCaptured),
      delta: r.delta === null ? null : Number(r.delta),
      tier: r.tier,
      alertCodes: r.alerts,
    });
  }
  return out;
}
