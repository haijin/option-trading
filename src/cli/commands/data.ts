import type { Command } from 'commander';
import { eq } from 'drizzle-orm';
import type { ISODate } from '../../core/dates';
import { centsToString } from '../../core/money';
import { UserError } from '../../core/util';
import { runCalibration } from '../../db/calibration';
import { closeManualPosition, openManualPosition } from '../../db/position-ops';
import { getInstrument, loadParams } from '../../db/repos';
import { instruments, positions } from '../../db/schema';
import { importChain, importJournal } from '../../providers/csv/store';
import { runAttribution } from '../attribution';
import type { CliContext } from '../context';
import { money, num2, renderTable } from '../table';
import { parseDateArg, parseMarket, parsePositive, parsePositiveInt, requireInstrument } from './common';

async function readFileOrFail(ctx: CliContext, path: string): Promise<string> {
  try {
    return await ctx.readFile(path);
  } catch (err) {
    throw new UserError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

export function registerData(program: Command, ctx: CliContext): void {
  // ------------------------------------------------------------------- chain
  const chain = program.command('chain').description('option chains pasted from your broker screen');
  chain
    .command('import <symbol> <market> <csv>')
    .description(
      'import a pasted chain (expiry,strike,right,bid,ask,last,volume,oi[,iv][,delta]); --spot and --date are authoritative',
    )
    .requiredOption('--spot <price>', 'underlying price when the chain was copied', parsePositive)
    .requiredOption('--date <date>', 'snapshot date (YYYY-MM-DD)', parseDateArg)
    .action(async (symbol: string, marketRaw: string, csv: string, opts: { spot: number; date: ISODate }) => {
      const inst = await requireInstrument(ctx, symbol, parseMarket(marketRaw));
      const text = await readFileOrFail(ctx, csv);
      const params = (await loadParams(ctx.db().db)).params;
      const rf = inst.market === 'HK' ? params['option.select'].riskFreeHK : params['option.select'].riskFreeUS;
      const r = await importChain(ctx.db().db, inst, text, {
        spot: opts.spot,
        date: opts.date,
        now: ctx.now(),
        riskFree: rf,
      });
      if (!r.ok) {
        throw new UserError(
          [
            `chain import rejected, nothing stored (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}):`,
            ...r.errors.map((e) => `  ${e}`),
          ].join('\n'),
        );
      }
      ctx.out(
        `stored ${r.stored} quotes for ${inst.market}:${inst.symbol} on ${r.snapshotDate} (expiries ${r.expiries.join(', ')})${r.iv30 !== null ? `; IV30 ${(r.iv30 * 100).toFixed(1)}%` : ''}`,
      );
      for (const w of r.warnings) ctx.out(`  warning ${w}`);
      ctx.out(
        `usable by \`scan\` for ${params.runner.chainMaxAgeDays} days (runner.chainMaxAgeDays); older pastes fall back to synthetic pricing`,
      );
    });

  // ----------------------------------------------------------------- journal
  const journal = program.command('journal').description('your past put trades: the first real HK option data');
  journal
    .command('import <csv>')
    .description(
      'import a trade journal (open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row)',
    )
    .action(async (csv: string) => {
      const text = await readFileOrFail(ctx, csv);
      const r = await importJournal(ctx.db().db, text, ctx.now());
      if (!r.ok) {
        throw new UserError(
          [
            `journal import rejected, nothing stored (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}):`,
            ...r.errors.map((e) => `  ${e}`),
          ].join('\n'),
        );
      }
      ctx.out(
        `imported ${r.imported} leg(s)${r.skippedExisting ? `, ${r.skippedExisting} already present (re-import is idempotent)` : ''}; ${r.quotesWritten} journal-tier option quotes stored`,
      );
      ctx.out('Realised P&L by market (compare with your broker statement):');
      for (const l of r.totals) ctx.out(`  ${l}`);
      for (const w of r.warnings) ctx.out(`  warning ${w}`);
      if (r.openLegs.length) {
        ctx.out(
          `Open positions (${r.openLegs.length}) block new recommendations on these names until closed with \`pnpm cli positions close <id>\`:`,
        );
        for (const o of r.openLegs) ctx.out(`  ${o.market}:${o.symbol} ${o.contracts} x P ${o.strike} ${o.expiry}`);
      }
      ctx.out(
        'next: `pnpm cli journal calibrate` prices these fills and your pasted chains against the synthetic pricer.',
      );
    });

  journal
    .command('calibrate')
    .description(
      'real versus synthetic prices per market and delta bucket (pasted chains primary, journal fills sanity)',
    )
    .action(async () => {
      const db = ctx.db().db;
      const params = (await loadParams(db)).params;
      const min = params['volatility.edge'].calibrationMinSamples;
      const rep = await runCalibration(db, params, min);
      ctx.out(
        'Calibration: real / synthetic price per market and delta bucket (pasted chains are the primary, unbiased set; journal fills only a sanity figure)',
      );
      if (rep.rows.length) {
        for (const l of renderTable(
          [
            { header: 'Market' },
            { header: 'Delta bucket' },
            { header: 'Chain n', align: 'right' },
            { header: 'Chain ratio', align: 'right' },
            { header: 'Journal n', align: 'right' },
            { header: 'Journal ratio', align: 'right' },
          ],
          rep.rows.map((r) => [
            r.market,
            r.bucket,
            String(r.chainN),
            num2(r.chainMedian, 3),
            String(r.journalN),
            num2(r.journalMedian, 3),
          ]),
        )) {
          ctx.out(l);
        }
      }
      for (const m of ['HK', 'US'] as const) {
        const n = rep.chainSamples[m];
        ctx.out(
          rep.calibrated[m]
            ? `${m}: calibrated (${n} chain samples >= ${min}): synthetic prices use the chain medians above instead of the default haircut`
            : `${m}: uncalibrated (${n} chain samples, need ${min}): synthetic prices use the default ${m === 'HK' ? '15' : '10'}% slippage + 5% model-risk haircut`,
        );
      }
      const e = rep.excluded;
      ctx.out(
        `Excluded: ${e.journalNoSpot} journal fill(s) without spot, ${e.journalOutlier} journal.priceOutlier, ${e.noVolHistory} sample(s) without 60 days of price history, ${e.illiquidChainRows} illiquid chain row(s)`,
      );
      ctx.out(`${rep.written} calibration sample(s) written`);
    });

  journal
    .command('attribution')
    .description('re-score every past trade as of its entry date and compare winners with losers per rule')
    .action(async () => {
      const rep = await runAttribution(ctx.db().db);
      ctx.out(
        `Journal attribution: ${rep.winners} winners, ${rep.losers} losers re-scored as of their entry dates (${rep.skipped} skipped: no price history then). Sample sizes are small: read this as a hint, not a result.`,
      );
      if (rep.rows.length === 0) return;
      for (const l of renderTable(
        [
          { header: 'Rule' },
          { header: 'Winners pass', align: 'right' },
          { header: 'Winners fail', align: 'right' },
          { header: 'Losers pass', align: 'right' },
          { header: 'Losers fail', align: 'right' },
        ],
        rep.rows.map((r) => [r.rule, String(r.winPass), String(r.winFail), String(r.losePass), String(r.loseFail)]),
      )) {
        ctx.out(l);
      }
    });

  // --------------------------------------------------------------- positions
  const pos = program.command('positions').description('record fills by hand (the app never places orders)');
  pos
    .command('add <symbol>')
    .description('record a put you sold; the name is then excluded from new recommendations until you close it')
    .requiredOption('--strike <price>', 'strike', parsePositive)
    .requiredOption('--expiry <date>', 'expiry date', parseDateArg)
    .requiredOption('--contracts <n>', 'number of contracts', parsePositiveInt)
    .requiredOption('--price <premium>', 'premium per share received', parsePositive)
    .option('--date <date>', 'fill date (default: today)', parseDateArg)
    .option('--fees <amount>', 'total fees for the fill', (v) => Number(v))
    .option('--spot <price>', 'underlying price at the fill (enables calibration)', parsePositive)
    .option('--market <market>', 'US or HK (default: inferred)', parseMarket)
    .action(
      async (
        symbol: string,
        o: {
          strike: number;
          expiry: ISODate;
          contracts: number;
          price: number;
          date?: ISODate;
          fees?: number;
          spot?: number;
          market?: 'US' | 'HK';
        },
      ) => {
        const inst = await requireInstrument(ctx, symbol, o.market);
        const openDate = o.date ?? ctx.now().toISOString().slice(0, 10);
        const id = await openManualPosition(ctx.db().db, {
          instrument: inst,
          strike: o.strike,
          expiry: o.expiry,
          contracts: o.contracts,
          price: o.price,
          date: openDate,
          ...(o.fees !== undefined ? { fees: o.fees } : {}),
          ...(o.spot !== undefined ? { spot: o.spot } : {}),
        });
        ctx.out(
          `position ${id} recorded: ${inst.market}:${inst.symbol} short ${o.contracts} x P ${o.strike} ${o.expiry} @ ${o.price} (multiplier ${inst.multiplier}); excluded from new recommendations until closed`,
        );
      },
    );

  pos
    .command('close <id>')
    .description('close a position: bought back (--price), expired worthless (--expired) or assigned (--assigned)')
    .option('--price <premium>', 'buy-back price per share', parsePositive)
    .option('--date <date>', 'close date (default: today; expired: the expiry)', parseDateArg)
    .option('--fees <amount>', 'closing fees', (v) => Number(v))
    .option('--expired', 'expired worthless')
    .option('--assigned', 'assigned: P&L books credit minus the intrinsic loss at assignment')
    .option(
      '--underlying-close <price>',
      'underlying close on the assignment date (default: the stored bar close)',
      parsePositive,
    )
    .action(
      async (
        idRaw: string,
        o: {
          price?: number;
          date?: ISODate;
          fees?: number;
          expired?: boolean;
          assigned?: boolean;
          underlyingClose?: number;
        },
      ) => {
        const db = ctx.db().db;
        const id = Number(idRaw);
        const today = ctx.now().toISOString().slice(0, 10);
        const kind = o.expired ? 'expired' : o.assigned ? 'assigned' : 'bought_back';
        if (kind === 'bought_back' && o.price === undefined)
          throw new UserError('pass --price <buy-back premium>, or --expired / --assigned');
        const r = await closeManualPosition(db, {
          id,
          kind,
          today,
          ...(o.price !== undefined ? { price: o.price } : {}),
          ...(o.date ? { date: o.date } : {}),
          ...(o.fees !== undefined ? { fees: o.fees } : {}),
          ...(o.underlyingClose !== undefined ? { underlyingClose: o.underlyingClose } : {}),
        });
        const inst = await getInstrument(db, r.instrumentId);
        const status = r.status;
        const date = r.date;
        const basis = r.basis;
        const ccy = inst?.currency ?? 'USD';
        ctx.out(
          `position ${id} ${status} on ${date}: realised P&L ${money(r.realizedPnl, ccy)} (${centsToString(Math.round(r.realizedPnl * 100))} ${ccy})${basis ? ' [mtm_at_assignment]' : ''}; ${inst?.symbol ?? ''} is eligible for new recommendations again`,
        );
      },
    );

  pos
    .command('list')
    .description('open positions (or all with --all)')
    .option('--all', 'include closed positions')
    .action(async (o: { all?: boolean }) => {
      const db = ctx.db().db;
      const rows = await db
        .select({ p: positions, i: instruments })
        .from(positions)
        .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
        .where(o.all ? undefined : eq(positions.status, 'open'))
        .orderBy(positions.id);
      if (rows.length === 0) return ctx.out(o.all ? 'no positions' : 'no open positions');
      for (const l of renderTable(
        [
          { header: 'Id', align: 'right' },
          { header: 'Symbol' },
          { header: 'Strike', align: 'right' },
          { header: 'Expiry' },
          { header: 'Qty', align: 'right' },
          { header: 'Premium', align: 'right' },
          { header: 'Opened' },
          { header: 'Status' },
          { header: 'P&L', align: 'right' },
          { header: 'Source' },
        ],
        rows.map(({ p, i }) => [
          String(p.id),
          `${i.market}:${i.symbol}`,
          num2(Number(p.strike), 2),
          p.expiry,
          String(p.quantity),
          num2(Number(p.openPrice), 3),
          p.openDate,
          p.status,
          p.realizedPnl === null ? '-' : num2(Number(p.realizedPnl), 2),
          p.source,
        ]),
      )) {
        ctx.out(l);
      }
    });
}
