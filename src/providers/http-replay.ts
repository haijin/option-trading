/**
 * Record/replay of HTTP responses for provider contract tests and the offline e2e suite.
 *
 * Replay NEVER falls through to the network: a request with no recorded response throws `ReplayMissError`, so CI can
 * not call Yahoo or Stooq by accident. Authentication handshakes (cookie page, crumb) are not recorded; replay answers
 * them with harmless canned responses.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DROPPED_PARAMS = new Set([
  'crumb',
  'period1',
  'period2',
  'lang',
  'region',
  'corsDomain',
  'formatted',
  'merge',
  'padTimeSeries',
  '.tsrc',
  'includePrePost',
  'd1',
  'd2',
]);

/** Host-insensitive, time-insensitive identity of a request (query1 vs query2, period1/period2, crumb are ignored). */
export function requestKey(method: string, rawUrl: string): string {
  const u = new URL(rawUrl);
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !DROPPED_PARAMS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Node 24 writes "^" in a URL path as %5E, Node 22 leaves it raw; the recorded fixtures use %5E (index symbols such as ^VIX).
  const path = u.pathname.replace(/\^/g, '%5E');
  return `${method.toUpperCase()} ${path}?${kept.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

export function fixtureFileName(key: string): string {
  const slug = key
    .replace(/^[A-Z]+ /, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .slice(0, 60);
  return `${slug}_${createHash('sha1').update(key).digest('hex').slice(0, 10)}.json`;
}

interface Recorded {
  key: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
}

function isHandshake(url: URL): boolean {
  return (
    url.hostname === 'finance.yahoo.com' ||
    url.hostname === 'fc.yahoo.com' ||
    url.hostname.endsWith('guce.yahoo.com') ||
    url.hostname.endsWith('consent.yahoo.com') ||
    url.pathname.endsWith('/getcrumb')
  );
}

export class ReplayMissError extends Error {
  constructor(key: string) {
    super(
      `no recorded HTTP fixture for "${key}" (replay never calls the network; record it with scripts/record-fixtures.ts)`,
    );
    this.name = 'ReplayMissError';
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

/** `dirs` are searched in order, so a test can overlay a modified response in a temp directory. */
export function createReplayFetch(dirs: string | string[]): typeof fetch {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return async (input, init) => {
    const rawUrl = requestUrl(input);
    const url = new URL(rawUrl);
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    ).toUpperCase();
    if (isHandshake(url)) {
      if (url.pathname.endsWith('/getcrumb'))
        return new Response('replaycrumb', { status: 200, headers: { 'content-type': 'text/plain' } });
      const h = new Headers({ 'content-type': 'text/html' });
      h.append('set-cookie', 'A1=replaycookie; Domain=.yahoo.com; Path=/; Max-Age=31536000; Secure');
      return new Response('<html></html>', { status: 200, headers: h });
    }
    const key = requestKey(method, rawUrl);
    const name = fixtureFileName(key);
    for (const dir of list) {
      const file = join(dir, name);
      if (existsSync(file)) {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as Recorded;
        return new Response(rec.body, { status: rec.status, headers: { 'content-type': rec.contentType } });
      }
    }
    throw new ReplayMissError(key);
  };
}

/** Wraps a real fetch and stores every non-handshake response under `dir` (used only by scripts/record-fixtures.ts). */
export function createRecordingFetch(real: typeof fetch, dir: string): typeof fetch {
  mkdirSync(dir, { recursive: true });
  return async (input, init) => {
    const rawUrl = requestUrl(input);
    const url = new URL(rawUrl);
    const res = await real(input, init);
    if (isHandshake(url)) return res;
    const body = await res.clone().text();
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = requestKey(method, rawUrl);
    const clean = new URL(rawUrl);
    clean.searchParams.delete('crumb');
    const rec: Recorded = {
      key,
      url: clean.href,
      status: res.status,
      contentType: res.headers.get('content-type') ?? 'application/json',
      body,
    };
    writeFileSync(join(dir, fixtureFileName(key)), JSON.stringify(rec));
    return res;
  };
}

/** Test helper: writes one replayable response (e.g. an overlay that makes a symbol fail). */
export function writeReplayFixture(
  dir: string,
  r: { method?: string; url: string; status?: number; contentType?: string; body: string },
): void {
  mkdirSync(dir, { recursive: true });
  const key = requestKey(r.method ?? 'GET', r.url);
  const rec: Recorded = {
    key,
    url: r.url,
    status: r.status ?? 200,
    contentType: r.contentType ?? 'application/json',
    body: r.body,
  };
  writeFileSync(join(dir, fixtureFileName(key)), JSON.stringify(rec));
}
