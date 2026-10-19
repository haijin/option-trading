import type { Currency } from '../api/types';

const LOCALE = 'en-US';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `toLocaleString('en-US')` with a fixed number of decimals (min..max). */
export function num(value: number, minDigits = 0, maxDigits = minDigits): string {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString(LOCALE, { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits });
}

export const n0 = (value: number): string => num(value, 0);
export const n1 = (value: number): string => num(value, 1);
export const n2 = (value: number): string => num(value, 2);

/** A strike as traders write it: 64, 60.5, 395 (no trailing zeros). */
export function strikeText(strike: number): string {
  return num(strike, 0, 2);
}

/** Percent field that is already a percentage (5.0 = 5%). */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '-';
  return `${num(value, digits)}%`;
}

/** Signed percentage, e.g. "+4.5%". */
export function signedPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '-';
  return `${value >= 0 ? '+' : '-'}${num(Math.abs(value), digits)}%`;
}

/** Volatility as traders read it: a decimal (0.194) is shown as 19.4%; a value above 3 is taken to be a percent already. */
export function volText(vol: number | null | undefined, digits = 1): string {
  if (vol === null || vol === undefined) return '-';
  return vol > 3 ? pct(vol, digits) : `${num(vol * 100, digits)}%`;
}

/** A ratio field (0.93 = 93%). */
export function ratioPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined) return '-';
  return `${num(ratio * 100, digits)}%`;
}

export function currencyPrefix(currency: Currency): string {
  return currency === 'USD' ? 'US$' : 'HK$';
}

/** "US$1,234" / "-HK$4,150". */
export function money(value: number, currency: Currency, digits = 0): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${currencyPrefix(currency)}${num(Math.abs(value), digits)}`;
}

/** "+HK$128,400" / "-US$4,150". */
export function signedMoney(value: number, currency: Currency, digits = 0): string {
  const sign = value < 0 ? '-' : '+';
  return `${sign}${currencyPrefix(currency)}${num(Math.abs(value), digits)}`;
}

/** "13 Nov" from an ISO date (no Date object: no timezone surprises). */
export function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month}` : iso;
}

/** "13 Nov 64P". */
export function contractLabel(expiry: string, strike: number): string {
  return `${shortDate(expiry)} ${strikeText(strike)}P`;
}

/** Local "2026-10-11 18:02" from an ISO timestamp; unparseable input is returned unchanged. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "1m 05s", "12s". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(count)} ${count === 1 ? singular : pluralForm}`;
}

/** "price 83% of IV" badge text from a price/IV ratio (a fraction). */
export function priceOfIvText(ratio: number): string {
  return `price ${num(ratio * 100, 0)}% of IV`;
}

/** "12% above" / "7% below" / "at intrinsic value" for a price/IV ratio (a fraction). */
export function priceVsIvText(ratio: number): { text: string; tone: 'pos' | 'neg' | '' } {
  const diff = Math.round(Math.abs(ratio - 1) * 100);
  if (diff === 0) return { text: 'at intrinsic value', tone: '' };
  return { text: `${diff}% ${ratio > 1 ? 'above' : 'below'}`, tone: ratio > 1 ? 'neg' : 'pos' };
}

/** Parses a user-typed number ("1,200", " 3.5 "); null when empty or not a finite number. */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
