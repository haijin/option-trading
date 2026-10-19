import type { CliContext } from '../cli/context';
import type { Db } from '../db/client';
import type { AuthConfig } from './auth/config';
import type { JournalAiConfig } from './journal-config';
import type { LeadersConfig } from './leaders/config';
import type { NewsConfig } from './news/config';
import type { AskConfig } from './research/ask-config';
import type { SkillExecutor } from './research/executor';

/** Where the AI skills come from and how they are run (see src/server/research). */
export interface ResearchConfig {
  /** Invest-agent repository root; the skill prompts are `<root>/skills/<id>.md`. */
  root: string;
  executor: SkillExecutor;
  executorKind: 'claude-cli' | 'fake' | 'none';
  python: string | null;
  claudeCli: string | null;
  maxBudgetUsd: number;
  model: string | null;
}

/** Everything the server needs from the outside world, injectable so the end-to-end tests run offline and in-process. */
export interface ServerDeps {
  db: Db;
  now(): Date;
  fetch: typeof fetch;
  dataDir: string;
  reportsDir: string;
  /** Built UI directory, or null to serve the API only. */
  webDir: string | null;
  version: string;
  database: { name: string; host: string; port: number };
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  research: ResearchConfig;
  /** News model settings over the environment defaults (tests set a tiny budget); omitted in the real server. */
  news?: Partial<NewsConfig>;
  /** Sign-in settings; null turns the login requirement off (OT_AUTH=off, and the offline end-to-end tests). */
  auth: AuthConfig | null;
  /** Overrides for the journal's AI rewrite (model, dollar cap, daily runs, timeout); unset values come from the environment. */
  journal?: Partial<JournalAiConfig>;
  /** Overrides for the Leaders brief (model, dollar caps, timeout); unset values come from the environment. */
  leaders?: Partial<LeadersConfig>;
  /** Overrides for the Ask chat (model, per-answer and daily caps, timeout); unset values come from the environment. */
  ask?: Partial<AskConfig>;
  log(line: string): void;
}

/** A CliContext view of the server dependencies, so the existing pipeline and importers are reused as they are. */
export function cliContextOf(deps: ServerDeps): CliContext {
  const noop = (): void => {};
  return {
    out: noop,
    err: noop,
    now: deps.now,
    db: () => ({ db: deps.db, pool: undefined as never, close: async () => {} }),
    fetch: deps.fetch,
    dataDir: deps.dataDir,
    readFile: deps.readFile,
    fileExists: deps.fileExists,
  };
}
