/**
 * The underlying's implied- and historical-volatility history from OpenD, for backfilling `iv_daily` so that S3 can
 * rank today's IV against a real series instead of a proxy. OpenD's IV is the composite near-term implied volatility
 * moomoo shows for the stock; it is stored as the day's `iv30` only where the app has no snapshot-derived row.
 */
import type { Market } from '../../core/calendar';
import type { ISODate } from '../../core/dates';
import { ProviderError } from '../yahoo/client';
import type { FutuClient } from './client';
import { buildFutuIvHistory, type FutuIvPoint, futuSecurity } from './normalize';

export interface FutuVolInstrument {
  market: Market;
  symbol: string;
}

export async function fetchFutuIvHistory(
  client: FutuClient,
  inst: FutuVolInstrument,
  from: ISODate,
  to: ISODate,
): Promise<FutuIvPoint[]> {
  const owner = futuSecurity(inst.market, inst.symbol);
  const items = await client.underlyingVolatility(owner, from, to);
  const points = buildFutuIvHistory(items).filter((p) => p.day >= from && p.day <= to);
  if (points.length === 0) {
    throw new ProviderError('futu', inst.symbol, `no implied-volatility history ${from} to ${to}`, 'no_data');
  }
  return points;
}
