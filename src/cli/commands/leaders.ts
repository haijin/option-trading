import type { Command } from 'commander';
import type { Market } from '../../core/calendar';
import { UserError } from '../../core/util';
import { leadersAsOf, runLeadersScan, yahooEarningsPort } from '../../jobs/leaders-scan';
import { runUniverseRefreshJob, seedUniverse } from '../../jobs/universe-jobs';
import type { LeaderCandidateView, LeaderStage, LeadersView } from '../../leaders/types';
import { buildLeadersRecord, buildLeadersView } from '../../leaders/view';
import { runIngest } from '../../providers/ingest';
import { ingestUniverseBars } from '../../providers/universe/ingest';
import { YahooClient } from '../../providers/yahoo/client';
import type { CliContext } from '../context';
import { num2, renderTable } from '../table';
import { parseMarket, requireInstrument } from './common';

const STAGES: LeaderStage[] = ['screened', 'leaders', 'consolidating', 'shortlist'];

function parseStage(raw: string): LeaderStage {
  if (!STAGES.includes(raw as LeaderStage)) throw new UserError(`stage must be one of ${STAGES.join(', ')}`);
  return raw as LeaderStage;
}

const signed = (x: number | null, d = 0): string =>
  x === null ? '-' : `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(d)}%`;

/** The list as a terminal table: what `/leaders` prints. */
export function renderLeaders(view: LeadersView): string[] {
  const out: string[] = [];
  if (view.asOf === null) {
    return ['no scan yet: run `pnpm cli leaders universe --seed` once, then `pnpm cli leaders scan`'];
  }
  const f = view.funnel;
  out.push(
    `Leaders · ${view.asOf}${view.isArchive ? ' (archive)' : ''}${view.regime ? ` · ${view.regime.line} · ${view.regime.postureText}` : ''}`,
  );
  out.push(
    `Funnel: ${f.screened.total} screened (US ${f.screened.US} / HK ${f.screened.HK}) → ${f.leaders} leaders → ${f.consolidating} consolidating → ${f.shortlist} listed (${f.setup} Setup / ${f.watch} Watch) · ${f.newToday} new · ${f.dropped} dropped`,
  );
  if (view.status.stale)
    out.push('stale: the newest run is more than one trading day old; run `pnpm cli leaders scan`');
  if (view.status.equityMissing)
    out.push('equity is not set: plans show no share counts (`pnpm cli settings set equity <amount> --base HKD`)');
  if (view.brief) out.push(view.brief.lead);
  if (view.candidates.length > 0) {
    out.push('');
    const rows = view.candidates.map((c: LeaderCandidateView) => [
      c.rank === null ? '-' : String(c.rank),
      c.market,
      c.symbol,
      c.state,
      num2(c.score, 1),
      c.price === null ? '-' : num2(c.price, 2),
      c.plan ? `${c.plan.stopPct.toFixed(1)}%` : c.stopPct === null ? '-' : `(${c.stopPct.toFixed(1)}%)`,
      signed(c.ret3mPct),
      c.flags
        .filter((x) => x.level !== 'ok')
        .map((x) => x.text)
        .join('; '),
    ]);
    for (const l of renderTable(
      [
        { header: '#', align: 'right' },
        { header: 'Mkt' },
        { header: 'Symbol' },
        { header: 'State' },
        { header: 'Score', align: 'right' },
        { header: 'Price', align: 'right' },
        { header: 'Stop', align: 'right' },
        { header: '3m', align: 'right' },
        { header: 'Flags' },
      ],
      rows,
    ))
      out.push(l);
    for (const c of view.candidates.filter((x) => x.state === 'setup')) {
      out.push('');
      out.push(`${c.symbol} (${c.market}): ${c.name ?? ''}`);
      for (const w of c.why) out.push(`  ${w.level === 'pass' ? '+' : w.level === 'warn' ? '!' : '·'} ${w.text}`);
      if (c.plan)
        out.push(
          `  plan: entry ${c.plan.entry}, stop ${c.plan.stop} (${c.plan.stopPct.toFixed(1)}%), 3R ${c.plan.r3}, 5R ${c.plan.r5}${c.plan.shares === null ? '' : `, ${c.plan.shares} shares (risk ${c.plan.riskAtStop})`}`,
        );
      if (c.brief) out.push(`  ${c.brief}`);
    }
  } else if (view.stage !== 'shortlist' && view.stageNote) out.push(view.stageNote);
  else if (view.candidates.length === 0) out.push('nothing on the list today');
  if (view.dropped.length > 0) {
    out.push('');
    out.push('Dropped since the last run:');
    for (const d of view.dropped) out.push(`  ${d.symbol} (${d.market}): ${d.reason}`);
  }
  out.push('');
  out.push(
    'Investigate a name with `/leaders investigate <symbol>`. Decision support only: the app never places orders.',
  );
  return out;
}

/** The Leaders page in the terminal: the stored list, and an in-process scan of both markets. */
export function registerLeaders(program: Command, ctx: CliContext): void {
  const leaders = program
    .command('leaders')
    .description(
      'the daily pullback-buy shortlist of HK + US market leaders (the Leaders page), from the latest stored runs',
    )
    .option('--json', 'print the Leaders view as JSON (the same shape as GET /api/leaders)')
    .option('--market <market>', 'only this market in the listing: US or HK', parseMarket)
    .option('--stage <stage>', `list the names that stopped at a funnel stage: ${STAGES.join(', ')}`, parseStage)
    .option('--date <date>', 'show an archived day (YYYY-MM-DD)')
    .action(async (o: { json?: boolean; market?: Market; stage?: LeaderStage; date?: string }) => {
      const view = await buildLeadersView(ctx.db().db, {
        now: ctx.now(),
        ...(o.date ? { date: o.date } : {}),
        ...(o.stage ? { stage: o.stage } : {}),
      });
      const shown: LeadersView = o.market
        ? { ...view, candidates: view.candidates.filter((c) => c.market === o.market) }
        : view;
      if (o.json)
        return ctx.out(
          JSON.stringify({ stale: shown.status.stale, ...shown, record: await buildLeadersRecord(ctx.db().db, '60') }),
        );
      for (const l of renderLeaders(shown)) ctx.out(l);
    });

  leaders
    .command('scan')
    .description(
      'fetch the universe bars (a warm run makes no call) and scan both markets in this process, then print the list',
    )
    .option('--json', 'print the Leaders view as JSON; progress goes to stderr')
    .option('--no-ingest', 'scan the bars already stored, without fetching')
    .option('--market <market>', 'scan only this market: US or HK', parseMarket)
    .action(async (_own: unknown, cmd: Command) => {
      // `--json` and `--market` also belong to the parent command, which takes them first: read the merged options
      const o = cmd.optsWithGlobals() as { json?: boolean; ingest?: boolean; market?: Market };
      const say = o.json ? (l: string) => ctx.err(l) : (l: string) => ctx.out(l);
      const db = ctx.db().db;
      const markets: Market[] = o.market ? [o.market] : ['HK', 'US'];
      for (const market of markets) {
        const asOf = leadersAsOf(market, ctx.now());
        if (o.ingest !== false) {
          const t0 = performance.now();
          const res = await ingestUniverseBars(
            { db, client: new YahooClient({ fetch: ctx.fetch }), now: ctx.now(), log: (l) => ctx.err(l) },
            { market, asOf },
          );
          say(
            `${market} bars to ${asOf}: ${res.names} names, ${res.fetched} fetched, ${res.skipped} up to date, ${res.failed} failed, ${res.notFound} not found, ${res.rows} rows in ${Math.round((performance.now() - t0) / 1000)} s`,
          );
          for (const f of res.failures.slice(0, 5)) say(`  ${f}`);
        }
        const out = await runLeadersScan(
          {
            db,
            now: ctx.now,
            log: (l) => ctx.err(l),
            earnings: yahooEarningsPort(new YahooClient({ fetch: ctx.fetch })),
          },
          { market, asOf },
        );
        say(
          `${market} ${out.asOf}: ${out.names} names, ${out.screened} screened, ${out.leaders} leaders, ${out.consolidating} consolidating, ${out.shortlisted} listed (${out.setups} setup / ${out.watches} watch), ${out.status}, ${(out.durationMs / 1000).toFixed(1)} s`,
        );
      }
      const view = await buildLeadersView(db, { now: ctx.now() });
      if (o.json)
        return ctx.out(
          JSON.stringify({ stale: view.status.stale, ...view, record: await buildLeadersRecord(db, '60') }),
        );
      for (const l of renderLeaders(view)) ctx.out(l);
    });

  leaders
    .command('statements <symbol>')
    .description(
      'fetch the financial statements of one name (about 30 s), so the quality screen can run on a name that is not on the watchlist',
    )
    .option('--market <market>', 'US or HK (default: from the symbol)', parseMarket)
    .action(async (symbol: string, _own: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals() as { market?: Market };
      const inst = await requireInstrument(ctx, symbol, o.market);
      const out = await runIngest(
        {
          db: ctx.db().db,
          client: new YahooClient({ fetch: ctx.fetch }),
          fetch: ctx.fetch,
          now: ctx.now(),
          dataDir: ctx.dataDir,
          readFile: (p) => ctx.readFile(p),
          fileExists: (p) => ctx.fileExists(p),
          log: (l) => ctx.err(l),
        },
        { steps: ['profile', 'fundamentals'], names: [inst] },
      );
      for (const i of out.items)
        ctx.out(`${i.status === 'ok' ? 'ok     ' : 'FAILED '} ${i.step.padEnd(12)} ${i.detail}`);
      if (out.failed > 0) throw new UserError('the statements could not be fetched');
    });

  leaders
    .command('universe')
    .description(
      'load the Leaders universe: constituents of the S&P 500, Nasdaq-100, S&P 400 and the Hang Seng indexes',
    )
    .option('--seed', 'from data/universe-us.csv and data/universe-hk.csv, no network')
    .action(async (o: { seed?: boolean }) => {
      const deps = { ctx, notifier: null, log: (l: string) => ctx.out(l) };
      if (o.seed) {
        const r = await seedUniverse(
          ctx.db().db,
          ctx.dataDir,
          (p) => ctx.readFile(p),
          ctx.now().toISOString().slice(0, 10),
        );
        for (const f of r.files) ctx.out(`${f.file}: ${f.members} memberships`);
        for (const m of r.missing) ctx.out(`${m}: not found`);
        ctx.out(`${r.sync.instruments} names, +${r.sync.added} added, ${r.sync.reactivated} reactivated`);
        return;
      }
      const out = await runUniverseRefreshJob(deps);
      ctx.out(`${out.status}: ${out.detail}`);
      if (out.status === 'failed') throw new UserError('the universe refresh failed; try `leaders universe --seed`');
    });
}
