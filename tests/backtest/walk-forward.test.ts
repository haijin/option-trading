import { describe, expect, it } from 'vitest';
import { addMonths, type EvalResult, MAX_GRID, walkForward } from '../../src/backtest/walk-forward';

describe('addMonths', () => {
  it('does calendar-month arithmetic with end-of-month clamping', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2023-12-15', 2)).toBe('2024-02-15');
    expect(addMonths('2024-01-15', -1)).toBe('2023-12-15');
    expect(addMonths('2010-01-01', 36)).toBe('2013-01-01');
    expect(addMonths('2024-03-31', 0)).toBe('2024-03-31');
  });
});

describe('walkForward', () => {
  const ok = (sharpe: number | null, n = 10): EvalResult => ({ sharpe, totalReturn: null, n });

  it('rolls 36m train / 12m test windows that never overlap and end by `to`', async () => {
    const calls: { p: number; from: string; to: string }[] = [];
    const res = await walkForward<number>({
      from: '2010-01-01',
      to: '2016-12-31',
      trainMonths: 36,
      testMonths: 12,
      grid: [1, 2],
      evaluate: async (p, from, to) => {
        calls.push({ p, from, to });
        return ok(p);
      },
    });
    expect(res.windows).toHaveLength(4);
    expect(res.windows[0]).toMatchObject({
      trainFrom: '2010-01-01',
      trainTo: '2012-12-31',
      testFrom: '2013-01-01',
      testTo: '2013-12-31',
    });
    expect(res.windows[3]).toMatchObject({ trainFrom: '2013-01-01', testFrom: '2016-01-01', testTo: '2016-12-31' });
    for (const w of res.windows) {
      expect(w.trainTo < w.testFrom).toBe(true);
      expect(w.trainFrom < w.trainTo).toBe(true);
      expect(w.testTo <= '2016-12-31').toBe(true);
    }
    for (let k = 1; k < res.windows.length; k++) {
      // consecutive test windows tile with no overlap
      expect(res.windows[k - 1]!.testTo < res.windows[k]!.testFrom).toBe(true);
    }
    // per window: 2 training evaluations + 1 test evaluation of the winner only
    expect(calls).toHaveLength(4 * 3);
  });

  it('optimises on train only and evaluates only the winner on test', async () => {
    const calls: { p: string; from: string; to: string }[] = [];
    const res = await walkForward<string>({
      from: '2020-01-01',
      to: '2023-12-31',
      trainMonths: 24,
      testMonths: 12,
      grid: ['a', 'b', 'c'],
      evaluate: async (p, from, to) => {
        calls.push({ p, from, to });
        const isTrain = to <= '2021-12-31';
        // b is best in-sample, but c is best out-of-sample: selection must not peek at the test window
        const table: Record<string, [number, number]> = { a: [1, 3], b: [2, 0.2], c: [1.5, 5] };
        return ok(table[p]![isTrain ? 0 : 1]!);
      },
    });
    expect(res.windows).toHaveLength(2);
    expect(res.windows[0]!.bestParams).toBe('b');
    expect(res.windows[0]!.inSample.sharpe).toBe(2);
    expect(res.windows[0]!.outOfSample.sharpe).toBe(0.2);
    const testCalls = calls.filter((c) => c.from === '2022-01-01');
    expect(testCalls).toEqual([{ p: 'b', from: '2022-01-01', to: '2022-12-31' }]);
  });

  it('aggregates mean sharpes and pooled OOS n', async () => {
    const res = await walkForward<number>({
      from: '2010-01-01',
      to: '2015-12-31',
      trainMonths: 36,
      testMonths: 12,
      grid: [0],
      // training ranges start before 2013; test ranges start 2013-01-01 or later
      evaluate: async (_p, from) => (from < '2013-01-01' ? ok(2, 5) : ok(0.5, 7)),
    });
    expect(res.windows).toHaveLength(3);
    expect(res.aggregate.pooledOutOfSampleN).toBe(21);
    expect(res.aggregate.meanOutOfSampleSharpe).toBeCloseTo(0.5, 12);
    expect(res.aggregate.meanInSampleSharpe).toBeCloseTo(2, 12);
    expect(res.aggregate.overfitting).toBe(true);
  });

  it('does not flag overfitting when OOS holds up', async () => {
    const fine = await walkForward<number>({
      from: '2010-01-01',
      to: '2013-12-31',
      trainMonths: 36,
      testMonths: 12,
      grid: [0],
      evaluate: async () => ok(1),
    });
    expect(fine.aggregate.overfitting).toBe(false);
  });

  it('honours stepMonths and a custom objective', async () => {
    const res = await walkForward<number>({
      from: '2010-01-01',
      to: '2014-06-30',
      trainMonths: 24,
      testMonths: 6,
      stepMonths: 12,
      grid: [1, 2],
      objective: (r) => -(r.sharpe ?? 0), // prefers the LOWER sharpe, i.e. param 1
      evaluate: async (p) => ok(p),
    });
    expect(res.windows.map((w) => w.testFrom)).toEqual(['2012-01-01', '2013-01-01', '2014-01-01']);
    expect(res.windows.every((w) => w.bestParams === 1)).toBe(true);
  });

  it('default objective treats null sharpe as -Infinity and keeps the first on ties', async () => {
    const res = await walkForward<string>({
      from: '2010-01-01',
      to: '2012-12-31',
      trainMonths: 24,
      testMonths: 12,
      grid: ['x', 'y', 'z'],
      evaluate: async (p) => ok(p === 'x' ? null : 1),
    });
    expect(res.windows[0]!.bestParams).toBe('y');
  });

  it('returns no windows (and no warning) when the range is too short', async () => {
    const res = await walkForward<number>({
      from: '2020-01-01',
      to: '2021-12-31',
      trainMonths: 36,
      testMonths: 12,
      grid: [1],
      evaluate: async () => ok(1),
    });
    expect(res.windows).toEqual([]);
    expect(res.aggregate).toEqual({
      meanInSampleSharpe: null,
      meanOutOfSampleSharpe: null,
      overfitting: false,
      pooledOutOfSampleN: 0,
    });
  });

  it('rejects oversized or empty grids and bad windows', async () => {
    const evaluate = async () => ok(1);
    const base = { from: '2010-01-01', to: '2020-01-01', trainMonths: 36, testMonths: 12, evaluate };
    await expect(walkForward({ ...base, grid: Array.from({ length: MAX_GRID + 1 }, (_, i) => i) })).rejects.toThrow(
      RangeError,
    );
    await expect(walkForward({ ...base, grid: Array.from({ length: MAX_GRID }, (_, i) => i) })).resolves.toBeDefined();
    await expect(walkForward({ ...base, grid: [] })).rejects.toThrow(RangeError);
    await expect(walkForward({ ...base, trainMonths: 0, grid: [1] })).rejects.toThrow(RangeError);
    await expect(walkForward({ ...base, from: 'nope', grid: [1] })).rejects.toThrow();
  });
});
