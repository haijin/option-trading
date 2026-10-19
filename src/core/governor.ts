/**
 * Drawdown governor (docs/designs/trade-skills-integration.md T3; pitfall 31 of himself65/trade-skills): the portfolio
 * brakes a put seller keeps outside the per-name rules. Pure: the caller passes a ledger already bounded by asOf, the
 * settings and an FX function; nothing here reads a clock or a database, so S6 and the alerts job share it.
 *   day P&L      = closes booked on asOf + (today's marks - the previous marks of the same open puts), base currency
 *   drawdown     = peak-to-now of the cumulative P&L curve (closes to date + latest marks of the open puts), % of equity
 *   loss streak  = consecutive losing closes ending with the most recent close
 */
import type { ISODate } from './dates';
import type { Currency, DegearTier, GovernorSettings, LedgerMark, LedgerPosition, PnlLedger } from './types';

export interface PnlSummary {
  /** Realised P&L of the closes dated asOf, base currency. */
  realisedToday: number;
  /** Change in the unrealised P&L of the open puts marked on asOf against their previous mark, base currency. */
  markedToday: number;
  dayPnl: number;
  /** Cumulative P&L on asOf: every close on or before it plus the latest mark of each put still open. */
  cumulative: number;
  /** Highest cumulative P&L on any day up to asOf, never below 0 (the curve starts flat). */
  peak: number;
  /** peak - cumulative, base currency, never below 0. */
  drawdown: number;
  /** drawdown as a percent of equity; null without equity. */
  drawdownPct: number | null;
  /** Consecutive losing closes ending at the most recent close. */
  consecutiveLosses: number;
  /** Currencies with no FX rate to the base: their puts are left out of every number above. */
  skippedCurrencies: Currency[];
}

export interface GovernorDecision {
  /** Size multiplier from the deepest tier reached (1 when none). */
  multiplier: number;
  tier: DegearTier | null;
  /** Why new puts are halted for the day, or null. */
  halt: { kind: 'dailyLoss' | 'consecutiveLosses'; detail: string } | null;
}

export const NO_GOVERNOR: GovernorSettings = { dailyLossLimit: null, consecutiveLossHalt: null, degearTiers: [] };

/** Tiers worth applying, shallowest first: a positive drawdown and a multiplier between 0 and 1. */
export function normaliseTiers(tiers: readonly DegearTier[] | undefined): DegearTier[] {
  return (tiers ?? [])
    .filter(
      (t) =>
        Number.isFinite(t.drawdownPct) &&
        t.drawdownPct > 0 &&
        Number.isFinite(t.multiplier) &&
        t.multiplier >= 0 &&
        t.multiplier <= 1,
    )
    .map((t) => ({ drawdownPct: t.drawdownPct, multiplier: t.multiplier }))
    .sort((a, b) => a.drawdownPct - b.drawdownPct);
}

/** The deepest tier whose threshold the drawdown has reached, or null. */
export function tierReached(tiers: readonly DegearTier[], drawdownPct: number | null): DegearTier | null {
  if (drawdownPct === null) return null;
  let hit: DegearTier | null = null;
  for (const t of normaliseTiers(tiers)) if (drawdownPct >= t.drawdownPct) hit = t;
  return hit;
}

function latestMarkOn(marks: readonly LedgerMark[], day: ISODate): LedgerMark | null {
  let best: LedgerMark | null = null;
  for (const m of marks) if (m.day <= day && (best === null || m.day > best.day)) best = m;
  return best;
}

function openOn(p: LedgerPosition, day: ISODate): boolean {
  return p.openDate <= day && (p.closeDate === null || p.closeDate > day);
}

/**
 * The P&L picture on `asOf` in the base currency. The ledger must already be bounded by asOf (a close after it reads as
 * still open, marks after it absent): the DataAccess does that, and the lookahead test checks it.
 */
export function summarisePnl(
  ledger: PnlLedger,
  asOf: ISODate,
  equity: number | null,
  fxToBase: (from: Currency) => number | null,
): PnlSummary {
  const skipped = new Set<Currency>();
  const fx = (c: Currency): number | null => {
    const r = fxToBase(c);
    if (r === null) skipped.add(c);
    return r;
  };
  const positions = ledger.positions
    .filter((p) => p.openDate <= asOf)
    .map((p) => (p.closeDate !== null && p.closeDate > asOf ? { ...p, closeDate: null, realizedPnl: null } : p));
  const marksByPosition = new Map<number, LedgerMark[]>();
  for (const m of ledger.marks) {
    if (m.day > asOf) continue;
    const list = marksByPosition.get(m.positionId) ?? [];
    list.push(m);
    marksByPosition.set(m.positionId, list);
  }
  const inBase = (p: LedgerPosition, amount: number): number => {
    const r = fx(p.currency);
    return r === null ? 0 : amount * r;
  };

  const closed = positions
    .filter((p): p is LedgerPosition & { closeDate: ISODate } => p.closeDate !== null)
    .sort((a, b) => a.closeDate.localeCompare(b.closeDate) || a.positionId - b.positionId);

  const cumulativeOn = (day: ISODate): number => {
    let total = 0;
    for (const p of closed) if (p.closeDate <= day) total += inBase(p, p.realizedPnl ?? 0);
    for (const p of positions) {
      if (!openOn(p, day)) continue;
      const m = latestMarkOn(marksByPosition.get(p.positionId) ?? [], day);
      if (m) total += inBase(p, m.unrealizedPnl);
    }
    return total;
  };

  const days = new Set<ISODate>();
  for (const p of closed) days.add(p.closeDate);
  for (const list of marksByPosition.values()) for (const m of list) days.add(m.day);
  let peak = 0;
  for (const d of days) peak = Math.max(peak, cumulativeOn(d));
  const cumulative = cumulativeOn(asOf);
  peak = Math.max(peak, cumulative);
  const drawdown = Math.max(0, peak - cumulative);

  let realisedToday = 0;
  for (const p of closed) if (p.closeDate === asOf) realisedToday += inBase(p, p.realizedPnl ?? 0);
  let markedToday = 0;
  for (const p of positions) {
    if (!openOn(p, asOf)) continue;
    const list = marksByPosition.get(p.positionId) ?? [];
    const today = list.find((m) => m.day === asOf);
    if (!today) continue;
    const before = latestMarkOn(
      list.filter((m) => m.day < asOf),
      asOf,
    );
    markedToday += inBase(p, today.unrealizedPnl - (before?.unrealizedPnl ?? 0));
  }

  let consecutiveLosses = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const p = closed[i] as LedgerPosition;
    if ((p.realizedPnl ?? 0) < 0) consecutiveLosses++;
    else break;
  }

  return {
    realisedToday,
    markedToday,
    dayPnl: realisedToday + markedToday,
    cumulative,
    peak,
    drawdown,
    drawdownPct: equity !== null && equity > 0 ? (drawdown / equity) * 100 : null,
    consecutiveLosses,
    skippedCurrencies: [...skipped],
  };
}

const money = (x: number): string => Math.round(x).toLocaleString('en-US');

/** What the governor does with today's picture: the size multiplier of the tier reached and any halt. */
export function governorDecision(summary: PnlSummary, settings: GovernorSettings | undefined): GovernorDecision {
  const s = settings ?? NO_GOVERNOR;
  const tier = tierReached(s.degearTiers, summary.drawdownPct);
  let halt: GovernorDecision['halt'] = null;
  if (s.dailyLossLimit !== null && s.dailyLossLimit > 0 && summary.dayPnl <= -s.dailyLossLimit) {
    halt = {
      kind: 'dailyLoss',
      detail: `today's P&L ${money(summary.dayPnl)} is past the daily loss limit of ${money(s.dailyLossLimit)} (realised ${money(summary.realisedToday)}, marks ${money(summary.markedToday)})`,
    };
  } else if (
    s.consecutiveLossHalt !== null &&
    s.consecutiveLossHalt > 0 &&
    summary.consecutiveLosses >= s.consecutiveLossHalt
  ) {
    halt = {
      kind: 'consecutiveLosses',
      detail: `${summary.consecutiveLosses} losing closes in a row, at the halt of ${s.consecutiveLossHalt}`,
    };
  }
  return { multiplier: tier ? tier.multiplier : 1, tier, halt };
}

/**
 * The tier the portfolio entered between `previous` and `today`: non-null only when today's tier is deeper than
 * yesterday's (the alert fires once per crossing, never while the drawdown sits inside a tier).
 */
export function tierCrossed(
  tiers: readonly DegearTier[],
  previous: PnlSummary | null,
  today: PnlSummary,
): DegearTier | null {
  const now = tierReached(tiers, today.drawdownPct);
  if (!now) return null;
  const before = previous ? tierReached(tiers, previous.drawdownPct) : null;
  return before === null || now.drawdownPct > before.drawdownPct ? now : null;
}
