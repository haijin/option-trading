import type { MethodView } from '../api/types';
import { placeMarkers } from '../lib/chart';
import { n2 } from '../lib/format';

export const METHOD_COLOR: Record<MethodView['id'], string> = {
  scenario: '#2563eb',
  dcf: '#d9822b',
  fair_value: '#7c3aed',
};

const LANE_TOP = [12, 82, -2];

export interface RangeBarProps {
  price: number;
  /** Intrinsic value, base case. */
  base: number;
  low: number;
  high: number;
  strike?: number | null;
  methods: readonly MethodView[];
}

/**
 * Where the price sits against the intrinsic-value range: a track from the lowest to the highest figure, a shaded
 * bear-to-bull band, one dot per method, and labelled markers for price, intrinsic value and strike.
 */
export function RangeBar({ price, base, low, high, strike, methods }: RangeBarProps) {
  const points: { key: string; cls: 'price' | 'iv' | 'strike'; value: number; text: string }[] = [
    { key: 'price', cls: 'price', value: price, text: `Price ${n2(price)}` },
    { key: 'iv', cls: 'iv', value: base, text: `Intrinsic ${n2(base)}` },
  ];
  if (strike !== null && strike !== undefined)
    points.push({ key: 'strike', cls: 'strike', value: strike, text: `Strike ${n2(strike)}` });

  const everything = [...points.map((p) => p.value), low, high, ...methods.map((m) => m.value)];
  const domainLo = Math.min(...everything) * 0.93;
  const domainHi = Math.max(...everything) * 1.05;
  const place = (value: number) => placeMarkers([value], domainLo, domainHi)[0]?.x ?? 0;
  const markers = placeMarkers(
    points.map((p) => p.value),
    domainLo,
    domainHi,
  );
  const bandLeft = place(low);
  const bandRight = place(high);

  return (
    <div>
      <div
        className="rb"
        role="img"
        aria-label={`Price ${n2(price)} against intrinsic value ${n2(base)}, range ${n2(low)} to ${n2(high)}`}
      >
        <div className="tr" />
        <div
          className="band"
          style={{ left: `${bandLeft}%`, width: `${Math.max(0.5, bandRight - bandLeft)}%` }}
          title={`range ${n2(low)} to ${n2(high)}`}
        />
        {methods.map((method) => (
          <div
            key={method.id}
            className="rbd"
            style={{ left: `${place(method.value)}%`, background: METHOD_COLOR[method.id] }}
            title={`${method.label} ${n2(method.value)}`}
          />
        ))}
        {points.map((point, index) => {
          const marker = markers[index];
          if (!marker) return null;
          return (
            <div key={point.key}>
              <div className={`rbm ${point.cls}`} style={{ left: `${marker.x}%` }} />
              <div className={`rbl ${point.cls}`} style={{ left: `${marker.x}%`, top: LANE_TOP[marker.lane] }}>
                {point.text}
              </div>
            </div>
          );
        })}
        <div className="rbl edge" style={{ left: `${bandLeft}%`, top: 96 }}>
          low {n2(low)}
        </div>
        <div className="rbl edge" style={{ left: `${bandRight}%`, top: 96 }}>
          high {n2(high)}
        </div>
      </div>
      <div className="leg">
        {methods.map((method) => (
          <span key={method.id}>
            <i style={{ background: METHOD_COLOR[method.id] }} />
            {method.label} {n2(method.value)}
          </span>
        ))}
        <span>shaded band = bear to bull range</span>
      </div>
    </div>
  );
}
