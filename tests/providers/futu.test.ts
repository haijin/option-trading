import { describe, expect, it } from 'vitest';
import { fetchFutuDailyBars } from '../../src/providers/futu/bars';
import { fetchFutuPutChain } from '../../src/providers/futu/chain';
import { chainWindows, FutuClient, REHAB } from '../../src/providers/futu/client';
import { futuSource } from '../../src/providers/futu/index';
import {
  buildFutuBars,
  buildFutuIvHistory,
  buildFutuPutChain,
  futuDay,
  futuSecurity,
  num,
} from '../../src/providers/futu/normalize';
import { fetchFutuIvHistory } from '../../src/providers/futu/volatility';
import { ProviderError } from '../../src/providers/yahoo/client';

type Req = { c2s: Record<string, unknown> };
type Handler = (req: Req) => Promise<unknown>;
type SdkMethod =
  | 'GetGlobalState'
  | 'GetOptionExpirationDate'
  | 'GetOptionChain'
  | 'GetSecuritySnapshot'
  | 'GetStaticInfo'
  | 'RequestHistoryKL'
  | 'RequestHistoryKLQuota'
  | 'GetOptionUnderlyingHisVolatility';

const rejected: Handler = async () => ({ retType: -1, retMsg: 'not stubbed' });

/** A stand-in for the OpenD SDK: start() answers the login callback on the next tick unless told not to. */
function fakeSdk(handlers: Partial<Record<SdkMethod, Handler>>, login = true) {
  const sdk = {
    onlogin: null as ((ok: boolean, msg: unknown) => void) | null,
    started: [] as unknown[][],
    closed: 0,
    start(ip: string, port: number, ssl: boolean, key?: string) {
      sdk.started.push([ip, port, ssl, key]);
      if (login) queueMicrotask(() => sdk.onlogin?.(true, undefined));
    },
    close() {
      sdk.closed += 1;
    },
    GetGlobalState: handlers.GetGlobalState ?? rejected,
    GetOptionExpirationDate: handlers.GetOptionExpirationDate ?? rejected,
    GetOptionChain: handlers.GetOptionChain ?? rejected,
    GetSecuritySnapshot: handlers.GetSecuritySnapshot ?? rejected,
    GetStaticInfo: handlers.GetStaticInfo ?? rejected,
    RequestHistoryKL: handlers.RequestHistoryKL ?? rejected,
    RequestHistoryKLQuota: handlers.RequestHistoryKLQuota ?? rejected,
    GetOptionUnderlyingHisVolatility: handlers.GetOptionUnderlyingHisVolatility ?? rejected,
  };
  return sdk;
}

const client = (sdk: ReturnType<typeof fakeSdk>) => new FutuClient(sdk, { host: '127.0.0.1', port: 33333 });
const ok = <T>(s2c: T) => ({ retType: 0, s2c });
const long = (n: number) => ({ toNumber: () => n });
const ts = Date.UTC(2026, 9, 9, 8, 0) / 1000; // 2026-10-09 16:00 in Hong Kong

describe('futu symbol mapping', () => {
  it('pads HK codes to five digits and keeps US tickers', () => {
    expect(futuSecurity('HK', '0700')).toEqual({ market: 1, code: '00700' });
    expect(futuSecurity('US', 'AAPL')).toEqual({ market: 11, code: 'AAPL' });
  });

  it('reads the calendar day out of OpenD time strings and rejects anything else', () => {
    expect(futuDay('2026-10-02 00:00:00')).toBe('2026-10-02');
    expect(futuDay('2026-10-13')).toBe('2026-10-13');
    expect(futuDay('2026-13-01')).toBeNull();
    expect(futuDay(undefined)).toBeNull();
  });
});

describe('futu chain windows', () => {
  it('covers the range with contiguous windows of at most 30 days', () => {
    const w = chainWindows('2026-11-01', '2027-01-15');
    expect(w[0]?.[0]).toBe('2026-11-01');
    expect(w[w.length - 1]?.[1]).toBe('2027-01-15');
    for (const [a, b] of w) {
      const days = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000 + 1;
      expect(days).toBeLessThanOrEqual(30);
    }
    for (let i = 1; i < w.length; i++) {
      const prevEnd = Date.parse(`${w[i - 1]?.[1]}T00:00:00Z`);
      expect(Date.parse(`${w[i]?.[0]}T00:00:00Z`) - prevEnd).toBe(86400000);
    }
  });

  it('returns one window for a single day', () => {
    expect(chainWindows('2026-11-26', '2026-11-26')).toEqual([['2026-11-26', '2026-11-26']]);
  });
});

describe('futu numeric fields', () => {
  it('reads Long-like int64, numbers and strings; rejects absent or non-finite values', () => {
    expect(num(long(1200))).toBe(1200);
    expect(num(7.5)).toBe(7.5);
    expect(num('3.25')).toBe(3.25);
    expect(num(undefined)).toBeNull();
    expect(num(Number.NaN)).toBeNull();
  });
});

describe('buildFutuPutChain', () => {
  const contract = (code: string, strike: number) => ({
    security: { market: 1, code },
    lotSize: 100,
    expiry: '2026-11-26',
    strike,
  });
  const quote = (code: string, iv: number, delta: number, bid: number | undefined) => ({
    basic: { security: { market: 1, code }, curPrice: 5.2, volume: long(1200), bidPrice: bid, askPrice: 5.4 },
    optionExData: {
      strikePrice: 0,
      openInterest: 900,
      impliedVolatility: iv,
      delta,
      gamma: 0.01,
      vega: 0.2,
      theta: -0.05,
    },
  });

  it('converts percent IV to decimal, keeps put deltas negative and tags the source as futu', () => {
    const snap = buildFutuPutChain({
      snapshotDate: '2026-10-09',
      underlyingPrice: 400,
      multiplier: 100,
      contracts: [contract('P1', 380)],
      quotes: [quote('P1', 32.5, 0.21, 5.1)],
    });
    expect(snap.source).toBe('futu');
    expect(snap.tier).toBe('real');
    expect(snap.quotes).toHaveLength(1);
    expect(snap.quotes[0]).toMatchObject({
      right: 'P',
      strike: 380,
      bid: 5.1,
      ask: 5.4,
      iv: 0.325,
      delta: -0.21,
      multiplier: 100,
    });
  });

  it('drops strikes outside the window, contracts without a snapshot, and implausible IV', () => {
    const snap = buildFutuPutChain({
      snapshotDate: '2026-10-09',
      underlyingPrice: 400,
      multiplier: 100,
      contracts: [contract('FAR', 500), contract('MISSING', 380), contract('ZERO', 390)],
      quotes: [quote('FAR', 30, -0.1, 1), quote('ZERO', 0, -0.2, undefined)],
    });
    expect(snap.quotes.map((q) => q.strike)).toEqual([390]);
    expect(snap.quotes[0]?.iv).toBeNull();
    expect(snap.quotes[0]?.bid).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- daily bars
const kl = (
  day: string,
  close: number,
  extra: Partial<{ open: number; high: number; low: number; volume: unknown; isBlank: boolean }> = {},
) => ({
  time: `${day} 00:00:00`,
  isBlank: extra.isBlank ?? false,
  openPrice: extra.open ?? close - 1,
  highPrice: extra.high ?? close + 2,
  lowPrice: extra.low ?? close - 2,
  closePrice: close,
  volume: extra.volume ?? '19108045',
});

describe('buildFutuBars', () => {
  it('takes OHLCV from the raw series and the adjusted close from the forward-adjusted one, ascending by day', () => {
    const raw = [kl('2026-10-05', 423, { volume: long(8709438) }), kl('2026-10-02', 421.2)];
    const adjusted = [kl('2026-10-02', 400.5), kl('2026-10-05', 402.2)];
    const bars = buildFutuBars(raw, adjusted);
    expect(bars.map((b) => b.day)).toEqual(['2026-10-02', '2026-10-05']);
    expect(bars[0]).toEqual({
      day: '2026-10-02',
      open: 420.2,
      high: 423.2,
      low: 419.2,
      close: 421.2,
      adjClose: 400.5,
      volume: 19108045,
      source: 'futu',
    });
    expect(bars[1]?.volume).toBe(8709438);
    expect(bars[1]?.adjClose).toBe(402.2);
  });

  it('drops blank and non-positive rows, and keeps the raw close as adjusted close when the adjusted row is missing', () => {
    const raw = [
      kl('2026-10-06', 428.2),
      kl('2026-10-07', 0),
      kl('2026-10-08', 411.4, { isBlank: true }),
      { time: 'garbage', isBlank: false, closePrice: 1 },
    ];
    const bars = buildFutuBars(raw, []);
    expect(bars.map((b) => b.day)).toEqual(['2026-10-06']);
    expect(bars[0]?.adjClose).toBe(428.2);
  });
});

describe('fetchFutuDailyBars', () => {
  it('requests raw then forward-adjusted daily K-lines, following the paging key until it repeats', async () => {
    const requests: Req[] = [];
    const key1 = Buffer.from('page-2');
    const sdk = fakeSdk({
      RequestHistoryKL: async (req) => {
        requests.push(req);
        const rehab = req.c2s.rehabType as number;
        const key = req.c2s.nextReqKey as Buffer | undefined;
        if (rehab === REHAB.none) {
          if (!key) return ok({ klList: [kl('2026-10-02', 421.2)], nextReqKey: key1 });
          // The last page comes back with the same key again.
          return ok({ klList: [kl('2026-10-05', 423)], nextReqKey: key1 });
        }
        return ok({ klList: [kl('2026-10-02', 400), kl('2026-10-05', 402)], nextReqKey: Buffer.alloc(0) });
      },
    });
    const bars = await fetchFutuDailyBars(client(sdk), { market: 'HK', symbol: '0700' }, '2026-10-01', '2026-10-13');
    expect(bars.map((b) => [b.day, b.close, b.adjClose])).toEqual([
      ['2026-10-02', 421.2, 400],
      ['2026-10-05', 423, 402],
    ]);
    expect(requests.map((r) => [r.c2s.rehabType, r.c2s.nextReqKey !== undefined])).toEqual([
      [REHAB.none, false],
      [REHAB.none, true],
      [REHAB.forward, false],
    ]);
    expect(requests[0]?.c2s).toMatchObject({
      klType: 2,
      security: { market: 1, code: '00700' },
      beginTime: '2026-10-01',
      endTime: '2026-10-13',
    });
  });

  it('is a no_data error when OpenD has no bars for the range', async () => {
    const sdk = fakeSdk({ RequestHistoryKL: async () => ok({ klList: [] }) });
    await expect(
      fetchFutuDailyBars(client(sdk), { market: 'HK', symbol: '0700' }, '2026-10-01', '2026-10-13'),
    ).rejects.toMatchObject({ code: 'no_data' });
  });
});

// ------------------------------------------------------------------------------------------------- IV history
describe('buildFutuIvHistory', () => {
  it('turns percent IV and HV into fractions, drops placeholder rows and sorts ascending', () => {
    const points = buildFutuIvHistory([
      { time: '2026-10-13', iv: 30.367, hv: 31.196, underlyingPrice: 425.2 },
      { time: '2026-10-12', iv: 0, hv: 31.9 },
      { time: '2026-10-09', iv: 29.616, hv: 0, underlyingPrice: 424.8 },
      { time: '2026-10-08', hv: 29.5 },
    ]);
    expect(points).toEqual([
      { day: '2026-10-09', iv: 0.29616, hv: null, underlyingPrice: 424.8 },
      { day: '2026-10-13', iv: 0.30367, hv: 0.31196, underlyingPrice: 425.2 },
    ]);
  });
});

describe('fetchFutuIvHistory', () => {
  it('pages through the volatility list and keeps only days inside the requested range', async () => {
    const requests: Req[] = [];
    const sdk = fakeSdk({
      GetOptionUnderlyingHisVolatility: async (req) => {
        requests.push(req);
        if (!req.c2s.nextPageKey) {
          return ok({
            volatilityList: [
              { time: '2026-10-13', iv: 30, hv: 31 },
              { time: '2026-10-12', iv: 29, hv: 31 },
            ],
            nextPageKey: 'k2',
          });
        }
        return ok({
          volatilityList: [
            { time: '2026-10-09', iv: 28, hv: 30 },
            { time: '2025-12-31', iv: 20, hv: 20 },
          ],
        });
      },
    });
    const points = await fetchFutuIvHistory(client(sdk), { market: 'HK', symbol: '0700' }, '2026-01-01', '2026-10-13');
    expect(points.map((p) => [p.day, p.iv])).toEqual([
      ['2026-10-09', 0.28],
      ['2026-10-12', 0.29],
      ['2026-10-13', 0.3],
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.c2s).toMatchObject({ owner: { market: 1, code: '00700' }, beginTime: '2026-01-01' });
    expect(requests[1]?.c2s.nextPageKey).toBe('k2');
  });

  it('is a no_data error when every row is a placeholder', async () => {
    const sdk = fakeSdk({
      GetOptionUnderlyingHisVolatility: async () => ok({ volatilityList: [{ time: '2026-10-13', iv: 0 }] }),
    });
    await expect(
      fetchFutuIvHistory(client(sdk), { market: 'HK', symbol: '0700' }, '2026-01-01', '2026-10-13'),
    ).rejects.toMatchObject({ code: 'no_data' });
  });
});

// ------------------------------------------------------------------------------------- static info and state
describe('futu static info, state and quota', () => {
  it('maps static info rows and leaves out names OpenD does not know', async () => {
    const sdk = fakeSdk({
      GetStaticInfo: async (req) => {
        expect(req.c2s.securityList).toEqual([
          { market: 1, code: '00700' },
          { market: 1, code: '09999' },
        ]);
        return ok({
          staticInfoList: [
            {
              basic: {
                security: { market: 1, code: '00700' },
                id: '54047868453564',
                lotSize: 100,
                secType: 3,
                name: 'TENCENT',
                listTime: '2004-06-16',
                delisting: false,
              },
            },
          ],
        });
      },
    });
    const info = await futuSource(client(sdk)).staticInfo([
      { market: 'HK', symbol: '0700' },
      { market: 'HK', symbol: '9999' },
    ]);
    expect(info).toEqual([
      {
        security: { market: 1, code: '00700' },
        name: 'TENCENT',
        lotSize: 100,
        secType: 3,
        listTime: '2004-06-16',
        delisting: false,
      },
    ]);
  });

  it('reads the gateway state and the history quota', async () => {
    const sdk = fakeSdk({
      GetGlobalState: async () => ok({ marketHK: 6, marketUS: 8, qotLogined: true, trdLogined: true, serverVer: 1011 }),
      RequestHistoryKLQuota: async () => ok({ usedQuota: 1, remainQuota: 999 }),
    });
    const src = futuSource(client(sdk));
    expect(await src.globalState()).toEqual({
      qotLogined: true,
      trdLogined: true,
      marketHK: 6,
      marketUS: 8,
      serverVer: 1011,
    });
    expect(await src.historyQuota()).toEqual({ used: 1, remaining: 999 });
  });
});

// ------------------------------------------------------------------------------------------------- put chain
describe('fetchFutuPutChain', () => {
  const inst = { market: 'HK' as const, symbol: '0700', multiplier: 100 };
  const opts = { now: new Date('2026-10-09T08:05:00Z'), minDte: 14, maxDte: 75 };

  function happyHandlers(overrides: { lotSize?: number } = {}) {
    const requests: [string, Req][] = [];
    return {
      requests,
      handlers: {
        GetSecuritySnapshot: async (req: Req) => {
          requests.push(['snapshot', req]);
          const list = req.c2s.securityList as { code: string }[];
          if (list.length === 1 && list[0]?.code === '00700') {
            return ok({
              snapshotList: [{ basic: { security: { market: 1, code: '00700' }, curPrice: 400, updateTimestamp: ts } }],
            });
          }
          return ok({
            snapshotList: list.map((s) => ({
              basic: { security: s, curPrice: 5.2, volume: long(1200), bidPrice: 5.1, askPrice: 5.4 },
              optionExData: {
                strikePrice: 380,
                openInterest: 900,
                impliedVolatility: 32.5,
                delta: -0.21,
                gamma: 0.01,
                vega: 0.2,
                theta: -0.05,
              },
            })),
          });
        },
        GetOptionExpirationDate: async (req: Req) => {
          requests.push(['expirations', req]);
          return ok({
            dateList: [
              { strikeTime: '2026-11-26', optionExpiryDateDistance: 48 },
              { strikeTime: '2026-12-30', optionExpiryDateDistance: 82 },
            ],
          });
        },
        GetOptionChain: async (req: Req) => {
          requests.push(['chain', req]);
          const lot = overrides.lotSize ?? 100;
          return ok({
            optionChain: [
              {
                strikeTime: '2026-11-26',
                option: [
                  {
                    put: {
                      basic: { security: { market: 1, code: 'TCH261126P380' }, lotSize: lot },
                      optionExData: { strikeTime: '2026-11-26', strikePrice: 380 },
                    },
                  },
                  {
                    put: {
                      basic: { security: { market: 1, code: 'TCH261126P500' }, lotSize: lot },
                      optionExData: { strikeTime: '2026-11-26', strikePrice: 500 },
                    },
                  },
                ],
              },
            ],
          });
        },
      } satisfies Record<string, Handler>,
    };
  }

  it('selects expiries in the DTE window, filters strikes and maps the result to a futu snapshot', async () => {
    const { handlers, requests } = happyHandlers();
    const snap = await fetchFutuPutChain(client(fakeSdk(handlers)), inst, opts);

    expect(snap.snapshotDate).toBe('2026-10-09');
    expect(snap.underlyingPrice).toBe(400);
    expect(snap.quotes.map((q) => [q.expiry, q.strike])).toEqual([['2026-11-26', 380]]);
    expect(snap.quotes[0]?.bid).toBe(5.1);

    const chain = requests.find((r) => r[0] === 'chain')?.[1];
    expect(chain?.c2s).toMatchObject({ type: 2, beginTime: '2026-11-26', endTime: '2026-11-26' });
  });

  it('a wider DTE window (HK six months) takes in the later expiry too', async () => {
    const { handlers, requests } = happyHandlers();
    await fetchFutuPutChain(client(fakeSdk(handlers)), inst, { ...opts, maxDte: 180 });
    const chains = requests.filter((r) => r[0] === 'chain').map((r) => r[1].c2s);
    expect(chains[0]).toMatchObject({ beginTime: '2026-11-26' });
    expect(chains[chains.length - 1]).toMatchObject({ endTime: '2026-12-30' });
  });

  it('fails loudly when the feed multiplier differs from the board lot', async () => {
    const { handlers } = happyHandlers({ lotSize: 50 });
    await expect(fetchFutuPutChain(client(fakeSdk(handlers)), inst, opts)).rejects.toMatchObject({
      code: 'multiplier_mismatch',
    });
  });

  it('maps an OpenD rejection to a ProviderError with the errCode', async () => {
    const { handlers } = happyHandlers();
    handlers.GetOptionChain = async () => {
      throw { retType: -1, retMsg: 'no option quote right', errCode: 1234 };
    };
    const err = await fetchFutuPutChain(client(fakeSdk(handlers)), inst, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'futu_1234' });
    expect((err as Error).message).toContain('no option quote right');
  });

  it('reports OpenD as unreachable when it never answers, and releases the socket', async () => {
    const sdk = fakeSdk({}, false);
    const c = new FutuClient(sdk, { host: '127.0.0.1', port: 33333, connectTimeoutMs: 20 });
    await expect(c.connect()).rejects.toMatchObject({ code: 'unreachable' });
    expect(sdk.closed).toBeGreaterThan(0);
    expect(sdk.started[0]).toEqual(['127.0.0.1', 33333, false, undefined]);
  });
});

describe('futu rate limit', () => {
  function throttled(sdk: ReturnType<typeof fakeSdk>, clock: { t: number }, sleeps: number[]) {
    return new FutuClient(sdk, {
      host: '127.0.0.1',
      port: 1,
      now: () => clock.t,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.t += ms;
      },
    });
  }

  it('never sends more than 9 chain requests inside 30 seconds, waiting instead of failing', async () => {
    const clock = { t: 0 };
    const sleeps: number[] = [];
    const stamps: number[] = [];
    const sdk = fakeSdk({
      GetOptionChain: async () => {
        stamps.push(clock.t);
        return ok({ optionChain: [] });
      },
    });
    const c = throttled(sdk, clock, sleeps);
    const owner = { market: 1, code: '00700' };
    for (let i = 0; i < 25; i++) await c.putContracts(owner, '2026-10-12', '2026-10-20');
    expect(stamps).toHaveLength(25);
    expect(sleeps.length).toBeGreaterThan(0);
    for (let i = 9; i < stamps.length; i++)
      expect((stamps[i] as number) - (stamps[i - 9] as number)).toBeGreaterThanOrEqual(30_000);
  });

  it('throttles history K-line requests to 9 per 30 seconds as well', async () => {
    const clock = { t: 0 };
    const sleeps: number[] = [];
    const stamps: number[] = [];
    const sdk = fakeSdk({
      RequestHistoryKL: async () => {
        stamps.push(clock.t);
        return ok({ klList: [kl('2026-10-02', 1)] });
      },
    });
    const c = throttled(sdk, clock, sleeps);
    for (let i = 0; i < 12; i++) await c.historyDailyBars({ market: 1, code: '00700' }, '2026-10-01', '2026-10-13', 0);
    expect(stamps).toHaveLength(12);
    expect((stamps[9] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(30_000);
  });
});
