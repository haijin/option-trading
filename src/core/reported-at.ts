import type { Market } from './calendar';
import { addDays, toISO } from './dates';
import type { PeriodType } from './types';

/**
 * Point-in-time anchor for fundamentals (docs/02 section 3). Yahoo rarely supplies filing dates, so the estimate is
 * market specific: US quarterly +45 days, US annual +60; HK interim (and any sub-annual period) +60, HK annual +90.
 * From go-live, `reported_at = min(estimate, first_seen_at)`: a statement we saw earlier than the estimate was
 * necessarily public by then, so the clamp can only move the anchor earlier, never later than the truth we observed.
 */
export const REPORTING_LAG_DAYS: Record<Market, Record<PeriodType, number>> = {
  US: { quarterly: 45, semiannual: 60, annual: 60, ttm: 45 },
  HK: { quarterly: 60, semiannual: 60, annual: 90, ttm: 60 },
};

export function estimateReportedAt(market: Market, periodType: PeriodType, periodEnd: string): Date {
  return new Date(`${addDays(periodEnd, REPORTING_LAG_DAYS[market][periodType])}T00:00:00Z`);
}

export interface ReportedAtInput {
  /** A real filing/announcement timestamp from the provider, when it gives one. */
  actual: Date | null;
  market: Market;
  periodType: PeriodType;
  periodEnd: string;
  /** When ingest first stored this statement (stable across re-ingests). */
  firstSeenAt: Date;
}

export interface ReportedAt {
  reportedAt: Date;
  estimated: boolean;
}

export function resolveReportedAt(i: ReportedAtInput): ReportedAt {
  if (i.actual) return { reportedAt: i.actual, estimated: false };
  const estimate = estimateReportedAt(i.market, i.periodType, i.periodEnd);
  const reportedAt = estimate.getTime() <= i.firstSeenAt.getTime() ? estimate : i.firstSeenAt;
  return { reportedAt, estimated: true };
}

/** A statement is visible on `asOf` when it was reported on or before the end of that day (UTC). */
export function isVisibleAsOf(reportedAt: Date | string, asOf: string): boolean {
  const t = typeof reportedAt === 'string' ? new Date(reportedAt).getTime() : reportedAt.getTime();
  return t < new Date(`${addDays(asOf, 1)}T00:00:00Z`).getTime();
}

export function dateOfTimestamp(t: Date): string {
  return toISO(t);
}
