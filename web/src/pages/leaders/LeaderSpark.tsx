import type { LeaderSparkView, LeaderState } from '../../api/types';

const W = 320;
const H = 92;
const PAD = 4;
/** The stop line starts this many bars before the last one. */
const STOP_BARS = 9;

export interface SparkGeometry {
  close: string;
  ema21: string;
  ema50: string;
  avwap: string;
  /** The AVWAP anchor dot (the range high), when it is inside the 70 bars. */
  anchor: { x: number; y: number } | null;
  last: { x: number; y: number } | null;
  stop: { x1: number; x2: number; y: number } | null;
}

/** An SVG path through the defined points; a gap (null) lifts the pen. */
function pathOf(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Scales the four series (and the stop) into the 320 x 92 box. Pure, so the picture can be checked without a DOM. */
export function sparkGeometry(spark: LeaderSparkView): SparkGeometry | null {
  const n = spark.closes.length;
  if (n < 2) return null;
  const all: number[] = [];
  for (const series of [spark.closes, spark.ema21, spark.ema50, spark.avwap]) {
    for (const v of series) if (v !== null && Number.isFinite(v)) all.push(v);
  }
  if (spark.stop !== null) all.push(spark.stop);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const x = (i: number): number => PAD + (i * (W - 2 * PAD)) / (n - 1);
  const y = (v: number): number => H - PAD - ((v - lo) * (H - 2 * PAD)) / (hi - lo || 1);
  const anchorAt = spark.anchorIndex;
  const anchorValue = anchorAt === null ? null : (spark.avwap[anchorAt] ?? spark.closes[anchorAt] ?? null);
  const lastClose = spark.closes[n - 1] as number;
  return {
    close: pathOf(spark.closes, x, y),
    ema21: pathOf(spark.ema21, x, y),
    ema50: pathOf(spark.ema50, x, y),
    avwap: pathOf(spark.avwap, x, y),
    anchor: anchorAt !== null && anchorValue !== null ? { x: x(anchorAt), y: y(anchorValue) } : null,
    last: { x: x(n - 1), y: y(lastClose) },
    stop: spark.stop === null ? null : { x1: x(Math.max(0, n - STOP_BARS)), x2: W - PAD, y: y(spark.stop) },
  };
}

const dot = (p: { x: number; y: number }): string => `M${p.x.toFixed(1)} ${p.y.toFixed(1)}h.01`;

/**
 * 70-bar picture of a candidate: close, EMA 21 (solid), EMA 50 (dashed), AVWAP from the range high (dotted, with a dot where
 * it starts) and, for a Setup, the stop as a red line. Strokes and dots keep their pixel size when the card is stretched.
 */
export function LeaderSpark({ spark, state }: { spark: LeaderSparkView; state: LeaderState }) {
  const g = sparkGeometry(spark);
  if (!g) return <div className="ld-spark ld-spark-empty">No chart yet</div>;
  return (
    <div className="ld-spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`70-day chart with the 21 and 50 day averages and the AVWAP from the range high${spark.stop === null ? '' : ', and the stop'}`}
      >
        <path
          d={g.ema50}
          fill="none"
          stroke="var(--dim)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={g.avwap}
          fill="none"
          stroke="var(--blue)"
          strokeWidth={1.4}
          strokeDasharray="1 3"
          vectorEffect="non-scaling-stroke"
        />
        <path d={g.ema21} fill="none" stroke="var(--warn)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        <path
          d={g.close}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.6}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {g.stop ? (
          <line
            x1={g.stop.x1}
            x2={g.stop.x2}
            y1={g.stop.y}
            y2={g.stop.y}
            stroke="var(--fail)"
            strokeWidth={1.2}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {g.anchor ? (
          <path
            d={dot(g.anchor)}
            stroke="var(--blue)"
            strokeWidth={5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {g.last ? (
          <path
            d={dot(g.last)}
            stroke={state === 'setup' ? 'var(--brand)' : 'var(--warn)'}
            strokeWidth={6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </div>
  );
}

/** The key under the chart. `stop` adds the red entry (a Setup). */
export function SparkLegend({ stop }: { stop: boolean }) {
  return (
    <div className="ld-legend" aria-hidden="true">
      <span>
        <i className="key" style={{ borderColor: 'var(--ink)' }} />
        Close
      </span>
      <span>
        <i className="key" style={{ borderColor: 'var(--warn)' }} />
        EMA 21
      </span>
      <span>
        <i className="key" style={{ borderColor: 'var(--dim)', borderTopStyle: 'dashed' }} />
        EMA 50
      </span>
      <span>
        <i className="key" style={{ borderColor: 'var(--blue)', borderTopStyle: 'dotted' }} />
        AVWAP (range high ●)
      </span>
      {stop ? (
        <span>
          <i className="key" style={{ borderColor: 'var(--fail)', borderTopStyle: 'dashed' }} />
          Stop
        </span>
      ) : null}
    </div>
  );
}
