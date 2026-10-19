import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publicOriginOf } from '../../src/server/auth/config';
import { authorizationUrl, exchangeCode, type OAuthTransaction } from '../../src/server/auth/google';
import { AttemptLimiter, newSetupCode, parseCookies, serializeCookie, sha256 } from '../../src/server/auth/http';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/server/auth/passwords';

describe('password hashing', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$65536\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batter', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash and treats equivalent Unicode spellings as the same password', async () => {
    const a = await hashPassword('pässword-1');
    const b = await hashPassword('pässword-1');
    expect(a).not.toBe(b);
    expect(await verifyPassword('pässword-1', a)).toBe(true); // "a" + combining diaeresis
  });

  it('never throws on a malformed stored hash', async () => {
    for (const bad of ['', 'plain', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$4$5', 'scrypt$65536$8$1$$'])
      expect(await verifyPassword('anything', bad)).toBe(false);
  });

  it('asks for length only', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('longenough')).toBeNull();
  });
});

describe('cookies', () => {
  it('parses a Cookie header and survives odd values', () => {
    expect(parseCookies('a=1; ot_session=abc%20d; b="q"; broken; =x')).toEqual({ a: '1', ot_session: 'abc d', b: 'q' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });

  it('always sets HttpOnly and SameSite=Lax, and Secure only when asked', () => {
    const plain = serializeCookie('ot_session', 'tok', { maxAge: 60 });
    expect(plain).toBe('ot_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    expect(serializeCookie('x', 'y', { secure: true, path: '/api/auth/google', maxAge: 0 })).toBe(
      'x=y; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });
});

describe('attempt limiter', () => {
  it('blocks after the maximum inside the window, forgives afterwards, and resets on success', () => {
    const l = new AttemptLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfter('k', i)).toBe(0);
      l.record('k', i);
    }
    expect(l.retryAfter('k', 10)).toBe(1);
    expect(l.retryAfter('other', 10)).toBe(0);
    expect(l.retryAfter('k', 1001)).toBe(0); // the first hit left the window
    for (const t of [2000, 2001, 2002]) l.record('k', t);
    expect(l.retryAfter('k', 2003)).toBeGreaterThan(0);
    l.reset('k');
    expect(l.retryAfter('k', 2003)).toBe(0);
  });

  it('drops the oldest names when full, so a spray of new names cannot reset a real one', () => {
    const l = new AttemptLimiter(2, 1_000_000);
    for (let i = 0; i < 9_990; i++) l.record(`spray-${i}`, i);
    for (let i = 0; i < 2; i++) l.record('owner', 10_000 + i);
    for (let i = 0; i < 100; i++) l.record(`more-${i}`, 20_000 + i); // crosses the 10,000-name cap
    expect(l.retryAfter('owner', 30_000)).toBeGreaterThan(0); // a "clear everything" cap would have forgotten it
    expect(l.retryAfter('spray-0', 30_000)).toBe(0);
  });
});

describe('setup code', () => {
  it('is eight unambiguous characters in two groups, and different every time', () => {
    const codes = new Set(Array.from({ length: 50 }, newSetupCode));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});

describe('small helpers', () => {
  it('accepts only an http(s) address as the public URL', () => {
    expect(publicOriginOf('https://app.example.com/some/path')).toBe('https://app.example.com');
    expect(publicOriginOf(' http://example.com:8080 ')).toBe('http://example.com:8080');
    for (const bad of [undefined, '', 'app.example.com', 'javascript:alert(1)', 'ftp://x.com'])
      expect(publicOriginOf(bad)).toBeNull();
  });

  it('hashes tokens so the database never holds a usable one', () => {
    expect(sha256('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('Google OAuth helpers', () => {
  const cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };
  const tx: OAuthTransaction = { state: 'st', verifier: 'ver', nonce: 'no' };
  const now = new Date('2026-10-11T08:00:00Z');
  const jwt = (claims: Record<string, unknown>): string =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const good = {
    iss: 'https://accounts.google.com',
    aud: cfg.clientId,
    exp: Math.floor(now.getTime() / 1000) + 600,
    nonce: 'no',
    sub: '1234',
    email: 'Me@Example.com',
    email_verified: true,
    name: 'Me',
  };
  const answer =
    (body: unknown, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it('builds a PKCE authorization URL that points back at the page the browser used', () => {
    const u = new URL(authorizationUrl(cfg, 'https://app.example.com', tx));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/auth/google/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('nonce')).toBe('no');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update('ver').digest('base64url'));
  });

  it('sends the code with the verifier and secret, and returns the lower-cased profile', async () => {
    const seen: { form?: URLSearchParams } = {};
    const f: typeof fetch = async (_url, init) => {
      seen.form = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ id_token: jwt(good) }), { status: 200 });
    };
    const p = await exchangeCode(cfg, f, 'http://127.0.0.1:3004', 'the-code', tx, now);
    expect(p).toEqual({ sub: '1234', email: 'me@example.com', name: 'Me' });
    expect(seen.form?.get('code')).toBe('the-code');
    expect(seen.form?.get('code_verifier')).toBe('ver');
    expect(seen.form?.get('client_secret')).toBe('secret');
    expect(seen.form?.get('redirect_uri')).toBe('http://127.0.0.1:3004/api/auth/google/callback');
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expired token', { exp: Math.floor(now.getTime() / 1000) - 1 }],
    ['a replayed nonce', { nonce: 'other' }],
    ['a missing email', { email: undefined }],
  ])('refuses %s', async (_name, change) => {
    const f = answer({ id_token: jwt({ ...good, ...change }) });
    await expect(exchangeCode(cfg, f, 'http://127.0.0.1:3004', 'c', tx, now)).rejects.toMatchObject({
      code: 'google_rejected',
    });
  });

  it('refuses an unverified email, a rejected code and an unreachable Google', async () => {
    await expect(
      exchangeCode(cfg, answer({ id_token: jwt({ ...good, email_verified: false }) }), 'http://x', 'c', tx, now),
    ).rejects.toMatchObject({ code: 'google_unverified' });
    await expect(
      exchangeCode(cfg, answer({ error: 'invalid_grant' }, 400), 'http://x', 'c', tx, now),
    ).rejects.toMatchObject({
      code: 'google_rejected',
    });
    const down: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(exchangeCode(cfg, down, 'http://x', 'c', tx, now)).rejects.toMatchObject({
      code: 'google_unreachable',
    });
  });
});
