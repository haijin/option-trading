import { appUsers } from '../../src/db/schema';
import type { JournalDocJson, JournalEntryInput } from '../../src/server/api-types';
import { SESSION_TTL_MS } from '../../src/server/auth/config';
import { newToken } from '../../src/server/auth/http';
import { AuthStore } from '../../src/server/auth/store';
import type { AppCall, TestApp } from './app';
import type { TestDb } from './test-db';

export interface TestUser {
  id: string;
  username: string;
  /** A Cookie header value for this user's live session. */
  cookie: string;
}

/** Inserts an account and a live session for it (the sign-in flows themselves are covered by auth.test.ts). */
export async function addUser(db: TestDb, username: string, now: Date): Promise<TestUser> {
  const [row] = await db.db
    .insert(appUsers)
    .values({ username, email: `${username}@example.com`, passwordHash: null })
    .returning();
  const token = newToken();
  await new AuthStore(db.db).createSession(token, (row as { id: string }).id, 'password', now, SESSION_TTL_MS);
  return { id: (row as { id: string }).id, username, cookie: `ot_session=${token}` };
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** A tiny HTTP client over `app.inject` that can carry a session cookie and send DELETE. */
export function journalClient(t: TestApp, cookie?: string) {
  const call = async (
    method: Method,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<AppCall> => {
    const res = await t.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        host: '127.0.0.1:4317',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
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
  /** POSTs one file as multipart/form-data, the way a browser's FormData does. `raw` returns the unparsed response (binary). */
  const upload = async (
    bytes: Buffer,
    filename = 'screenshot.png',
    opts: { url?: string; headers?: Record<string, string>; field?: string; fileType?: string } = {},
  ): Promise<AppCall> => {
    const boundary = `----otboundary${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${filename}"\r\nContent-Type: ${opts.fileType ?? 'image/png'}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await t.app.inject({
      method: 'POST',
      url: opts.url ?? '/api/journal/assets',
      payload: Buffer.concat([head, bytes, tail]),
      headers: {
        host: '127.0.0.1:4317',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(cookie ? { cookie } : {}),
        ...opts.headers,
      },
    });
    let json: unknown = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      // not JSON
    }
    return { status: res.statusCode, json, text: res.body, headers: res.headers as Record<string, unknown> };
  };
  /** GET that keeps the raw bytes of the answer (an image). */
  const bytes = async (url: string, headers: Record<string, string> = {}) => {
    const res = await t.app.inject({
      method: 'GET',
      url,
      headers: { host: '127.0.0.1:4317', ...(cookie ? { cookie } : {}), ...headers },
    });
    return { status: res.statusCode, body: res.rawPayload, headers: res.headers as Record<string, unknown> };
  };
  return {
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    put: (url: string, body?: unknown) => call('PUT', url, body),
    post: (url: string, body?: unknown) => call('POST', url, body),
    del: (url: string) => call('DELETE', url),
    call,
    upload,
    bytes,
  };
}

/** A document with one figure (and optionally text) for an uploaded image. */
export const figureDoc = (assetId: string, caption: string | null = 'Tencent 1D', text = 'Chart:'): JournalDocJson => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    { type: 'figure', attrs: { assetId, caption } },
  ],
});

// ------------------------------------------------------------------------------------------------ documents
const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

/** A document of one paragraph. */
export const paragraphDoc = (t: string): JournalDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [text(t)] }],
});

/** A paragraph that mentions a stock with a mark. */
export const mentionDoc = (before: string, market: 'US' | 'HK', symbol: string, label: string): JournalDocJson => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [text(`${before} `), text(label, [{ type: 'stockMention', attrs: { market, symbol } }])],
    },
  ],
});

export const entryInput = (doc: JournalDocJson, over: Partial<JournalEntryInput> = {}): JournalEntryInput => ({
  title: null,
  template: null,
  marketView: 'neutral',
  tags: [],
  doc,
  revisionNo: null,
  ...over,
});

/** A second, later session for an existing user (sessions expire after 30 days, which a test that moves the clock may pass). */
export async function newSession(db: TestDb, userId: string, now: Date): Promise<string> {
  const token = newToken();
  await new AuthStore(db.db).createSession(token, userId, 'password', now, SESSION_TTL_MS);
  return `ot_session=${token}`;
}
