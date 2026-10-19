import type {
  LeaderCandidateView,
  LeaderFlagView,
  LeaderOutcomeView,
  LeaderPutAngleView,
  LeadersView,
  LeaderWhyView,
  Market,
} from '../../api/types';
import { contractLabel, currencyPrefix, num, signedPct } from '../../lib/format';
import { fmtDay, fmtDayYear, hkTime } from '../../lib/news';

/** Pure helpers of the Leaders page: filtering, sorting, and the strings the cards print. */

export type MarketFilter = 'all' | Market;
export type StateFilter = 'all' | 'setup' | 'watch';
export type SortKey = 'score' | 'tight' | 'stop' | 'r3';

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'score', label: 'Score' },
  { id: 'tight', label: 'Tightness' },
  { id: 'stop', label: 'Stop %' },
  { id: 'r3', label: '3m gain' },
];

/** The method's stop cap and earnings blackout (params `stopMaxPct` 3% and `earningsBlackoutDays` 7 of leaders.pullback). */
export const STOP_CAP_PCT = 3;
export const BLACKOUT_DAYS = 7;

const LAST = Number.POSITIVE_INFINITY;

/** Base tightness: 10-bar over 20-bar range plus 10-bar over 50-bar volume. Lower is tighter; unknown sorts last. */
export function tightness(c: Pick<LeaderCandidateView, 'base'>): number {
  const ratio = c.base?.contractionRatio;
  const dry = c.base?.volDryUpRatio;
  if (ratio === null || ratio === undefined || dry === null || dry === undefined) return LAST;
  return ratio + dry;
}

const stateRank = (c: LeaderCandidateView): number => (c.state === 'setup' ? 0 : 1);

/** One sort key per option, lower first (so "higher is better" keys are negated). */
function keyOf(c: LeaderCandidateView, sort: SortKey): number {
  switch (sort) {
    case 'score':
      return -c.score;
    case 'tight':
      return tightness(c);
    case 'stop':
      return c.stopPct ?? LAST;
    case 'r3':
      return c.ret3mPct === null ? LAST : -c.ret3mPct;
  }
}

/** A new array: Setups before Watch on a tie, then the list's own rank, then id, so the order never jumps. */
export function sortCandidates(list: readonly LeaderCandidateView[], sort: SortKey): LeaderCandidateView[] {
  return [...list].sort((a, b) => {
    const ka = keyOf(a, sort);
    const kb = keyOf(b, sort);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return stateRank(a) - stateRank(b) || (a.rank ?? 999) - (b.rank ?? 999) || a.id - b.id;
  });
}

export function filterCandidates(
  list: readonly LeaderCandidateView[],
  market: MarketFilter,
  state: StateFilter,
): LeaderCandidateView[] {
  return list.filter((c) => (market === 'all' || c.market === market) && (state === 'all' || c.state === state));
}

// ------------------------------------------------------------------------------------------------ formatting
/** Price with the currency prefix and two decimals: "US$168.40", "HK$2.64". */
export function price(c: Pick<LeaderCandidateView, 'currency'>, value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '-';
  return `${currencyPrefix(c.currency)}${num(value, digits)}`;
}

/** Whole-money figure ("US$1,420"); "-" when the server could not size it. */
export function money0(c: Pick<LeaderCandidateView, 'currency'>, value: number | null | undefined): string {
  return price(c, value, 0);
}

/** "1.4b", "410m", "950k": a 20-day dollar volume in the name's own currency. */
export function bigMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value >= 1e9) return `${num(value / 1e9, 1)}b`;
  if (value >= 1e6) return `${num(value / 1e6, 0)}m`;
  return `${num(value / 1e3, 0)}k`;
}

/** A ratio as a whole percent: 0.62 -> "62%". */
export function ratio0(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

/** "+9.0%" / "-2.1%" / "-". */
export const gain = (value: number | null | undefined): string => signedPct(value, 1);

export const tone = (value: number | null | undefined): '' | 'up' | 'dn' =>
  value === null || value === undefined ? '' : value >= 0 ? 'up' : 'dn';

/** Percentile rank as the cards print it: 88 -> "p88". */
export const rankText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : `p${Math.round(value)}`;

/** The marker in front of a reason line. */
export const WHY_ICON: Record<LeaderWhyView['level'], string> = { pass: '✓', warn: '!', info: 'i' };

// ------------------------------------------------------------------------------------------------ chart link
/**
 * TradingView chart for a name, opened in a new tab: Hong Kong codes are `HKEX:700` (leading zeros dropped), US names
 * the bare symbol. Built here from the market and symbol only; no link is ever taken from the data.
 */
export function tradingViewUrl(market: Market, symbol: string): string {
  const exchange = market === 'HK' ? 'HKEX:' : '';
  const code = market === 'HK' ? symbol.replace(/^0+(?=\d)/, '') : symbol;
  return `https://www.tradingview.com/chart/?symbol=${exchange}${encodeURIComponent(code)}`;
}

// ------------------------------------------------------------------------------------------------ header and day lines
/** The Hong Kong calendar day of an ISO instant. */
export const hkDay = (iso: string): string => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

/** "after US close" when the US run is for the day shown, else "after HK close"; null when no run matches. */
export function sessionText(runs: LeadersView['runs'], asOf: string): string | null {
  if (runs.US?.asOf === asOf) return 'after US close';
  if (runs.HK?.asOf === asOf) return 'after HK close';
  return null;
}

/** "Tue 13 Oct · after US close · 06:52 HKT" for today, "Archive · Mon 12 Oct" for a stored day. */
export function asOfLine(view: LeadersView): string {
  if (view.asOf === null) return 'No scan yet';
  if (view.isArchive) return `Archive · ${fmtDay(view.asOf)}`;
  const parts: string[] = [fmtDay(view.asOf)];
  const session = sessionText(view.runs, view.asOf);
  if (session) parts.push(session);
  if (view.status.lastRunAt) parts.push(`${hkTime(view.status.lastRunAt)} HKT`);
  return parts.join(' · ');
}

/** The small line under the day label: when each market's run finished, or "outcomes stamped" on an archived day. */
export function runsLine(view: LeadersView): string {
  if (view.asOf === null) return '';
  if (view.isArchive) return `${view.asOf.slice(0, 4)} · outcomes stamped`;
  const times = (['HK', 'US'] as const)
    .map((m) => {
      const run = view.runs[m];
      return run?.finishedAt ? `${m} run ${hkTime(run.finishedAt)}` : null;
    })
    .filter((t): t is string => t !== null);
  return [fmtDayYear(view.asOf), ...(times.length > 0 ? [`${times.join(' · ')} HKT`] : [])].join(' · ');
}

// ------------------------------------------------------------------------------------------------ card text
/** "Put angle: 21 Nov 160P · delta .21 · 1.6% ROC · strike 1.1% under the stop". */
export function putAngleText(put: LeaderPutAngleView): string {
  const parts = [`Put angle: ${contractLabel(put.expiry, put.strike)}`];
  if (put.delta !== null) parts.push(`delta ${num(put.delta, 2).replace(/^0/, '')}`);
  if (put.rocPct !== null) parts.push(`${num(put.rocPct, 1)}% ROC`);
  if (put.belowStopPct !== null) parts.push(`strike ${num(put.belowStopPct, 1)}% under the stop`);
  return parts.join(' · ');
}

/** What a Watch card says where the plan would be: why there is none, and what the last turn-up bar needed. */
export function noPlanNote(c: Pick<LeaderCandidateView, 'stopPct' | 'earningsInDays'>): string {
  let text = 'Watch names have no plan: the stop is set from the turn-up bar on the day it prints.';
  if (c.stopPct !== null) {
    text += ` The last turn-up bar needed a ${num(c.stopPct, 1)}% stop${c.stopPct > STOP_CAP_PCT ? `, above the ${STOP_CAP_PCT}% cap` : ''}.`;
  }
  if (c.earningsInDays !== null && c.earningsInDays <= BLACKOUT_DAYS) {
    text += ` Earnings inside the ${BLACKOUT_DAYS}-day blackout.`;
  }
  return text;
}

const OWN_FLAGS = /^(on watchlist|chain stored)/i;

/**
 * The chips under the reasons: the server's flags, then "On watchlist" and "Chain stored" from the card's own booleans
 * (a server flag with the same words is dropped so neither shows twice).
 */
export function flagsOf(c: Pick<LeaderCandidateView, 'flags' | 'watched' | 'hasChain'>): LeaderFlagView[] {
  const flags = c.flags.filter((f) => !OWN_FLAGS.test(f.text));
  if (c.watched) flags.push({ level: 'ok', text: 'On watchlist' });
  if (c.hasChain) flags.push({ level: 'ok', text: 'Chain stored' });
  return flags;
}

/** Hong Kong lot text on a plan row: "(lot 100)" for a lot above one share. */
export function lotText(lot: number): string {
  return lot > 1 ? ` (lot ${num(lot)})` : '';
}

// ------------------------------------------------------------------------------------------------ archived days
export interface OutcomeText {
  /** "After 5 d +3.2% · 10 d +6.1%". */
  later: string;
  /** "Reached 3R in 7 d · max 3.4R", "Stopped first", "Still open". */
  result: string;
  kind: 'ok' | 'fail' | 'blue';
  /** "Counted to Fri 9 Oct". */
  counted: string | null;
}

/** What happened after the close a Setup was shown (an archived day only). */
export function outcomeText(o: LeaderOutcomeView): OutcomeText {
  const windows: [string, number | null][] = [
    ['5 d', o.fwd5Pct],
    ['10 d', o.fwd10Pct],
    ['20 d', o.fwd20Pct],
  ];
  const forward = windows.flatMap(([label, value]) => (value === null ? [] : [`${label} ${gain(value)}`]));
  let result: string;
  let kind: OutcomeText['kind'];
  if (o.hit3r) {
    result = `Reached 3R${o.daysTo3r === null ? '' : ` in ${o.daysTo3r} d`}`;
    kind = 'ok';
  } else if (o.stopped) {
    result = 'Stopped first';
    kind = 'fail';
  } else if (o.hit3r === null && o.stopped === null) {
    // No plan to follow (a Watch) or no bar yet: only the forward returns, if any, say anything.
    result = forward.length > 0 ? 'Watch: no plan to track' : 'Not counted yet';
    kind = 'blue';
  } else {
    result = 'Still open';
    kind = 'blue';
  }
  if (o.maxR !== null) result += ` · max ${num(o.maxR, 1)}R`;
  return {
    later: forward.length > 0 ? `After ${forward.join(' · ')}` : 'No bar after this day yet',
    result,
    kind,
    counted: o.asOf ? `Counted to ${fmtDay(o.asOf)}` : null,
  };
}
