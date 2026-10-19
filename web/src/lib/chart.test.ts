import { describe, expect, it } from 'vitest';
import { linearScale, linePath, placeMarkers, spreadLabels } from './chart';

function minGapOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, (sorted[i] as number) - (sorted[i - 1] as number));
  return gap;
}

describe('spreadLabels', () => {
  it('keeps labels at least minGap apart, in bounds, and returns them in input order', () => {
    const out = spreadLabels([100, 102, 101, 180, 181], 13, 10, 200);
    expect(minGapOf(out)).toBeGreaterThanOrEqual(13 - 1e-9);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...out)).toBeLessThanOrEqual(200);
    // the original order of nearby labels is preserved: 100 < 101 < 102 and 180 < 181
    expect(out[0] as number).toBeLessThan(out[2] as number);
    expect(out[2] as number).toBeLessThan(out[1] as number);
    expect(out[3] as number).toBeLessThan(out[4] as number);
  });

  it('pulls a crowded bottom edge back up instead of overflowing', () => {
    const out = spreadLabels([245, 246, 247, 248], 13, 0, 250);
    expect(Math.max(...out)).toBeLessThanOrEqual(250);
    expect(minGapOf(out)).toBeGreaterThanOrEqual(13 - 1e-9);
  });

  it('leaves well separated labels alone', () => {
    expect(spreadLabels([20, 80, 140], 13, 0, 200)).toEqual([20, 80, 140]);
  });
});

describe('linePath and linearScale', () => {
  it('starts a new sub-path after a gap', () => {
    const path = linePath(
      [null, 1, 2, null, 3],
      (i) => i * 10,
      (v) => v * 10,
    );
    expect(path).toBe('M10.0,10.0L20.0,20.0M40.0,30.0');
  });

  it('maps a domain onto a range', () => {
    const y = linearScale(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(50)).toBe(100);
  });
});

describe('placeMarkers', () => {
  it('puts nearby markers on different lanes', () => {
    const markers = placeMarkers([70, 71, 72], 60, 80);
    expect(new Set(markers.map((m) => m.lane)).size).toBe(3);
  });

  it('keeps far apart markers on the first lane and clamps to the track', () => {
    const markers = placeMarkers([50, 80, 200], 60, 100);
    expect(markers.map((m) => m.lane)).toEqual([0, 0, 0]);
    expect(markers[0]?.x).toBe(6);
    expect(markers[2]?.x).toBe(94);
  });
});
