import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { DataStatusRow, ProviderStatusView } from '../../api/types';
import { ErrorBanner } from '../../components/Callout';
import { Chip, type ChipKind, PriceVsIvChip, StatusChip } from '../../components/Chip';
import { Panel } from '../../components/Panel';
import { PasteChainModal } from '../../components/PasteChainModal';
import { Skeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { shortDate } from '../../lib/format';
import { stockKey } from '../../lib/symbols';
import { FairValuesModal } from './FairValuesModal';
import { IngestCard } from './IngestCard';

const PROVIDER_KIND: Record<ProviderStatusView['state'], ChipKind> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  unknown: '',
};

function StatusTable({ rows, onPaste }: { rows: DataStatusRow[]; onPaste: (row: DataStatusRow) => void }) {
  if (rows.length === 0) {
    return (
      <p className="muted" style={{ padding: 12 }}>
        You are not watching any stock yet. Add some in the Watchlist.
      </p>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Stock</th>
          <th>Last bar</th>
          <th>Chain</th>
          <th>Next results</th>
          <th>Fundamentals</th>
          <th>Price vs IV</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={stockKey(row.market, row.symbol)}>
            <td>
              <b>{row.symbol}</b> <small>{row.name ?? ''}</small> <Chip>{row.market}</Chip>
            </td>
            <td className={row.stale ? 'neg' : undefined}>{row.lastBar ?? <span className="faint">none yet</span>}</td>
            <td className={row.chain ? undefined : 'faint'}>
              {row.chain ? `${row.chain.source} ${row.chain.date}` : 'none'}
            </td>
            <td className="muted">
              {row.nextEarnings ? (
                <>
                  {row.nextEarnings.date} {row.nextEarnings.confirmed ? '' : <small>(estimated)</small>}
                </>
              ) : (
                'unknown'
              )}
            </td>
            <td className="muted">
              {row.fundamentals.annual}y / {row.fundamentals.quarterly}q
              {row.fundamentals.lastPeriodEnd ? (
                <small> &middot; to {shortDate(row.fundamentals.lastPeriodEnd)}</small>
              ) : null}
            </td>
            <td>
              <PriceVsIvChip badge={row.priceVsIv} />
            </td>
            <td>
              <StatusChip status={row.status} />
            </td>
            <td>
              {row.market === 'HK' ? (
                <button type="button" className="btn sm" onClick={() => onPaste(row)}>
                  Paste chain
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DataPage() {
  const status = useResource((signal) => api.dataStatus(signal), []);
  const [chainFor, setChainFor] = useState<DataStatusRow | null>(null);
  const [fairValues, setFairValues] = useState(false);

  if (status.loading) {
    return (
      <div className="page" aria-busy="true">
        <Skeleton height={140} />
        <Skeleton height={220} />
      </div>
    );
  }
  if (status.error && !status.data) {
    return (
      <div className="page">
        <ErrorBanner error={status.error} onRetry={status.refresh} title="Could not load the data status." />
      </div>
    );
  }
  const view = status.data;

  return (
    <div className="page">
      <h2>Data</h2>
      {status.error ? (
        <ErrorBanner error={status.error} onRetry={status.refresh} title="Could not refresh the data status." />
      ) : null}
      <IngestCard status={view} />

      <Panel
        flush
        title="Data status of watched stocks"
        actions={
          <button type="button" className="btn sm" onClick={() => setFairValues(true)}>
            Import fair values CSV...
          </button>
        }
      >
        <StatusTable rows={view?.names ?? []} onPaste={setChainFor} />
      </Panel>

      <div className="grid2">
        <Panel title="Providers">
          <div className="stack">
            {view?.providers.map((provider) => (
              <div className="row" key={provider.id}>
                <Chip kind={PROVIDER_KIND[provider.state]}>{provider.state}</Chip> <b>{provider.label}</b>{' '}
                <small>{provider.detail}</small>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Files">
          <div className="stack">
            <div className="row">
              <Chip kind={view && view.files.boardLots.rows > 0 ? 'ok' : 'warn'}>
                {view?.files.boardLots.rows ?? 0} rows
              </Chip>{' '}
              <b>HK board lots</b> <small className="mono">{view?.files.boardLots.path}</small>
            </div>
            <div className="row">
              <Chip kind={view?.files.vhsi.found ? 'ok' : 'warn'}>{view?.files.vhsi.found ? 'found' : 'missing'}</Chip>{' '}
              <b>VHSI file</b> <small className="mono">{view?.files.vhsi.path}</small>
            </div>
            <small>Without the VHSI file the HK regime runs without a volatility index (data note, no penalty).</small>
          </div>
        </Panel>
      </div>

      {chainFor ? (
        <PasteChainModal
          symbol={chainFor.symbol}
          market={chainFor.market}
          {...(chainFor.lastClose !== null ? { spot: chainFor.lastClose } : {})}
          onClose={() => setChainFor(null)}
        />
      ) : null}
      {fairValues ? <FairValuesModal onClose={() => setFairValues(false)} /> : null}
    </div>
  );
}
