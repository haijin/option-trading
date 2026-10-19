import type { Command } from 'commander';
import { buildRemindersView } from '../../db/reminders';
import { notifierFromEnv } from '../../jobs/notifier';
import type { CliContext } from '../context';

function hkToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

const LEVEL_ICON: Record<string, string> = { fail: '✗', warn: '!', info: '·' };

export function registerReminders(program: Command, ctx: CliContext): void {
  program
    .command('reminders')
    .description('print upcoming results dates, ex-dividends, expiries and position alerts')
    .option('--days <n>', 'look-ahead window in days (default: 30)', '30')
    .option('--notify', "send today's reminders via the configured push channel (OT_NOTIFY_*)")
    .action(async (opts: { days: string; notify?: boolean }) => {
      const days = Math.min(90, Math.max(1, Number.parseInt(opts.days, 10)));
      const today = hkToday(ctx.now());
      const db = ctx.db().db;
      const view = await buildRemindersView(db, today, days);
      const all = [...view.today, ...view.upcoming];
      if (all.length === 0) {
        ctx.out(`No reminders in the next ${days} days (${today}).`);
      } else {
        ctx.out(`Reminders as of ${today}:`);
        if (view.today.length > 0) {
          ctx.out('');
          ctx.out('Today');
          for (const item of view.today) ctx.out(`  ${LEVEL_ICON[item.level] ?? '·'}  ${item.title}  —  ${item.why}`);
        }
        if (view.upcoming.length > 0) {
          ctx.out('');
          ctx.out('Upcoming');
          for (const item of view.upcoming)
            ctx.out(`  ${item.date}  ${LEVEL_ICON[item.level] ?? '·'}  ${item.title}  —  ${item.why}`);
        }
      }
      if (opts.notify) {
        const log = (l: string): void => ctx.err(l);
        const notifier = notifierFromEnv(process.env, ctx.fetch, log);
        if (!notifier) {
          ctx.err('No push channel configured (set OT_NOTIFY_KIND and related env vars).');
        } else if (view.today.length > 0) {
          await notifier.send({
            title: `Option Trading: ${view.today.length} reminder${view.today.length === 1 ? '' : 's'} (${today})`,
            lines: view.today.map((i) => `${i.title}: ${i.why}`),
          });
          ctx.out(`Sent ${view.today.length} reminder${view.today.length === 1 ? '' : 's'} via ${notifier.kind}.`);
        } else {
          ctx.out('Nothing due today — nothing sent.');
        }
      }
    });
}
