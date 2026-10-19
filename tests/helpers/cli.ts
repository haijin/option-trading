import '../../src/cli/commands';
import { createContext } from '../../src/cli/context';
import { runCli } from '../../src/cli/program';
import { createReplayFetch } from '../../src/providers/http-replay';

export const HTTP_BASE = 'tests/fixtures/http/yahoo-recorded';
/** The recordings were taken on Friday 2026-10-09 after the US close; "now" is the following Saturday. */
export const RECORDED_NOW = new Date('2026-10-10T08:00:00Z');
export const RECORDED_AS_OF = '2026-10-09';

export interface CliHarness {
  run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
}

/** Runs CLI commands in-process against one database with replayed HTTP (never the network). */
export function cliHarness(
  databaseUrl: string,
  opts: { replayDirs?: string[]; now?: Date; dataDir?: string } = {},
): CliHarness {
  return {
    async run(args) {
      const out: string[] = [];
      const err: string[] = [];
      const ctx = createContext({
        databaseUrl,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        now: () => opts.now ?? RECORDED_NOW,
        fetch: createReplayFetch(opts.replayDirs ?? [HTTP_BASE]),
        ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      });
      const code = await runCli(args, ctx);
      return { code, out, err };
    },
  };
}
