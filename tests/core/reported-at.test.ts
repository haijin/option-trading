import { describe, expect, it } from 'vitest';
import { estimateReportedAt, isVisibleAsOf, resolveReportedAt } from '../../src/core/reported-at';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('T2: market-specific reported_at lag', () => {
  it('US quarterly is period_end + 45 days, US annual + 60', () => {
    expect(estimateReportedAt('US', 'quarterly', '2025-06-30')).toEqual(d('2025-08-14'));
    expect(estimateReportedAt('US', 'annual', '2025-09-30')).toEqual(d('2025-11-29'));
  });

  it('HK interim (semiannual and quarterly) is +60 days, HK annual +90', () => {
    expect(estimateReportedAt('HK', 'semiannual', '2025-06-30')).toEqual(d('2025-08-29'));
    expect(estimateReportedAt('HK', 'quarterly', '2025-09-30')).toEqual(d('2025-11-29'));
    expect(estimateReportedAt('HK', 'annual', '2025-12-31')).toEqual(d('2026-03-31'));
  });
});

describe('T2: clamp by first_seen_at', () => {
  const base = { market: 'US' as const, periodType: 'quarterly' as const, periodEnd: '2025-06-30' };

  it('pre-go-live history keeps the estimate (first seen long after it)', () => {
    const r = resolveReportedAt({ ...base, actual: null, firstSeenAt: d('2026-03-01') });
    expect(r).toEqual({ reportedAt: d('2025-08-14'), estimated: true });
  });

  it('a statement first seen BEFORE the estimate is anchored at first_seen_at (it was public by then)', () => {
    const r = resolveReportedAt({ ...base, actual: null, firstSeenAt: d('2025-07-30') });
    expect(r).toEqual({ reportedAt: d('2025-07-30'), estimated: true });
  });

  it('first_seen_at equal to the estimate gives the same instant', () => {
    const r = resolveReportedAt({ ...base, actual: null, firstSeenAt: d('2025-08-14') });
    expect(r.reportedAt).toEqual(d('2025-08-14'));
  });

  it('a real filing date wins and is not flagged estimated', () => {
    const r = resolveReportedAt({ ...base, actual: new Date('2025-07-31T20:05:00Z'), firstSeenAt: d('2026-03-01') });
    expect(r).toEqual({ reportedAt: new Date('2025-07-31T20:05:00Z'), estimated: false });
  });

  it('HK annual statement seen the day it appears is anchored then, not 90 days out', () => {
    const r = resolveReportedAt({
      market: 'HK',
      periodType: 'annual',
      periodEnd: '2025-12-31',
      actual: null,
      firstSeenAt: d('2026-03-18'),
    });
    expect(r).toEqual({ reportedAt: d('2026-03-18'), estimated: true });
  });
});

describe('point-in-time visibility', () => {
  it('visible on the day it is reported (any time that day) and not the day before', () => {
    expect(isVisibleAsOf(new Date('2025-08-14T15:00:00Z'), '2025-08-14')).toBe(true);
    expect(isVisibleAsOf(new Date('2025-08-14T15:00:00Z'), '2025-08-13')).toBe(false);
  });
});
