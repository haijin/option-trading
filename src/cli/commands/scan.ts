import type { Command } from 'commander';
import { saveScanRun } from '../../db/scan-store';
import type { NameResult, RunReport } from '../../skills';
import { defaultAsOf } from '../asof';
import type { CliContext } from '../context';
import { executeRun } from '../pipeline';
import { renderExplain, renderScan } from '../render';
import { inferMarket, parseDateArg, parseMarket, requireInstrument } from './common';

function nameJson(n: NameResult) {
  const s4 = n.results['option.select']?.payload as
    | { chosen?: unknown; alternative?: unknown; source?: string; tier?: string }
    | undefined;
  const s5 = n.results['rank.composite']?.payload;
  const s6 = n.results['size.position']?.payload;
  const s7 = n.results['explain.narrative']?.payload as { text?: string; reasons?: unknown } | undefined;
  return {
    symbol: n.instrument.symbol,
    market: n.instrument.market,
    status: n.status,
    rank: n.rank,
    composite: n.composite,
    dataTier: n.results['rank.composite']?.dataQuality.tier ?? null,
    stale: n.stale,
    staleTagged: n.staleTagged,
    binding: n.binding,
    cutReason: n.cutReason,
    contract: s4?.chosen ?? null,
    alternative: s4?.alternative ?? null,
    priceSource: s4?.source ?? null,
    composite_detail: s5 ?? null,
    sizing: s6 ?? null,
    narrative: s7?.text ?? null,
    reasons: s7?.reasons ?? [],
  };
}

export function reportJson(report: RunReport) {
  return {
    asOf: report.asOf,
    mode: report.mode,
    paramsHash: report.paramsHash,
    stats: { cacheHits: report.stats.cacheHits, computed: report.stats.computed },
    shortlist: { US: report.shortlist.US.map(nameJson), HK: report.shortlist.HK.map(nameJson) },
    dropped: report.names.filter((n) => n.status === 'dropped_stale').map(nameJson),
    failed: report.names.filter((n) => n.status === 'failed').map(nameJson),
    excluded: report.names.filter((n) => n.status === 'excluded').map(nameJson),
    cut: report.names.filter((n) => n.status === 'cut').map(nameJson),
    noContract: report.names.filter((n) => n.status === 'no_contract').map(nameJson),
    pasteChainsFor: report.pasteList.map((n) => n.instrument.symbol),
  };
}

export function registerScan(program: Command, ctx: CliContext): void {
  program
    .command('scan')
    .description('rank the watchlist and print the justified shortlist (reads the database only; never fetches)')
    .option('--as-of <date>', 'scan as of this date (default: the latest completed session)', parseDateArg)
    .option('--allow-stale', 'rank names with stale inputs anyway, tagged STALE')
    .option('--json', 'machine-readable output')
    .action(async (opts: { asOf?: string; allowStale?: boolean; json?: boolean }) => {
      const asOf = opts.asOf ?? defaultAsOf(ctx.now());
      const started = ctx.now();
      const { report, meta, params } = await executeRun(ctx, {
        asOf,
        mode: 'scan',
        gate: 'enforce',
        allowStale: !!opts.allowStale,
        requireEquity: true,
      });
      await saveScanRun(ctx.db().db, params, report, started);
      if (opts.json) ctx.out(JSON.stringify(reportJson(report), null, 2));
      else for (const l of renderScan(report, meta)) ctx.out(l);
    });

  program
    .command('explain <symbol>')
    .description('every skill result for one name, even one that FAILs the fundamental gate')
    .option('--market <market>', 'US or HK (default: inferred from the symbol)', parseMarket)
    .option('--as-of <date>', 'explain as of this date (default: the latest completed session)', parseDateArg)
    .option('--json', 'machine-readable output')
    .action(async (symbol: string, opts: { market?: 'US' | 'HK'; asOf?: string; json?: boolean }) => {
      const inst = await requireInstrument(ctx, symbol, opts.market ?? inferMarket(symbol));
      const asOf = opts.asOf ?? defaultAsOf(ctx.now());
      const { report, meta } = await executeRun(ctx, {
        asOf,
        mode: 'full',
        gate: 'report',
        allowStale: true,
        only: [inst],
        requireEquity: false,
      });
      const n = report.names[0] as NameResult;
      if (opts.json) ctx.out(JSON.stringify(nameJson(n), null, 2));
      else for (const l of renderExplain(n, meta)) ctx.out(l);
    });
}
