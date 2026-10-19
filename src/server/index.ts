/** `pnpm app:server` (normally started by `pnpm app`): the local API and web UI on http://127.0.0.1:3004. */
import 'dotenv/config';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { DEFAULT_DATA_DIR } from '../cli/context';
import { systemClock } from '../core/util';
import { connect, databaseUrl } from '../db/client';
import { notifierFromEnv } from '../jobs/notifier';
import { type Scheduler, startScheduler } from '../jobs/scheduler';
import { buildApp } from './app';
import { authConfigFromEnv } from './auth/config';
import { cliContextOf, type ResearchConfig, type ServerDeps } from './deps';
import { detectClaude, detectPython, investAgentRoot } from './research/env';
import { createClaudeCliExecutor, FakeExecutor, type SkillExecutor } from './research/executor';

const DEFAULT_PORT = 3004;
const REPO = fileURLToPath(new URL('../..', import.meta.url));

function researchConfig(env: NodeJS.ProcessEnv): ResearchConfig {
  const claude = detectClaude(env);
  const wanted = (env.OT_SKILL_EXECUTOR ?? 'auto').toLowerCase();
  let executor: SkillExecutor | null = null;
  let kind: ResearchConfig['executorKind'] = 'none';
  if (wanted === 'fake') {
    executor = new FakeExecutor({ delayMs: 400, steps: 5 });
    kind = 'fake';
  } else if (wanted !== 'none' && claude) {
    executor = createClaudeCliExecutor(claude);
    kind = 'claude-cli';
  }
  return {
    root: investAgentRoot(env),
    executor: executor ?? createClaudeCliExecutor('claude'),
    executorKind: kind,
    python: detectPython(env),
    claudeCli: claude,
    maxBudgetUsd: Number(env.OT_SKILL_MAX_BUDGET_USD ?? 5) || 5,
    model: env.OT_SKILL_MODEL?.trim() || null,
  };
}

function signInSummary(auth: ReturnType<typeof authConfigFromEnv>, env: NodeJS.ProcessEnv): string {
  if (!auth)
    return `Sign-in: OFF (OT_AUTH=off)${env.APP_URL ? '; APP_URL is ignored while the login is off' : ''}. Anyone who can reach this port can use the app.`;
  const via = [
    'password',
    auth.google ? 'Google' : 'Google (not set up: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)',
    auth.mailer.kind === 'smtp' ? 'email link' : 'email link (links are printed here: no OT_SMTP_URL)',
  ];
  return `Sign-in: on (${via.join(', ')})${auth.publicOrigin ? `; public address ${auth.publicOrigin}` : ''}`;
}

async function main(): Promise<void> {
  const env = process.env;
  const url = new URL(databaseUrl());
  const handle = connect();
  const port = Number(env.OT_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
  const auth = authConfigFromEnv(env, port, (l) => console.error(l));
  if (auth) {
    const present = await handle.db.execute(sql`select to_regclass('public.app_users') as t`);
    if (!present.rows[0]?.t)
      throw new Error(
        'the sign-in tables are missing: run `pnpm db:migrate` first (or set OT_AUTH=off to run without a login)',
      );
  }
  const phase34 = await handle.db.execute(
    sql`select to_regclass('public.stock_lots') as lots,
        (select count(*) from information_schema.columns where table_name = 'backtest_runs' and column_name = 'request') as req`,
  );
  if (!phase34.rows[0]?.lots || Number(phase34.rows[0]?.req) === 0)
    throw new Error('the database is missing the stock-lot and backtest tables: run `pnpm db:migrate` first');
  const deps: ServerDeps = {
    db: handle.db,
    now: systemClock,
    fetch,
    dataDir: DEFAULT_DATA_DIR,
    reportsDir: env.OT_REPORTS_DIR ?? join(REPO, 'reports'),
    webDir: env.OT_WEB_DIR ?? join(REPO, 'web', 'dist'),
    version: JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version as string,
    database: { name: url.pathname.replace(/^\//, ''), host: url.hostname, port: Number(url.port || 5432) },
    readFile: (p) => readFile(p, 'utf8'),
    fileExists: (p) =>
      access(p).then(
        () => true,
        () => false,
      ),
    research: researchConfig(env),
    auth,
    log: (l) => console.error(l),
  };
  const app = await buildApp(deps);
  await app.listen({ host: '0.0.0.0', port });
  console.log(
    `Option Trading is running at http://127.0.0.1:${port}  (database ${deps.database.name} on ${deps.database.host}:${deps.database.port})`,
  );
  console.log(signInSummary(auth, env));
  await app.services.auth?.announceSetup();
  console.log(
    `AI skills: ${deps.research.executorKind}${deps.research.claudeCli ? ` (${deps.research.claudeCli})` : ''}; Invest-agent root ${deps.research.root || 'not set (INVEST_AGENT_ROOT)'}`,
  );
  let scheduler: Scheduler | null = null;
  if ((env.OT_JOBS ?? 'off').toLowerCase() === 'on') {
    const log = (l: string): void => console.error(l);
    const notifier = notifierFromEnv(env, fetch, log);
    scheduler = await startScheduler({
      connectionString: databaseUrl(),
      deps: {
        ctx: cliContextOf(deps),
        notifier,
        log,
        reminders: app.services.reminders.jobPorts(),
        news: app.services.news.jobPorts(),
        leaders: app.services.leaders.jobPorts(),
      },
      extra: {
        'run-backtest': async (data) => app.services.backtests.execute(String(data.runId)),
        'news-refresh': async () => app.services.news.runRefresh(),
        'leaders-refresh': async () => app.services.leaders.runRefresh(),
      },
    });
    app.services.backtests.attachScheduler(scheduler);
    app.services.news.attachScheduler(scheduler);
    app.services.leaders.attachScheduler(scheduler);
    const push = notifier ? `alerts pushed via ${notifier.kind}` : 'no push channel configured';
    console.log(`Scheduled jobs: on (pg-boss; ${push}). Run \`pnpm cli jobs list\` for the schedule.`);
  } else console.log('Scheduled jobs: off (set OT_JOBS=on to run the daily jobs inside this process)');
  const stop = async (): Promise<void> => {
    await scheduler?.stop();
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`could not start: ${(err as Error).message}`);
  process.exit(1);
});
