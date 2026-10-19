import { describe, expect, it } from 'vitest';
import { type AlertInput, evaluateAlerts } from '../../src/core/alerts';

const base: AlertInput = {
  strike: 100,
  expiry: '2026-04-17',
  openPrice: 2,
  openDate: '2026-03-02',
  today: '2026-03-13',
  spot: 112,
  mark: 1.2,
  nextEarnings: null,
};
const codes = (i: Partial<AlertInput>) => evaluateAlerts({ ...base, ...i }).map((a) => a.code);

describe('evaluateAlerts', () => {
  it('is quiet for a healthy put', () => {
    expect(codes({})).toEqual([]);
  });

  it('fires the 50% profit target at exactly half the credit and not below', () => {
    expect(codes({ mark: 1.0 })).toContain('profit50');
    expect(codes({ mark: 1.01 })).not.toContain('profit50');
  });

  it('fires the 2x stop when the loss reaches twice the credit', () => {
    // credit 2.00 -> stop at a mark of 6.00 (loss 4.00 = 2x)
    expect(codes({ mark: 6, spot: 100.5 })).toContain('stop2x');
    expect(codes({ mark: 5.9, spot: 100.5 })).not.toContain('stop2x');
  });

  it('applies the time exit at 21 DTE and fails past expiry', () => {
    expect(codes({ today: '2026-03-27' })).toContain('dte21'); // 21 DTE
    expect(codes({ today: '2026-03-26' })).not.toContain('dte21'); // 22 DTE
    const past = evaluateAlerts({ ...base, today: '2026-04-20' }).find((a) => a.code === 'dte21');
    expect(past?.level).toBe('fail');
  });

  it('flags assignment risk only when in the money with little time value', () => {
    // strike 100, spot 90, intrinsic 10; a 10.05 mark leaves 0.05 extrinsic < 1% of strike
    expect(codes({ spot: 90, mark: 10.05 })).toEqual(expect.arrayContaining(['itm', 'assignment_risk']));
    expect(codes({ spot: 90, mark: 12 })).not.toContain('assignment_risk');
    expect(codes({ spot: 105, mark: 0.2 })).not.toContain('assignment_risk');
  });

  it('skips the mark-based rules when there is no mark', () => {
    const c = codes({ mark: null, spot: 90 });
    expect(c).toContain('itm');
    expect(c).not.toContain('assignment_risk');
    expect(c).not.toContain('profit50');
    expect(c).not.toContain('stop2x');
  });

  it('warns when the spot is within 5% above the strike', () => {
    expect(codes({ spot: 104 })).toContain('near_strike');
    expect(codes({ spot: 106 })).not.toContain('near_strike');
  });

  it('flags earnings before expiry, and a date announced after the sale as new', () => {
    const known = { date: '2026-04-02', knownAt: '2026-02-01T00:00:00.000Z' };
    expect(codes({ nextEarnings: known })).toEqual(['earnings_before_expiry']);
    const fresh = { date: '2026-04-02', knownAt: '2026-03-10T09:00:00.000Z' };
    expect(codes({ nextEarnings: fresh })).toEqual(['earnings_before_expiry', 'new_earnings_date']);
    expect(codes({ nextEarnings: { date: '2026-05-01', knownAt: '2026-03-10T09:00:00.000Z' } })).toEqual([]);
  });
});
