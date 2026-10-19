import { describe, expect, it } from 'vitest';
import { computeCoverage, KEY_FIELDS } from '../../src/db/coverage';

const row = (periodEnd: string, periodType: string, missing: string[] = []) => ({
  periodEnd,
  periodType,
  values: Object.fromEntries(KEY_FIELDS.map((f) => [f, missing.includes(f) ? null : 1])),
});

describe('S1 input coverage report', () => {
  it('4 annuals and 5 quarters: F-score and CAGR3 supported, 5-year medians and 8-period margins not', () => {
    const c = computeCoverage([
      row('2022-12-31', 'annual'),
      row('2023-12-31', 'annual'),
      row('2024-12-31', 'annual'),
      row('2025-12-31', 'annual', ['interestExpense', 'dividendsPaid']),
      ...['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'].map((d) => row(d, 'quarterly')),
    ]);
    expect(c).toMatchObject({
      annual: 4,
      quarterly: 5,
      semiannual: 0,
      firstPeriod: '2022-12-31',
      lastPeriod: '2026-03-31',
    });
    expect(c.supports).toEqual({
      fScore: true,
      revenueCagr3y: true,
      roic5y: false,
      valuationZ5y: false,
      gmStdev8: false,
    });
    expect(c.missingLatestAnnual).toEqual(['interestExpense', 'dividendsPaid']);
    expect(c.missingCells).toBe(2);
    expect(c.totalCells).toBe(4 * KEY_FIELDS.length);
  });

  it('5 annuals unlock the 5-year medians; no statements at all supports nothing', () => {
    const five = computeCoverage(Array.from({ length: 5 }, (_, i) => row(`${2021 + i}-12-31`, 'annual')));
    expect(five.supports).toMatchObject({ fScore: true, roic5y: true, valuationZ5y: true });
    const none = computeCoverage([]);
    expect(none.supports).toEqual({
      fScore: false,
      revenueCagr3y: false,
      roic5y: false,
      valuationZ5y: false,
      gmStdev8: false,
    });
    expect(none.missingLatestAnnual).toHaveLength(KEY_FIELDS.length);
  });
});
