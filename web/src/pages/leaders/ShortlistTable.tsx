import { useId, useState } from 'react';
import type { LeaderCandidateView } from '../../api/types';
import { Icon } from '../../layout/Icon';
import { num } from '../../lib/format';
import { toHash } from '../../lib/route';
import type { CardActions } from './CandidateCard';
import { KpiGrid } from './KpiGrid';
import { LeaderSpark, SparkLegend } from './LeaderSpark';
import {
  bigMoney,
  flagsOf,
  gain,
  outcomeText,
  price,
  putAngleText,
  ratio0,
  tone,
  tradingViewUrl,
  WHY_ICON,
} from './leadersLib';
import { PlanSection } from './PlanSection';
import { SupportMap } from './SupportMap';

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="ld-tbl-score">
      <span className="bar" aria-hidden="true">
        <i className="ld-tbl-fill" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </span>
      <b>{Math.round(score)}</b>
    </span>
  );
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

function rowLabel(c: LeaderCandidateView): string {
  return `${c.symbol} ${c.name ?? ''}`.trim();
}

function DetailPanel({ c, actions }: { c: LeaderCandidateView; actions: CardActions }) {
  const listed = c.state === 'setup' || c.state === 'watch';
  const flags = flagsOf(c);
  return (
    <section className="ld-tbl-detail" aria-label={`${rowLabel(c)} details`}>
      <div className="ld-tbl-detail-left">
        <LeaderSpark spark={c.spark} state={c.state} />
        <SparkLegend stop={c.spark.stop !== null} />
        <KpiGrid c={c} />
        {c.why.length > 0 ? (
          <ul className="ld-why">
            {c.why.map((w) => (
              <li key={`${w.level}:${w.text}`}>
                <span className={`k ${w.level}`} aria-hidden="true">
                  {WHY_ICON[w.level]}
                </span>
                <span>{w.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {c.brief ? (
          <p className="ld-brief">
            <b>Model note</b> {c.brief}
          </p>
        ) : null}
        {flags.length > 0 ? (
          <div className="ld-flags">
            {flags.map((f) => (
              <span key={`${f.level}:${f.text}`} className={`ld-flag ${f.level}`}>
                {f.text}
              </span>
            ))}
          </div>
        ) : null}
        <Outcome c={c} />
      </div>
      <div className="ld-tbl-detail-right">
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
            title="Hide from the list for 10 trading days"
            onClick={() => actions.onMute(c)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}

/** One row of the shortlist table; clicking expands an inline detail panel. */
function ShortlistRow({ c, actions }: { c: LeaderCandidateView; actions: CardActions }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const listed = c.state === 'setup' || c.state === 'watch';
  const cur = c.currency === 'USD' ? 'US$' : 'HK$';
  const toggle = () => setOpen((v) => !v);

  return (
    <>
      <tr className={`ld-trow ${c.state}${open ? ' open' : ''}`} onClick={toggle}>
        <td className="ld-tc-rank num">{c.rank ?? '·'}</td>
        <td className="ld-tc-sym">
          <span className="ld-sym">
            {/* The whole row is clickable with a mouse; this button is the keyboard and screen-reader handle, and its click bubbles to the row. */}
            <button
              type="button"
              className="ld-rowbtn"
              aria-expanded={open}
              aria-controls={detailId}
              aria-label={rowLabel(c)}
            >
              {c.symbol}
            </button>
            <span className="ld-chip">{c.market}</span>
            <span className={`ld-badge ${c.state}`}>{c.state.toUpperCase()}</span>
            {c.isNew ? <span className="ld-badge new">NEW</span> : null}
          </span>
          <span className="ld-name">{c.name}</span>
        </td>
        <td className="ld-tc-px">
          <span className="num">{price(c, c.price)}</span>
          <span className={`chg num ${tone(c.changePct)}`}>{gain(c.changePct)}</span>
        </td>
        <td className="ld-tc-score">{listed ? <ScoreBar score={c.score} /> : null}</td>
        <td className="ld-tc-kpi ld-hide-sm">
          <span className={tone(c.ret1mPct)}>{gain(c.ret1mPct)}</span>
        </td>
        <td className="ld-tc-kpi ld-hide-sm">
          <span className={tone(c.ret3mPct)}>{gain(c.ret3mPct)}</span>
        </td>
        <td className="ld-tc-kpi ld-hide-sm">
          <span className={tone(c.ret6mPct)}>{gain(c.ret6mPct)}</span>
        </td>
        <td className="ld-tc-kpi ld-hide-md">
          <span>{gain(c.distEma21Pct)}</span>
        </td>
        <td className="ld-tc-kpi ld-hide-md">
          <span>{gain(c.distAvwapPct)}</span>
        </td>
        <td className="ld-tc-kpi ld-hide-lg">
          {c.base ? (
            <>
              {ratio0(c.base.depthRatio)}
              <small>{c.base.lenDays}d</small>
            </>
          ) : (
            '—'
          )}
        </td>
        <td className="ld-tc-kpi ld-hide-lg">{ratio0(c.base?.contractionRatio)}</td>
        <td className="ld-tc-kpi ld-hide-lg">{ratio0(c.base?.volDryUpRatio)}</td>
        <td className="ld-tc-kpi ld-hide-lg">
          {c.dollarVol20 !== null ? `${cur}${bigMoney(c.dollarVol20)}` : '—'}
          {c.atrPct !== null ? <small>{num(c.atrPct, 1)}%</small> : null}
        </td>
        <td className="ld-tc-expand" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </td>
      </tr>
      {open ? (
        <tr id={detailId} className="ld-trow-detail">
          <td colSpan={14}>
            <DetailPanel c={c} actions={actions} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Shortlist candidates in a sortable table; each row expands to show the full detail panel with chart and plan. */
export function ShortlistTable({ rows, actions }: { rows: LeaderCandidateView[]; actions: CardActions }) {
  return (
    <div className="ld-tbl-wrap">
      <table className="ld-tbl" aria-label="Shortlist">
        <thead>
          <tr>
            <th className="ld-tc-rank">#</th>
            <th className="ld-tc-sym">Symbol</th>
            <th className="ld-tc-px">Price / Δ</th>
            <th className="ld-tc-score">Score</th>
            <th className="ld-tc-kpi ld-hide-sm">1m</th>
            <th className="ld-tc-kpi ld-hide-sm">3m</th>
            <th className="ld-tc-kpi ld-hide-sm">6m</th>
            <th className="ld-tc-kpi ld-hide-md">EMA21</th>
            <th className="ld-tc-kpi ld-hide-md">AVWAP</th>
            <th className="ld-tc-kpi ld-hide-lg">Base</th>
            <th className="ld-tc-kpi ld-hide-lg">Rng</th>
            <th className="ld-tc-kpi ld-hide-lg">Vol</th>
            <th className="ld-tc-kpi ld-hide-lg">$Vol · ATR</th>
            <th className="ld-tc-expand" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <ShortlistRow key={c.id} c={c} actions={actions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
