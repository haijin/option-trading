import type { Command, InvalidArgumentError } from 'commander';
import { canonicalSymbol } from '../../core/symbols';
import type { Currency, ReportingFrequency, SolvencyModel } from '../../core/types';
import { UserError } from '../../core/util';
import { coverageFor } from '../../db/coverage';
import {
  addToWatchlist,
  getSettings,
  listWatchlist,
  removeFromWatchlist,
  setSettings,
  upsertInstrument,
} from '../../db/repos';
import { type EventInput, writeCorporateEvents } from '../../db/writers';
import { futuFromEnv } from '../../providers/futu';
import { ALL_STEPS, type IngestStep, runIngest } from '../../providers/ingest';
import { YahooClient } from '../../providers/yahoo/client';
import type { CliContext } from '../context';
import { renderTable } from '../table';
import {
  boardLotFromSeed,
  parseDateArg,
  parseMarket,
  parsePositive,
  parsePositiveInt,
  requireInstrument,
} from './common';

const SOLVENCY: SolvencyModel[] = ['altman', 'property', 'financial', 'reit'];
const REPORTING: ReportingFrequency[] = ['quarterly', 'semiannual'];
const EVENT_TYPES = [
  'earnings',
  'ex_dividend',
  'agm',
  'rights_issue',
  'spin_off',
  'split',
  'index_rebalance',
  'other',
] as const;

export function registerSetup(program: Command, ctx: CliContext): void {
  // ---------------------------------------------------------------- settings
  const settings = program.command('settings').description('portfolio settings (equity and base currency)');
  settings
    .command('set <key> <value>')
    .description('set equity (required once before the first scan) or base currency')
    .option('--base <ccy>', 'base currency for equity and caps (HKD, USD or SGD)')
    .action(async (key: string, value: string, opts: { base?: string }) => {
      const db = ctx.db().db;
      const base = opts.base?.toUpperCase();
      if (base && base !== 'HKD' && base !== 'USD' && base !== 'SGD')
        throw new UserError('--base must be HKD, USD or SGD');
      if (key === 'equity') {
        const equity = Number(value);
        if (!Number.isFinite(equity) || equity <= 0)
          throw new UserError(`equity must be a positive number, got "${value}"`);
        const s = await setSettings(db, { equity, ...(base ? { baseCurrency: base as Currency } : {}) });
        ctx.out(`equity set to ${s.baseCurrency} ${s.equity?.toLocaleString('en-US')}`);
      } else if (key === 'base') {
        const b = value.toUpperCase();
        if (b !== 'HKD' && b !== 'USD' && b !== 'SGD') throw new UserError('base must be HKD, USD or SGD');
        const s = await setSettings(db, { baseCurrency: b as Currency });
        ctx.out(`base currency set to ${s.baseCurrency}`);
      } else {
        throw new UserError(`unknown setting "${key}" (expected equity or base)`);
      }
    });
  settings
    .command('show')
    .description('print current settings')
    .action(async () => {
      const s = await getSettings(ctx.db().db);
      ctx.out(`base currency: ${s.baseCurrency}`);
      ctx.out(
        `equity: ${s.equity === null ? 'NOT SET (run: settings set equity <amount> --base HKD)' : s.equity.toLocaleString('en-US')}`,
      );
    });

  // --------------------------------------------------------------- watchlist
  const wl = program.command('watchlist').description('names you would be happy to own');
  wl.command('add <symbol> <market>')
    .description('add a name; HK board lots come from data/hk-board-lots.csv unless --lot is given')
    .option('--lot <n>', 'contract multiplier (HK board lot)', parsePositiveInt)
    .option('--solvency <model>', `solvency model: ${SOLVENCY.join(' | ')}`)
    .option('--reporting <freq>', `reporting frequency: ${REPORTING.join(' | ')}`)
    .option('--name <name>')
    .option('--sector <sector>')
    .option('--conviction <1-5>', 'your own prior, small ranking weight', parsePositiveInt)
    .option('--notes <text>')
    .action(
      async (
        symbolRaw: string,
        marketRaw: string,
        opts: {
          lot?: number;
          solvency?: string;
          reporting?: string;
          name?: string;
          sector?: string;
          conviction?: number;
          notes?: string;
        },
      ) => {
        const market = parseMarket(marketRaw);
        let symbol: string;
        try {
          symbol = canonicalSymbol(market, symbolRaw);
        } catch (err) {
          throw new UserError((err as Error).message);
        }
        if (opts.solvency && !SOLVENCY.includes(opts.solvency as SolvencyModel)) {
          throw new UserError(`--solvency must be one of ${SOLVENCY.join(', ')}`);
        }
        if (opts.reporting && !REPORTING.includes(opts.reporting as ReportingFrequency)) {
          throw new UserError(`--reporting must be one of ${REPORTING.join(', ')}`);
        }
        if (opts.conviction !== undefined && (opts.conviction < 1 || opts.conviction > 5)) {
          throw new UserError('--conviction must be 1 to 5');
        }
        let lot = opts.lot ?? 100;
        let lotNote = '';
        if (market === 'HK' && opts.lot === undefined) {
          const seeded = await boardLotFromSeed(ctx, symbol);
          if (seeded) {
            lot = seeded;
            lotNote = ' (from data/hk-board-lots.csv)';
          } else {
            lotNote = ' (WARNING: not in data/hk-board-lots.csv; pass --lot, the multiplier drives every HK number)';
          }
        }
        const db = ctx.db().db;
        const inst = await upsertInstrument(db, {
          market,
          symbol,
          boardLot: market === 'HK' ? lot : 100,
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.sector ? { sector: opts.sector } : {}),
          ...(opts.solvency ? { solvencyModel: opts.solvency as SolvencyModel } : {}),
          ...(opts.reporting ? { reportingFrequency: opts.reporting as ReportingFrequency } : {}),
          ...(opts.solvency ? { providerSymbols: { solvencySource: 'user' } } : {}),
        });
        await addToWatchlist(db, inst.id, { notes: opts.notes ?? null, conviction: opts.conviction ?? null });
        ctx.out(
          `added ${market}:${symbol}  lot ${inst.multiplier}${lotNote}  solvency ${inst.solvencyModel}${opts.solvency ? '' : ' (inferred at first ingest unless set)'}  reporting ${inst.reportingFrequency}`,
        );
      },
    );
  wl.command('list')
    .description('show the watchlist')
    .action(async () => {
      const rows = await listWatchlist(ctx.db().db);
      if (rows.length === 0) return ctx.out('watchlist is empty: `watchlist add AAPL US`');
      for (const l of renderTable(
        [
          { header: 'market' },
          { header: 'symbol' },
          { header: 'name' },
          { header: 'lot', align: 'right' },
          { header: 'solvency' },
          { header: 'reporting' },
          { header: 'sector' },
        ],
        rows.map((r) => [
          r.market,
          r.symbol,
          r.name ?? '',
          String(r.multiplier),
          r.solvencyModel,
          r.reportingFrequency,
          r.sector ?? '',
        ]),
      )) {
        ctx.out(l);
      }
    });
  wl.command('remove <symbol> <market>')
    .description('stop scanning a name (history is kept)')
    .action(async (symbol: string, marketRaw: string) => {
      const inst = await requireInstrument(ctx, symbol, parseMarket(marketRaw));
      const ok = await removeFromWatchlist(ctx.db().db, inst.id);
      ctx.out(
        ok
          ? `removed ${inst.market}:${inst.symbol} from the watchlist`
          : `${inst.market}:${inst.symbol} was not on the watchlist`,
      );
    });

  // ------------------------------------------------------------------ events
  const events = program.command('events').description('corporate events');
  events
    .command('add <symbol> <type> <date>')
    .description(`record an event, e.g. \`events add 0700 earnings 2026-11-12\` (types: ${EVENT_TYPES.join(', ')})`)
    .option('--unconfirmed', 'mark the date as an estimate')
    .action(async (symbol: string, type: string, date: string, opts: { unconfirmed?: boolean }) => {
      if (!(EVENT_TYPES as readonly string[]).includes(type))
        throw new UserError(`event type must be one of ${EVENT_TYPES.join(', ')}`);
      let day: string;
      try {
        day = parseDateArg(date);
      } catch (err) {
        throw new UserError((err as InvalidArgumentError).message);
      }
      const inst = await requireInstrument(ctx, symbol);
      const e: EventInput = {
        type: type as EventInput['type'],
        date: day,
        confirmed: !opts.unconfirmed,
        source: 'manual',
      };
      const r = await writeCorporateEvents(ctx.db().db, inst.id, [e], ctx.now());
      ctx.out(
        `${inst.market}:${inst.symbol} ${type} on ${day} ${r.inserted ? 'recorded' : r.updated ? 'updated' : 'unchanged'} (${opts.unconfirmed ? 'unconfirmed' : 'confirmed'}, source manual)`,
      );
    });

  // ------------------------------------------------------------------ ingest
  program
    .command('ingest')
    .description('fetch prices, fundamentals, US chains, events and FX from providers (the only command that fetches)')
    .option('--all', 'every step for every watchlist name (default)')
    .option('--only <symbols>', 'comma-separated watchlist symbols')
    .option('--steps <list>', `comma-separated subset of: ${ALL_STEPS.join(', ')}`)
    .option('--years <n>', 'years of bar history', parsePositive)
    .action(async (opts: { all?: boolean; only?: string; steps?: string; years?: number }) => {
      let steps: IngestStep[] | undefined;
      if (opts.steps) {
        steps = opts.steps.split(',').map((s) => s.trim()) as IngestStep[];
        const bad = steps.filter((s) => !ALL_STEPS.includes(s));
        if (bad.length) throw new UserError(`unknown step(s): ${bad.join(', ')} (valid: ${ALL_STEPS.join(', ')})`);
      }
      const only = opts.only
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => canonicalSymbol(/^\d/.test(s) ? 'HK' : 'US', s));
      const futu = futuFromEnv(process.env);
      const summary = await runIngest(
        {
          db: ctx.db().db,
          client: new YahooClient({ fetch: ctx.fetch }),
          futu: futu ?? undefined,
          fetch: ctx.fetch,
          now: ctx.now(),
          dataDir: ctx.dataDir,
          readFile: (p) => ctx.readFile(p),
          fileExists: (p) => ctx.fileExists(p),
          log: (l) => ctx.out(l),
        },
        { ...(steps ? { steps } : {}), ...(only ? { only } : {}), ...(opts.years ? { years: opts.years } : {}) },
      ).finally(() => futu?.close());
      for (const i of summary.items) {
        ctx.out(
          `${i.status === 'ok' ? 'ok     ' : i.status === 'skipped' ? 'skipped' : 'FAILED '} ${i.target.padEnd(14)} ${i.step.padEnd(12)} ${i.detail}`,
        );
      }
      const ok = summary.items.filter((i) => i.status === 'ok').length;
      const skipped = summary.items.filter((i) => i.status === 'skipped').length;
      ctx.out(
        `ingest finished: ${ok} ok, ${summary.failed} failed, ${skipped} skipped; ${summary.rowsWritten} rows written`,
      );
      if (summary.failed > 0)
        throw new UserError('ingest had failures (see FAILED lines above); data for those inputs is stale');
    });

  // ------------------------------------------------------------------ report
  const report = program.command('report').description('data-quality reports');
  report
    .command('coverage')
    .description(
      'fundamentals coverage per watchlist name: periods available and missing key fields (decides docs/07 Q14)',
    )
    .action(async () => {
      const db = ctx.db().db;
      const names = await listWatchlist(db);
      if (names.length === 0) return ctx.out('watchlist is empty');
      const rows: string[][] = [];
      let enough = 0;
      for (const n of names) {
        const c = await coverageFor(db, n.id);
        if (c.supports.fScore && c.missingLatestAnnual.length <= 4) enough++;
        rows.push([
          `${n.market}:${n.symbol}`,
          String(c.annual),
          String(c.quarterly + c.semiannual),
          `${c.firstPeriod ?? '-'}..${c.lastPeriod ?? '-'}`,
          `${c.totalCells - c.missingCells}/${c.totalCells}`,
          c.missingLatestAnnual.length === 0 ? 'none' : c.missingLatestAnnual.join(','),
          [
            c.supports.fScore ? 'F' : '-',
            c.supports.revenueCagr3y ? 'CAGR3' : '-',
            c.supports.roic5y ? 'ROIC5' : '-',
            c.supports.valuationZ5y ? 'valZ5' : '-',
            c.supports.gmStdev8 ? 'GM8' : '-',
          ].join(' '),
        ]);
      }
      for (const l of renderTable(
        [
          { header: 'name' },
          { header: 'annual', align: 'right' },
          { header: 'sub-annual', align: 'right' },
          { header: 'span' },
          { header: 'cells filled', align: 'right' },
          { header: 'missing on latest annual' },
          { header: 'S1 tests supported' },
        ],
        rows,
      )) {
        ctx.out(l);
      }
      ctx.out(
        `${enough}/${names.length} names have a usable F-score input set from free data (>= 2 annuals, <= 4 key fields missing).`,
      );
      ctx.out(
        'Legend: F = Piotroski F-score, CAGR3 = 3y revenue CAGR, ROIC5 = 5y median ROIC, valZ5 = 5y valuation z-scores, GM8 = 8-period margin stability.',
      );
    });
}
