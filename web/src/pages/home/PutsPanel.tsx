import type { IdeaView, ScanView } from '../../api/types';
import type { Resource } from '../../hooks/useResource';
import { RunScanButton } from '../../layout/TopBar';
import { n2, pct, shortDate, strikeText } from '../../lib/format';
import { toHash } from '../../lib/route';
import { isEquityNotSet } from '../today/TodayPage';
import { Empty, HomePanel, PanelState, type PanelSummary, Sym } from './HomePanel';

function IdeaRow({ idea }: { idea: IdeaView }) {
  const c = idea.contract;
  return (
    <a className="hm-row put" href={toHash({ page: 'puts', market: idea.market, symbol: idea.symbol })}>
      <span className="rk">{idea.rank}</span>
      <Sym symbol={idea.symbol} name={idea.name} market={idea.market} />
      <span className="ln">
        <span className="ctr">
          {shortDate(c.expiry)} {strikeText(c.strike)} P<span className="d">{n2(c.delta)}Δ</span>
        </span>
        <span className="meta">
          <span>
            cushion <b>{pct(c.cushionPct)}</b>
          </span>
          <span>{c.dte} dte</span>
          {idea.sizing ? (
            <span>
              {idea.sizing.contracts} {idea.sizing.contracts === 1 ? 'contract' : 'contracts'}
            </span>
          ) : null}
        </span>
      </span>
      <span className="ret">
        <b>{pct(c.annRocPct)}</b>
        <small>ann. return</small>
      </span>
    </a>
  );
}

function scanTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function putsSummary(scan: Resource<ScanView>): PanelSummary {
  const sell = scan.data?.ideas.length;
  return {
    count: sell === undefined ? null : String(sell),
    kind: sell ? 'ok' : 'quiet',
    tile: sell === undefined ? null : { value: String(sell), label: 'Puts' },
  };
}

/** Puts to sell: the scan's top ideas, and how the rest of the watchlist split. */
export function PutsPanel({ scan, limit }: { scan: Resource<ScanView>; limit: number }) {
  const data = scan.data;
  const sell = data?.ideas.length ?? 0;
  const other = data?.rejected.length ?? 0;
  const open = data?.openNames.length ?? 0;
  const total = sell + other + open || 1;
  const equityMissing = isEquityNotSet(scan.error) && !data;
  const summary = putsSummary(scan);
  return (
    <HomePanel
      id="puts"
      title="Puts to sell"
      count={summary.count}
      countKind={summary.kind}
      action={<RunScanButton compact />}
      page="puts"
      foot={
        data ? (
          <>
            <span className="hm-dist" aria-hidden="true">
              <i className="sell" style={{ width: `${(sell / total) * 100}%` }} />
              <i className="wait" style={{ width: `${(other / total) * 100}%` }} />
              <i className="open" style={{ width: `${(open / total) * 100}%` }} />
            </span>
            <span>{sell} sell</span>
            <span>{other} not recommended</span>
            <span>{open} open</span>
            <span className="right">scan {scanTime(data.generatedAt)}</span>
          </>
        ) : null
      }
    >
      {equityMissing ? (
        <Empty>
          Equity is not set, so the scan cannot size anything. <a href={toHash({ page: 'settings' })}>Open Settings</a>.
        </Empty>
      ) : (
        <PanelState resource={scan} title="The scan could not run." />
      )}
      {data?.ideas.slice(0, limit).map((idea) => (
        <IdeaRow key={`${idea.market}:${idea.symbol}`} idea={idea} />
      ))}
      {data && sell === 0 ? (
        <Empty>
          {data.waitingForData.length > 0
            ? `Nothing to sell yet: ${data.waitingForData.length} watched ${data.waitingForData.length === 1 ? 'name has' : 'names have'} no prices. Run an ingest on Data.`
            : 'Nothing to sell today: every watched name is waiting, avoided or already held.'}
        </Empty>
      ) : null}
    </HomePanel>
  );
}
