import type { NewsImpact, NewsItemView, NewsStandingView } from '../api/types';

/** Date-only helpers for the News page. Every date is a `YYYY-MM-DD` string in Hong Kong time; arithmetic is done in UTC. */

export const IMPACT_LABEL: Record<NewsImpact, string> = {
  supports: 'Supports',
  caution: 'Caution',
  blocks: 'Blocks',
  neutral: 'Neutral',
};

/** Calendar dots show the most severe impact words first. */
export const DOT_ORDER: readonly (NewsImpact | 'none')[] = ['blocks', 'caution', 'supports', 'neutral', 'none'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const DOW_SHORT = DOW.map((d) => d.slice(0, 2).toUpperCase());

const toMs = (day: string): number =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, n: number): string => fromMs(toMs(day) + n * 86_400_000);

/** Whole days from `from` to `to` (positive when `to` is later). */
export const diffDays = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / 86_400_000);

/** 'Mon 12 Oct'. */
export function fmtDay(day: string): string {
  const d = new Date(toMs(day));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** 'Tue 13 Oct 2026'. */
export const fmtDayYear = (day: string): string => `${fmtDay(day)} ${day.slice(0, 4)}`;

/** '2026-10-13' -> '13 Oct'. */
export function fmtDayMonth(day: string): string {
  return `${Number(day.slice(8, 10))} ${MON[Number(day.slice(5, 7)) - 1]}`;
}

/** The sub-line under the day navigator: the year for a past day with how long ago it was, the full date for today. */
export function daySub(day: string, today: string): string {
  if (day === today) return fmtDayYear(day);
  const ago = diffDays(day, today);
  return `${day.slice(0, 4)} · ${ago === 1 ? 'yesterday' : `${ago} days ago`}`;
}

// ------------------------------------------------------------------------------------------------------------ months
export const monthOf = (day: string): string => day.slice(0, 7);

/** '2026-10' shifted by n months. */
export function shiftMonth(month: string, n: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  return `${MON[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

export interface CalendarCell {
  day: string;
  n: number;
  future: boolean;
  today: boolean;
  selected: boolean;
}

/** The days of a month with the weekday offset of the 1st (Sunday first), for the calendar grid. */
export function monthGrid(month: string, today: string, selected: string): { lead: number; cells: CalendarCell[] } {
  const first = `${month}-01`;
  const lead = new Date(toMs(first)).getUTCDay();
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const cells: CalendarCell[] = [];
  for (let n = 1; n <= count; n++) {
    const day = `${month}-${String(n).padStart(2, '0')}`;
    cells.push({ day, n, future: day > today, today: day === today, selected: day === selected });
  }
  return { lead, cells };
}

// ------------------------------------------------------------------------------------------------------------ stories
const HK_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 'HH:mm' in Hong Kong time. */
export const hkTime = (iso: string): string => HK_TIME.format(new Date(iso));

/** 'Today 05:10' for a story of the selected day when that is today, '05:10' for another selected day, else 'Mon 12 Oct 18:40'. */
export function whenLabel(item: Pick<NewsItemView, 'day' | 'publishedAt'>, selected: string, today: string): string {
  const t = hkTime(item.publishedAt);
  if (item.day === selected) return `${selected === today ? 'Today ' : ''}${t}`;
  return `${fmtDay(item.day)} ${t}`;
}

/** What the window chips say: 'Last' on today, 'Up to Mon 12 Oct, last' in the archive. */
export const windowPrefix = (date: string, today: string): string =>
  date === today ? 'Last' : `Up to ${fmtDay(date)}, last`;

/** 'in the last 24h', 'on Mon 12 Oct', 'in the 3 days to today' / 'to Mon 12 Oct'. */
export function windowPhrase(days: number, date: string, today: string): string {
  if (days === 1) return date === today ? 'in the last 24h' : `on ${fmtDay(date)}`;
  return `in the ${days} days to ${date === today ? 'today' : fmtDay(date)}`;
}

/** The text split into plain and matching parts, so the page can wrap matches in <mark> without injecting HTML. */
export function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const hay = text.toLowerCase();
  let from = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, from)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}

/** Two standings that print the same: the "then" line is only worth showing when it differs from now. */
export function sameStanding(a: NewsStandingView | null, b: NewsStandingView): boolean {
  return a !== null && a.label === b.label && a.detail === b.detail;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) links are rendered as links: a feed or a model must never hand the page a javascript: or data: URL. */
export function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}
