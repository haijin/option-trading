import type { BacktestDetailView, BacktestEquityMetrics, BacktestTradeSummary } from '../backtest/views';
import { num2, pct, renderTable } from './table';

const signed = (x: number | null, digits = 1): string =>
  x === null || !Number.isFinite(x) ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

function equityRow(label: string, e: BacktestEquityMetrics): string[] {
  return [
    label,
    signed(e.totalReturn),
    signed(e.cagr),
    pct(e.annualVol),
    num2(e.sharpe),
    num2(e.sortino),
    pct(e.maxDrawdown),
    e.maxDrawdownDays === null ? '-' : `${e.maxDrawdownDays}d`,
    pct(e.avgDeployedPct, 0),
  ];
}

/** A plain-text report of a stored backtest. Everything shown is in `BacktestDetailView`; nothing is recomputed. */
export function renderBacktest(d: BacktestDetailView): string[] {
  const out: string[] = [];
  out.push(
    `Backtest ${d.id}${d.name ? ` "${d.name}"` : ''}: ${d.status}, ${d.from} to ${d.to}, ${d.names} names, tier policy ${d.tierPolicy}`,
  );
  if (d.status !== 'done' || !d.metrics) {
    if (d.error) out.push(`  ${d.error}`);
    if (d.status === 'running') out.push(`  progress ${d.progress.toFixed(0)}%`);
    return out;
  }
  const m = d.metrics;
  const t = m.trades;
  out.push('');
  out.push('Trades');
  out.push(
    `  ${t.n} trades, win rate ${pct(t.winRate)}${t.winRateCI ? ` (95% CI ${pct(t.winRateCI.lo, 0)} to ${pct(t.winRateCI.hi, 0)})` : ''}, average ROC ${signed(t.avgRoc, 2)}${t.avgRocCI ? ` (CI ${signed(t.avgRocCI.lo, 2)} to ${signed(t.avgRocCI.hi, 2)})` : ''}`,
  );
  out.push(
    `  profit factor ${num2(t.profitFactor)}, average ${num2(t.avgDaysHeld, 1)} days held, assignment rate ${pct(t.assignmentRate)}, t-statistic of mean P&L ${num2(t.tStat)}`,
  );
  out.push(
    `  exits: ${
      Object.entries(t.exitReasonMix)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || '-'
    }`,
  );
  out.push(`  tier mix: real ${m.tierMix.real}, synthetic ${m.tierMix.synthetic}`);

  out.push('');
  out.push('Portfolio versus benchmarks');
  const rows: string[][] = [equityRow('This strategy', m.equity)];
  if (m.benchmarks) {
    rows.push(equityRow('Naive 30-delta 45-DTE, no filters', m.benchmarks.naive.equity));
    rows.push(equityRow('Buy and hold, equal weight', m.benchmarks.equalWeightHold));
    for (const [sym, e] of Object.entries(m.benchmarks.index)) rows.push(equityRow(`Index ${sym}`, e));
  }
  for (const l of renderTable(
    [
      { header: '' },
      { header: 'Total', align: 'right' },
      { header: 'CAGR', align: 'right' },
      { header: 'Vol', align: 'right' },
      { header: 'Sharpe', align: 'right' },
      { header: 'Sortino', align: 'right' },
      { header: 'Max DD', align: 'right' },
      { header: 'DD length', align: 'right' },
      { header: 'Deployed', align: 'right' },
    ],
    rows,
  ))
    out.push(`  ${l}`);
  if (m.benchmarks) {
    const diff = (m.equity.totalReturn ?? 0) - (m.benchmarks.naive.equity.totalReturn ?? 0);
    out.push(`  filters add ${signed(diff)} of total return over the naive strategy (same pricing and exits)`);
  }

  if (m.sensitivity) {
    out.push('');
    out.push(`Pricing sensitivity: ${m.sensitivity.note}`);
    for (const p of m.sensitivity.points)
      out.push(
        `  model volatility x${p.sigmaMultiplier.toFixed(1)}: total ${signed(p.totalReturn)}, Sharpe ${num2(p.sharpe)}`,
      );
  }

  if (m.attribution.length > 0) {
    out.push('');
    out.push('Per-rule attribution (rule passed versus failed at entry)');
    for (const l of renderTable(
      [
        { header: 'Rule' },
        { header: 'Passed n', align: 'right' },
        { header: 'Win', align: 'right' },
        { header: 'ROC', align: 'right' },
        { header: 'Failed n', align: 'right' },
        { header: 'Win', align: 'right' },
        { header: 'ROC', align: 'right' },
      ],
      m.attribution.map((a) => [
        a.rule,
        String(a.passed.n),
        pct(a.passed.winRate, 0),
        signed(a.passed.avgRoc, 2),
        String(a.failed.n),
        pct(a.failed.winRate, 0),
        signed(a.failed.avgRoc, 2),
      ]),
    ))
      out.push(`  ${l}`);
  }

  if (d.walkForward) {
    const w = d.walkForward;
    out.push('');
    out.push(
      `Walk-forward (out-of-sample only): ${w.windows.length} windows, mean OOS Sharpe ${num2(w.aggregate.meanOutOfSampleSharpe)} vs in-sample ${num2(w.aggregate.meanInSampleSharpe)}${w.aggregate.overfitting ? '  WARNING: out-of-sample Sharpe is below half of in-sample (overfitting)' : ''}`,
    );
    for (const x of w.windows)
      out.push(
        `  train ${x.trainFrom}..${x.trainTo} test ${x.testFrom}..${x.testTo}: OOS return ${signed(x.outOfSample.totalReturn)}, Sharpe ${num2(x.outOfSample.sharpe)}, ${x.outOfSample.n} trades`,
      );
  }

  out.push('');
  out.push('Caveats');
  for (const c of m.caveats) out.push(`  - ${c}`);
  return out;
}

export function tradeSummaryLine(t: BacktestTradeSummary): string {
  return `${t.n} trades, win ${pct(t.winRate)}, avg ROC ${signed(t.avgRoc, 2)}`;
}
