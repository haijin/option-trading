import { fileURLToPath } from 'node:url';
import { type Clock, systemClock } from '../core/util';
import { connect, type DbHandle } from '../db/client';

/** Everything a command needs from the outside world, injectable so e2e tests run in-process and offline. */
export interface CliContext {
  out(line: string): void;
  err(line: string): void;
  now: Clock;
  /** Lazily opened; closed by `runCli` when the command finishes. */
  db(): DbHandle;
  fetch: typeof fetch;
  /** Directory holding seed CSVs (hk-board-lots.csv, vhsi.csv). */
  dataDir: string;
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
}

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));

export interface ContextOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: Clock;
  databaseUrl?: string;
  fetch?: typeof fetch;
  dataDir?: string;
}

export function createContext(opts: ContextOptions = {}): CliContext & { closeDb(): Promise<void> } {
  let handle: DbHandle | null = null;
  return {
    out: opts.out ?? ((l) => console.log(l)),
    err: opts.err ?? ((l) => console.error(l)),
    now: opts.now ?? systemClock,
    fetch: opts.fetch ?? fetch,
    dataDir: opts.dataDir ?? DEFAULT_DATA_DIR,
    db() {
      if (!handle) handle = connect(opts.databaseUrl);
      return handle;
    },
    async readFile(path: string) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
    async fileExists(path: string) {
      const { access } = await import('node:fs/promises');
      return access(path).then(
        () => true,
        () => false,
      );
    },
    async closeDb() {
      if (handle) await handle.close();
      handle = null;
    },
  };
}
