/**
 * Records the live HTTP responses the e2e suite replays (tests/fixtures/http/yahoo-2026-10-09/).
 * It drives the real CLI against a throwaway database through a recording fetch, so the recorded requests are exactly
 * the ones `ingest` makes. Network is needed; CI never runs this. Usage: pnpm tsx scripts/record-fixtures.ts [dir]
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { createContext } from '../src/cli/context';
import '../src/cli/commands';
import { runCli } from '../src/cli/program';
import { connect } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrate';
import { createRecordingFetch } from '../src/providers/http-replay';

const UNIVERSE = [
  ['AAPL', 'US'],
  ['MSFT', 'US'],
  ['NVDA', 'US'],
  ['JPM', 'US'],
  ['XOM', 'US'],
  ['0700', 'HK'],
  ['0005', 'HK'],
  ['0941', 'HK'],
  ['0016', 'HK'],
  ['2318', 'HK'],
] as const;

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join('tests', 'fixtures', 'http', 'yahoo-recorded');
  const base = process.env.PG_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('PG_ADMIN_URL or DATABASE_URL required');
  const name = `ot_rec_${randomBytes(4).toString('hex')}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${name}`;
  const h = connect(dbUrl.toString());
  await migrateDatabase(h);
  await h.close();
  try {
    const ctx = createContext({ databaseUrl: dbUrl.toString(), fetch: createRecordingFetch(fetch, dir) });
    const run = async (args: string[]) => {
      const code = await runCli(args, ctx);
      if (code !== 0) throw new Error(`command failed (${code}): ${args.join(' ')}`);
    };
    await run(['settings', 'set', 'equity', '2000000', '--base', 'HKD']);
    for (const [s, m] of UNIVERSE) await run(['watchlist', 'add', s, m]);
    const code = await runCli(['ingest', '--all'], ctx);
    console.log(`ingest exit code ${code}; fixtures in ${dir}`);
  } finally {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
