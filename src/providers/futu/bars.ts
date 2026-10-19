/**
 * Daily bars for one stock from OpenD: two history requests (raw prices and forward-adjusted prices) merged into the
 * app's DailyBar shape with source `futu`. Read-only. One security counts once against OpenD's 30-day history quota
 * (1,000 securities per login), so this is meant for the watchlist, not for a universe of a thousand names.
 */
import type { Market } from '../../core/calendar';
import type { ISODate } from '../../core/dates';
import type { DailyBar } from '../../core/types';
import { ProviderError } from '../yahoo/client';
import { type FutuClient, REHAB } from './client';
import { buildFutuBars, futuSecurity } from './normalize';

export interface FutuBarsInstrument {
  market: Market;
  symbol: string;
}

export async function fetchFutuDailyBars(
  client: FutuClient,
  inst: FutuBarsInstrument,
  from: ISODate,
  to: ISODate,
): Promise<DailyBar[]> {
  const security = futuSecurity(inst.market, inst.symbol);
  const raw = await client.historyDailyBars(security, from, to, REHAB.none);
  if (raw.length === 0) throw new ProviderError('futu', inst.symbol, `no daily bars ${from} to ${to}`, 'no_data');
  const adjusted = await client.historyDailyBars(security, from, to, REHAB.forward);
  const bars = buildFutuBars(raw, adjusted);
  if (bars.length === 0) throw new ProviderError('futu', inst.symbol, 'daily bars had no usable rows', 'no_data');
  return bars;
}
