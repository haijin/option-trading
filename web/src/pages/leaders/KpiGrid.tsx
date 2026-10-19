import type { LeaderCandidateView } from '../../api/types';
import { num } from '../../lib/format';
import { bigMoney, gain, rankText, ratio0, tone } from './leadersLib';

function Kpi({
  label,
  value,
  small,
  toneClass = '',
}: {
  label: string;
  value: string;
  small?: string;
  toneClass?: string;
}) {
  return (
    <div className="ld-kpi">
      <div className="l">{label}</div>
      <div className={`v ${toneClass}`.trim()}>
        {value}
        {small ? <small>{small}</small> : null}
      </div>
    </div>
  );
}

/** The 3 x 3 grid under the chart: returns with their percentile, distances, base shape, and liquidity. */
export function KpiGrid({ c }: { c: LeaderCandidateView }) {
  const cur = c.currency === 'USD' ? 'US$' : 'HK$';
  return (
    <div className="ld-kpis">
      <Kpi label="1m" value={gain(c.ret1mPct)} small={rankText(c.rank1m)} toneClass={tone(c.ret1mPct)} />
      <Kpi label="3m" value={gain(c.ret3mPct)} small={rankText(c.rank3m)} toneClass={tone(c.ret3mPct)} />
      <Kpi label="6m" value={gain(c.ret6mPct)} small={rankText(c.rank6m)} toneClass={tone(c.ret6mPct)} />
      <Kpi label="vs EMA 21" value={gain(c.distEma21Pct)} />
      <Kpi label="vs AVWAP" value={gain(c.distAvwapPct)} />
      <Kpi
        label="Base depth"
        value={c.base ? ratio0(c.base.depthRatio) : '-'}
        small={c.base ? `${c.base.lenDays} d` : undefined}
      />
      <Kpi label="Range 10/20" value={ratio0(c.base?.contractionRatio)} />
      <Kpi label="Vol 10/50" value={ratio0(c.base?.volDryUpRatio)} />
      <Kpi
        label="$ vol 20d · ATR"
        value={c.dollarVol20 === null ? '-' : `${cur}${bigMoney(c.dollarVol20)}`}
        small={c.atrPct === null ? undefined : `${num(c.atrPct, 1)}%`}
      />
    </div>
  );
}
