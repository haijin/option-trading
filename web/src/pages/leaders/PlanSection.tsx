import type { LeaderCandidateView } from '../../api/types';
import { num } from '../../lib/format';
import { toHash } from '../../lib/route';
import { lotText, money0, noPlanNote, price } from './leadersLib';

function Row({ label, value, toneClass = '' }: { label: string; value: string; toneClass?: string }) {
  return (
    <div>
      <span>{label}</span>
      <span className={`v ${toneClass}`.trim()}>{value}</span>
    </div>
  );
}

/**
 * The trade plan of a Setup, stop first: entry at the close or a stop-buy above the day's high, the stop, 1R, the size that
 * risks 0.5% of equity, and the 3R / 5R levels. A Watch has no plan and says why. Without equity the sizing rows stay blank.
 */
export function PlanSection({ c }: { c: LeaderCandidateView }) {
  const p = c.plan;
  if (!p) {
    return (
      <div className="ld-sec">
        <h3>Trade plan · needs a turn-up bar</h3>
        <p className="ld-note">{noPlanNote(c)}</p>
      </div>
    );
  }
  const unsized = p.shares === null;
  return (
    <div className="ld-sec">
      <h3>Trade plan · risk 0.5% of equity</h3>
      <div className="ld-plan">
        <Row label="Entry (close)" value={price(c, p.entry)} />
        <Row label="Stop-buy alt." value={price(c, p.altEntry)} />
        <Row label="Stop" value={price(c, p.stop)} toneClass="dn" />
        <Row label="Stop distance" value={`${num(p.stopPct, 1)}%`} />
        <Row label="1R" value={price(c, p.r)} />
        <Row label="Risk budget" value={money0(c, p.riskBudget)} />
        <Row label={`Shares${lotText(p.lot)}`} value={p.shares === null ? '-' : num(p.shares)} />
        <Row label="Risk at stop" value={money0(c, p.riskAtStop)} />
        <Row label="Position" value={money0(c, p.positionValue)} />
        <Row label="% of equity" value={p.pctOfEquity === null ? '-' : `${num(p.pctOfEquity, 1)}%`} />
        <Row label="3R · sell part" value={price(c, p.r3)} toneClass="big" />
        <Row label="5R · sell part" value={price(c, p.r5)} toneClass="big" />
      </div>
      {unsized ? (
        <>
          <p className="ld-note warn">Set equity in Settings to size this.</p>
          <a className="ld-research" href={toHash({ page: 'settings' })}>
            Open Settings ›
          </a>
        </>
      ) : null}
      {p.lotAssumed ? (
        <p className="ld-note">
          The board lot of {num(p.lot)} shares is a default, not a verified lot: check it with your broker.
        </p>
      ) : null}
      <p className="ld-note">
        Trail the rest. Levels are before costs; the stop is the lower of today's and yesterday's low less 0.2%.
      </p>
    </div>
  );
}
