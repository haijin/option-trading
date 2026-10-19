/**
 * Stateful mock of the local sell-put API (src/server/api-types.ts) for developing the web UI without the real server.
 *
 *   pnpm exec tsx web/mock/server.ts          listens on http://127.0.0.1:4318
 *   pnpm demo                                 this mock plus Vite with API_TARGET pointing at it (UI on :5173)
 *
 * Environment
 *   MOCK_PORT=4318            port to listen on
 *   MOCK_EQUITY_UNSET=1       start with no equity: /api/scan fails with 409 equity_not_set until PUT /api/settings sets it
 *   MOCK_LATENCY_MS=N         fixed delay per request in ms (a scan takes 10x); 0 disables every delay.
 *                             Default: random 60-200 ms, and 1500-2500 ms for a scan
 *   MOCK_SKILL_UNAVAILABLE=1  mark investment-research as unavailable in GET /api/skills
 *   MOCK_LOG=1                print one line per request
 *   MOCK_LEADERS=...          Leaders page variants (comma-separated): empty, watch_only, stale, brief (see web/mock/leaders.ts)
 *
 * All state lives in memory and resets when the process restarts. Names starting with ZZ simulate "the provider has no
 * data": their ingest fails and their AI research runs fail at step 3.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ApiErrorBody } from '../../src/server/api-types';
import { seedIngest, settleIngest } from './ingest';
import { advanceRuns, seedRuns } from './research';
import { type RawReply, ROUTES, type Route } from './routes';
import { HttpError, randBetween, sleep } from './util';

const PORT = Number(process.env.MOCK_PORT ?? 4318);
const HOST = '127.0.0.1';
const MAX_BODY = 2_000_000;
/** The one multipart endpoint is the journal's image upload: 8 MB of image plus the form around it. */
const MAX_UPLOAD = 9_000_000;

// ------------------------------------------------------------------------------------------------ latency
function delayFor(scan: boolean): number {
  const text = process.env.MOCK_LATENCY_MS;
  if (text === '0') return 0;
  const fixed = text !== undefined && text !== '' && Number.isFinite(Number(text)) ? Math.max(0, Number(text)) : null;
  if (scan) return Math.round(fixed !== null ? Math.min(fixed * 10, 5000) : randBetween(1500, 2500));
  return Math.round(fixed ?? randBetween(60, 200));
}

// ------------------------------------------------------------------------------------------------ routing
interface Match {
  route: Route;
  params: Record<string, string>;
}

const compiled = ROUTES.map((route) => {
  const names: string[] = [];
  const source = route.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, names, regex: new RegExp(`^${source}/?$`) };
});

function match(method: string, path: string): { match: Match | null; pathKnown: boolean } {
  let pathKnown = false;
  for (const { route, names, regex } of compiled) {
    const m = regex.exec(path);
    if (!m) continue;
    pathKnown = true;
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { match: { route, params }, pathKnown };
  }
  return { match: null, pathKnown };
}

// ------------------------------------------------------------------------------------------------ request / response
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY)
      throw new HttpError(413, 'payload_too_large', `The request body is larger than ${MAX_BODY / 1_000_000} MB.`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(
      400,
      'bad_json',
      `The request body is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}.`,
    );
  }
}

/** The raw bytes of a multipart request, up to MAX_UPLOAD (the rest is read and dropped, then answered 413). */
async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size <= MAX_UPLOAD) chunks.push(buf);
  }
  if (size > MAX_UPLOAD) throw new HttpError(413, 'file_too_large', 'Images are limited to 8 MB.');
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

function sendError(res: ServerResponse, err: HttpError): void {
  const body: ApiErrorBody = {
    error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
  };
  send(res, err.status, 'application/json; charset=utf-8', JSON.stringify(body), err.headers);
}

const isRaw = (x: unknown): x is RawReply =>
  typeof x === 'object' && x !== null && (x as { raw?: unknown }).raw === true;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  let status = 200;
  try {
    const found = url.pathname.startsWith('/api') ? match(method, url.pathname) : { match: null, pathKnown: false };
    if (!found.match) {
      if (found.pathKnown) {
        const allowed = compiled.filter((c) => c.regex.test(url.pathname)).map((c) => c.route.method);
        throw new HttpError(
          405,
          'method_not_allowed',
          `${method} is not supported here: use ${allowed.join(', ')}.`,
          undefined,
          { Allow: allowed.join(', ') },
        );
      }
      throw new HttpError(404, 'not_found', `No such endpoint: ${method} ${url.pathname}`);
    }
    const { route, params } = found.match;
    let body: unknown;
    const contentType = req.headers['content-type'] ?? '';
    if (
      method === 'POST' &&
      url.pathname === '/api/journal/assets' &&
      contentType.toLowerCase().startsWith('multipart/form-data')
    ) {
      body = { multipart: true, contentType, bytes: await readRaw(req) };
    } else if (method !== 'GET') {
      const type = contentType;
      if (!/^application\/json\s*(;.*)?$/i.test(type)) {
        req.resume();
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Writes must send Content-Type: application/json (got ${type === '' ? 'none' : type}).`,
        );
      }
      body = await readBody(req);
    }
    const delayMs = delayFor(route.kind === 'scan');
    if (delayMs > 0) await sleep(delayMs);
    settleIngest();
    advanceRuns();
    const reply = route.handler({ params, query: url.searchParams, body, delayMs });
    if (isRaw(reply)) send(res, status, reply.contentType, reply.body, reply.headers);
    else sendJson(res, status, reply);
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      sendError(res, e);
    } else {
      status = 500;
      console.error(e);
      sendError(
        res,
        new HttpError(500, 'internal_error', e instanceof Error ? e.message : 'Unexpected error in the mock server.'),
      );
    }
  }
  if (process.env.MOCK_LOG === '1')
    console.log(`${method} ${url.pathname}${url.search} -> ${status} (${Date.now() - started} ms)`);
}

// ------------------------------------------------------------------------------------------------ start
seedIngest();
seedRuns();
const server = createServer((req, res) => {
  void handle(req, res);
});
server.listen(PORT, HOST, () => {
  const equity = process.env.MOCK_EQUITY_UNSET === '1' ? 'UNSET' : 'set';
  const latency = process.env.MOCK_LATENCY_MS ?? 'random';
  console.log(
    `mock API listening on http://${HOST}:${PORT} (equity ${equity}, latency ${latency}, skills ${process.env.MOCK_SKILL_UNAVAILABLE === '1' ? 'one unavailable' : 'all available'})`,
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
