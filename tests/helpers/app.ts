import { mkdirSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR } from '../../src/cli/context';
import { createReplayFetch } from '../../src/providers/http-replay';
import { buildApp } from '../../src/server/app';
import { LINK_TTL_MS, SESSION_TTL_MS } from '../../src/server/auth/config';
import type { GoogleConfig } from '../../src/server/auth/google';
import type { Mailer, MailMessage } from '../../src/server/auth/mailer';
import type { ServerDeps } from '../../src/server/deps';
import type { JournalAiConfig } from '../../src/server/journal-config';
import type { LeadersConfig } from '../../src/server/leaders/config';
import type { NewsConfig } from '../../src/server/news/config';
import type { AskConfig } from '../../src/server/research/ask-config';
import { FakeExecutor, type SkillExecutor } from '../../src/server/research/executor';
import { SKILLS } from '../../src/server/research/skills';
import { HTTP_BASE, RECORDED_NOW } from './cli';
import type { TestDb } from './test-db';

export interface AppCall {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper returns whatever JSON the endpoint sent
  json: any;
  text: string;
  headers: Record<string, unknown>;
}

export interface TestApp {
  deps: ServerDeps;
  app: Awaited<ReturnType<typeof buildApp>>;
  executor: SkillExecutor;
  reportsDir: string;
  root: string;
  get(url: string, headers?: Record<string, string>): Promise<AppCall>;
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<AppCall>;
  put(url: string, body?: unknown): Promise<AppCall>;
  patch(url: string, body?: unknown): Promise<AppCall>;
  del(url: string): Promise<AppCall>;
  close(): Promise<void>;
}

/** The skill files the research runner reads: tiny stand-ins with the same placeholders as the real Invest-agent prompts. */
export function writeFakeSkills(root: string): void {
  mkdirSync(join(root, 'skills'), { recursive: true });
  for (const s of SKILLS) {
    if (!s.file) continue;
    writeFileSync(
      join(root, 'skills', s.file),
      `# ${s.enName}\n\nAnalyse $ARGUMENTS.\nRun: python3 ~/ai-berkshire/tools/financial_rigor.py verify-valuation\n`,
    );
  }
}

/** A mailer that keeps what it was asked to send, so a test can read the emailed link. */
export class MemoryMailer implements Mailer {
  readonly kind = 'smtp' as const;
  readonly sent: MailMessage[] = [];

  async send(m: MailMessage): Promise<void> {
    this.sent.push(m);
  }

  /** The token in the newest message's link (`.../#/login?token=...`), or null when nothing was sent. */
  lastToken(): string | null {
    const last = this.sent.at(-1);
    return last?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
}

export interface AuthOptions {
  mailer?: Mailer;
  google?: GoogleConfig | null;
  publicOrigin?: string | null;
}

export interface StartOptions {
  tmp: string;
  /** Turns the login on. Without it the server runs open, like the other end-to-end tests. */
  auth?: AuthOptions;
  /** Replaces the replayed Yahoo HTTP: the stand-in for Google's token endpoint in the sign-in tests. */
  fetch?: typeof fetch;
  executor?: SkillExecutor;
  /** News model settings (a tiny budget, OT_AI_AUTO off) over the defaults. */
  news?: Partial<NewsConfig>;
  now?: Date;
  python?: string | null;
  withSkillFiles?: boolean;
  /** A built UI directory to serve at `/`. */
  webDir?: string;
  /** Where the app keeps its data files (journal images). Default: the repository's `data` folder, which tests must not write to. */
  dataDir?: string;
  /** Overrides for the journal's AI rewrite (model, cap, daily runs, timeout). */
  journal?: Partial<JournalAiConfig>;
  /** Overrides for the Leaders brief (model, caps, OT_AI_AUTO). */
  leaders?: Partial<LeadersConfig>;
  /** Overrides for the Ask chat (model, caps, timeout). */
  ask?: Partial<AskConfig>;
}

/** Boots the real server code in-process over a throwaway database, replayed Yahoo HTTP and a fake AI executor. */
export async function startApp(db: TestDb, o: StartOptions): Promise<TestApp> {
  const reportsDir = join(o.tmp, 'reports');
  const root = join(o.tmp, 'invest-agent');
  if (o.withSkillFiles !== false) writeFakeSkills(root);
  const executor = o.executor ?? new FakeExecutor({ steps: 3 });
  const u = new URL(db.url);
  const deps: ServerDeps = {
    db: db.db,
    now: () => o.now ?? RECORDED_NOW,
    fetch: o.fetch ?? createReplayFetch([HTTP_BASE]),
    dataDir: o.dataDir ?? DEFAULT_DATA_DIR,
    reportsDir,
    webDir: o.webDir ?? null,
    version: '0.0.0-test',
    database: { name: u.pathname.slice(1), host: u.hostname, port: Number(u.port || 5432) },
    readFile: (p) => readFile(p, 'utf8'),
    fileExists: (p) =>
      access(p).then(
        () => true,
        () => false,
      ),
    ...(o.news ? { news: o.news } : {}),
    research: {
      root,
      executor,
      executorKind: executor.kind === 'fake' ? 'fake' : 'claude-cli',
      python: o.python === undefined ? 'C:/Python/python.exe' : o.python,
      claudeCli: null,
      maxBudgetUsd: 1,
      model: null,
    },
    ...(o.journal ? { journal: o.journal } : {}),
    ...(o.leaders ? { leaders: o.leaders } : {}),
    ...(o.ask ? { ask: o.ask } : {}),
    auth: o.auth
      ? {
          publicOrigin: o.auth.publicOrigin ?? null,
          localUrl: 'http://127.0.0.1:4317',
          google: o.auth.google ?? null,
          mailer: o.auth.mailer ?? new MemoryMailer(),
          sessionTtlMs: SESSION_TTL_MS,
          linkTtlMs: LINK_TTL_MS,
        }
      : null,
    log: () => {},
  };
  const app = await buildApp(deps);
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<AppCall> => {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        host: '127.0.0.1:4317',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    });
    let json: unknown = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      // text endpoints
    }
    return { status: res.statusCode, json, text: res.body, headers: res.headers as Record<string, unknown> };
  };
  return {
    deps,
    app,
    executor,
    reportsDir,
    root,
    get: (url, headers) => call('GET', url, undefined, headers),
    post: (url, body, headers) => call('POST', url, body, headers),
    put: (url, body) => call('PUT', url, body),
    patch: (url, body) => call('PATCH', url, body),
    del: (url) => call('DELETE', url),
    close: async () => {
      await app.services.research.idle();
      await app.services.leaders.idle();
      await app.services.backtests.idle();
      await app.services.journalAi.idle();
      await app.services.ask.idle();
      await app.services.auth?.idle();
      await app.close();
    },
  };
}

/** Polls an ingest job until it leaves `running`. */
export async function waitIngest(t: TestApp, id: string, timeoutMs = 60_000): Promise<AppCall> {
  const started = Date.now();
  for (;;) {
    const r = await t.get(`/api/ingest/${id}`);
    if (r.json?.status !== 'running') return r;
    if (Date.now() - started > timeoutMs) throw new Error('ingest did not finish in time');
    await new Promise((res) => setTimeout(res, 50));
  }
}
