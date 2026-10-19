/** Terminal rendering for `scan` and `explain`. Presentation only: no computation beyond formatting. */
import type { Market } from '../core/calendar';
import type { Reason } from '../core/types';
import type { SkillResult } from '../skills/contract';
import type { NameResult, RunReport } from '../skills/runner';
import type { RegimePayload } from '../skills/s0-market-regime';
import type { OptionSelectPayload } from '../skills/s4-option-select';
import type { CompositePayload } from '../skills/s5-rank-composite';
import type { SizingPayload } from '../skills/s6-size-position';
import type { NarrativePayload } from '../skills/s7-explain-narrative';
import { money, num2, pct, renderTable } from './table';

export interface RenderMeta {
  asOf: string;
  paramsLabel: string;
  baseCurrency: string;
  equity: number | null;
  allowStale: boolean;
}

const MARKET_NAME: Record<Market, string> = { US: 'US', HK: 'HK' };

const s4Of = (n: NameResult) => n.results['option.select']?.payload as OptionSelectPayload | undefined;
const s5Of = (n: NameResult) => n.results['rank.composite']?.payload as CompositePayload | undefined;
const s6Of = (n: NameResult) => n.results['size.position']?.payload as SizingPayload | undefined;
const s7Of = (n: NameResult) => n.results['explain.narrative']?.payload as NarrativePayload | undefined;
const s0Of = (n: NameResult) => n.results['market.regime']?.payload as RegimePayload | undefined;

const LEVEL_TAG: Record<string, string> = { PASS: '[ ok ]', WARN: '[warn]', FAIL: '[FAIL]', INFO: '[info]' };

function valueText(r: Reason): string {
  const v = r.value === null || r.value === undefined ? 'n/a' : String(r.value);
  return v.length > 60 ? `${v.slice(0, 57)}...` : v;
}

export function reasonLines(
  reasons: readonly Reason[],
  indent = '    ',
  opts: { includeInfo?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    const level = r.level ?? (r.passed ? 'PASS' : 'WARN');
    if (level === 'INFO' && opts.includeInfo === false) continue;
    const kind = r.kind === 'data' ? ' (data)' : '';
    const parts = [`${indent}${LEVEL_TAG[level] ?? '[    ]'} ${r.rule}${kind}: ${valueText(r)}`];
    if (r.threshold) parts.push(`want ${r.threshold}`);
    if (r.note) parts.push(r.note);
    out.push(parts.join('  |  '));
  }
  return out;
}

function flagsOf(n: NameResult): string {
  const flags: string[] = [];
  if (n.staleTagged) flags.push('STALE');
  const all = Object.values(n.results).flatMap((r) => r.reasons);
  if (all.some((r) => r.rule === 'events.earningsUnknown')) flags.push('NO-ER-DATE');
  const warns = s5Of(n)?.ruleWarns.length ?? 0;
  if (warns > 0) flags.push(`WARN:${warns}`);
  return flags.join(' ');
}

function rowFor(n: NameResult): string[] {
  const c = s4Of(n)?.chosen;
  const z = s6Of(n);
  const ccy = n.instrument.currency;
  const tier = n.results['rank.composite']?.dataQuality.tier ?? '-';
  return [
    String(n.rank ?? '-'),
    n.instrument.symbol,
    c ? `${c.expiry} P ${num2(c.strike, 2)}` : '-',
    c ? String(c.dte) : '-',
    c ? num2(c.delta, 2) : '-',
    c ? money(c.credit, ccy) : '-',
    c ? money(c.collateral, ccy) : '-',
    c ? pct(c.annRoc) : '-',
    c ? pct(c.cushionPct) : '-',
    num2(n.composite, 1),
    tier,
    s4Of(n)?.source ?? '-',
    z ? (z.contracts > 0 ? String(z.contracts) : `0 (${z.capsHit.join(',') || 'cap'})`) : '-',
    flagsOf(n),
  ];
}

const COLUMNS = [
  { header: '#', align: 'right' as const },
  { header: 'Symbol' },
  { header: 'Contract' },
  { header: 'DTE', align: 'right' as const },
  { header: 'Delta', align: 'right' as const },
  { header: 'Credit', align: 'right' as const },
  { header: 'Collateral', align: 'right' as const },
  { header: 'AnnROC', align: 'right' as const },
  { header: 'Cushion', align: 'right' as const },
  { header: 'Score', align: 'right' as const },
  { header: 'Data' },
  { header: 'Prices' },
  { header: 'Size', align: 'right' as const },
  { header: 'Flags' },
];

export function renderScan(report: RunReport, meta: RenderMeta): string[] {
  const out: string[] = [];
  out.push(
    `Scan as of ${meta.asOf} | ${meta.paramsLabel} | reads the database only (ingest fetches) | ${report.stats.cacheHits} cached + ${report.stats.computed} computed skill results`,
  );
  out.push(
    `Equity: ${meta.baseCurrency} ${meta.equity === null ? 'not set' : Math.round(meta.equity).toLocaleString('en-US')} (sizing on full notional, margin shown nowhere as a limit)`,
  );

  // regime per market
  const regimes: string[] = [];
  for (const m of ['US', 'HK'] as Market[]) {
    const n = report.names.find((x) => x.instrument.market === m && s0Of(x));
    const r = n ? s0Of(n) : undefined;
    if (r)
      regimes.push(
        `${MARKET_NAME[m]} ${r.regime.replace('_', '-')} (deploy cap ${pct(r.deployCapPct, 0)}, delta <= ${num2(r.deltaCap)}${r.usedVolIndex ? '' : '; no vol index: regime.noVolIndex'})`,
      );
  }
  if (regimes.length) out.push(`Regime: ${regimes.join(' | ')}`);

  const dropped = report.names.filter((n) => n.status === 'dropped_stale');
  if (dropped.length) {
    out.push('');
    out.push(
      `Dropped for stale data (${dropped.length}); fix with \`ingest --all\` or rank them anyway with --allow-stale:`,
    );
    for (const n of dropped) {
      out.push(
        `  ${n.instrument.symbol} (${n.instrument.market}): ${n.stale.map((s) => `data.stale ${s.input} ${s.actual ?? 'missing'}, required ${s.required}`).join('; ')}`,
      );
    }
  }
  const tagged = report.names.filter((n) => n.staleTagged);
  if (tagged.length)
    out.push(`STALE-tagged (ranked because of --allow-stale): ${tagged.map((n) => n.instrument.symbol).join(', ')}`);

  for (const market of ['US', 'HK'] as Market[]) {
    const rows = report.shortlist[market];
    out.push('');
    out.push(
      `${MARKET_NAME[market]} shortlist (ranked within the market; ${market === 'HK' ? 'HK$' : 'US$'} amounts per contract)`,
    );
    if (rows.length === 0) {
      out.push('  no recommendations in this market today');
    } else {
      for (const l of renderTable(COLUMNS, rows.map(rowFor))) out.push(l);
      for (const n of rows) {
        out.push('');
        out.push(
          `  Why ${n.instrument.symbol} (rank ${n.rank}, composite ${num2(n.composite, 1)}, data tier ${n.results['rank.composite']?.dataQuality.tier}):`,
        );
        const narrative = s7Of(n);
        if (narrative) for (const line of narrative.text.split('\n')) out.push(`    ${line}`);
        out.push('    Reasons:');
        for (const l of reasonLines(narrative?.reasons ?? [], '      ', { includeInfo: false })) out.push(l);
      }
    }
    const cut = report.names.filter((n) => n.instrument.market === market && n.status === 'cut');
    if (cut.length) {
      out.push('');
      out.push(
        `  Cut from the ${market} shortlist: ${cut.map((n) => `${n.instrument.symbol} (${n.cutReason})`).join('; ')}`,
      );
    }
  }

  const failed = report.names.filter((n) => n.status === 'failed');
  if (failed.length) {
    out.push('');
    out.push('Not recommended (FAIL), each with its binding rule:');
    const cols = [{ header: 'Symbol' }, { header: 'Market' }, { header: 'Binding rule' }, { header: 'Detail' }];
    const rows = failed.map((n) => [
      n.instrument.symbol,
      n.instrument.market,
      n.binding?.reason.rule ?? 'unknown',
      [
        `value ${valueText(n.binding?.reason ?? ({ value: null } as Reason))}`,
        n.binding?.reason.threshold ? `want ${n.binding.reason.threshold}` : '',
        n.binding?.reason.note ?? '',
      ]
        .filter(Boolean)
        .join(' | '),
    ]);
    for (const l of renderTable(cols, rows)) out.push(`  ${l}`);
  }
  const noContract = report.names.filter((n) => n.status === 'no_contract');
  if (noContract.length)
    out.push(`\nNo contract to recommend: ${noContract.map((n) => n.instrument.symbol).join(', ')}`);
  const excluded = report.names.filter((n) => n.status === 'excluded');
  if (excluded.length)
    out.push(
      `\nSkipped, open put already on the name (portfolio.alreadyOpen): ${excluded.map((n) => n.instrument.symbol).join(', ')}`,
    );

  if (report.pasteList.length) {
    out.push('');
    out.push(
      `Paste chains for these HK names (top ${report.pasteList.length} by composite without a fresh chain; currently priced synthetically):`,
    );
    for (const n of report.pasteList) {
      out.push(
        `  ${n.instrument.symbol}  composite ${num2(n.composite, 1)}  pnpm cli chain import ${n.instrument.symbol} HK ./${n.instrument.symbol}-chain.csv --spot <price> --date ${meta.asOf}`,
      );
    }
    out.push('  then re-run `scan`: only the names you might trade need real quotes.');
  }
  out.push('');
  out.push(
    'Decision support only: statistics about rules you configured, not investment advice. The app never places orders.',
  );
  return out;
}

export function renderExplain(n: NameResult, meta: RenderMeta): string[] {
  const out: string[] = [];
  const inst = n.instrument;
  out.push(
    `Explain ${inst.symbol} (${inst.market}${inst.name ? `, ${inst.name}` : ''}) as of ${meta.asOf} | ${meta.paramsLabel} | full mode: every skill runs, even after a FAIL`,
  );
  out.push(
    `Status: ${n.status}${n.binding ? ` | binding rule: ${n.binding.reason.rule} (${n.binding.skillId})${n.binding.reason.note ? `: ${n.binding.reason.note}` : ''}` : ''}`,
  );
  if (n.stale.length) {
    out.push(
      `Freshness: ${n.stale.map((s) => `data.stale ${s.input} ${s.actual ?? 'missing'} (required ${s.required})`).join('; ')}`,
    );
  } else {
    out.push('Freshness: all inputs current');
  }
  out.push(
    `Chain: ${n.freshChain ? 'fresh real chain' : n.chainAgeDays !== null ? `pasted chain ${n.chainAgeDays} days old (older than allowed): priced synthetically` : 'none: priced synthetically'}`,
  );
  out.push('');
  const narrative = s7Of(n);
  if (narrative) for (const l of narrative.text.split('\n')) out.push(l);
  out.push('');
  for (const id of [
    'market.regime',
    'fundamental.gate',
    'technical.timing',
    'volatility.edge',
    'option.select',
    'rank.composite',
    'size.position',
  ] as const) {
    const r = n.results[id] as SkillResult | undefined;
    if (!r) continue;
    out.push(
      `-- ${id} v${r.version}  verdict ${r.verdict}  score ${num2(r.score, 1)}  data tier ${r.dataQuality.tier}${r.dataQuality.missing.length ? `  missing: ${r.dataQuality.missing.join(',')}` : ''}`,
    );
    for (const l of reasonLines(r.reasons, '   ')) out.push(l);
  }
  const s4 = s4Of(n);
  if (s4?.chosen) {
    const c = s4.chosen;
    out.push('');
    out.push(
      `Chosen: ${c.expiry} P ${c.strike} | bid ${num2(c.bid, 3)} ask ${num2(c.ask, 3)} fill ${num2(c.fillPrice, 3)} | delta ${num2(c.delta, 3)} (${c.greeksSource}) iv ${pct(c.iv)} | credit ${money(c.credit, inst.currency)} collateral ${money(c.collateral, inst.currency)} | margin estimate ${money(c.marginEstimate, inst.currency)} (display only, return on margin ${pct(c.rocOnMargin)}) | annualised ${pct(c.annRoc)} | breakeven ${num2(c.breakeven, 2)} cushion ${pct(c.cushionPct)} | P(ITM) ${pct(c.probItm, 0)} BS ${pct(c.bsProbItm, 0)} | EV ${money(c.expectedValue, inst.currency)}`,
    );
    if (s4.alternative)
      out.push(
        `Alternative (next lower strike): ${s4.alternative.expiry} P ${s4.alternative.strike} | credit ${money(s4.alternative.credit, inst.currency)} | annualised ${pct(s4.alternative.annRoc)} | delta ${num2(s4.alternative.delta, 2)}`,
      );
  }
  if (s4 && s4.rejected.length > 0) {
    out.push('');
    out.push(`Rejected contracts (${s4.rejected.length}${s4.rejected.length >= 40 ? '+, first 40' : ''}):`);
    for (const r of s4.rejected.slice(0, 12)) out.push(`   ${r.expiry} P ${r.strike}: ${r.reason}`);
    if (s4.rejected.length > 12) out.push(`   ... ${s4.rejected.length - 12} more`);
  }
  return out;
}
