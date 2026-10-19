/**
 * Puts-only option chain from OpenD for one underlying: expiries in the DTE window, contracts, then snapshots.
 * Read-only. Multiplier is the instrument's board lot (CLAUDE.md), and a feed that disagrees is an error, not a silent
 * rescale.
 */
import type { Market } from '../../core/calendar';
import type { ISODate } from '../../core/dates';
import type { OptionChainSnapshot } from '../../core/types';
import { ProviderError } from '../yahoo/client';
import { localDate, MARKET_TZ } from '../yahoo/normalize';
import type { FutuClient } from './client';
import { buildFutuPutChain, futuSecurity } from './normalize';

export interface FutuChainInstrument {
  market: Market;
  symbol: string;
  multiplier: number;
}

export interface FutuChainOptions {
  now: Date;
  minDte: number;
  maxDte: number;
  range?: { lo: number; hi: number };
}

export async function fetchFutuPutChain(
  client: FutuClient,
  inst: FutuChainInstrument,
  opts: FutuChainOptions,
): Promise<OptionChainSnapshot> {
  const owner = futuSecurity(inst.market, inst.symbol);
  const [underlying] = await client.snapshots([owner]);
  const price = underlying?.basic.curPrice;
  if (!underlying || price === undefined || !(price > 0)) {
    throw new ProviderError('futu', inst.symbol, 'snapshot has no underlying price', 'no_data');
  }
  const tz = MARKET_TZ[inst.market];
  const quoteTime = underlying.basic.updateTimestamp ? new Date(underlying.basic.updateTimestamp * 1000) : opts.now;
  const snapshotDate = localDate(quoteTime, tz);

  const expiries = (await client.optionExpirations(owner))
    .filter((e) => e.distance >= opts.minDte && e.distance <= opts.maxDte)
    .map((e) => e.strikeTime);
  if (expiries.length === 0) {
    throw new ProviderError('futu', inst.symbol, `no expiries ${opts.minDte} to ${opts.maxDte} days out`, 'no_data');
  }
  const wanted = new Set(expiries);
  const sorted: ISODate[] = [...wanted].sort();
  const first = sorted[0] as ISODate;
  const last = sorted[sorted.length - 1] as ISODate;

  const range = opts.range ?? { lo: 0.5, hi: 1.15 };
  const contracts = (await client.putContracts(owner, first, last)).filter(
    (c) => wanted.has(c.expiry) && c.strike >= range.lo * price && c.strike <= range.hi * price,
  );
  if (contracts.length === 0) {
    throw new ProviderError('futu', inst.symbol, 'chain has no put contracts in the strike window', 'no_data');
  }
  const mismatch = contracts.find((c) => c.lotSize !== inst.multiplier);
  if (mismatch) {
    throw new ProviderError(
      'futu',
      inst.symbol,
      `contract multiplier ${mismatch.lotSize} differs from board lot ${inst.multiplier}`,
      'multiplier_mismatch',
    );
  }

  const quotes = await client.snapshots(contracts.map((c) => c.security));
  const snap = buildFutuPutChain({
    snapshotDate,
    underlyingPrice: price,
    multiplier: inst.multiplier,
    contracts,
    quotes,
    range,
  });
  if (snap.quotes.length === 0) throw new ProviderError('futu', inst.symbol, 'no usable put quotes', 'no_data');
  return snap;
}
