/**
 * News page vocabulary (docs/designs/latest-news.md). Pure: no clock, no I/O. News rows are display-only data: no skill
 * reads them, and nothing in here feeds the scan.
 */
import { createHash } from 'node:crypto';
import { isTradingDay, type Market } from './calendar';
import { addDays, type ISODate, isWeekend } from './dates';

export const NEWS_IMPACTS = ['supports', 'caution', 'blocks', 'neutral'] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

/** F fundamentals, T timing, E events, P open position: the rule a story touched. */
export const NEWS_RULE_KEYS = ['f', 't', 'e', 'p'] as const;
export type NewsRuleKey = (typeof NEWS_RULE_KEYS)[number];

export interface NewsRule {
  key: NewsRuleKey;
  text: string;
}

export const NEWS_STANDING_KINDS = ['sell', 'open', 'wait', 'avoid'] as const;
export type NewsStandingKind = (typeof NEWS_STANDING_KINDS)[number];

/**
 * What the app thought of a name at one moment: the recommended put, the open position, or the reason it waits. Stored on
 * the news row when the model judged it (`ai_standing`), so a past day renders the judgement against the standing it had.
 */
export interface NewsStanding {
  kind: NewsStandingKind;
  /** 'Sell', 'Open put', 'Wait (was Sell)', 'Avoid'. */
  label: string;
  /** The contract or the reason, ready to print: '14 Nov 65 put, 19.4%/yr'. May be empty. */
  detail: string;
  strike: number | null;
  expiry: ISODate | null;
  dte: number | null;
  otmPct: number | null;
}

export type NewsSession = 'hk_open' | 'us_open' | 'manual';
export const NEWS_SESSIONS: readonly NewsSession[] = ['hk_open', 'us_open', 'manual'];

export interface NewsBullet {
  tag: 'US' | 'HK·CN' | 'Macro' | 'Dates';
  text: string;
}

export interface NewsTapeItem {
  key: string;
  label: string;
  /** Printed value: '17.2', '4.08%', '+0.9%'. */
  value: string;
  /** Day change in percent when the series has one. */
  changePct: number | null;
  /** The date of the last observation behind the number. */
  asOf: ISODate | null;
}

export interface NewsCitation {
  url: string;
  source: string;
  title: string;
  publishedAt: string;
}

// ---------------------------------------------------------------------------------------------------- Hong Kong days
/** The news page buckets by Hong Kong calendar day. Hong Kong has no daylight saving, so the offset is fixed. */
export const NEWS_TZ = 'Asia/Hong_Kong';
const HK_OFFSET_MS = 8 * 3_600_000;

/** The instant a Hong Kong calendar day starts (00:00 HKT). */
export function hkDayStart(day: ISODate): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

/** The Hong Kong calendar date of an instant. */
export function hkDayOf(instant: Date): ISODate {
  return new Date(instant.getTime() + HK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * [from, to) for the `days` Hong Kong days that end on `day`; for today and one day it is the rolling last 24 hours. For today
 * `to` is one millisecond past `now`, so a story first seen at this very instant (an undated one) is inside the window.
 */
export function newsWindow(day: ISODate, days: number, now: Date): { from: Date; to: Date; rolling: boolean } {
  const today = hkDayOf(now);
  const end = new Date(now.getTime() + 1);
  if (day >= today && days === 1) return { from: new Date(now.getTime() - 24 * 3_600_000), to: end, rolling: true };
  const from = hkDayStart(addDays(day, -(days - 1)));
  const to = day >= today ? end : hkDayStart(addDays(day, 1));
  return { from, to, rolling: false };
}

// ------------------------------------------------------------------------------------------------------------ urls
const TRACKING_PARAM = /^(utm_|\.tsrc$|guccounter$|guce_|ncid$|ocid$|cmpid$|ref$|src$)/i;

/** Strips fragments and tracking parameters so the same story seen twice dedupes. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    let s = u.href;
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function newsHash(url: string): string {
  return createHash('sha256').update(canonicalUrl(url)).digest('hex');
}

/** True for http(s) links only: a model or a feed must never hand the page a javascript: or data: URL. */
export function isHttpUrl(raw: string): boolean {
  try {
    const p = new URL(raw).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------------- schedule
const MARKET_HOURS: Record<Market, { tz: string; open: number; close: number }> = {
  HK: { tz: 'Asia/Hong_Kong', open: 9 * 60, close: 16 * 60 + 30 },
  US: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
};

/** The calendar date and minute of the day an instant has in a time zone. */
export function localClock(now: Date, tz: string): { date: ISODate; minutes: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function tradingDay(market: Market, day: ISODate): boolean {
  try {
    return isTradingDay(market, day);
  } catch {
    return !isWeekend(day); // outside the calendar tables: weekdays only
  }
}

export function marketIsOpen(market: Market, now: Date): boolean {
  const h = MARKET_HOURS[market];
  const { date, minutes } = localClock(now, h.tz);
  return tradingDay(market, date) && minutes >= h.open && minutes < h.close;
}

/**
 * `news-fetch` ticks every 30 minutes (weekdays and weekends alike: HKEXnews posts on Saturdays). The tick at :00 always
 * runs; the one at :30 runs only while the Hong Kong or the US market is open, so the cadence is hourly otherwise.
 */
export function newsFetchDue(now: Date): boolean {
  return now.getUTCMinutes() < 30 || marketIsOpen('HK', now) || marketIsOpen('US', now);
}

/**
 * The brief jobs fire at 07:30 and 21:00 Hong Kong time and write a brief only on a trading day of their market. 21:00 in
 * Hong Kong is the morning of the same calendar date in New York.
 */
export function briefSessionDue(session: 'hk_open' | 'us_open', now: Date): boolean {
  const market: Market = session === 'hk_open' ? 'HK' : 'US';
  return tradingDay(market, localClock(now, MARKET_HOURS[market].tz).date);
}

// -------------------------------------------------------------------------------------------------------- printing
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-14' -> '14 Nov'. */
export function fmtDayMonth(day: ISODate): string {
  const m = Number(day.slice(5, 7));
  return `${Number(day.slice(8, 10))} ${MONTHS[m - 1] ?? day.slice(5, 7)}`;
}

/** 65 -> '65', 62.5 -> '62.5': the strike as a trader writes it. */
export function fmtStrike(strike: number): string {
  return String(Number(strike.toFixed(2)));
}
