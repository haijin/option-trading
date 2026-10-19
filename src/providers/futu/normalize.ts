/**
 * Pure mapping from OpenD rows to the app's types. No I/O here, so the rules are testable with plain objects.
 */
import type { Market } from '../../core/calendar';
import { type ISODate, isISODate } from '../../core/dates';
import type { DailyBar, OptionChainSnapshot, OptionQuote } from '../../core/types';
import {
  type FutuContract,
  type FutuKLine,
  type FutuSecurity,
  type FutuSnapshot,
  type FutuVolatilityItem,
  QOT_MARKET,
} from './client';

/** OpenD codes: HK codes are five digits (`0700` → `00700`), US codes are the ticker. */
export function futuSecurity(market: Market, symbol: string): FutuSecurity {
  return market === 'HK'
    ? { market: QOT_MARKET.HK, code: symbol.padStart(5, '0') }
    : { market: QOT_MARKET.US, code: symbol };
}

export function futuKey(s: FutuSecurity): string {
  return `${s.market}.${s.code}`;
}

/**
 * Protobuf int64 fields arrive as Long objects (the SDK configures long.js), doubles as numbers, and absent optional
 * fields as undefined. Returns null for anything that is not a finite number.
 */
export function num(x: unknown): number | null {
  let n: number;
  if (typeof x === 'number') n = x;
  else if (typeof x === 'object' && x !== null && 'toNumber' in x) n = (x as { toNumber(): number }).toNumber();
  else if (typeof x === 'string') n = Number(x);
  else return null;
  return Number.isFinite(n) ? n : null;
}

/** OpenD's K-line and volatility rows carry the market-local calendar day as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'. */
export function futuDay(time: string | undefined): ISODate | null {
  if (typeof time !== 'string') return null;
  const day = time.slice(0, 10);
  return isISODate(day) ? day : null;
}

// ------------------------------------------------------------------ daily bars

/**
 * Builds daily bars from two OpenD series of the same security: the raw one supplies open/high/low/close/volume, the
 * forward-adjusted one supplies the adjusted close (its latest bar equals the raw one; history is scaled for splits,
 * rights issues and dividends, the same convention as Yahoo's `adjclose`). A day missing from the adjusted series keeps
 * its raw close as the adjusted close; a day missing from the raw series is dropped, as are blank and non-positive rows.
 */
export function buildFutuBars(raw: FutuKLine[], adjusted: FutuKLine[], source = 'futu'): DailyBar[] {
  const adjByDay = new Map<ISODate, number>();
  for (const k of adjusted) {
    const day = futuDay(k.time);
    const close = num(k.closePrice);
    if (day && !k.isBlank && close !== null && close > 0) adjByDay.set(day, close);
  }
  const byDay = new Map<ISODate, DailyBar>();
  for (const k of raw) {
    const day = futuDay(k.time);
    if (!day || k.isBlank) continue;
    const open = num(k.openPrice);
    const high = num(k.highPrice);
    const low = num(k.lowPrice);
    const close = num(k.closePrice);
    if (open === null || high === null || low === null || close === null || close <= 0) continue;
    byDay.set(day, {
      day,
      open,
      high,
      low,
      close,
      adjClose: adjByDay.get(day) ?? close,
      volume: Math.max(0, Math.round(num(k.volume) ?? 0)),
      source,
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// --------------------------------------------------------------- IV history

export interface FutuIvPoint {
  day: ISODate;
  /** Implied volatility as a fraction (0.30 = 30%). */
  iv: number;
  /** Historical (realised) volatility as a fraction, when OpenD sends one. */
  hv: number | null;
  underlyingPrice: number | null;
}

/**
 * Percent fields become fractions; a row keeps only an IV inside 1% to 500% (outside that is a placeholder, not a
 * market), and the newest-first order OpenD sends becomes ascending by day with one row per day (last one wins).
 */
export function buildFutuIvHistory(items: FutuVolatilityItem[]): FutuIvPoint[] {
  const byDay = new Map<ISODate, FutuIvPoint>();
  for (const it of items) {
    const day = futuDay(it.time);
    const ivPct = num(it.iv);
    if (!day || ivPct === null) continue;
    const iv = ivPct / 100;
    if (iv < 0.01 || iv > 5) continue;
    const hvPct = num(it.hv);
    const hv = hvPct === null ? null : hvPct / 100;
    byDay.set(day, {
      day,
      iv,
      hv: hv !== null && hv > 0 && hv <= 5 ? hv : null,
      underlyingPrice: num(it.underlyingPrice),
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ----------------------------------------------------------------- put chain

export interface FutuPutChainInput {
  snapshotDate: ISODate;
  underlyingPrice: number;
  /** Board lot for HK, 100 for US. Every contract must report this same multiplier. */
  multiplier: number;
  contracts: FutuContract[];
  quotes: FutuSnapshot[];
  range?: { lo: number; hi: number };
}

/**
 * Builds the put-only snapshot. Mirrors the Yahoo normaliser: strike window around spot, IV kept only inside 1% to
 * 500% (outside that is a stale or illiquid row, not a real vol), and put deltas kept negative.
 * A contract without a matching snapshot row is skipped, not guessed.
 */
export function buildFutuPutChain(input: FutuPutChainInput): OptionChainSnapshot {
  const range = input.range ?? { lo: 0.5, hi: 1.15 };
  const byKey = new Map(input.quotes.map((q) => [futuKey(q.basic.security), q]));
  const quotes: OptionQuote[] = [];
  for (const c of input.contracts) {
    if (c.strike <= 0) continue;
    if (c.strike < range.lo * input.underlyingPrice || c.strike > range.hi * input.underlyingPrice) continue;
    const s = byKey.get(futuKey(c.security));
    const opt = s?.optionExData;
    if (!s || !opt) continue;
    const bid = num(s.basic.bidPrice);
    const ask = num(s.basic.askPrice);
    const last = num(s.basic.curPrice);
    const ivPct = num(opt.impliedVolatility);
    const iv = ivPct === null ? null : ivPct / 100;
    const delta = num(opt.delta);
    quotes.push({
      expiry: c.expiry,
      strike: c.strike,
      right: 'P',
      bid: bid !== null && bid >= 0 ? bid : null,
      ask: ask !== null && ask >= 0 ? ask : null,
      last: last !== null && last > 0 ? last : null,
      volume: num(s.basic.volume),
      openInterest: num(opt.openInterest),
      iv: iv !== null && iv >= 0.01 && iv <= 5 ? iv : null,
      delta: delta === null ? null : -Math.abs(delta),
      gamma: num(opt.gamma),
      theta: num(opt.theta),
      vega: num(opt.vega),
      multiplier: input.multiplier,
    });
  }
  return {
    snapshotDate: input.snapshotDate,
    underlyingPrice: input.underlyingPrice,
    source: 'futu',
    tier: 'real',
    quotes,
  };
}
