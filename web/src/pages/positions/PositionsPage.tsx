import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { Currency, LotView, PositionView } from '../../api/types';
import { AskSheet } from '../../components/AskSheet';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip, type ChipKind } from '../../components/Chip';
import { LogFillModal } from '../../components/LogFillModal';
import { Panel, Tile } from '../../components/Panel';
import { Skeleton } from '../../components/Skeleton';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { contractLabel, money, n2, num, pct, shortDate, signedMoney } from '../../lib/format';
import { useOverview } from '../../state/overview';
import { CloseModal } from './CloseModal';
import { JournalImportModal } from './JournalImportModal';
import { SellLotModal } from './SellLotModal';

const ALERT_KIND: Record<PositionView['alerts'][number]['level'], ChipKind> = {
  info: 'blue',
  warn: 'warn',
  fail: 'fail',
};

/** Chips in the Ask sheet of an open put: the questions a put seller asks after the fill. */
export const POSITION_QUESTIONS = [
  'Close at 50%?',
  'Roll or hold?',
  'Assignment risk?',
  'What changed since the fill?',
];

const OUTCOME: Record<PositionView['status'], { text: string; kind: ChipKind }> = {
  open: { text: 'open', kind: 'blue' },
  closed: { text: 'bought back', kind: '' },
  expired: { text: 'expired', kind: 'ok' },
  assigned: { text: 'assigned', kind: 'fail' },
  rolled: { text: 'rolled', kind: 'blue' },
};

function PnlText({ value, currency }: { value: number | null; currency: Currency }) {
  if (value === null) return <span className="faint">-</span>;
  return <span className={value >= 0 ? 'pos' : 'neg'}>{signedMoney(value, currency)}</span>;
}

export function PositionsPage() {
  const positions = useResource((signal) => api.positions(signal), []);
  const overview = useOverview();
  const [modal, setModal] = useState<'fill' | 'journal' | null>(null);
  const [closing, setClosing] = useState<PositionView | null>(null);
  const [asking, setAsking] = useState<PositionView | null>(null);
  const [selling, setSelling] = useState<LotView | null>(null);
  const marking = useMutation();
  const base: Currency = overview.data?.baseCurrency ?? 'HKD';

  if (positions.loading) {
    return (
      <div className="page" aria-busy="true">
        <Skeleton height={80} />
        <Skeleton height={200} />
      </div>
    );
  }
  if (positions.error && !positions.data) {
    return (
      <div className="page">
        <ErrorBanner error={positions.error} onRetry={positions.refresh} title="Could not load positions." />
      </div>
    );
  }
  const view = positions.data;
  if (!view) return null;

  const deployedAmount = view.deployed.US.amountBase + view.deployed.HK.amountBase;
  const deployedPct = view.deployed.US.pctOfEquity + view.deployed.HK.pctOfEquity;
  const realised = Object.entries(view.journal.realised) as [Currency, number][];

  return (
    <div className="page">
      <div className="row">
        <h2>Positions</h2>
        <div className="sp" />
        <button
          type="button"
          className="btn"
          disabled={marking.busy || view.open.length === 0}
          onClick={() =>
            marking.run(() => api.runMarks(), {
              success: (r) =>
                `Marked ${r.marked} put${r.marked === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`,
            })
          }
        >
          {marking.busy ? 'Marking...' : 'Mark now'}
        </button>
        <button type="button" className="btn" onClick={() => setModal('journal')}>
          Import journal CSV
        </button>
        <button type="button" className="btn primary" onClick={() => setModal('fill')}>
          + Log a fill
        </button>
      </div>
      {positions.error ? (
        <ErrorBanner error={positions.error} onRetry={positions.refresh} title="Could not refresh positions." />
      ) : null}

      <div className="grid3">
        <Tile label="Open puts" value={view.open.length} />
        <Tile label="Collateral deployed (full notional)" value={money(deployedAmount, base)} sub={pct(deployedPct)} />
        <div className="panel tile">
          <small>
            Journal: {view.journal.trades} trades, win rate{' '}
            {view.journal.winRatePct === null ? '-' : pct(view.journal.winRatePct, 0)}
          </small>
          <h2 style={{ fontSize: 17 }}>
            {realised.length === 0 ? <span className="faint">no closed trades</span> : null}
            {realised.map(([currency, value]) => (
              <span key={currency} style={{ marginRight: 12 }}>
                <PnlText value={value} currency={currency} />
              </span>
            ))}
          </h2>
        </div>
      </div>

      {!view.marksAvailable ? (
        <Callout kind="blue">
          <b>No marks yet.</b> The daily mark job prices each open put (a stored quote when there is one, otherwise a
          model price) and adds profit and loss and the take-profit, stop and assignment alerts. Run it now with Mark
          now. Until then the alerts below come from stored data only.
        </Callout>
      ) : null}

      <Panel flush title="Open puts">
        {view.open.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>
            No open puts. When you sell one in your broker, log the fill so new ideas on that name are blocked.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contract</th>
                <th className="num">Qty</th>
                <th className="num">Credit</th>
                <th className="num">Collateral</th>
                <th className="num">DTE</th>
                <th className="num">P&amp;L (mark)</th>
                <th className="num">Spot / to strike</th>
                <th>Alerts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.open.map((position) => (
                <tr key={position.id}>
                  <td className="full">
                    <b>{position.symbol}</b> <small>{position.name ?? ''}</small>
                    {!position.watching ? (
                      <>
                        {' '}
                        <Chip title="You stopped watching this stock, but its open put is still tracked">
                          not watching: still tracked
                        </Chip>
                      </>
                    ) : null}
                  </td>
                  <td className="mono" data-label="Contract">
                    {contractLabel(position.expiry, position.strike)}
                  </td>
                  <td className="num" data-label="Qty">
                    {position.quantity}
                  </td>
                  <td className="num" data-label="Credit">
                    {money(position.credit, position.currency)}
                  </td>
                  <td className="num" data-label="Collateral">
                    {money(position.collateral, position.currency)}
                  </td>
                  <td className="num" data-label="DTE">
                    {position.dte}
                  </td>
                  <td className="num" data-label="P&L (mark)">
                    {position.mark === null ? (
                      <span className="faint">-</span>
                    ) : (
                      <>
                        <PnlText value={position.mark.unrealizedPnl} currency={position.currency} />{' '}
                        <small title={`mark ${n2(position.mark.price)} on ${position.mark.day}`}>
                          {position.mark.pctCaptured === null ? '' : pct(position.mark.pctCaptured * 100, 0)}
                          {position.mark.tier === 'real' ? '' : ' model'} {shortDate(position.mark.day)}
                        </small>
                      </>
                    )}
                  </td>
                  <td className="num" data-label="Spot / to strike">
                    {position.spot === null ? '-' : n2(position.spot)}{' '}
                    {position.distancePct === null ? null : <small>({pct(position.distancePct)})</small>}
                  </td>
                  <td className="full" data-label="Alerts">
                    <span className="row" style={{ gap: 4 }}>
                      {position.alerts.length === 0 ? <span className="faint">-</span> : null}
                      {position.alerts.map((alert) => (
                        <Chip key={alert.code} kind={ALERT_KIND[alert.level]} title={alert.code}>
                          {alert.text}
                        </Chip>
                      ))}
                    </span>
                  </td>
                  <td className="actions">
                    <button type="button" className="btn sm" onClick={() => setAsking(position)}>
                      Ask
                    </button>{' '}
                    <button type="button" className="btn sm" onClick={() => setClosing(position)}>
                      Close...
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {view.lots.some((l) => l.status === 'open') ? (
        <Panel flush title="Shares from assigned puts (the wheel)">
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Shares</th>
                <th className="num">Effective cost</th>
                <th className="num">Basis (assignment close)</th>
                <th className="num">Last close</th>
                <th className="num">Unrealised</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.lots
                .filter((l) => l.status === 'open')
                .map((lot) => (
                  <tr key={lot.id}>
                    <td className="full">
                      <b>{lot.symbol}</b> <small>{lot.name ?? ''}</small>
                    </td>
                    <td className="num" data-label="Shares">
                      {num(lot.shares)}
                    </td>
                    <td className="num" data-label="Effective cost">
                      {lot.effectiveCost === null ? '-' : n2(lot.effectiveCost)}
                    </td>
                    <td className="num" data-label="Basis">
                      {n2(lot.costBasis)}
                    </td>
                    <td className="num" data-label="Last close">
                      {lot.spot === null ? '-' : n2(lot.spot)}
                    </td>
                    <td className="num" data-label="Unrealised">
                      <PnlText value={lot.unrealizedPnl} currency={lot.currency} />
                    </td>
                    <td className="actions">
                      <button type="button" className="btn sm" onClick={() => setSelling(lot)}>
                        Sold...
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="note" style={{ padding: '0 12px 8px' }}>
            Sell a covered call above the effective cost to leave the position at a profit. The app records what you did
            in your broker; it never places an order.
          </p>
        </Panel>
      ) : null}

      <Panel flush title="Recently closed">
        {view.closed.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>
            Nothing closed yet.
          </p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Name</th>
                <th>Outcome</th>
                <th>Contract</th>
                <th className="num">Qty</th>
                <th>Opened</th>
                <th>Closed</th>
                <th className="num">Realised</th>
              </tr>
            </thead>
            <tbody>
              {view.closed.map((position) => {
                const outcome = OUTCOME[position.status];
                return (
                  <tr key={position.id}>
                    <td>
                      <b>{position.symbol}</b>
                    </td>
                    <td data-label="Outcome">
                      <Chip kind={outcome.kind}>{outcome.text}</Chip>
                    </td>
                    <td className="mono" data-label="Contract">
                      {contractLabel(position.expiry, position.strike)}
                    </td>
                    <td className="num" data-label="Qty">
                      {position.quantity}
                    </td>
                    <td className="muted" data-label="Opened">
                      {position.openDate}
                    </td>
                    <td className="muted" data-label="Closed">
                      {position.closeDate ?? '-'}
                    </td>
                    <td className="num" data-label="Realised">
                      <PnlText value={position.realizedPnl} currency={position.currency} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="note">
        Journal totals: {num(view.journal.wins)} wins of {num(view.journal.trades)} trades. Risk and sizing use full
        notional (strike x multiplier); broker margin is a display number only.
      </p>

      {modal === 'fill' ? <LogFillModal onClose={() => setModal(null)} /> : null}
      {modal === 'journal' ? <JournalImportModal onClose={() => setModal(null)} /> : null}
      {closing ? <CloseModal position={closing} onClose={() => setClosing(null)} /> : null}
      {asking ? (
        <AskSheet
          target={{ kind: 'position', positionId: asking.id }}
          title={`Ask about ${asking.symbol} ${contractLabel(asking.expiry, asking.strike)}`}
          suggestions={POSITION_QUESTIONS}
          onClose={() => setAsking(null)}
        />
      ) : null}
      {selling ? <SellLotModal lot={selling} onClose={() => setSelling(null)} /> : null}
    </div>
  );
}
