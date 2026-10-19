import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthSessionView } from '../api-types';
import { ApiError, badRequest } from '../errors';
import { isLoopbackHost } from '../security';
import type { AuthConfig } from './config';
import type { OAuthTransaction } from './google';
import { parseCookies, SESSION_COOKIE, serializeCookie, sessionTokenOf } from './http';
import type { AuthService, RequestInfo, Signed } from './service';

const OAUTH_COOKIE = 'ot_oauth';
const OAUTH_PATH = '/api/auth/google';

/** Headers a reverse proxy or tunnel adds. A request carrying any of them did not come from a browser on this machine. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'via',
  'cf-connecting-ip',
  'cf-ray',
];

const isLoopbackAddress = (a: string | undefined): boolean =>
  a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

/**
 * Who is asking. Behind a proxy every socket address is 127.0.0.1, so the address our own proxy appended (the LAST
 * `X-Forwarded-For` entry; earlier ones are whatever the client claimed) is the best available. With no proxy header it
 * is the socket address. Only used to share out rate limits, never to grant anything.
 */
function callerIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim();
  return (last || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

export function requestInfo(req: FastifyRequest, cfg: AuthConfig): RequestInfo {
  const host = req.headers.host ?? '';
  const isPublic = cfg.publicOrigin !== null && host.toLowerCase() === new URL(cfg.publicOrigin).host.toLowerCase();
  const origin = isPublic && cfg.publicOrigin ? cfg.publicOrigin : `http://${host}`;
  const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  return {
    origin,
    local: !isPublic && isLoopbackHost(host) && !proxied && isLoopbackAddress(req.socket.remoteAddress),
    secure: isPublic && origin.startsWith('https:'),
    ip: callerIp(req),
  };
}

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const loginBody = z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) });
const registerBody = z.object({
  username: z.string().trim().min(1).max(64),
  email,
  password: z.string().max(1024),
  setupCode: z.string().max(64),
});
const emailBody = z.object({ email });
const verifyBody = z.object({ token: z.string().min(20).max(200) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const field = r.error.issues[0]?.path[0];
    const message =
      field === 'email'
        ? 'Enter a valid email address.'
        : r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw badRequest('validation', message, r.error.issues);
  }
  return r.data;
}

/** The session answer when the login requirement is off (OT_AUTH=off): the UI shows the app straight away. */
const DISABLED: AuthSessionView = {
  authRequired: false,
  user: null,
  setupRequired: false,
  canSetup: false,
  localUrl: '',
  providers: { password: true, google: false, emailLink: true, emailDelivery: 'console' },
};

function setSession(reply: FastifyReply, signed: Signed, info: RequestInfo, ttlMs: number): void {
  reply.header(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, signed.token, { maxAge: ttlMs / 1000, secure: info.secure }),
  );
}

/**
 * The gate: a hook for the data routes, attached to the routes themselves (see app.ts). It must never look at the URL:
 * Fastify routes on the decoded path (`/%61pi/x` is `/api/x`; an absolute-form request line loses its host), so any
 * test of the raw string can disagree with the router.
 */
export function requireSession(auth: AuthService) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!(await auth.userForCookie(req.headers.cookie)))
      throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  };
}

/**
 * The public login endpoints. `auth === null` means the login requirement is off: only the session probe is registered,
 * and it says so.
 */
export function registerAuth(app: FastifyInstance, auth: AuthService | null): void {
  if (!auth) {
    app.get('/api/auth/session', async () => DISABLED);
    return;
  }
  const cfg = auth.cfg;
  const tokenOf = (req: FastifyRequest): string | undefined => sessionTokenOf(req.headers.cookie);

  app.get('/api/auth/session', async (req) => auth.session(tokenOf(req), requestInfo(req, cfg)));

  app.post('/api/auth/login', async (req, reply) => {
    const b = parse(loginBody, req.body);
    const info = requestInfo(req, cfg);
    const signed = await auth.login(b.identifier, b.password, info);
    setSession(reply, signed, info, cfg.sessionTtlMs);
    return signed.user;
  });

  app.post('/api/auth/register', async (req, reply) => {
    const info = requestInfo(req, cfg);
    const signed = await auth.register(parse(registerBody, req.body), info);
    setSession(reply, signed, info, cfg.sessionTtlMs);
    return reply.code(201).send(signed.user);
  });

  app.post('/api/auth/email/request', async (req) =>
    auth.requestEmailLink(parse(emailBody, req.body).email, requestInfo(req, cfg)),
  );

  app.post('/api/auth/email/verify', async (req, reply) => {
    const info = requestInfo(req, cfg);
    const signed = await auth.verifyEmailLink(parse(verifyBody, req.body).token);
    setSession(reply, signed, info, cfg.sessionTtlMs);
    return signed.user;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.logout(tokenOf(req));
    reply.header(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: requestInfo(req, cfg).secure }),
    );
    return { ok: true };
  });

  // ---- Google: two browser navigations, so they answer with redirects instead of JSON
  const redirect = (reply: FastifyReply, to: string): FastifyReply => reply.code(302).header('Location', to).send();
  const toLogin = (reply: FastifyReply, error: string): FastifyReply =>
    redirect(reply, `/#/login?error=${encodeURIComponent(error)}`);

  app.get('/api/auth/google/start', async (req, reply) => {
    const info = requestInfo(req, cfg);
    let start: ReturnType<AuthService['googleStart']>;
    try {
      start = auth.googleStart(info);
    } catch (err) {
      if (err instanceof ApiError) return toLogin(reply, err.code);
      throw err;
    }
    reply.header(
      'Set-Cookie',
      serializeCookie(OAUTH_COOKIE, Buffer.from(JSON.stringify(start.transaction)).toString('base64url'), {
        maxAge: 600,
        path: OAUTH_PATH,
        secure: info.secure,
      }),
    );
    return redirect(reply, start.url);
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const info = requestInfo(req, cfg);
    const clear = serializeCookie(OAUTH_COOKIE, '', { maxAge: 0, path: OAUTH_PATH, secure: info.secure });
    let transaction: OAuthTransaction | null = null;
    try {
      const raw = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
      if (raw) transaction = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as OAuthTransaction;
    } catch {
      transaction = null;
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    try {
      const signed = await auth.googleFinish({ code: q.code, state: q.state, error: q.error }, transaction, info);
      reply.header('Set-Cookie', [
        clear,
        serializeCookie(SESSION_COOKIE, signed.token, { maxAge: cfg.sessionTtlMs / 1000, secure: info.secure }),
      ]);
      return redirect(reply, '/#/today');
    } catch (err) {
      reply.header('Set-Cookie', clear);
      if (err instanceof ApiError) return toLogin(reply, err.code);
      throw err;
    }
  });
}
