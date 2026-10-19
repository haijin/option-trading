/**
 * The watchlist board: one row per watched stock with price, KPIs, a highlight line and a recommendation.
 * Pure: no database, no clock (the as-of date comes in), so the server and the UI's mock server build the same rows
 * and tests can pin every rule. The recommendation is the scan's own verdict in plain words, not a second opinion:
 * `idea` -> sell put, a quality-gate failure -> avoid, any other rule that blocks it -> wait.
 */
import { diffDays, type ISODate } from '../core/dates';
import type {
  EarningsView,
  IdeaView,
  KpiRowView,
  ScreenView,
  ValueBadge,
  WatchAction,
  WatchActionKind,
  WatchBoardRow,
  WatchEntryView,
  WatchHighlight,
  WatchPutView,
  WatchStatus,
} from './api-types';

/** Results due within this many days are flagged. */
export const EARNINGS_SOON_DAYS = 14;
/** Price at or below this share of intrinsic value counts as undervalued (20% margin of safety). */
export const UNDERVALUED_RATIO = 0.8;
/** The price this far above intrinsic value is flagged as rich. */
export const RICH_RATIO = 1.2;
const MAX_HIGHLIGHTS = 3;
export const SPARKLINE_BARS = 60;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** Prices come out of the store at float32 precision: four decimals hides the noise and keeps sub-dollar names exact. */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

// ------------------------------------------------------------------------------------------------ recommendation
export interface RecommendInput {
  statusKind: WatchStatus['kind'];
  /** The scan's idea for this name, when it is one. */
  idea: { contract: Pick<IdeaView['contract'], 'annRocPct' | 'cushionPct'>; ruleWarns: string[] } | null;
  /** The rule that blocked it (the scan's binding reason). */
  binding: { skillId: string | null; rule: string; detail: string } | null;
  staleLastBar: ISODate | null;
  /** Next results date, when known: the earnings rules name it. */
  earningsDate: ISODate | null;
}

const LABELS: Record<WatchActionKind, string> = {
  sell_put: 'Sell put',
  wait: 'Wait',
  avoid: 'Avoid',
  hold: 'Hold',
  needs_data: 'Needs data',
};

const action = (kind: WatchActionKind, reason: string): WatchAction => ({ kind, label: LABELS[kind], reason });
const earningsAction = (date: ISODate | null): WatchAction =>
  action('wait', earningsText.text({ detail: '', earningsDate: date }));

/** Plain-English sentence from a rule's detail: first letter up, no trailing full stop (the UI adds none). */
function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, '');
  return t === '' ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

interface RuleText {
  kind: Exclude<WatchActionKind, 'sell_put' | 'hold'>;
  text: (ctx: { detail: string; earningsDate: ISODate | null }) => string;
}

const earningsText: RuleText = {
  kind: 'wait',
  text: ({ earningsDate }) =>
    earningsDate ? `Results due ${earningsDate}: wait until after them` : 'Results are close: wait until after them',
};
const noPrices: RuleText = { kind: 'needs_data', text: () => 'No option prices: run an ingest, or paste a chain' };
const fixed = (kind: RuleText['kind'], text: string): RuleText => ({ kind, text: () => text });

/** The scan's rule ids in plain words. A rule not listed here shows the scan's own note. */
const RULE_TEXT: Record<string, RuleText> = {
  'events.earningsBeforeExpiry': earningsText,
  'events.earningsWindow': earningsText,
  'events.earningsNeedsIvr': earningsText,
  'events.pendingCorporateAction': fixed('wait', 'A corporate action is pending: wait until it settles'),
  'regime.crashGuard': fixed('wait', 'The market regime has new entries off'),
  'delta.regimeCap': fixed('wait', 'No put fits the delta range the market regime allows'),
  'vol.noEdge': fixed('wait', 'Premium is thin: IV is neither high nor above realised volatility'),
  'vol.ivFloorRamp': fixed('wait', 'IV is at its floor with results 30 to 60 days out: premium ramps into them, wait'),
  'size.dailyLossHalt': fixed('wait', 'The drawdown governor has halted new puts for today'),
  'technical.fallingKnife': fixed('wait', 'Falling fast: wait for it to steady'),
  'technical.supportDistance': fixed('wait', 'Not near support yet'),
  'technical.trend': fixed('wait', 'In a downtrend: wait for it to turn'),
  'option.annRoc': fixed('wait', 'The best put pays too little a year'),
  'option.delta': fixed('wait', 'No put in the delta range the regime allows'),
  'option.noContract': fixed('wait', 'No put is quoted in the delta range'),
  'option.dte': fixed('wait', 'No expiry in the allowed day range'),
  'option.noChain': noPrices,
  'option.noPrice': noPrices,
  'option.noSynthetic': noPrices,
  'liquidity.oi': fixed('wait', 'Its options are too thinly traded'),
  'liquidity.spread': fixed('wait', 'Its option quotes are too wide'),
  'size.perNameCap': fixed('wait', 'One contract is bigger than the per-name cap'),
  'size.sectorCap': fixed('wait', 'Sector limit reached: puts are already open in this sector'),
  'size.regimeCap': fixed('wait', 'The market is at its deploy cap'),
  'fx.missing': fixed('needs_data', 'No FX rate to size it: run an ingest'),
  'fundamentals.insufficientData': fixed('needs_data', 'Too few financial statements to judge it: run an ingest'),
  'fundamentals.fScore': fixed('avoid', 'Weak financial health: Piotroski score below the floor'),
  'quality.fcfYield': fixed('avoid', 'Free cash flow yield is below the floor'),
  'quality.netDebtEbitda': fixed('avoid', 'Debt is too high against earnings'),
  'quality.dividendCut': fixed('avoid', 'It cut its dividend'),
  'quality.epsPositiveYears': fixed('avoid', 'Too few profitable years'),
  'quality.gmStability': fixed('avoid', 'Gross margin is unstable'),
  'solvency.altmanZ': fixed('avoid', 'Altman Z puts it in the distress zone'),
  'solvency.gearing': fixed('avoid', 'Gearing is too high'),
  'solvency.interestCover': fixed('avoid', 'Interest cover is too thin'),
};

export function recommend(i: RecommendInput): WatchAction {
  switch (i.statusKind) {
    case 'pending_first_ingest':
      return action('needs_data', 'No prices yet: run an ingest and it is scored');
    case 'stale':
      return action('needs_data', `Prices stop at ${i.staleLastBar ?? 'an old date'}: run an ingest`);
    case 'no_data':
      return action('needs_data', 'The scan found nothing to score today');
    case 'unscored':
      return action('needs_data', 'Not scored yet: set your equity in Settings');
    case 'paused':
      return action('wait', 'Not watching');
    case 'open_put':
      return action('hold', 'Open put: manage it on Positions; no new idea on this name');
    case 'idea': {
      if (!i.idea) return action('wait', 'Not recommended today');
      const warns = i.idea.ruleWarns.length;
      const tail = warns > 0 ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
      return action(
        'sell_put',
        `${r1(i.idea.contract.annRocPct)}% a year, ${r1(i.idea.contract.cushionPct)}% cushion${tail}`,
      );
    }
    case 'rejected': {
      const b = i.binding;
      if (!b) return action('wait', 'Not recommended today');
      const known = RULE_TEXT[b.rule];
      if (known) return action(known.kind, known.text({ detail: b.detail, earningsDate: i.earningsDate }));
      const why = sentence(b.detail) || b.rule;
      if (b.rule.startsWith('events.')) return earningsAction(i.earningsDate);
      if (b.skillId === 'fundamental.gate') return action('avoid', why);
      return action('wait', why);
    }
  }
}

// ------------------------------------------------------------------------------------------------ highlights
export interface HighlightInput {
  market: WatchBoardRow['market'];
  actionKind: WatchActionKind;
  rank: number | null;
  trend: WatchBoardRow['trend'];
  supportDistPct: number | null;
  rsi14: number | null;
  ivRank: number | null;
  priceRatio: number | null;
  screen: WatchBoardRow['screen'];
  earningsInDays: number | null;
  hasOpenPut: boolean;
  changePct: number | null;
}

/** What stands out about a name today, most important first, at most three. */
export function highlightsFor(i: HighlightInput): WatchHighlight[] {
  const out: WatchHighlight[] = [];
  const add = (tone: WatchHighlight['tone'], text: string): void => {
    out.push({ tone, text });
  };
  if (i.earningsInDays !== null && i.earningsInDays <= EARNINGS_SOON_DAYS) {
    add(
      'warn',
      i.earningsInDays === 0
        ? 'Results today'
        : i.earningsInDays === 1
          ? 'Results tomorrow'
          : `Results in ${i.earningsInDays} days`,
    );
  }
  if (i.actionKind === 'sell_put' && i.rank === 1) add('good', `Top ${i.market} idea`);
  if (i.supportDistPct !== null) {
    if (i.supportDistPct < 0) add('warn', `Below support (${r1(i.supportDistPct)}%)`);
    else if (i.supportDistPct <= 3) add('good', `Near support (+${r1(i.supportDistPct)}%)`);
  }
  if (i.priceRatio !== null) {
    if (i.priceRatio <= UNDERVALUED_RATIO) add('good', `${Math.round((1 - i.priceRatio) * 100)}% below IV`);
    else if (i.priceRatio >= RICH_RATIO) add('warn', `${Math.round((i.priceRatio - 1) * 100)}% above IV`);
  }
  if (i.ivRank !== null) {
    if (i.ivRank >= 60) add('good', `IV rank ${Math.round(i.ivRank)}: rich premium`);
    else if (i.ivRank <= 20) add('info', `IV rank ${Math.round(i.ivRank)}: thin premium`);
  }
  if (i.rsi14 !== null) {
    if (i.rsi14 <= 30) add('info', `Oversold, RSI ${Math.round(i.rsi14)}`);
    else if (i.rsi14 >= 70) add('warn', `Overbought, RSI ${Math.round(i.rsi14)}`);
  }
  if (i.trend === 'down') add('warn', 'Downtrend');
  if (i.screen === 'EXCLUDED') add('warn', 'Fails the quality screen');
  if (i.changePct !== null && Math.abs(i.changePct) >= 4)
    add('info', `${i.changePct > 0 ? '+' : '-'}${Math.abs(r1(i.changePct))}% today`);
  if (i.hasOpenPut) add('info', 'Open put');
  return out.slice(0, MAX_HIGHLIGHTS);
}

// ------------------------------------------------------------------------------------------------ rows
/** The part of the scan's idea the board reads: the UI's mock server builds it without a full IdeaView. */
export type BoardIdea = Pick<IdeaView, 'rank' | 'composite' | 'contract' | 'ruleWarns'>;

export interface BoardRowInput {
  entry: WatchEntryView;
  asOf: ISODate;
  /** Closes up to `asOf`, oldest first (the last `SPARKLINE_BARS` are kept). */
  closes: { day: ISODate; close: number }[];
  technical: {
    support: number | null;
    trendState: 'up' | 'down' | 'side' | null;
    rsi14: number | null;
  } | null;
  ivRank: number | null;
  kpis: KpiRowView[] | null;
  value: ValueBadge | null;
  screen: ScreenView['verdict'] | null;
  /** Rank and composite are the scan's: null when the name is not an idea. */
  idea: BoardIdea | null;
  binding: RecommendInput['binding'];
  staleLastBar: ISODate | null;
}

const kpi = (kpis: KpiRowView[] | null, key: string): number | null => {
  const v = kpis?.find((k) => k.key === key)?.value;
  return v === undefined || v === null || !Number.isFinite(v) ? null : v;
};

export function earningsInDays(asOf: ISODate, earnings: EarningsView | null): number | null {
  if (!earnings) return null;
  const d = diffDays(earnings.date, asOf);
  return d < 0 ? null : d;
}

function putOf(idea: BoardIdea | null): WatchPutView | null {
  if (!idea) return null;
  const c = idea.contract;
  return {
    strike: c.strike,
    expiry: c.expiry,
    dte: c.dte,
    delta: c.delta,
    premium: c.premium,
    annRocPct: r1(c.annRocPct),
    cushionPct: r1(c.cushionPct),
    warns: idea.ruleWarns.length,
  };
}

export function buildBoardRow(i: BoardRowInput): WatchBoardRow {
  const e = i.entry;
  const bars = i.closes.slice(-SPARKLINE_BARS);
  const last = bars[bars.length - 1] ?? null;
  const prev = bars[bars.length - 2] ?? null;
  const price = last ? r4(last.close) : null;
  const changePct = last && prev && prev.close > 0 ? r2((last.close / prev.close - 1) * 100) : null;
  const support = i.technical?.support ?? null;
  const supportDistPct = price !== null && support !== null && support > 0 ? r1((price / support - 1) * 100) : null;
  const days = earningsInDays(i.asOf, e.nextEarnings);
  const idea = e.status.kind === 'idea' ? i.idea : null;
  const act = recommend({
    statusKind: e.status.kind,
    idea,
    binding: i.binding,
    staleLastBar: i.staleLastBar ?? last?.day ?? null,
    earningsDate: e.nextEarnings?.date ?? null,
  });
  const trend = i.technical?.trendState ?? null;
  const rsi14 = i.technical?.rsi14 ?? null;
  const rank = idea?.rank ?? null;
  return {
    symbol: e.symbol,
    market: e.market,
    name: e.name,
    sector: e.sector,
    currency: e.currency,
    conviction: e.conviction,
    hasOpenPut: e.hasOpenPut,
    price,
    lastBar: last?.day ?? null,
    changePct,
    closes: bars.map((b) => r4(b.close)),
    trend,
    supportDistPct,
    rsi14: rsi14 === null ? null : r1(rsi14),
    ivRank: i.ivRank === null ? null : r1(i.ivRank),
    roePct: kpi(i.kpis, 'roe5'),
    // free cash flow is not a measure for banks and insurers (the KPI table skips ROIC and gross margin for them too)
    fcfYieldPct: e.solvencyModel === 'financial' ? null : kpi(i.kpis, 'fcf_yield'),
    pe: kpi(i.kpis, 'pe'),
    value: i.value,
    screen: i.screen,
    nextEarnings: e.nextEarnings,
    earningsInDays: days,
    rank,
    composite: idea?.composite ?? null,
    put: putOf(idea),
    action: act,
    highlights: highlightsFor({
      market: e.market,
      actionKind: act.kind,
      rank,
      trend,
      supportDistPct,
      rsi14,
      ivRank: i.ivRank,
      priceRatio: i.value?.priceRatio ?? null,
      screen: i.screen,
      earningsInDays: days,
      hasOpenPut: e.hasOpenPut,
      changePct,
    }),
  };
}

// ------------------------------------------------------------------------------------------------ list
const ACTION_ORDER: Record<WatchActionKind, number> = { sell_put: 0, wait: 1, avoid: 2, hold: 3, needs_data: 4 };

/** Default order: sell ideas by rank, then wait, avoid, hold, needs data; market and symbol break ties. */
export function compareBoardRows(a: WatchBoardRow, b: WatchBoardRow): number {
  return (
    ACTION_ORDER[a.action.kind] - ACTION_ORDER[b.action.kind] ||
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
    a.market.localeCompare(b.market) ||
    a.symbol.localeCompare(b.symbol)
  );
}
