import 'dotenv/config';
import { createContext } from './context';
import './commands';
import { runCli } from './program';

/**
 * Test/CI hooks (documented in README): OT_NOW pins the clock, OT_HTTP_REPLAY_DIR replays recorded HTTP fixtures
 * instead of calling Yahoo or Stooq.
 */
async function main(): Promise<void> {
  const { replayFetchFromEnv } = await import('./replay');
  const now = process.env.OT_NOW ? () => new Date(process.env.OT_NOW as string) : undefined;
  const ctx = createContext({ now, fetch: replayFetchFromEnv() });
  const code = await runCli(process.argv.slice(2), ctx);
  process.exit(code);
}

main();
