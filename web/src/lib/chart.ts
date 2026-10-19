/** Pure geometry helpers for the SVG charts, kept apart from React so they can be unit tested. */

/**
 * Spreads right-edge labels so no two are closer than `minGap`, keeping them inside [lo, hi].
 * Returns the adjusted y positions in the order of the input.
 */
export function spreadLabels(ys: readonly number[], minGap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  const out = order.map((item) => Math.min(hi, Math.max(lo, item.y)));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as number;
    if ((out[i] as number) - prev < minGap) out[i] = prev + minGap;
  }
  // The forward pass may have pushed the last labels past `hi`: pull them back up.
  if (out.length > 0 && (out[out.length - 1] as number) > hi) {
    out[out.length - 1] = hi;
    for (let i = out.length - 2; i >= 0; i--) {
      const next = out[i + 1] as number;
      if (next - (out[i] as number) < minGap) out[i] = next - minGap;
    }
  }
  const result = new Array<number>(ys.length).fill(0);
  order.forEach((item, position) => {
    result[item.index] = out[position] as number;
  });
  return result;
}

/** SVG path for a series with gaps (nulls start a new sub-path). */
export function linePath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let path = '';
  let pen = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      pen = false;
      return;
    }
    path += `${pen ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    pen = true;
  });
  return path;
}

/** Linear scale from a value domain to a pixel range. */
export function linearScale(
  domainLo: number,
  domainHi: number,
  rangeLo: number,
  rangeHi: number,
): (value: number) => number {
  const span = domainHi - domainLo || 1;
  return (value) => rangeLo + ((value - domainLo) / span) * (rangeHi - rangeLo);
}

export interface RangeMarker {
  value: number;
  /** Position in percent of the track (0..100). */
  x: number;
  /** Label lane (0, 1, 2) so neighbouring labels do not overlap. */
  lane: number;
}

/**
 * Places labelled markers on a 0..100 track and assigns each one a vertical lane so labels that would
 * overlap horizontally (closer than `minGap` percent) go on different lanes. Result order follows the input.
 */
export function placeMarkers(
  values: readonly number[],
  domainLo: number,
  domainHi: number,
  lanes = 3,
  minGap = 17,
  clamp: [number, number] = [6, 94],
): RangeMarker[] {
  const span = domainHi - domainLo || 1;
  const toX = (value: number) => Math.max(clamp[0], Math.min(clamp[1], ((value - domainLo) / span) * 100));
  const order = values.map((value, index) => ({ value, index, x: toX(value) })).sort((a, b) => a.x - b.x);
  const lastX = new Array<number>(lanes).fill(-999);
  const out = new Array<RangeMarker>(values.length);
  for (const item of order) {
    const gaps = lastX.map((last) => item.x - last);
    let lane = gaps.findIndex((gap) => gap >= minGap);
    if (lane < 0) lane = gaps.indexOf(Math.max(...gaps));
    lastX[lane] = item.x;
    out[item.index] = { value: item.value, x: item.x, lane };
  }
  return out;
}
