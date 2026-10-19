import { linearScale, linePath } from '../lib/chart';
import { num } from '../lib/format';

const W = 720;
const H = 220;
const PAD = { left: 8, right: 8, top: 12, bottom: 22 };

/** Equity over time with the starting capital as a reference line. `curve` is [day, equity, deployed share] per day. */
export function EquityChart({
  curve,
  start,
  label = 'Equity',
}: {
  curve: readonly [string, number, number][];
  start: number;
  label?: string;
}) {
  if (curve.length < 2) return <p className="muted">Not enough days to draw a curve.</p>;
  const values = curve.map((p) => p[1]);
  let lo = Math.min(start, ...values);
  let hi = Math.max(start, ...values);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const x = linearScale(0, curve.length - 1, PAD.left, W - PAD.right);
  const y = linearScale(lo, hi, H - PAD.bottom, PAD.top);
  const first = curve[0] as [string, number, number];
  const last = curve[curve.length - 1] as [string, number, number];
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label} from ${first[0]} to ${last[0]}, ${num(first[1])} to ${num(last[1])}`}
    >
      <line stroke="var(--line)" x1={PAD.left} x2={W - PAD.right} y1={y(start)} y2={y(start)} strokeDasharray="4 4" />
      <path className="ln-price" d={linePath(values, (i) => x(i), y)} fill="none" />
      <text x={PAD.left} y={H - 6}>
        {first[0]}
      </text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end">
        {last[0]}
      </text>
      <text x={W - PAD.right} y={PAD.top} textAnchor="end">
        {num(hi)}
      </text>
      <text x={W - PAD.right} y={H - PAD.bottom - 4} textAnchor="end">
        {num(lo)}
      </text>
    </svg>
  );
}
