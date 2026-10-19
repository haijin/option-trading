import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import type { Underlying } from '../../backtest/engine';
import { type BacktestRequest, runBacktest } from '../../backtest/run';
import { getBacktest, listBacktests, listBacktestTrades, tradesToCsv } from '../../backtest/store';
import { studiesFor } from '../../backtest/studies';
import { managedPutChecks, putWriteChecks } from '../../backtest/validation';
import { UserError } from '../../core/util';
import { loadBars } from '../../db/history';
import { findInstrument, loadParams } from '../../db/repos';
import { renderBacktest } from '../backtest-render';
import type { CliContext } from '../context';
import { num2, pct, renderTable } from '../table';
import { parseDateArg, parseMarket, parsePositive, parsePositiveInt, requireInstrument } from './common';

/** `--set option.select.deltaMax=0.2` becomes { 'option.select': { deltaMax: 0.2 } }: the key before the last dot-separated name is the skill id. */
export function parseSet(items: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq < 0) throw new InvalidArgumentError(`--set expects key=value, got "${item}"`);
    const key = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1).trim();
    const dot = key.lastIndexOf('.');
    if (dot <= 0) throw new InvalidArgumentError(`--set key must look like option.select.deltaMax, got "${key}"`);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // a bare word stays a string
    }
    const group = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const cur = (out[group] as Record<string, unknown> | undefined) ?? {};
    cur[name] = value;
    out[group] = cur;
  }
  return out;
}

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

/** Phase 4: backtests, event studies and the validation reproduction. */
export function registerBacktest(program: Command, ctx: CliContext): void {
  const bt = program.command('backtest').description('replay the live rules over history (docs/05)');

  bt.command('run')
    .description('run a backtest over the watchlist and print the report')
    .requiredOption('--from <date>', 'first day (the exchange calendar starts in 2010)', parseDateArg)
    .requiredOption('--to <date>', 'last day', parseDateArg)
    .option('--tier <policy>', 'real_only | real_then_synthetic | synthetic_only', 'real_then_synthetic')
    .option('--capital <amount>', 'starting capital in the base currency (default: equity setting)', parsePositive)
    .option('--symbols <list>', 'comma-separated watchlist symbols (default: all active)')
    .option('--scan-every <n>', 'trading days between scans', parsePositiveInt)
    .option('--observe', 'also record rejected entries for per-rule attribution (about 2x compute)')
    .option('--no-benchmarks', 'skip the benchmark runs')
    .option('--no-sensitivity', 'skip the sigma +/-20% re-runs')
    .option('--walk-forward <train,test>', 'walk-forward in months, e.g. 36,12')
    .option('--set <key=value>', 'override a strategy parameter, e.g. option.select.deltaMax=0.2 (repeatable)', collect)
    .option('--name <name>', 'a label for the run')
    .action(
      async (o: {
        from: string;
        to: string;
        tier: string;
        capital?: number;
        symbols?: string;
        scanEvery?: number;
        observe?: boolean;
        benchmarks: boolean;
        sensitivity: boolean;
        walkForward?: string;
        set?: string[];
        name?: string;
      }) => {
        if (!['real_only', 'real_then_synthetic', 'synthetic_only'].includes(o.tier))
          throw new UserError('--tier must be real_only, real_then_synthetic or synthetic_only');
        const db = ctx.db().db;
        const symbols = o.symbols
          ? await Promise.all(
              o.symbols
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map(async (s) => {
                  const i = await requireInstrument(ctx, s);
                  return { market: i.market, symbol: i.symbol };
                }),
            )
          : undefined;
        let wf: BacktestRequest['walkForward'];
        if (o.walkForward) {
          const [a, b] = o.walkForward.split(',').map((x) => Number(x));
          if (!Number.isInteger(a) || !Number.isInteger(b) || (a as number) < 1 || (b as number) < 1)
            throw new UserError('--walk-forward expects two whole numbers of months, e.g. 36,12');
          wf = { trainMonths: a as number, testMonths: b as number };
        }
        const req: BacktestRequest = {
          from: o.from,
          to: o.to,
          tierPolicy: o.tier as BacktestRequest['tierPolicy'],
          benchmarks: o.benchmarks,
          sensitivity: o.sensitivity,
          ...(o.name ? { name: o.name } : {}),
          ...(o.capital !== undefined ? { initialCapital: o.capital } : {}),
          ...(symbols ? { symbols } : {}),
          ...(o.scanEvery !== undefined ? { scanEveryDays: o.scanEvery } : {}),
          ...(o.observe ? { observeRejected: true } : {}),
          ...(wf ? { walkForward: wf } : {}),
          ...(o.set?.length ? { paramsOverride: parseSet(o.set) as BacktestRequest['paramsOverride'] } : {}),
        };
        let lastBucket = -1;
        const id = await runBacktest(db, req, {
          onProgress: (f, msg) => {
            const bucket = Math.floor(f * 10);
            if (bucket > lastBucket) {
              lastBucket = bucket;
              ctx.out(`  ${Math.round(f * 100)}% ${msg}`);
            }
          },
        });
        const detail = await getBacktest(db, id);
        if (!detail) throw new UserError('the run was not stored');
        for (const l of renderBacktest(detail)) ctx.out(l);
      },
    );

  bt.command('list')
    .description('stored backtests, newest first')
    .action(async () => {
      const rows = await listBacktests(ctx.db().db);
      if (rows.length === 0) return ctx.out('no backtests yet; try `backtest run --from 2018-01-02 --to 2025-12-31`');
      for (const l of renderTable(
        [
          { header: 'Id' },
          { header: 'Name' },
          { header: 'Status' },
          { header: 'Period' },
          { header: 'Trades', align: 'right' },
          { header: 'Win', align: 'right' },
          { header: 'CAGR', align: 'right' },
          { header: 'Sharpe', align: 'right' },
          { header: 'Max DD', align: 'right' },
        ],
        rows.map((r) => [
          r.id,
          r.name ?? '',
          r.status,
          `${r.from}..${r.to}`,
          r.headline ? String(r.headline.trades) : '-',
          r.headline ? pct(r.headline.winRate, 0) : '-',
          r.headline ? pct(r.headline.cagr) : '-',
          r.headline ? num2(r.headline.sharpe) : '-',
          r.headline ? pct(r.headline.maxDrawdown) : '-',
        ]),
      ))
        ctx.out(l);
    });

  bt.command('show <id>')
    .description('the full report of a stored backtest')
    .action(async (id: string) => {
      const d = await getBacktest(ctx.db().db, id);
      if (!d) throw new UserError(`no backtest with id ${id}`);
      for (const l of renderBacktest(d)) ctx.out(l);
    });

  bt.command('trades <id>')
    .description('the trades of a backtest as CSV on standard output')
    .option('--shadow', 'include observe-mode shadow trades')
    .action(async (id: string, o: { shadow?: boolean }) => {
      const d = await getBacktest(ctx.db().db, id);
      if (!d) throw new UserError(`no backtest with id ${id}`);
      const rows = await listBacktestTrades(ctx.db().db, id, { shadow: !!o.shadow });
      ctx.out(tradesToCsv(rows).replace(/\r\n$/, ''));
    });

  bt.command('studies <symbol>')
    .description('what each entry rule has historically been followed by on this name (docs/05 section 5)')
    .option('--market <market>', 'US or HK (default: inferred)', parseMarket)
    .action(async (symbol: string, o: { market?: 'US' | 'HK' }) => {
      const inst = await requireInstrument(ctx, symbol, o.market);
      const { params } = await loadParams(ctx.db().db);
      const s = await studiesFor(ctx.db().db, inst, {
        riskFree: inst.market === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS,
        ivRvRatio: params['volatility.edge'].ivRvRatioDefault[inst.market],
      });
      ctx.out(`${inst.market}:${inst.symbol}: ${s.bars} bars, ${s.from ?? '-'} to ${s.to ?? '-'}`);
      for (const r of s.rules)
        for (const h of r.byHorizon) {
          ctx.out(
            `  ${r.rule.padEnd(20)} ${String(h.horizon).padStart(2)}d  fired ${String(h.nFired).padStart(4)} / not ${String(h.nNotFired).padStart(4)}  win ${pct(h.fired.winRate, 0)} vs ${pct(h.notFired.winRate, 0)} (${h.edge.winRateDelta === null ? '-' : `${h.edge.winRateDelta >= 0 ? '+' : ''}${(h.edge.winRateDelta * 100).toFixed(1)} pts`})  touch ${pct(h.fired.touchRate, 0)} vs ${pct(h.notFired.touchRate, 0)}`,
          );
        }
    });

  bt.command('validate')
    .description(
      'reproduce the docs/05 section 6 checks on stored SPY history (monthly ATM put-write, 16-delta managed)',
    )
    .option('--symbol <symbol>', 'the price history to use', 'SPY')
    .option('--market <market>', 'US or HK', parseMarket, 'US')
    .action(async (o: { symbol: string; market: 'US' | 'HK' }) => {
      const db = ctx.db().db;
      const inst = await findInstrument(db, o.market, o.symbol);
      if (!inst) throw new UserError(`${o.market}:${o.symbol} is not in the database`);
      const all = await loadBars(db, inst.id);
      const bars = all.filter((b) => b.day >= '2010-01-01' && b.day <= '2027-12-31');
      if (bars.length < 900)
        throw new UserError(
          `only ${bars.length} bars of ${o.symbol} since 2010; the checks need about 4 years. Run \`ingest --only ${o.symbol} --years 15\` first`,
        );
      const u: Underlying = {
        instrumentId: inst.id,
        symbol: inst.symbol,
        market: inst.market,
        currency: inst.currency,
        sector: inst.sector,
        multiplier: inst.multiplier,
        bars: bars.map((b) => ({ day: b.day, close: b.close, adjClose: b.adjClose, low: b.low })),
        divYield: 0.015,
      };
      ctx.out(
        `${o.symbol}: ${bars.length} bars, ${bars[0]?.day} to ${bars[bars.length - 1]?.day} (the calendar tables start in 2010)`,
      );
      const checks = [...(await putWriteChecks(u)), ...(await managedPutChecks(u))];
      for (const c of checks) ctx.out(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
      const failed = checks.filter((c) => !c.pass).length;
      ctx.out(
        failed === 0
          ? 'all checks passed: the synthetic pricer and the exit logic behave as documented'
          : `${failed} check(s) failed: do not trust synthetic results until the pricer or the exit logic is explained`,
      );
      if (failed > 0) throw new UserError('validation failed');
    });
}
