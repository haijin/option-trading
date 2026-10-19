import type { Command } from 'commander';
import { UserError } from '../../core/util';
import { listLots, sellLot } from '../../db/lots';
import { runIngestJob, runMarkJob, runScanJob } from '../../jobs/jobs';
import { notifierFromEnv } from '../../jobs/notifier';
import { JOB_DEFS } from '../../jobs/scheduler';
import type { CliContext } from '../context';
import { money, num2, pct, renderTable } from '../table';
import { parseDateArg, parsePositive } from './common';

/** Phase 3 commands: daily marks, the wheel (stock lots) and running a scheduled job by hand. */
export function registerOps(program: Command, ctx: CliContext): void {
  const deps = () => ({
    ctx,
    notifier: notifierFromEnv(process.env, ctx.fetch, (l) => ctx.err(l)),
    log: (l: string) => ctx.out(l),
  });

  const pos = program.commands.find((c) => c.name() === 'positions');
  if (!pos) throw new Error('registerOps must run after registerData (the positions command group)');
  pos
    .command('mark')
    .description('price every open put (a stored quote, else the model), store the marks and print P&L and alerts')
    .option('--as-of <date>', 'mark as of this date (default: the latest completed session)', parseDateArg)
    .option('--notify', 'push new alerts through the configured channel (Telegram or email)')
    .action(async (o: { asOf?: string; notify?: boolean }) => {
      const d = deps();
      const out = await runMarkJob({ ...d, notifier: o.notify ? d.notifier : null }, o.asOf ? { asOf: o.asOf } : {});
      if (out.status === 'failed') throw new UserError(`mark failed: ${out.detail}`);
      const { latestMarks } = await import('../../db/marks');
      const { listPositionsDetailed } = await import('../../db/app-repos');
      const rows = (await listPositionsDetailed(ctx.db().db)).filter((p) => p.status === 'open');
      const marks = await latestMarks(
        ctx.db().db,
        rows.map((r) => r.id),
      );
      if (rows.length === 0) return ctx.out('no open positions');
      for (const l of renderTable(
        [
          { header: 'Id', align: 'right' },
          { header: 'Symbol' },
          { header: 'Strike', align: 'right' },
          { header: 'Expiry' },
          { header: 'Credit', align: 'right' },
          { header: 'Mark', align: 'right' },
          { header: 'Captured', align: 'right' },
          { header: 'P&L', align: 'right' },
          { header: 'Tier' },
          { header: 'Alerts' },
        ],
        rows.map((p) => {
          const m = marks.get(p.id);
          return [
            String(p.id),
            `${p.instrument.market}:${p.instrument.symbol}`,
            num2(p.strike, 2),
            p.expiry,
            num2(p.openPrice, 3),
            m ? num2(m.mark, 3) : '-',
            m ? pct(m.pctCaptured, 0) : '-',
            m ? money(m.unrealizedPnl, p.instrument.currency) : '-',
            m ? m.tier : 'no mark',
            m ? m.alertCodes.join(',') : '',
          ];
        }),
      ))
        ctx.out(l);
      ctx.out(out.detail);
    });

  // ------------------------------------------------------------------- lots
  const lots = program
    .command('lots')
    .description('shares received from assigned puts (the wheel); the app never sells');
  lots
    .command('list')
    .description('open stock lots (or all with --all)')
    .option('--all', 'include sold lots')
    .action(async (o: { all?: boolean }) => {
      const rows = await listLots(ctx.db().db, o.all ? {} : { status: 'open' });
      if (rows.length === 0) return ctx.out(o.all ? 'no stock lots' : 'no open stock lots');
      for (const l of renderTable(
        [
          { header: 'Id', align: 'right' },
          { header: 'Symbol' },
          { header: 'Shares', align: 'right' },
          { header: 'Basis', align: 'right' },
          { header: 'Effective cost', align: 'right' },
          { header: 'Opened' },
          { header: 'Status' },
          { header: 'Realised', align: 'right' },
        ],
        rows.map((l) => [
          String(l.id),
          `${l.instrument.market}:${l.instrument.symbol}`,
          String(l.shares),
          num2(l.costBasis, 3),
          l.effectiveCost === null ? '-' : num2(l.effectiveCost, 3),
          l.openDate,
          l.status,
          l.realizedPnl === null ? '-' : money(l.realizedPnl, l.instrument.currency),
        ]),
      ))
        ctx.out(l);
    });
  lots
    .command('sell <id>')
    .description('record the sale of a lot you sold in your broker')
    .requiredOption('--price <price>', 'sale price per share', parsePositive)
    .option('--date <date>', 'sale date (default: today)', parseDateArg)
    .option('--fees <amount>', 'total fees', (v) => Number(v))
    .action(async (idRaw: string, o: { price: number; date?: string; fees?: number }) => {
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) throw new UserError('lot id must be a positive integer');
      const r = await sellLot(ctx.db().db, id, {
        price: o.price,
        date: o.date ?? ctx.now().toISOString().slice(0, 10),
        ...(o.fees !== undefined ? { fees: o.fees } : {}),
      });
      ctx.out(`lot ${id} sold: realised ${num2(r.realizedPnl, 2)} (from the assignment-close basis)`);
    });

  // ------------------------------------------------------------------- jobs
  const jobs = program
    .command('jobs')
    .description('the scheduled jobs (run by pg-boss when the app runs with OT_JOBS=on)');
  jobs
    .command('list')
    .description('every job, its schedule and time zone')
    .action(() => {
      for (const l of renderTable(
        [{ header: 'Job' }, { header: 'Cron' }, { header: 'Time zone' }, { header: 'What it does' }],
        JOB_DEFS.map((j) => [j.name, j.cron ?? 'queued by another job', j.tz, j.description]),
      ))
        ctx.out(l);
    });
  jobs
    .command('run <name>')
    .description('run one job now: ingest, mark-positions, daily-scan, or any name from `jobs list`')
    .action(async (name: string) => {
      const def = JOB_DEFS.find((j) => j.name === name);
      const d = deps();
      const out = def
        ? await def.run(d)
        : name === 'ingest'
          ? await runIngestJob(d)
          : name === 'mark-positions'
            ? await runMarkJob(d)
            : name === 'daily-scan'
              ? await runScanJob(d)
              : null;
      if (!out) throw new UserError(`unknown job "${name}"; see \`jobs list\``);
      if (out.status === 'failed') throw new UserError(`${name} failed: ${out.detail}`);
    });
}
