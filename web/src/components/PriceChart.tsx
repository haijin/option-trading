import type { ChartView } from '../api/types';
import { linearScale, linePath, spreadLabels } from '../lib/chart';
import { n2 } from '../lib/format';

const W = 720;
const H = 270;
const PAD = { left: 8, right: 112, top: 14, bottom: 22 };

function lastDefined(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

interface Level {
  key: string;
  value: number;
  text: string;
  cls: string;
}

/** Close-price chart with SMA50, SMA200, support, strike and breakeven; right-edge labels never overlap. */
export function PriceChart({ chart }: { chart: ChartView }) {
  const { bars } = chart;
  if (bars.length < 2) return <p className="muted">Not enough price history to draw a chart.</p>;

  const closes = bars.map((bar) => bar.close);
  const sma50 = chart.sma50;
  const sma200 = chart.sma200;
  const levels: Level[] = [{ key: 'last', value: chart.last, text: `last ${n2(chart.last)}`, cls: 'lb-last' }];
  if (chart.support !== null)
    levels.push({ key: 'sup', value: chart.support, text: `support ${n2(chart.support)}`, cls: 'lb-sup' });
  if (chart.strike !== null)
    levels.push({ key: 'k', value: chart.strike, text: `strike ${n2(chart.strike)}`, cls: 'lb-k' });
  if (chart.breakeven !== null)
    levels.push({ key: 'be', value: chart.breakeven, text: `breakeven ${n2(chart.breakeven)}`, cls: 'lb-be' });
  const s50 = lastDefined(sma50);
  const s200 = lastDefined(sma200);
  const smaLabels: Level[] = [];
  if (s50 !== null) smaLabels.push({ key: '50', value: s50, text: `SMA50 ${n2(s50)}`, cls: 'lb-50' });
  if (s200 !== null) smaLabels.push({ key: '200', value: s200, text: `SMA200 ${n2(s200)}`, cls: 'lb-200' });

  const all = [...closes, ...levels.map((l) => l.value), ...smaLabels.map((l) => l.value)];
  for (const series of [sma50, sma200]) for (const v of series) if (v !== null) all.push(v);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.07 || 1;
  lo -= pad;
  hi += pad;

  const x = linearScale(0, bars.length - 1, PAD.left, W - PAD.right);
  const y = linearScale(lo, hi, H - PAD.bottom, PAD.top);
  const hline = (value: number, cls: string) => (
    <line className={cls} x1={PAD.left} x2={W - PAD.right} y1={y(value)} y2={y(value)} />
  );

  const labelled = [...levels, ...smaLabels];
  const labelYs = spreadLabels(
    labelled.map((l) => y(l.value) + 3),
    13,
    PAD.top + 6,
    H - PAD.bottom - 2,
  );

  const first = bars[0]?.day ?? '';
  const mid = bars[Math.floor(bars.length / 2)]?.day ?? '';
  const lastDay = bars[bars.length - 1]?.day ?? chart.asOf;
  const label = `Price chart for ${chart.symbol}: last ${n2(chart.last)} ${chart.currency}${chart.strike !== null ? `, strike ${n2(chart.strike)}` : ''}`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <path className="ln-200" d={linePath(sma200, x, y)} />
      <path className="ln-50" d={linePath(sma50, x, y)} />
      <path className="ln-price" d={linePath(closes, x, y)} />
      {chart.support !== null ? hline(chart.support, 'ln-sup') : null}
      {chart.strike !== null ? hline(chart.strike, 'ln-k') : null}
      {chart.breakeven !== null ? hline(chart.breakeven, 'ln-be') : null}
      {labelled.map((item, index) => (
        <text key={item.key} className={item.cls} x={W - PAD.right + 5} y={labelYs[index]}>
          {item.text}
        </text>
      ))}
      <text x={PAD.left + 2} y={H - 6}>
        {first}
      </text>
      <text x={(PAD.left + W - PAD.right) / 2} y={H - 6} textAnchor="middle">
        {mid}
      </text>
      <text x={W - PAD.right - 2} y={H - 6} textAnchor="end">
        {lastDay}
      </text>
    </svg>
  );
}
