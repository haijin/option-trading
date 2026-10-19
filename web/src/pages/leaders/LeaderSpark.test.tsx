import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeaderSpark, SparkLegend, sparkGeometry } from './LeaderSpark';
import { candidate } from './testFixtures';

const spark = candidate().spark;

describe('sparkGeometry', () => {
  it('scales everything into the 320 x 92 box', () => {
    const g = sparkGeometry(spark);
    expect(g).not.toBeNull();
    const points = [g?.close, g?.ema21, g?.ema50, g?.avwap]
      .flatMap((d) => (d ?? '').match(/-?\d+\.\d+/g) ?? [])
      .map(Number);
    expect(Math.min(...points)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...points)).toBeLessThanOrEqual(320);
    expect(g?.close.startsWith('M')).toBe(true);
    expect(g?.last?.x).toBeCloseTo(316, 5);
  });

  it('starts a series where it is first defined and lifts the pen at a gap', () => {
    const g = sparkGeometry({ ...spark, ema21: [null, null, 5, 6, null, 7, ...spark.ema21.slice(6)] });
    expect(g?.ema21.startsWith('M')).toBe(true);
    expect((g?.ema21.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('draws the stop only for a Setup, below the lowest close so the line is on the chart', () => {
    const withStop = sparkGeometry(spark);
    expect(withStop?.stop).not.toBeNull();
    expect(withStop?.stop?.x2).toBe(316);
    const without = sparkGeometry({ ...spark, stop: null });
    expect(without?.stop).toBeNull();
    const low = sparkGeometry({ ...spark, stop: 10 });
    expect(low?.stop?.y).toBeLessThanOrEqual(88);
    expect(low?.stop?.y).toBeGreaterThan(80);
  });

  it('puts the AVWAP anchor dot only when the range high is inside the 70 bars', () => {
    expect(sparkGeometry(spark)?.anchor).not.toBeNull();
    expect(sparkGeometry({ ...spark, anchorIndex: null })?.anchor).toBeNull();
  });

  it('has no chart for fewer than two bars', () => {
    expect(sparkGeometry({ ...spark, closes: [1] })).toBeNull();
  });
});

describe('LeaderSpark', () => {
  it('is a labelled image with the stop in its description for a Setup', () => {
    render(<LeaderSpark spark={spark} state="setup" />);
    expect(screen.getByRole('img', { name: /and the stop/ })).toBeInTheDocument();
  });

  it('has no stop in the description for a Watch', () => {
    render(<LeaderSpark spark={{ ...spark, stop: null }} state="watch" />);
    expect(screen.getByRole('img', { name: /AVWAP from the range high$/ })).toBeInTheDocument();
  });

  it('says there is no chart yet instead of drawing an empty one', () => {
    render(<LeaderSpark spark={{ ...spark, closes: [] }} state="watch" />);
    expect(screen.getByText('No chart yet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('SparkLegend', () => {
  it('lists Stop only when there is a stop line', () => {
    const { container, rerender } = render(<SparkLegend stop />);
    expect(container).toHaveTextContent('Stop');
    rerender(<SparkLegend stop={false} />);
    expect(container).not.toHaveTextContent('Stop');
    expect(container).toHaveTextContent('EMA 21');
  });
});
