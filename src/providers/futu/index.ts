/**
 * Entry point for the moomoo OpenD source. Configured from the environment; absent when FUTU_PORT is unset, so the
 * app runs unchanged without OpenD. Everything here is read-only quote data: put chains, daily bars, the
 * underlying's IV history, static facts (name, board lot) and the gateway's state.
 */
import type { ISODate } from '../../core/dates';
import type { DailyBar, Instrument, OptionChainSnapshot } from '../../core/types';
import { fetchFutuDailyBars } from './bars';
import { type FutuChainOptions, fetchFutuPutChain } from './chain';
import { FutuClient, type FutuGlobalState, type FutuHistoryQuota, type FutuStaticInfo, openDSdk } from './client';
import { type FutuIvPoint, futuSecurity } from './normalize';
import { fetchFutuIvHistory } from './volatility';

export { fetchFutuDailyBars } from './bars';
export { fetchFutuPutChain } from './chain';
export type { FutuGlobalState, FutuHistoryQuota, FutuStaticInfo } from './client';
export { FutuClient, openDSdk } from './client';
export { buildFutuBars, buildFutuIvHistory, buildFutuPutChain, type FutuIvPoint, futuSecurity } from './normalize';
export { fetchFutuIvHistory } from './volatility';

type Name = Pick<Instrument, 'market' | 'symbol'>;

export interface FutuSource {
  putChain(inst: Instrument, opts: FutuChainOptions): Promise<OptionChainSnapshot>;
  dailyBars(inst: Name, from: ISODate, to: ISODate): Promise<DailyBar[]>;
  ivHistory(inst: Name, from: ISODate, to: ISODate): Promise<FutuIvPoint[]>;
  /** Static facts for several names at once; a name OpenD does not know is absent from the result. */
  staticInfo(insts: Name[]): Promise<FutuStaticInfo[]>;
  globalState(): Promise<FutuGlobalState>;
  historyQuota(): Promise<FutuHistoryQuota>;
  close(): void;
}

/** The chain-only view the ingest pipeline first used; kept as a name for callers that only need chains. */
export type FutuChainSource = Pick<FutuSource, 'putChain' | 'close'>;

/** Wraps a client (real or fake) as a source. Exported so tests can drive the pipeline without a running OpenD. */
export function futuSource(client: FutuClient): FutuSource {
  return {
    putChain: (inst, opts) => fetchFutuPutChain(client, inst, opts),
    dailyBars: (inst, from, to) => fetchFutuDailyBars(client, inst, from, to),
    ivHistory: (inst, from, to) => fetchFutuIvHistory(client, inst, from, to),
    staticInfo: (insts) => client.staticInfo(insts.map((i) => futuSecurity(i.market, i.symbol))),
    globalState: () => client.globalState(),
    historyQuota: () => client.historyQuota(),
    close: () => client.close(),
  };
}

/** Returns a source when FUTU_PORT is set, else null. FUTU_HOST defaults to 127.0.0.1. */
export function futuFromEnv(env: NodeJS.ProcessEnv): FutuSource | null {
  const raw = env.FUTU_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`FUTU_PORT must be a port number (the OpenD WebSocket port), got "${raw}"`);
  }
  const client = new FutuClient(openDSdk(), {
    host: env.FUTU_HOST?.trim() || '127.0.0.1',
    port,
    ...(env.FUTU_WS_KEY?.trim() ? { wsKey: env.FUTU_WS_KEY.trim() } : {}),
  });
  return futuSource(client);
}
