/**
 * Read-only moomoo OpenD client (docs/02-architecture.md section 3, Phase 1 Futu adapter).
 *
 * OpenD is a local gateway the user runs and logs in to by hand. This client talks to it over WebSocket through the
 * official `futu-api` SDK. Only quote calls are exposed here: option expirations, option chain, snapshots, static
 * info, daily history bars, the underlying's IV/HV history, the history quota and the gateway state.
 * No Trd_* call exists in this module, so the app cannot place or modify an order.
 */
import FtWebsocket from 'futu-api';
import { addDays, type ISODate } from '../../core/dates';
import { ProviderError } from '../yahoo/client';

/** Qot_Common.QotMarket values this app uses. */
export const QOT_MARKET = { HK: 1, US: 11 } as const;
/** Qot_Common.OptionType.OptionType_Put. */
export const OPTION_TYPE_PUT = 2;
/** Qot_Common.RehabType: raw prices, or forward-adjusted (history scaled so that today's price is unadjusted). */
export const REHAB = { none: 0, forward: 1 } as const;
/** Qot_Common.KLType.KLType_Day. */
export const KL_TYPE_DAY = 2;
/** The chain endpoint accepts at most one month of expiries per request. */
export const CHAIN_WINDOW_DAYS = 30;
/** The snapshot endpoint accepts at most 400 securities per request. */
export const SNAPSHOT_BATCH = 400;
/** The static-info endpoint accepts at most 400 securities per request. */
export const STATIC_BATCH = 400;
/** Paging guard: no history call is allowed to page more than this many times for one security. */
export const MAX_PAGES = 50;

export interface FutuSecurity {
  market: number;
  code: string;
}

/** Read-only subset of the SDK. Kept as an interface so tests can drive the client without a running OpenD. */
export interface FutuSdk {
  onlogin: ((ok: boolean, msg: unknown) => void) | null;
  start(ip: string, port: number, ssl: boolean, key?: string): void;
  /** Stops the WebSocket and its reconnect timer. */
  close(): void;
  GetGlobalState(req: unknown): Promise<unknown>;
  GetOptionExpirationDate(req: unknown): Promise<unknown>;
  GetOptionChain(req: unknown): Promise<unknown>;
  GetSecuritySnapshot(req: unknown): Promise<unknown>;
  GetStaticInfo(req: unknown): Promise<unknown>;
  RequestHistoryKL(req: unknown): Promise<unknown>;
  RequestHistoryKLQuota(req: unknown): Promise<unknown>;
  GetOptionUnderlyingHisVolatility(req: unknown): Promise<unknown>;
}

export interface FutuConfig {
  host: string;
  /** The WebSocket port set in OpenD's configuration (websocket_port). Not the TCP API port. */
  port: number;
  /** Plain-text key matching OpenD's websocket_key, when OpenD requires one. The SDK hashes it itself. */
  wsKey?: string;
  connectTimeoutMs?: number;
  /** Clock and sleep for the rate limiter; injectable so tests need not wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * OpenD limits each call type to N requests per 30 seconds and rejects the rest ("high frequency"); stay under it.
 * The documented limits are 10 per 30 s for most quote calls and 60 for snapshots; one less than each keeps a margin.
 */
const RATE_WINDOW_MS = 30_000;
const RATE_LIMIT = {
  GetGlobalState: 9,
  GetOptionChain: 9,
  GetOptionExpirationDate: 25,
  GetSecuritySnapshot: 50,
  GetStaticInfo: 9,
  RequestHistoryKL: 9,
  RequestHistoryKLQuota: 9,
  GetOptionUnderlyingHisVolatility: 9,
} as const;
type Method = keyof typeof RATE_LIMIT;

export interface FutuExpiration {
  strikeTime: ISODate;
  /** Days to expiry as OpenD reports them; negative means already expired. */
  distance: number;
}

/** One put contract from the chain endpoint (static fields only). */
export interface FutuContract {
  security: FutuSecurity;
  lotSize: number;
  expiry: ISODate;
  strike: number;
}

/** Snapshot of one security. `optionExData` is present for options only. */
export interface FutuSnapshot {
  basic: {
    security: FutuSecurity;
    curPrice: number;
    volume?: unknown;
    bidPrice?: number;
    askPrice?: number;
    updateTimestamp?: number;
    isSuspend?: boolean;
  };
  optionExData?: {
    strikePrice: number;
    openInterest: number;
    /** Percent field: 20 means 20%. */
    impliedVolatility: number;
    delta: number;
    gamma: number;
    vega: number;
    theta: number;
  };
}

/** Static facts about one security (Qot_Common.SecurityStaticBasic). For a stock `lotSize` is the board lot. */
export interface FutuStaticInfo {
  security: FutuSecurity;
  name: string;
  /** Board lot for a stock; contract multiplier for an option or future. */
  lotSize: number;
  /** Qot_Common.SecurityType: 3 = stock, 8 = option. */
  secType: number;
  listTime: string;
  delisting: boolean;
}

/** One daily K-line row as OpenD sends it (Qot_Common.KLine). `time` is 'YYYY-MM-DD 00:00:00' in the market's zone. */
export interface FutuKLine {
  time: string;
  isBlank: boolean;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  closePrice?: number;
  volume?: unknown;
  turnover?: number;
}

/** One day of the underlying's volatility history. `iv` and `hv` are percent fields (20 means 20%). */
export interface FutuVolatilityItem {
  time: string;
  iv?: number;
  hv?: number;
  underlyingPrice?: number;
}

export interface FutuHistoryQuota {
  used: number;
  remaining: number;
}

export interface FutuGlobalState {
  qotLogined: boolean;
  trdLogined: boolean;
  /** Qot_Common.QotMarketState for the HK stock market (6 = closed). */
  marketHK: number;
  marketUS: number;
  serverVer: number;
}

interface Response<T> {
  retType: number;
  retMsg?: string;
  errCode?: number;
  s2c?: T;
}

export function openDSdk(): FutuSdk {
  const ws = new FtWebsocket();
  const internal = ws as unknown as { websock?: { close(): void } };
  return {
    get onlogin() {
      return ws.onlogin;
    },
    set onlogin(fn) {
      ws.onlogin = fn;
    },
    start: (ip, port, ssl, key) => ws.start(ip, port, ssl, key),
    close: () => {
      ws.stop();
      internal.websock?.close();
    },
    GetGlobalState: (req) => ws.GetGlobalState(req),
    GetOptionExpirationDate: (req) => ws.GetOptionExpirationDate(req),
    GetOptionChain: (req) => ws.GetOptionChain(req),
    GetSecuritySnapshot: (req) => ws.GetSecuritySnapshot(req),
    GetStaticInfo: (req) => ws.GetStaticInfo(req),
    RequestHistoryKL: (req) => ws.RequestHistoryKL(req),
    RequestHistoryKLQuota: (req) => ws.RequestHistoryKLQuota(req),
    GetOptionUnderlyingHisVolatility: (req) => ws.GetOptionUnderlyingHisVolatility(req),
  };
}

function toProviderError(err: unknown, symbol: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (typeof err === 'object' && err !== null && 'retType' in err) {
    const r = err as Response<unknown>;
    const code = r.errCode ? `futu_${r.errCode}` : 'rejected';
    return new ProviderError('futu', symbol, `${r.retMsg ?? 'request rejected'} (errCode ${r.errCode ?? 0})`, code);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError('futu', symbol, message, 'unreachable');
}

/** Protobuf `bytes` arrive as a Buffer, a Uint8Array or (through JSON) a base64 string; all are sent back as given. */
function hasKey(key: unknown): boolean {
  if (key === undefined || key === null) return false;
  if (typeof key === 'string') return key.length > 0;
  return (key as { length?: number }).length !== 0;
}

function sameKey(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!hasKey(a) || !hasKey(b)) return false;
  return Buffer.from(a as Uint8Array | string).equals(Buffer.from(b as Uint8Array | string));
}

export class FutuClient {
  private login: Promise<void> | null = null;
  private readonly sent: Partial<Record<Method, number[]>> = {};

  constructor(
    private readonly sdk: FutuSdk,
    private readonly config: FutuConfig,
  ) {}

  /** Opens the WebSocket and waits for OpenD to accept it. Memoised: one connection per client. */
  connect(): Promise<void> {
    if (!this.login) {
      const timeoutMs = this.config.connectTimeoutMs ?? 8000;
      const where = `${this.config.host}:${this.config.port}`;
      this.login = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.close();
          reject(
            new ProviderError(
              'futu',
              'OpenD',
              `no answer from ${where} within ${timeoutMs} ms: is OpenD running with WebSocket enabled?`,
              'unreachable',
            ),
          );
        }, timeoutMs);
        this.sdk.onlogin = (ok, msg) => {
          clearTimeout(timer);
          if (ok) {
            resolve();
            return;
          }
          this.close();
          reject(new ProviderError('futu', 'OpenD', `${where} refused the connection: ${String(msg)}`, 'refused'));
        };
        this.sdk.start(this.config.host, this.config.port, false, this.config.wsKey);
      });
    }
    return this.login;
  }

  close(): void {
    this.sdk.close();
    this.login = null;
  }

  /** Waits until another request of this kind fits in OpenD's 30-second window. */
  private async throttle(method: Method): Promise<void> {
    const now = this.config.now ?? Date.now;
    const sleep = this.config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const times = this.sent[method] ?? [];
    this.sent[method] = times;
    for (;;) {
      const t = now();
      while (times.length > 0 && t - (times[0] as number) >= RATE_WINDOW_MS) times.shift();
      if (times.length < RATE_LIMIT[method]) {
        times.push(t);
        return;
      }
      await sleep((times[0] as number) + RATE_WINDOW_MS - t + 50);
    }
  }

  private async call<T>(method: Method, req: unknown, symbol: string): Promise<T> {
    await this.connect();
    await this.throttle(method);
    try {
      const res = (await this.sdk[method](req)) as Response<T>;
      if (res.retType !== 0) throw res;
      return res.s2c as T;
    } catch (err) {
      throw toProviderError(err, symbol);
    }
  }

  /** Gateway state: whether the quote and trade sessions are logged in and what state each market is in. */
  async globalState(): Promise<FutuGlobalState> {
    const s2c = await this.call<Partial<FutuGlobalState>>('GetGlobalState', { c2s: { userID: 0 } }, 'OpenD');
    return {
      qotLogined: s2c.qotLogined === true,
      trdLogined: s2c.trdLogined === true,
      marketHK: Number(s2c.marketHK ?? 0),
      marketUS: Number(s2c.marketUS ?? 0),
      serverVer: Number(s2c.serverVer ?? 0),
    };
  }

  async optionExpirations(owner: FutuSecurity): Promise<FutuExpiration[]> {
    const s2c = await this.call<{ dateList?: { strikeTime: string; optionExpiryDateDistance: number }[] }>(
      'GetOptionExpirationDate',
      { c2s: { owner } },
      owner.code,
    );
    return (s2c.dateList ?? []).map((d) => ({ strikeTime: d.strikeTime, distance: d.optionExpiryDateDistance }));
  }

  /** Put contracts whose expiry falls in [from, to]. The range is queried in one-month windows. */
  async putContracts(owner: FutuSecurity, from: ISODate, to: ISODate): Promise<FutuContract[]> {
    const out: FutuContract[] = [];
    for (const [begin, end] of chainWindows(from, to)) {
      const s2c = await this.call<{
        optionChain?: {
          option?: {
            put?: {
              basic: { security: FutuSecurity; lotSize: number };
              optionExData: { strikeTime: string; strikePrice: number };
            };
          }[];
        }[];
      }>('GetOptionChain', { c2s: { owner, type: OPTION_TYPE_PUT, beginTime: begin, endTime: end } }, owner.code);
      for (const chain of s2c.optionChain ?? []) {
        for (const item of chain.option ?? []) {
          const put = item.put;
          if (!put) continue;
          const expiry = put.optionExData.strikeTime;
          if (expiry < from || expiry > to) continue;
          out.push({
            security: put.basic.security,
            lotSize: put.basic.lotSize,
            expiry,
            strike: put.optionExData.strikePrice,
          });
        }
      }
    }
    return out;
  }

  async snapshots(securities: FutuSecurity[]): Promise<FutuSnapshot[]> {
    const out: FutuSnapshot[] = [];
    for (let i = 0; i < securities.length; i += SNAPSHOT_BATCH) {
      const batch = securities.slice(i, i + SNAPSHOT_BATCH);
      const s2c = await this.call<{ snapshotList?: FutuSnapshot[] }>(
        'GetSecuritySnapshot',
        { c2s: { securityList: batch } },
        batch[0]?.code ?? 'unknown',
      );
      out.push(...(s2c.snapshotList ?? []));
    }
    return out;
  }

  /** Name, board lot, type and listing date for each security. Unknown codes are simply absent from the answer. */
  async staticInfo(securities: FutuSecurity[]): Promise<FutuStaticInfo[]> {
    const out: FutuStaticInfo[] = [];
    for (let i = 0; i < securities.length; i += STATIC_BATCH) {
      const batch = securities.slice(i, i + STATIC_BATCH);
      const s2c = await this.call<{
        staticInfoList?: {
          basic: {
            security: FutuSecurity;
            lotSize: number;
            secType: number;
            name: string;
            listTime: string;
            delisting?: boolean;
          };
        }[];
      }>('GetStaticInfo', { c2s: { securityList: batch } }, batch[0]?.code ?? 'unknown');
      for (const row of s2c.staticInfoList ?? []) {
        out.push({
          security: row.basic.security,
          name: row.basic.name,
          lotSize: Number(row.basic.lotSize),
          secType: Number(row.basic.secType),
          listTime: row.basic.listTime,
          delisting: row.basic.delisting === true,
        });
      }
    }
    return out;
  }

  /**
   * Daily K-lines in [from, to], raw (`REHAB.none`) or forward-adjusted (`REHAB.forward`), following OpenD's paging key
   * until it stops. Each distinct security counts once against the 30-day history quota, however many pages or
   * adjustment types are fetched.
   */
  async historyDailyBars(security: FutuSecurity, from: ISODate, to: ISODate, rehab: number): Promise<FutuKLine[]> {
    const out: FutuKLine[] = [];
    let key: unknown;
    for (let page = 0; page < MAX_PAGES; page++) {
      const s2c = await this.call<{ klList?: FutuKLine[]; nextReqKey?: unknown }>(
        'RequestHistoryKL',
        {
          c2s: {
            rehabType: rehab,
            klType: KL_TYPE_DAY,
            security,
            beginTime: from,
            endTime: to,
            ...(hasKey(key) ? { nextReqKey: key } : {}),
          },
        },
        security.code,
      );
      const rows = s2c.klList ?? [];
      out.push(...rows);
      // OpenD sends a key even with the last page; an empty page or the same key again means there is nothing more.
      if (rows.length === 0 || !hasKey(s2c.nextReqKey) || sameKey(s2c.nextReqKey, key)) break;
      key = s2c.nextReqKey;
    }
    return out;
  }

  /** The underlying's daily implied and historical volatility in [from, to], newest first as OpenD sends it. */
  async underlyingVolatility(owner: FutuSecurity, from: ISODate, to: ISODate): Promise<FutuVolatilityItem[]> {
    const out: FutuVolatilityItem[] = [];
    let key: unknown;
    for (let page = 0; page < MAX_PAGES; page++) {
      const s2c = await this.call<{ volatilityList?: FutuVolatilityItem[]; nextPageKey?: unknown }>(
        'GetOptionUnderlyingHisVolatility',
        { c2s: { owner, beginTime: from, endTime: to, ...(hasKey(key) ? { nextPageKey: key } : {}) } },
        owner.code,
      );
      const rows = s2c.volatilityList ?? [];
      out.push(...rows);
      if (rows.length === 0 || !hasKey(s2c.nextPageKey) || sameKey(s2c.nextPageKey, key)) break;
      key = s2c.nextPageKey;
    }
    return out;
  }

  /** How many securities' history this OpenD login has pulled in the current 30-day window, and how many remain. */
  async historyQuota(): Promise<FutuHistoryQuota> {
    const s2c = await this.call<{ usedQuota?: number; remainQuota?: number }>(
      'RequestHistoryKLQuota',
      { c2s: { bGetDetail: false } },
      'OpenD',
    );
    return { used: Number(s2c.usedQuota ?? 0), remaining: Number(s2c.remainQuota ?? 0) };
  }
}

/** Splits [from, to] into consecutive windows of at most `maxDays` calendar days, inclusive at both ends. */
export function chainWindows(from: ISODate, to: ISODate, maxDays = CHAIN_WINDOW_DAYS): [ISODate, ISODate][] {
  const out: [ISODate, ISODate][] = [];
  let start = from;
  while (start <= to) {
    const last = addDays(start, maxDays - 1);
    const end = last < to ? last : to;
    out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}
