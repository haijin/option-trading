import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppCall, MemoryMailer, startApp, type TestApp } from '../helpers/app';
import { createTestDb, type TestDb } from '../helpers/test-db';

const OWNER = { username: 'Haijin', email: 'Owner@Example.com', password: 'correct horse battery' };
const LOCAL = 'http://127.0.0.1:4317';
const PUBLIC = 'https://app.example.com';
const GOOGLE = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };

const setCookies = (r: AppCall): string[] => [r.headers['set-cookie']].flat().filter((c): c is string => !!c);
/** `name=value` of a Set-Cookie, ready to send back in a Cookie header; null when the response did not set it. */
const cookie = (r: AppCall, name: string): string | null =>
  setCookies(r)
    .map((c) => c.split(';')[0] as string)
    .find((c) => c.startsWith(`${name}=`)) ?? null;
const session = (r: AppCall): string => cookie(r, 'ot_session') as string;

const jwt = (claims: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('sign-in', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  let mail: MemoryMailer;
  /** What the fake Google token endpoint answers; the Google tests set it from the transaction they started. */
  let google: { claims: Record<string, unknown> | null; status: number } = { claims: null, status: 200 };

  const googleFetch: typeof fetch = async () =>
    new Response(JSON.stringify(google.claims ? { id_token: jwt(google.claims) } : { error: 'invalid_grant' }), {
      status: google.status,
    });

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-auth-'));
    mail = new MemoryMailer();
    t = await startApp(db, {
      tmp,
      fetch: googleFetch,
      auth: { mailer: mail, google: GOOGLE, publicOrigin: PUBLIC },
    });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.db.execute(sql`truncate app_users, login_links cascade`);
    mail.sent.length = 0;
    google = { claims: null, status: 200 };
  });

  /** One second before the app's own clock (the harness pins it), which is what expiry is judged against. */
  const secondAgo = (): Date => new Date(t.deps.now().getTime() - 1000);
  /** The code the server prints at start-up when no account exists. */
  const setupCode = (): string => t.app.services.auth?.setupCode as string;
  const register = (over: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    t.post('/api/auth/register', { ...OWNER, setupCode: setupCode(), ...over }, headers);

  describe('the gate', () => {
    it('keeps every data endpoint behind a session, and leaves the login endpoints and health open', async () => {
      for (const url of ['/api/overview', '/api/settings', '/api/watchlist', '/api/positions']) {
        const r = await t.get(url);
        expect(r.status, url).toBe(401);
        expect(r.json.error.code).toBe('unauthenticated');
      }
      expect((await t.post('/api/scan/run')).status).toBe(401);
      expect((await t.get('/api/nope')).status).toBe(404); // matches no route, so there is nothing to guard or leak
      expect((await t.get('/api/health')).status).toBe(200);
      const s = await t.get('/api/auth/session');
      expect(s.status).toBe(200);
      expect(s.json).toMatchObject({
        authRequired: true,
        user: null,
        setupRequired: true,
        canSetup: true,
        providers: { password: true, google: true, emailLink: true, emailDelivery: 'smtp' },
      });
    });

    it('tells a visitor without a session nothing but that the server is up', async () => {
      const anon = await t.get('/api/health');
      expect(anon.json).toEqual({ ok: true });
      await register();
      const signedIn = await t.get('/api/health', {
        cookie: session(await t.post('/api/auth/login', { identifier: 'haijin', password: OWNER.password })),
      });
      expect(signedIn.json).toMatchObject({ ok: true, version: '0.0.0-test', database: { connected: true } });
    });

    it('rejects a forged or foreign cookie', async () => {
      const r = await t.get('/api/settings', { cookie: 'ot_session=not-a-real-session-token' });
      expect(r.status).toBe(401);
    });

    it('is off when no auth is configured: the session probe says so and the API is open', async () => {
      const open = await startApp(db, { tmp });
      try {
        expect((await open.get('/api/auth/session')).json).toMatchObject({ authRequired: false, user: null });
        expect((await open.get('/api/settings')).status).toBe(200);
        expect((await open.post('/api/auth/login', { identifier: 'a', password: 'b' })).status).toBe(404);
      } finally {
        await open.close();
      }
    });
  });

  describe('first account', () => {
    it('is created from the machine itself and signs in straight away', async () => {
      const r = await register();
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ id: expect.any(String), username: 'haijin', email: 'owner@example.com' });
      const set = setCookies(r).find((c) => c.startsWith('ot_session='));
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/SameSite=Lax/);
      expect(set).toMatch(/Max-Age=2592000/);
      expect(set).not.toMatch(/Secure/); // plain http on the loopback address

      const cookieHeader = { cookie: session(r) };
      expect((await t.get('/api/settings', cookieHeader)).status).toBe(200);
      expect((await t.get('/api/auth/session', cookieHeader)).json).toMatchObject({
        user: { username: 'haijin' },
        setupRequired: false,
        canSetup: false,
      });
    });

    it('never stores the password or the session token in the clear', async () => {
      const r = await register();
      const users = await db.db.execute(sql`select password_hash from app_users`);
      const hash = (users.rows[0] as { password_hash: string }).password_hash;
      expect(hash).toMatch(/^scrypt\$/);
      expect(hash).not.toContain(OWNER.password);
      const sessions = await db.db.execute(sql`select token_hash, method from app_sessions`);
      const row = sessions.rows[0] as { token_hash: string; method: string };
      expect(session(r)).not.toContain(row.token_hash);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.method).toBe('setup');
    });

    it('is closed once an account exists', async () => {
      await register();
      const again = await register({ username: 'second', email: 'second@example.com' });
      expect(again.status).toBe(403);
      expect(again.json.error.code).toBe('signup_closed');
      expect((await t.get('/api/auth/session')).json).toMatchObject({ setupRequired: false, canSetup: false });
    });

    it('is refused through a proxy or tunnel, and through the public address', async () => {
      const attempts: Record<string, string>[] = [
        { 'x-forwarded-for': '203.0.113.9' },
        { 'cf-connecting-ip': '203.0.113.9' },
        { host: 'app.example.com' },
      ];
      for (const headers of attempts) {
        const r = await register({}, headers);
        expect(r.status, JSON.stringify(headers)).toBe(403);
        expect(r.json.error.code).toBe('setup_local_only');
        expect((await t.get('/api/auth/session', headers)).json).toMatchObject({
          setupRequired: true,
          canSetup: false,
        });
      }
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(0);
    });

    it('needs the setup code printed in the server terminal', async () => {
      for (const wrong of ['', 'AAAA-AAAA', 'not the code']) {
        const r = await register({ setupCode: wrong });
        expect(r.status, wrong).toBe(403);
        expect(r.json.error.code).toBe('invalid_setup_code');
      }
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(0);
      // Case, dashes and spaces do not matter when a person retypes it.
      const typed = setupCode().toLowerCase().replace('-', ' ');
      expect((await register({ setupCode: typed })).status).toBe(201);
    });

    it('is not offered to a client that holds the code but is not at the machine', async () => {
      const r = await register({}, { 'x-forwarded-for': '203.0.113.9' });
      expect(r.json.error.code).toBe('setup_local_only');
    });

    it('stops guessing the setup code after five wrong tries', async () => {
      const guesser = await startApp(db, { tmp, auth: {} });
      try {
        const post = (code: string) => guesser.post('/api/auth/register', { ...OWNER, setupCode: code });
        for (let i = 0; i < 5; i++) expect((await post(`AAAA-AAA${i}`)).json.error.code).toBe('invalid_setup_code');
        const blocked = await post(guesser.app.services.auth?.setupCode as string); // even the right one
        expect(blocked.status).toBe(429);
        expect(blocked.json.error.code).toBe('too_many_attempts');
      } finally {
        await guesser.close();
      }
    });

    it('checks the username, the email and the password', async () => {
      expect((await register({ username: 'a b' })).json.error.code).toBe('invalid_username');
      expect((await register({ username: 'ab' })).json.error.code).toBe('invalid_username');
      expect((await register({ password: 'short' })).json.error.code).toBe('invalid_password');
      const badEmail = await register({ email: 'not-an-email' });
      expect(badEmail.status).toBe(400);
      expect(badEmail.json.error.message).toBe('Enter a valid email address.');
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(0);
    });

    it('cannot be created twice by two simultaneous requests', async () => {
      const results = await Promise.all([
        register({ username: 'first', email: 'first@example.com' }),
        register({ username: 'second', email: 'second@example.com' }),
        register({ username: 'third', email: 'third@example.com' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(1);
    });
  });

  describe('username and password', () => {
    beforeEach(async () => {
      await register();
    });

    it('signs in by username (any case) or by email', async () => {
      for (const identifier of ['haijin', 'HAIJIN', ' Haijin ', 'owner@example.com', 'OWNER@example.com']) {
        const r = await t.post('/api/auth/login', { identifier, password: OWNER.password });
        expect(r.status, identifier).toBe(200);
        expect(r.json.username).toBe('haijin');
        expect((await t.get('/api/settings', { cookie: session(r) })).status).toBe(200);
      }
    });

    it('answers a wrong password and an unknown user in the same words', async () => {
      const wrong = await t.post('/api/auth/login', { identifier: 'haijin', password: 'nope-nope-nope' });
      const unknown = await t.post('/api/auth/login', { identifier: 'nobody', password: 'nope-nope-nope' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.json).toEqual(unknown.json);
      expect(wrong.json.error).toMatchObject({ code: 'invalid_credentials', message: 'Wrong username or password.' });
      expect(cookie(wrong, 'ot_session')).toBeNull();
    });

    it('blocks a name after ten wrong passwords, even for the right one, but not other names', async () => {
      for (let i = 0; i < 10; i++)
        expect((await t.post('/api/auth/login', { identifier: 'target', password: `wrong-${i}-pass` })).status).toBe(
          401,
        );
      const blocked = await t.post('/api/auth/login', { identifier: 'target', password: 'wrong-again!' });
      expect(blocked.status).toBe(429);
      expect(blocked.json.error.code).toBe('too_many_attempts');
      expect(blocked.json.error.details.retryAfterSec).toBeGreaterThan(0);
      // The owner is unaffected, and a success clears that name's counter.
      expect((await t.post('/api/auth/login', { identifier: 'haijin', password: OWNER.password })).status).toBe(200);
    });

    it('does not let one caller lock the owner out from another address', async () => {
      const attacker = { 'x-forwarded-for': '198.51.100.7' };
      for (let i = 0; i < 10; i++)
        await t.post('/api/auth/login', { identifier: 'haijin', password: `guess-${i}-wrong` }, attacker);
      const blocked = await t.post('/api/auth/login', { identifier: 'haijin', password: OWNER.password }, attacker);
      expect(blocked.status).toBe(429);
      const owner = await t.post(
        '/api/auth/login',
        { identifier: 'haijin', password: OWNER.password },
        { 'x-forwarded-for': '192.0.2.44' },
      );
      expect(owner.status).toBe(200);
    });

    it('still bounds a guesser who rotates addresses, with a ceiling per name', async () => {
      let blockedAt = 0;
      for (let i = 0; i < 60 && !blockedAt; i++) {
        const r = await t.post(
          '/api/auth/login',
          { identifier: 'rotator', password: `guess-${i}-wrong` },
          { 'x-forwarded-for': `203.0.113.${i + 1}` },
        );
        if (r.status === 429) blockedAt = i + 1;
      }
      expect(blockedAt).toBe(51); // 50 failures are allowed, the 51st is refused whoever asks
    });

    it('signs out: the cookie is cleared and the old session stops working', async () => {
      const cookieHeader = { cookie: await signIn() };
      const out = await t.post('/api/auth/logout', {}, cookieHeader);
      expect(out.json).toEqual({ ok: true });
      expect(setCookies(out).find((c) => c.startsWith('ot_session='))).toMatch(/Max-Age=0/);
      expect((await t.get('/api/settings', cookieHeader)).status).toBe(401);
    });

    it('expires a session after its lifetime', async () => {
      const c = await signIn();
      await db.db.execute(sql`update app_sessions set expires_at = ${secondAgo()}`);
      expect((await t.get('/api/settings', { cookie: c })).status).toBe(401);
    });

    it('validates the body', async () => {
      expect((await t.post('/api/auth/login', {})).status).toBe(400);
      expect((await t.post('/api/auth/login', { identifier: 'a', password: 'x'.repeat(2000) })).status).toBe(400);
    });

    async function signIn(): Promise<string> {
      return session(await t.post('/api/auth/login', { identifier: 'haijin', password: OWNER.password }));
    }
  });

  describe('email link', () => {
    // The link limiter is per address and lives as long as the app, so every test gets its own owner address.
    let seq = 0;
    const owner = async (): Promise<string> => {
      const email = `owner${++seq}@example.com`;
      await register({ email });
      return email;
    };
    it('mails a single-use link to a known address and signs in with it', async () => {
      const email = await owner();
      const asked = await t.post('/api/auth/email/request', { email: email.toUpperCase() });
      expect(asked.json).toEqual({ sent: true, delivery: 'smtp' });
      await t.app.services.auth?.idle();
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(email);
      expect(mail.sent[0]?.text).toContain(`${LOCAL}/#/login?token=`);
      const token = mail.lastToken() as string;

      const used = await t.post('/api/auth/email/verify', { token });
      expect(used.status).toBe(200);
      expect(used.json.username).toBe('haijin');
      expect((await t.get('/api/settings', { cookie: session(used) })).status).toBe(200);

      const replay = await t.post('/api/auth/email/verify', { token });
      expect(replay.status).toBe(401);
      expect(replay.json.error.code).toBe('invalid_link');
    });

    it('stores only a hash of the link token', async () => {
      const email = await owner();
      await t.post('/api/auth/email/request', { email });
      await t.app.services.auth?.idle();
      const token = mail.lastToken() as string;
      const rows = await db.db.execute(sql`select token_hash from login_links`);
      expect((rows.rows[0] as { token_hash: string }).token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows.rows)).not.toContain(token);
    });

    it('answers an unknown address exactly like a known one, and sends nothing', async () => {
      const email = await owner();
      const known = await t.post('/api/auth/email/request', { email });
      const unknown = await t.post('/api/auth/email/request', { email: 'stranger@example.com' });
      await t.app.services.auth?.idle();
      expect(unknown.status).toBe(known.status);
      expect(unknown.json).toEqual(known.json);
      expect(mail.sent.map((m) => m.to)).toEqual([email]);
    });

    it('refuses an expired link', async () => {
      const email = await owner();
      await t.post('/api/auth/email/request', { email });
      await t.app.services.auth?.idle();
      await db.db.execute(sql`update login_links set expires_at = ${secondAgo()}`);
      const r = await t.post('/api/auth/email/verify', { token: mail.lastToken() as string });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe('invalid_link');
    });

    it('refuses a made-up token and a malformed one', async () => {
      expect((await t.post('/api/auth/email/verify', { token: 'x'.repeat(43) })).json.error.code).toBe('invalid_link');
      expect((await t.post('/api/auth/email/verify', { token: 'short' })).status).toBe(400);
      expect((await t.post('/api/auth/email/request', { email: 'nope' })).status).toBe(400);
    });

    it('limits how often one address can be asked for a link', async () => {
      await owner();
      for (let i = 0; i < 5; i++)
        expect((await t.post('/api/auth/email/request', { email: 'spam@example.com' })).status).toBe(200);
      const sixth = await t.post('/api/auth/email/request', { email: 'spam@example.com' });
      expect(sixth.status).toBe(429);
      expect(sixth.json.error.code).toBe('too_many_attempts');
    });

    it('points the link at the address the browser used, and marks cookies Secure on the https address', async () => {
      const email = await owner();
      const viaPublic = { host: 'app.example.com', 'x-forwarded-for': '203.0.113.9' };
      await t.post('/api/auth/email/request', { email }, viaPublic);
      await t.app.services.auth?.idle();
      expect(mail.sent[0]?.text).toContain(`${PUBLIC}/#/login?token=`);
      const used = await t.post('/api/auth/email/verify', { token: mail.lastToken() as string }, viaPublic);
      expect(setCookies(used).find((c) => c.startsWith('ot_session='))).toMatch(/; Secure$/);
    });

    it('never creates an account, even on first run: only the setup form does', async () => {
      await t.post('/api/auth/email/request', { email: 'New.Owner@example.com' });
      await t.app.services.auth?.idle();
      expect(mail.sent).toHaveLength(0);
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(0);
    });
  });

  describe('Google', () => {
    /** Starts the flow and returns what the browser would hold: the cookie, and the state and nonce Google would echo. */
    async function start(headers?: Record<string, string>) {
      const r = await t.get('/api/auth/google/start', headers);
      const location = new URL(r.headers.location as string);
      return {
        r,
        location,
        oauth: cookie(r, 'ot_oauth') as string,
        state: location.searchParams.get('state') as string,
        nonce: location.searchParams.get('nonce') as string,
      };
    }
    const claims = (nonce: string, over: Record<string, unknown> = {}) => ({
      iss: 'https://accounts.google.com',
      aud: GOOGLE.clientId,
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce,
      sub: 'g-1',
      email: OWNER.email.toLowerCase(),
      email_verified: true,
      ...over,
    });
    const finish = async (
      s: Awaited<ReturnType<typeof start>>,
      over: Record<string, unknown> = {},
      state = s.state,
    ) => {
      google.claims = claims(s.nonce, over);
      return t.get(`/api/auth/google/callback?code=abc&state=${state}`, { cookie: s.oauth });
    };

    it('sends the browser to Google with PKCE and a redirect back to the address it used', async () => {
      const s = await start();
      expect(s.r.status).toBe(302);
      expect(s.location.origin + s.location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(s.location.searchParams.get('client_id')).toBe(GOOGLE.clientId);
      expect(s.location.searchParams.get('redirect_uri')).toBe(`${LOCAL}/api/auth/google/callback`);
      expect(s.location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(setCookies(s.r).find((c) => c.startsWith('ot_oauth='))).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600/);

      const pub = await start({ host: 'app.example.com', 'x-forwarded-for': '203.0.113.9' });
      expect(pub.location.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/google/callback`);
      expect(setCookies(pub.r).find((c) => c.startsWith('ot_oauth='))).toMatch(/; Secure$/);
    });

    it('signs the owner in and remembers their Google account', async () => {
      await register();
      const s = await start();
      const done = await finish(s);
      expect(done.status).toBe(302);
      expect(done.headers.location).toBe('/#/today');
      expect((await t.get('/api/settings', { cookie: session(done) })).status).toBe(200);
      expect(setCookies(done).find((c) => c.startsWith('ot_oauth='))).toMatch(/Max-Age=0/);
      const row = (await db.db.execute(sql`select google_sub, email_verified_at from app_users`)).rows[0] as {
        google_sub: string;
        email_verified_at: Date | null;
      };
      expect(row.google_sub).toBe('g-1');
      expect(row.email_verified_at).not.toBeNull();

      // Later the same Google account signs in by id even if its email changed.
      const again = await finish(await start(), { email: 'changed@gmail.com' });
      expect(again.headers.location).toBe('/#/today');
    });

    it('never creates an account, even on first run from the machine itself', async () => {
      const r = await finish(await start());
      expect(r.headers.location).toBe('/#/login?error=no_account');
      expect(cookie(r, 'ot_session')).toBeNull();
      expect((await db.db.execute(sql`select 1 from app_users`)).rows).toHaveLength(0);
    });

    it('refuses a stranger once an account exists', async () => {
      await register();
      const r = await finish(await start(), { sub: 'g-2', email: 'stranger@gmail.com' });
      expect(r.headers.location).toBe('/#/login?error=no_account');
      expect(cookie(r, 'ot_session')).toBeNull();
    });

    it('refuses a different Google account on an account already linked to one', async () => {
      await register();
      await finish(await start());
      const r = await finish(await start(), { sub: 'g-evil' });
      expect(r.headers.location).toBe('/#/login?error=google_mismatch');
    });

    it('refuses a state that does not match, a missing cookie, a cancelled sign-in and an unverified email', async () => {
      await register();
      const s = await start();
      google.claims = claims(s.nonce);
      expect((await finish(s, {}, 'forged-state')).headers.location).toBe('/#/login?error=google_state');
      const noCookie = await t.get(`/api/auth/google/callback?code=abc&state=${s.state}`);
      expect(noCookie.headers.location).toBe('/#/login?error=google_state');
      const cancelled = await t.get('/api/auth/google/callback?error=access_denied', { cookie: s.oauth });
      expect(cancelled.headers.location).toBe('/#/login?error=google_denied');
      const unverified = await finish(await start(), { email_verified: false });
      expect(unverified.headers.location).toBe('/#/login?error=google_unverified');
      const wrongNonce = await finish(await start(), { nonce: 'replayed' });
      expect(wrongNonce.headers.location).toBe('/#/login?error=google_rejected');
      for (const r of [noCookie, cancelled, unverified, wrongNonce]) expect(cookie(r, 'ot_session')).toBeNull();
    });

    it('says so when Google refuses the code', async () => {
      await register();
      const s = await start();
      google = { claims: null, status: 400 };
      const r = await t.get(`/api/auth/google/callback?code=bad&state=${s.state}`, { cookie: s.oauth });
      expect(r.headers.location).toBe('/#/login?error=google_rejected');
    });
  });

  describe('which hosts are let in', () => {
    it('answers the public address, and nothing else beyond loopback', async () => {
      expect((await t.get('/api/health', { host: 'app.example.com' })).status).toBe(200);
      const evil = await t.get('/api/health', { host: 'evil.example.com' });
      expect(evil.status).toBe(403);
      expect(evil.json.error.code).toBe('forbidden_host');
      const lookalike = await t.get('/api/health', { host: 'app.example.com.evil.com' });
      expect(lookalike.status).toBe(403);
    });

    it('still blocks a cross-site form or fetch to the login endpoints', async () => {
      const r = await t.post('/api/auth/login', { identifier: 'a', password: 'b' }, { origin: 'https://evil.example' });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('forbidden_origin');
      const form = await t.post('/api/auth/login', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
      expect(form.status).toBe(415);
    });

    it('does not let the public address in when the login is off', async () => {
      const open = await startApp(db, { tmp });
      try {
        expect((await open.get('/api/health', { host: 'app.example.com' })).status).toBe(403);
      } finally {
        await open.close();
      }
    });
  });

  describe('Google when it is not set up', () => {
    it('sends the browser back to the login page with a reason', async () => {
      const bare = await startApp(db, { tmp, auth: {} });
      try {
        expect((await bare.get('/api/auth/session')).json.providers.google).toBe(false);
        const r = await bare.get('/api/auth/google/start');
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/#/login?error=google_not_configured');
      } finally {
        await bare.close();
      }
    });
  });
});
