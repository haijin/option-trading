/**
 * Freshness gate (docs/02 section 2, T3). Runs before S0 with a window per input source:
 *  - bars, index and FX must be dated the last trading day of that market on or before asOf;
 *  - a chain from an automated source (yahoo, futu, ibkr) likewise;
 *  - a pasted CSV chain may be up to `chainMaxAgeDays` old, and an older one is NOT stale: it is ignored (the name is
 *    priced synthetically and joins the "paste chains for these" block);
 *  - the vol index is exempt whenever `regime.noVolIndex` is in effect (no vol-index data, or it lags the index by more
 *    than five days, which is when S0 stops using it).
 * A stale input drops the name with Reason `data.stale` naming the input and its date.
 */
import { lastTradingDayOnOrBefore, type Market } from '../core/calendar';
import { diffDays, type ISODate } from '../core/dates';
import type { Currency, DataSources, Instrument, Reason } from '../core/types';

export type StaleInput = 'bars' | 'index' | 'volIndex' | 'fx' | 'chain';

export interface StaleFinding {
  input: StaleInput;
  actual: ISODate | null;
  required: ISODate;
}

export interface FreshnessResult {
  stale: StaleFinding[];
  /** Required session date for this market. */
  expected: ISODate;
  /** A real chain (automated, or pasted within chainMaxAgeDays) is available. */
  hasFreshChain: boolean;
  chainAgeDays: number | null;
}

/** Keep in step with S0: a vol index lagging the index by more than this many days is treated as missing. */
export const VOL_INDEX_MAX_LAG_DAYS = 5;

export function expectedSession(market: Market, asOf: ISODate): ISODate {
  return lastTradingDayOnOrBefore(market, asOf);
}

export function evaluateFreshness(i: {
  instrument: Instrument;
  sources: DataSources;
  asOf: ISODate;
  baseCurrency: Currency;
  chainMaxAgeDays: number;
}): FreshnessResult {
  const { instrument: inst, sources: s } = i;
  const expected = expectedSession(inst.market, i.asOf);
  const stale: StaleFinding[] = [];
  const need = (input: StaleInput, actual: ISODate | null): void => {
    if (actual === null || actual < expected) stale.push({ input, actual, required: expected });
  };

  need('bars', s.barsLast);
  need('index', s.indexLast);
  if (
    s.volIndexLast !== null &&
    s.indexLast !== null &&
    diffDays(s.indexLast, s.volIndexLast) <= VOL_INDEX_MAX_LAG_DAYS
  ) {
    need('volIndex', s.volIndexLast);
  }
  if (inst.currency !== i.baseCurrency) need('fx', s.fxLast);

  let hasFreshChain = false;
  let chainAgeDays: number | null = null;
  if (s.chain) {
    chainAgeDays = diffDays(i.asOf, s.chain.snapshotDate);
    if (s.chain.source === 'csv') {
      hasFreshChain = chainAgeDays <= i.chainMaxAgeDays;
    } else {
      need('chain', s.chain.snapshotDate);
      hasFreshChain = s.chain.snapshotDate >= expected;
    }
  }
  return { stale, expected, hasFreshChain, chainAgeDays };
}

export function staleReasons(findings: StaleFinding[]): Reason[] {
  return findings.map((f) => ({
    rule: 'data.stale',
    value: `${f.input} ${f.actual ?? 'missing'}`,
    threshold: `dated ${f.required}`,
    passed: false,
    level: 'FAIL',
    kind: 'data',
    note: f.actual
      ? `${f.input} data ends ${f.actual}, the last session is ${f.required}`
      : `no ${f.input} data on or before the as-of date`,
  }));
}
