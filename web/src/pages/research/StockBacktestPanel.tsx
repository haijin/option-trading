import { api } from '../../api/endpoints';
import type { BacktestSummaryView, BacktestTradeView, Market } from '../../api/types';
import { Callout } from '../../components/Callout';
import { KvGrid, Panel } from '../../components/Panel';
import { Skeleton } from '../../components/Skeleton';
import { useResource } from '../../hooks/useResource';
import { pct, shortDate } from '../../lib/format';
import { toHash } from '../../lib/route';

/** What the latest finished backtest says about this one name: trades, win rate, average return on collateral. */
export function StockBacktestPanel({ market, symbol }: { market: Market; symbol: string }) {
  const runs = useResource((signal) => api.backtests(signal), []);
  const latest: BacktestSummaryView | undefined = runs.data?.find((r) => r.status === 'done');
  const trades = useResource(
    (signal) => (latest ? api.backtestTrades(latest.id, signal) : Promise.resolve<BacktestTradeView[]>([])),
    [latest?.id],
    { enabled: latest !== undefined },
  );

  if (runs.loading || (latest && trades.loading)) return <Skeleton height={80} />;
  if (!latest) {
    return (
      <Panel title="Backtest history">
        <p className="muted">
          No finished backtest yet. Run one on the <a href={toHash({ page: 'backtests' })}>Backtests</a> page to see how
          this name's rules would have done.
        </p>
      </Panel>
    );
  }
  const mine = (trades.data ?? []).filter((t) => t.symbol === symbol && t.market === market && !t.shadow);
  const wins = mine.filter((t) => t.pnl > 0).length;
  const avgRoc = mine.length ? (mine.reduce((s, t) => s + t.roc, 0) / mine.length) * 100 : null;
  const synthetic = mine.filter((t) => t.tier === 'synthetic').length;
  return (
    <Panel title="Backtest history">
      {mine.length === 0 ? (
        <p className="muted">
          The latest backtest ({shortDate(latest.from)} to {shortDate(latest.to)}) never opened a put on {symbol}.
        </p>
      ) : (
        <>
          <KvGrid
            items={[
              { label: 'Trades', value: String(mine.length) },
              { label: 'Win rate', value: pct((wins / mine.length) * 100, 0) },
              { label: 'Average return on collateral', value: pct(avgRoc, 2) },
              { label: 'On modelled prices', value: `${synthetic} of ${mine.length}` },
            ]}
          />
          {synthetic > 0 ? (
            <Callout kind="blue">
              Most history has no stored option quotes, so these trades use model prices. Read them as a rule check, not
              as results you could have banked.
            </Callout>
          ) : null}
          <p className="muted">
            Run: {latest.name ?? latest.id.slice(0, 8)}, {shortDate(latest.from)} to {shortDate(latest.to)}.
          </p>
        </>
      )}
    </Panel>
  );
}
