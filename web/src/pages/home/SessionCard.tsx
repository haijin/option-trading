import type { Market, OverviewView, RegimeView } from '../../api/types';
import { Chip, type ChipKind } from '../../components/Chip';
import { useNow } from '../../hooks/useNow';
import { Meter } from '../../layout/Meter';
import { pct } from '../../lib/format';
import { toHash } from '../../lib/route';
import { clockText, type SessionBlock, sessionState } from '../../lib/sessions';

const DAY = 24 * 60;
const left = (minute: number): string => `${((minute / DAY) * 100).toFixed(2)}%`;

function regimeKind(regime: RegimeView): ChipKind {
  if (regime.regime.startsWith('bull')) return 'ok';
  if (regime.regime.startsWith('panic')) return 'fail';
  return 'warn';
}

function Band({ blocks, minute, open }: { blocks: SessionBlock[]; minute: number; open: 'HK' | 'US' | null }) {
  const label = blocks.map((b) => `${b.market} ${clockText(b.start)} to ${clockText(b.end)}`).join(', ');
  return (
    <>
      <div
        className="hm-band"
        role="img"
        aria-label={`Sessions in Hong Kong time: ${label}. Now ${clockText(minute)}.`}
      >
        {blocks.map((b) => (
          <span
            key={`${b.market}${b.start}`}
            className={`blk${b.market === 'US' ? ' us' : ''}${open === b.market && minute >= b.start && minute < b.end ? ' open' : ''}`}
            style={{ left: left(b.start), width: left(b.end - b.start) }}
          >
            {b.market}
          </span>
        ))}
        <span className="nowm" style={{ left: left(minute) }} />
      </div>
      <div className="hm-ticks" aria-hidden="true">
        <span>00:00</span>
        <span style={{ left: '25%' }}>06:00</span>
        <span style={{ left: '50%' }}>12:00</span>
        <span style={{ left: '75%' }}>18:00</span>
        <span style={{ left: '100%' }}>24:00</span>
      </div>
    </>
  );
}

/** One market on one row: its name, the S0 regime chip with the cap and delta limit, and the capital deployed against it. */
function MarketRow({ market, overview }: { market: Market; overview: OverviewView | undefined }) {
  const regime = overview?.regime[market];
  const deploy = overview?.deployed[market];
  return (
    <div className="hm-mk">
      <div className="hd">
        <b>{market}</b>
        {regime ? (
          <Chip kind={regimeKind(regime)} title={regime.note}>
            {regime.label}
          </Chip>
        ) : (
          <Chip>unknown</Chip>
        )}
        <small title="delta cap: the highest put delta the regime allows">
          {regime ? `Δ ≤ ${regime.deltaCap.toFixed(2)}` : 'no regime yet'}
        </small>
      </div>
      {deploy ? (
        <a href={toHash({ page: 'positions' })} aria-label={`${market} capital deployed, open Positions`}>
          <Meter
            market={market}
            deploy={deploy}
            label={`${pct(deploy.pctOfEquity)} deployed of ${pct(deploy.capPct, 0)} cap`}
          />
        </a>
      ) : (
        <span className="hm-mk-empty">no capital figures yet</span>
      )}
    </div>
  );
}

/**
 * The Home hero: both market sessions on one Hong Kong clock with a "now" marker and the next open or close in words,
 * then one row per market with the S0 regime and the capital deployed against its cap. Tapping a meter opens Positions.
 * On a laptop the three parts sit side by side in one strip; on a phone they stack.
 */
export function SessionCard({ overview }: { overview: OverviewView | undefined }) {
  const now = useNow(true, 30_000);
  const s = sessionState(new Date(now));
  return (
    <section className="hm-sess" aria-label="Sessions and capital">
      <div className="now">
        <span>
          <b>{s.headline}</b>
          <br />
          <span className="sub">{s.sub}</span>
        </span>
        <span className="clock">{s.clock} HKT</span>
      </div>
      <div className="hm-tl">
        <Band blocks={s.blocks} minute={s.minute} open={s.open} />
      </div>
      <div className="hm-state">
        <MarketRow market="US" overview={overview} />
        <MarketRow market="HK" overview={overview} />
      </div>
    </section>
  );
}
