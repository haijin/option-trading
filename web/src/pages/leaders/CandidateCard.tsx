import { useId, useState } from 'react';
import type { LeaderCandidateView } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { toHash } from '../../lib/route';
import { KpiGrid } from './KpiGrid';
import { LeaderSpark, SparkLegend } from './LeaderSpark';
import { flagsOf, gain, outcomeText, price, putAngleText, tone, tradingViewUrl, WHY_ICON } from './leadersLib';
import { PlanSection } from './PlanSection';
import { SupportMap } from './SupportMap';

export interface CardActions {
  onInvestigate: (c: LeaderCandidateView) => void;
  onWatch: (c: LeaderCandidateView) => void;
  onMute: (c: LeaderCandidateView) => void;
  /** A watch or mute request is in flight. */
  busy: boolean;
}

function Outcome({ c }: { c: LeaderCandidateView }) {
  if (!c.outcome) return null;
  const o = outcomeText(c.outcome);
  return (
    <div className="ld-outcome">
      <span className={`ld-flag ${o.kind}`}>{o.result}</span>
      <span>{o.later}</span>
      {o.counted ? <small className="when">{o.counted}</small> : null}
    </div>
  );
}

/**
 * One name on the list. Collapsed: identity, price, score, chart, the nine numbers, three reasons and the flags.
 * Expanded: the trade plan, the support map, the put angle, the research link and the actions.
 */
export function CandidateCard({ c, actions }: { c: LeaderCandidateView; actions: CardActions }) {
  const [open, setOpen] = useState(false);
  const moreId = useId();
  const flags = flagsOf(c);
  const stateText = c.state.toUpperCase();
  // Only a Setup or a Watch is scored and planned; a name listed under an earlier funnel stage just says where it stopped.
  const listed = c.state === 'setup' || c.state === 'watch';
  const toggle = (): void => setOpen((v) => !v);

  return (
    <article className={`ld-card ${c.state}${open ? ' open' : ''}`} aria-label={`${c.symbol} ${c.name ?? ''}`.trim()}>
      <button type="button" className="ld-hd" aria-expanded={open} aria-controls={moreId} onClick={toggle}>
        <span className="ld-rank num">{c.rank ?? '·'}</span>
        <span className="ld-idn">
          <span className="ld-sym">
            {c.symbol}
            <span className="ld-chip">{c.market}</span>
            <span className={`ld-badge ${c.state}`}>{stateText}</span>
            {c.isNew ? <span className="ld-badge new">NEW</span> : null}
          </span>
          <span className="ld-name">{c.name}</span>
        </span>
        <span className="ld-px">
          <span className="p num">{price(c, c.price)}</span>
          <span className={`c num ${tone(c.changePct)}`}>{gain(c.changePct)}</span>
        </span>
      </button>

      {listed ? (
        <div className="ld-score">
          <span>Score</span>
          <span className="bar" aria-hidden="true">
            <i className="fill" style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
          </span>
          <b>{Math.round(c.score)}</b>
        </div>
      ) : null}

      <LeaderSpark spark={c.spark} state={c.state} />
      <SparkLegend stop={c.spark.stop !== null} />
      <KpiGrid c={c} />

      {c.reason ? <p className="ld-reason">{c.reason}</p> : null}
      {c.why.length > 0 ? (
        <ul className="ld-why">
          {c.why.map((w) => (
            <li key={`${w.level}:${w.text}`}>
              <span className={`k ${w.level}`} aria-hidden="true">
                {WHY_ICON[w.level]}
              </span>
              <span>
                <span className="sr-only">
                  {w.level === 'pass' ? 'Pass: ' : w.level === 'warn' ? 'Warning: ' : 'Note: '}
                </span>
                {w.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {c.brief ? (
        <p className="ld-brief">
          <b>Model note</b> {c.brief}
        </p>
      ) : null}
      <Outcome c={c} />
      {flags.length > 0 ? (
        <div className="ld-flags">
          {flags.map((f) => (
            <span key={`${f.level}:${f.text}`} className={`ld-flag ${f.level}`}>
              {f.text}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ld-more" id={moreId} hidden={!open}>
        {listed ? <PlanSection c={c} /> : null}
        <SupportMap c={c} />
        {c.put ? (
          <div className="ld-sec">
            <p className="ld-put">{putAngleText(c.put)}</p>
          </div>
        ) : null}
        {c.researchReports > 0 ? (
          <div className="ld-sec">
            <a className="ld-research" href={toHash({ page: 'research', market: c.market, symbol: c.symbol })}>
              Research: {c.researchReports} {c.researchReports === 1 ? 'report' : 'reports'} ›
            </a>
          </div>
        ) : null}
        <div className="ld-acts">
          <button type="button" className="ld-btn pri" onClick={() => actions.onInvestigate(c)}>
            <Icon name="research" size={16} />
            Investigate
          </button>
          {c.watched ? null : (
            <button type="button" className="ld-btn" disabled={actions.busy} onClick={() => actions.onWatch(c)}>
              Add to watchlist
            </button>
          )}
          <a
            className="ld-btn ghost"
            href={tradingViewUrl(c.market, c.symbol)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Chart ${c.symbol} on TradingView (opens a new tab)`}
          >
            Chart ↗
          </a>
          <button
            type="button"
            className="ld-btn ghost danger"
            disabled={actions.busy}
            title="Hide it from the list for 10 trading days"
            onClick={() => actions.onMute(c)}
          >
            Dismiss
          </button>
        </div>
      </div>

      <div className="ld-foot">
        <button type="button" className="ld-btn pri sm" onClick={() => actions.onInvestigate(c)}>
          Investigate
        </button>
        <button type="button" className="ld-ex" aria-expanded={open} aria-controls={moreId} onClick={toggle}>
          {listed ? 'Plan & levels' : 'More'}
          <Icon name="chevron" size={16} />
        </button>
      </div>
    </article>
  );
}
