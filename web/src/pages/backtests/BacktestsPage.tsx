import { type FormEvent, useState } from 'react';
import { api } from '../../api/endpoints';
import type {
  BacktestDetailView,
  BacktestEquityMetrics,
  BacktestRequestInput,
  BacktestSummaryView,
  TierPolicy,
} from '../../api/types';
import { Callout, ErrorBanner } from '../../components/Callout';
import { Chip, type ChipKind } from '../../components/Chip';
import { EquityChart } from '../../components/EquityChart';
import { Field } from '../../components/Field';
import { Panel, Tile } from '../../components/Panel';
import { Skeleton } from '../../components/Skeleton';
import { useMutation } from '../../hooks/useMutation';
import { useResource } from '../../hooks/useResource';
import { num, parseNumber, pct, signedPct, todayIso } from '../../lib/format';

const STATUS: Record<BacktestSummaryView['status'], ChipKind> = {
  queued: '',
  running: 'blue',
  done: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};

const TIERS: { id: TierPolicy; label: string; help: string }[] = [
  {
    id: 'real_then_synthetic',
    label: 'Real quotes where stored, model prices elsewhere',
    help: 'Uses your stored option snapshots when a day has one and the pricing model otherwise.',
  },
  {
    id: 'synthetic_only',
    label: 'Model prices only',
    help: 'Prices every put with the model: the whole history is usable.',
  },
  {
    id: 'real_only',
    label: 'Real quotes only',
    help: 'Only trades that had a stored chain; short until snapshots accumulate.',
  },
];

const frac = (x: number | null, digits = 1): string => (x === null ? '-' : pct(x * 100, digits));
const sfrac = (x: number | null, digits = 1): string => (x === null ? '-' : signedPct(x * 100, digits));
const n2 = (x: number | null): string => (x === null ? '-' : x.toFixed(2));

function NewRun({ onStarted }: { onStarted: (id: string) => void }) {
  const mutation = useMutation();
  const [from, setFrom] = useState(`${new Date().getFullYear() - 5}-01-04`);
  const [to, setTo] = useState(todayIso());
  const [tier, setTier] = useState<TierPolicy>('real_then_synthetic');
  const [capital, setCapital] = useState('');
  const [observe, setObserve] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return setError('Dates as YYYY-MM-DD.');
    const input: BacktestRequestInput = { from, to, tierPolicy: tier, observeRejected: observe };
    if (capital.trim() !== '') {
      const value = parseNumber(capital);
      if (value === null || value <= 0) return setError('Capital must be a number above 0.');
      input.initialCapital = value;
    }
    setError(null);
    const started = await mutation.run(() => api.startBacktest(input), {
      inlineError: true,
      success: 'Backtest started. It runs in the background.',
    });
    if (started) onStarted(started.id);
  };

  return (
    <Panel title="New backtest">
      <form className="stack" onSubmit={submit} noValidate>
        {mutation.error ? (
          <Callout kind="fail" role="alert">
            {mutation.error.message}
          </Callout>
        ) : null}
        <p className="muted">
          Replays your scanner rules over history on the active watchlist. The exchange calendars start in 2010, so
          earlier dates are refused.
        </p>
        <div className="grid2">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Prices" hint={TIERS.find((t) => t.id === tier)?.help}>
            <select value={tier} onChange={(e) => setTier(e.target.value as TierPolicy)}>
              {TIERS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Starting capital (optional)" hint="Default: the equity in Settings">
            <input inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} />
          </Field>
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={observe} onChange={(e) => setObserve(e.target.checked)} />
          <span>
            Also track the entries the rules rejected, to see which rule adds value <small>(about twice as slow)</small>
          </span>
        </label>
        {error ? (
          <Callout kind="fail" role="alert">
            {error}
          </Callout>
        ) : null}
        <div className="row">
          <div className="sp" />
          <button type="submit" className="btn primary" disabled={mutation.busy}>
            {mutation.busy ? 'Starting...' : 'Run backtest'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function MetricsRow({ label, e }: { label: string; e: BacktestEquityMetrics }) {
  return (
    <tr>
      <td className="full">
        <b>{label}</b>
      </td>
      <td className="num" data-label="Total">
        {sfrac(e.totalReturn)}
      </td>
      <td className="num" data-label="CAGR">
        {sfrac(e.cagr)}
      </td>
      <td className="num" data-label="Volatility">
        {frac(e.annualVol)}
      </td>
      <td className="num" data-label="Sharpe">
        {n2(e.sharpe)}
      </td>
      <td className="num" data-label="Max drawdown">
        {frac(e.maxDrawdown)}
      </td>
    </tr>
  );
}

function Detail({ run }: { run: BacktestDetailView }) {
  const trades = useResource((signal) => api.backtestTrades(run.id, signal), [run.id], {
    enabled: run.status === 'done',
    refetchOnWrite: false,
  });
  const m = run.metrics;
  if (run.status !== 'done' || !m) {
    return (
      <Panel title="Result">
        {run.status === 'failed' || run.status === 'cancelled' ? (
          <Callout kind={run.status === 'failed' ? 'fail' : 'blue'}>{run.error ?? run.status}</Callout>
        ) : (
          <p className="muted" aria-live="polite">
            {run.status === 'queued' ? 'Waiting to start...' : `Running: ${run.progress.toFixed(0)}% done.`}
          </p>
        )}
      </Panel>
    );
  }
  const t = m.trades;
  return (
    <>
      <div className="grid3">
        <Tile label="Trades" value={num(t.n)} sub={`win rate ${frac(t.winRate, 0)}`} />
        <Tile label="Total return" value={sfrac(m.equity.totalReturn)} sub={`CAGR ${sfrac(m.equity.cagr)}`} />
        <Tile label="Max drawdown" value={frac(m.equity.maxDrawdown)} sub={`Sharpe ${n2(m.equity.sharpe)}`} />
      </div>

      <Panel title="Equity">
        <EquityChart curve={run.equityCurve} start={run.initialCapital} />
        <p className="note">
          Starts at {num(run.initialCapital)}. Cash earns the risk-free rate; each put locks its full notional.
        </p>
      </Panel>

      <Panel flush title="Against the alternatives">
        <table className="tbl cards">
          <thead>
            <tr>
              <th />
              <th className="num">Total</th>
              <th className="num">CAGR</th>
              <th className="num">Volatility</th>
              <th className="num">Sharpe</th>
              <th className="num">Max drawdown</th>
            </tr>
          </thead>
          <tbody>
            <MetricsRow label="This strategy" e={m.equity} />
            {m.benchmarks ? (
              <>
                <MetricsRow label="Naive: every name, 30 delta, 45 days, no filters" e={m.benchmarks.naive.equity} />
                <MetricsRow label="Buy and hold, equal weight" e={m.benchmarks.equalWeightHold} />
                {Object.entries(m.benchmarks.index).map(([sym, e]) => (
                  <MetricsRow key={sym} label={`Index ${sym}`} e={e} />
                ))}
              </>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Panel title="Trade quality">
        <div className="kv">
          {[
            ['Average return on collateral', sfrac(t.avgRoc, 2)],
            ['Profit factor', n2(t.profitFactor)],
            ['Average days held', t.avgDaysHeld === null ? '-' : t.avgDaysHeld.toFixed(1)],
            ['Assigned', frac(t.assignmentRate, 0)],
            ['Win rate 95% range', t.winRateCI ? `${frac(t.winRateCI.lo, 0)} to ${frac(t.winRateCI.hi, 0)}` : '-'],
            ['Priced by the model', `${num(m.tierMix.synthetic)} of ${num(t.n)} trades`],
          ].map(([label, value]) => (
            <div key={label}>
              <span className="kvl">{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
        <p className="note">
          Exits:{' '}
          {Object.entries(t.exitReasonMix)
            .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
            .join(', ') || '-'}
        </p>
      </Panel>

      {m.sensitivity ? (
        <Callout kind={m.sensitivity.robust === false ? 'fail' : 'blue'}>
          <b>{m.sensitivity.robust === false ? 'Not robust to pricing error. ' : 'Holds under pricing error. '}</b>
          Volatility moved by 20% either way:{' '}
          {m.sensitivity.points.map((p) => `x${p.sigmaMultiplier.toFixed(1)}: ${sfrac(p.totalReturn)}`).join(' / ')}
        </Callout>
      ) : null}

      {m.attribution.length > 0 ? (
        <Panel flush title="Which rules add value">
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Rule</th>
                <th className="num">Passed: trades</th>
                <th className="num">Win</th>
                <th className="num">Failed: trades</th>
                <th className="num">Win</th>
              </tr>
            </thead>
            <tbody>
              {m.attribution.map((a) => (
                <tr key={a.rule}>
                  <td className="full mono">{a.rule}</td>
                  <td className="num" data-label="Passed: trades">
                    {a.passed.n}
                  </td>
                  <td className="num" data-label="Win">
                    {frac(a.passed.winRate, 0)}
                  </td>
                  <td className="num" data-label="Failed: trades">
                    {a.failed.n}
                  </td>
                  <td className="num" data-label="Win">
                    {frac(a.failed.winRate, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {run.walkForward ? (
        <Callout kind={run.walkForward.aggregate.overfitting ? 'fail' : 'blue'}>
          <b>Walk-forward (out of sample only).</b> {run.walkForward.windows.length} windows, mean Sharpe{' '}
          {n2(run.walkForward.aggregate.meanOutOfSampleSharpe)} against{' '}
          {n2(run.walkForward.aggregate.meanInSampleSharpe)} in sample.
          {run.walkForward.aggregate.overfitting ? ' Out-of-sample is below half of in-sample: likely overfitted.' : ''}
        </Callout>
      ) : null}

      <Panel
        flush
        title="Trades"
        actions={
          <a className="btn sm" href={`/api/backtests/${run.id}/trades.csv`} download>
            Download CSV
          </a>
        }
      >
        {trades.loading ? (
          <Skeleton height={80} />
        ) : trades.data && trades.data.length > 0 ? (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Name</th>
                <th>Opened</th>
                <th>Closed</th>
                <th className="num">Strike</th>
                <th className="num">Qty</th>
                <th>Exit</th>
                <th className="num">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {trades.data.slice(-200).map((x) => (
                <tr key={x.id}>
                  <td className="full">
                    <b>{x.symbol}</b> {x.tier === 'real' ? null : <Chip title="model price">model</Chip>}
                  </td>
                  <td className="muted" data-label="Opened">
                    {x.entryDate}
                  </td>
                  <td className="muted" data-label="Closed">
                    {x.exitDate}
                  </td>
                  <td className="num" data-label="Strike">
                    {x.strike}
                  </td>
                  <td className="num" data-label="Qty">
                    {x.contracts}
                  </td>
                  <td data-label="Exit">{x.exitReason.replace(/_/g, ' ')}</td>
                  <td className={x.pnl >= 0 ? 'num pos' : 'num neg'} data-label="P&L">
                    {num(x.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ padding: 12 }}>
            No trades: the rules passed nothing in this period.
          </p>
        )}
        {trades.data && trades.data.length > 200 ? (
          <p className="note" style={{ padding: '0 12px 8px' }}>
            The last 200 of {num(trades.data.length)} trades; the CSV has all of them.
          </p>
        ) : null}
      </Panel>

      <Panel title="Read this before trusting the numbers">
        <ul className="note" style={{ paddingLeft: 18 }}>
          {m.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

export function BacktestsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const cancel = useMutation();
  const runs = useResource((signal) => api.backtests(signal), [], {
    pollWhile: (list) => list.some((r) => r.status === 'queued' || r.status === 'running'),
  });
  const active = selected ?? runs.data?.[0]?.id ?? null;
  const detail = useResource((signal) => api.backtest(active as string, signal), [active], {
    enabled: active !== null,
    pollWhile: (d) => d.status === 'queued' || d.status === 'running',
  });

  return (
    <div className="page">
      <div className="row">
        <h2>Backtests</h2>
      </div>
      <NewRun onStarted={setSelected} />
      {runs.error && !runs.data ? (
        <ErrorBanner error={runs.error} onRetry={runs.refresh} title="Could not load backtests." />
      ) : null}
      {runs.loading ? <Skeleton height={80} /> : null}

      {runs.data && runs.data.length > 0 ? (
        <Panel flush title="Runs">
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Run</th>
                <th>Period</th>
                <th>Status</th>
                <th className="num">Trades</th>
                <th className="num">CAGR</th>
                <th className="num">Max drawdown</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className={r.id === active ? 'sel' : undefined}>
                  <td className="full">
                    <button type="button" className="linklike" onClick={() => setSelected(r.id)}>
                      <b>{r.name ?? r.id.slice(0, 8)}</b>
                    </button>{' '}
                    <small>{r.names} names</small>
                  </td>
                  <td className="muted" data-label="Period">
                    {r.from} to {r.to}
                  </td>
                  <td data-label="Status">
                    <Chip kind={STATUS[r.status]}>
                      {r.status === 'running' ? `running ${r.progress.toFixed(0)}%` : r.status}
                    </Chip>
                  </td>
                  <td className="num" data-label="Trades">
                    {r.headline ? num(r.headline.trades) : '-'}
                  </td>
                  <td className="num" data-label="CAGR">
                    {r.headline ? sfrac(r.headline.cagr) : '-'}
                  </td>
                  <td className="num" data-label="Max drawdown">
                    {r.headline ? frac(r.headline.maxDrawdown) : '-'}
                  </td>
                  <td className="actions">
                    {r.status === 'queued' || r.status === 'running' ? (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={cancel.busy}
                        onClick={() => cancel.run(() => api.cancelBacktest(r.id), { success: 'Cancelling...' })}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : runs.data ? (
        <p className="muted">No backtests yet. Run one above to see how your rules would have done.</p>
      ) : null}

      {detail.data ? <Detail run={detail.data} /> : active && detail.loading ? <Skeleton height={160} /> : null}
      <p className="note">
        Statistics about rules you configured on past data, not a forecast and not investment advice. The app never
        places orders.
      </p>
    </div>
  );
}
