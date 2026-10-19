import { timingSafeEqual } from 'node:crypto';
import type { AuthSessionView, AuthUserView, EmailLinkRequestView, RegisterInput } from '../api-types';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest } from '../errors';
import type { AuthConfig } from './config';
import { authorizationUrl, exchangeCode, newTransaction, type OAuthTransaction } from './google';
import { AttemptLimiter, newSetupCode, newToken, sessionTokenOf } from './http';
import { signInMessage } from './mailer';
import { decoyHash, hashPassword, passwordProblem, verifyPassword } from './passwords';
import { AuthStore, type SessionMethod, type UserRow } from './store';

/** What the service needs to know about the HTTP request, worked out once by the routes. */
export interface RequestInfo {
  /** Where links and the Google redirect point: the loopback address or `APP_URL`, whichever the browser used. */
  origin: string;
  /** The request comes from the machine itself (loopback Host, no proxy headers): the only place setup is allowed. */
  local: boolean;
  /** Cookies get the Secure flag (the browser reached us over https through `APP_URL`). */
  secure: boolean;
  /** Who is asking, for rate limits: the last `X-Forwarded-For` entry (the one our own proxy added), else the socket address. */
  ip: string;
}

export interface Signed {
  user: AuthUserView;
  token: string;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const WINDOW_MS = 15 * 60 * 1000;

export const userView = (u: UserRow): AuthUserView => ({ id: u.id, username: u.username, email: u.email });

/**
 * Every sign-in decision: who may create the account, how a password, a Google account or an emailed link maps to it,
 * and when to say no. The HTTP layer (routes.ts) only parses requests and sets cookies.
 *
 * One account owns the app. The first one is created from the login page by someone at the server's own machine who
 * also holds the setup code printed in its terminal; after that, Google and email links sign in to that account by its
 * email address. Nothing but that one form creates an account, so a stranger's Google or email-link request can only be
 * refused.
 */
export class AuthService {
  private readonly store: AuthStore;
  /**
   * Failed password attempts are counted three ways. Per caller and name (10): one attacker locks only themselves out,
   * not the owner on another address. Per name overall (50): bounds a guesser who rotates addresses (free when a proxy
   * passes a client-supplied X-Forwarded-For through). Per caller overall (30): bounds a spray of unknown names, each of
   * which still costs a full 64 MiB hash.
   */
  private readonly loginPair = new AttemptLimiter(10, WINDOW_MS);
  private readonly loginName = new AttemptLimiter(50, WINDOW_MS);
  private readonly loginIp = new AttemptLimiter(30, WINDOW_MS);
  private readonly linkPair = new AttemptLimiter(5, WINDOW_MS);
  private readonly linkEmail = new AttemptLimiter(10, WINDOW_MS);
  private readonly linkIp = new AttemptLimiter(20, WINDOW_MS);
  private readonly setupLimit = new AttemptLimiter(5, WINDOW_MS);
  /** Proves the person creating the first account can read this server's terminal, not just reach its port. */
  readonly setupCode = newSetupCode();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly deps: ServerDeps,
    readonly cfg: AuthConfig,
  ) {
    this.store = new AuthStore(deps.db);
  }

  /** Prints the setup code when there is no account yet (called once at start-up). */
  async announceSetup(): Promise<void> {
    if ((await this.store.userCount()) === 0)
      this.deps.log(
        `First-run setup: open ${this.cfg.localUrl} on this computer and enter the setup code ${this.setupCode} to create the account.`,
      );
  }

  private setupCodeMatches(given: string): boolean {
    const norm = (s: string): Buffer => Buffer.from(s.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const a = norm(given);
    const b = norm(this.setupCode);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Resolves when background work (sending mail) has finished: for tests and a clean shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** The account behind a request's Cookie header, or null. */
  async userForCookie(cookieHeader: string | undefined): Promise<UserRow | null> {
    return this.userForToken(sessionTokenOf(cookieHeader));
  }

  async userForToken(token: string | undefined): Promise<UserRow | null> {
    if (!token) return null;
    return this.store.userForSession(token, this.deps.now());
  }

  async session(token: string | undefined, info: RequestInfo): Promise<AuthSessionView> {
    const user = await this.userForToken(token);
    const setupRequired = user === null && (await this.store.userCount()) === 0;
    return {
      authRequired: true,
      user: user ? userView(user) : null,
      setupRequired,
      canSetup: setupRequired && info.local,
      localUrl: this.cfg.localUrl,
      providers: {
        password: true,
        google: this.cfg.google !== null,
        emailLink: true,
        emailDelivery: this.cfg.mailer.kind,
      },
    };
  }

  // ---- first account

  async register(input: RegisterInput, info: RequestInfo): Promise<Signed> {
    if ((await this.store.userCount()) > 0)
      throw new ApiError(403, 'signup_closed', 'This app already has an account. Sign in instead.');
    // Two independent proofs, because neither is enough alone: `local` is worked out from headers (a proxy that rewrites
    // Host and adds nothing looks local), and the code is worthless to anyone who cannot read the server's terminal.
    if (!info.local)
      throw new ApiError(
        403,
        'setup_local_only',
        `The first account can only be created on the computer that runs the server: open ${this.cfg.localUrl} there.`,
      );
    const setupNow = this.deps.now().getTime();
    const setupWait = this.setupLimit.retryAfter('setup', setupNow);
    if (setupWait > 0)
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many wrong setup codes. Try again in ${Math.ceil(setupWait / 60)} minute(s).`,
        { retryAfterSec: setupWait },
      );
    if (!this.setupCodeMatches(input.setupCode)) {
      this.setupLimit.record('setup', setupNow);
      throw new ApiError(
        403,
        'invalid_setup_code',
        'That setup code is not right. It is printed in the terminal where the server runs.',
      );
    }
    const username = input.username.trim().toLowerCase();
    if (!USERNAME.test(username))
      throw badRequest(
        'invalid_username',
        'Use 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
      );
    const bad = passwordProblem(input.password);
    if (bad) throw badRequest('invalid_password', bad);
    const user = await this.store.insertFirstUser({
      username,
      email: input.email.trim().toLowerCase(),
      passwordHash: await hashPassword(input.password),
      emailVerifiedAt: null,
    });
    if (!user) throw new ApiError(403, 'signup_closed', 'This app already has an account. Sign in instead.');
    return this.startSession(user, 'setup');
  }

  // ---- username and password

  async login(identifier: string, password: string, info: RequestInfo): Promise<Signed> {
    const key = identifier.trim().toLowerCase();
    const now = this.deps.now().getTime();
    const pair = `${info.ip}\u0000${key}`;
    const wait = Math.max(
      this.loginPair.retryAfter(pair, now),
      this.loginName.retryAfter(key, now),
      this.loginIp.retryAfter(info.ip, now),
    );
    if (wait > 0)
      throw new ApiError(
        429,
        'too_many_attempts',
        `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s), or sign in with Google or an email link.`,
        { retryAfterSec: wait },
      );
    const user = await this.store.byIdentifier(key);
    // Always run one full hash check, so an unknown name or a password-less account answers no faster than a wrong password.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
    if (!user?.passwordHash || !ok) {
      this.loginPair.record(pair, now);
      this.loginName.record(key, now);
      this.loginIp.record(info.ip, now);
      throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.');
    }
    this.loginPair.reset(pair);
    return this.startSession(user, 'password');
  }

  // ---- email link

  /**
   * Sends a one-time link when the address belongs to the account. The answer is the same either way, and the mail goes out in the background, so neither the body nor the
   * response time says whether the address is known.
   */
  async requestEmailLink(email: string, info: RequestInfo): Promise<EmailLinkRequestView> {
    const key = email.trim().toLowerCase();
    const now = this.deps.now();
    const pair = `${info.ip}\u0000${key}`;
    const wait = Math.max(
      this.linkPair.retryAfter(pair, now.getTime()),
      this.linkEmail.retryAfter(key, now.getTime()),
      this.linkIp.retryAfter(info.ip, now.getTime()),
    );
    if (wait > 0)
      throw new ApiError(
        429,
        'too_many_attempts',
        `A link was just sent. Wait ${Math.ceil(wait / 60)} minute(s) before asking again.`,
        { retryAfterSec: wait },
      );
    this.linkPair.record(pair, now.getTime());
    this.linkEmail.record(key, now.getTime());
    this.linkIp.record(info.ip, now.getTime());

    if ((await this.store.byEmail(key)) !== null) {
      const token = newToken();
      await this.store.createLink(token, key, now, this.cfg.linkTtlMs);
      const message = signInMessage(
        key,
        `${info.origin}/#/login?token=${token}`,
        Math.round(this.cfg.linkTtlMs / 60_000),
      );
      const job: Promise<void> = this.cfg.mailer
        .send(message)
        .catch((err: unknown) => this.deps.log(`could not send the sign-in email: ${(err as Error).message}`))
        .finally(() => this.pending.delete(job));
      this.pending.add(job);
    }
    return { sent: true, delivery: this.cfg.mailer.kind };
  }

  async verifyEmailLink(token: string): Promise<Signed> {
    const email = await this.store.consumeLink(token, this.deps.now());
    if (!email)
      throw new ApiError(401, 'invalid_link', 'This link has expired or was already used. Ask for a new one.');
    const user = await this.userForVerifiedEmail(email, null);
    return this.startSession(user, 'email_link');
  }

  // ---- Google

  googleStart(info: RequestInfo): { url: string; transaction: OAuthTransaction } {
    if (!this.cfg.google)
      throw new ApiError(503, 'google_not_configured', 'Google sign-in is not set up on this server.');
    const transaction = newTransaction();
    return { url: authorizationUrl(this.cfg.google, info.origin, transaction), transaction };
  }

  async googleFinish(
    query: { code?: string; state?: string; error?: string },
    transaction: OAuthTransaction | null,
    info: RequestInfo,
  ): Promise<Signed> {
    if (!this.cfg.google)
      throw new ApiError(503, 'google_not_configured', 'Google sign-in is not set up on this server.');
    if (query.error) throw new ApiError(401, 'google_denied', 'Google sign-in was cancelled.');
    if (!transaction || !query.state || query.state !== transaction.state || !query.code)
      throw new ApiError(
        401,
        'google_state',
        'The Google sign-in expired or was started in another browser window. Try again.',
      );
    const profile = await exchangeCode(
      this.cfg.google,
      this.deps.fetch,
      info.origin,
      query.code,
      transaction,
      this.deps.now(),
    );
    const user = await this.userForVerifiedEmail(profile.email, profile);
    return this.startSession(user, 'google');
  }

  // ---- sessions

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.deleteSession(token);
  }

  /**
   * The account for an address Google or an emailed link has just proven. It is found by Google id, then by email.
   */
  private async userForVerifiedEmail(
    email: string,
    google: { sub: string; name: string | null } | null,
  ): Promise<UserRow> {
    const now = this.deps.now();
    const existing = (google ? await this.store.byGoogleSub(google.sub) : null) ?? (await this.store.byEmail(email));
    if (existing) {
      if (google && existing.googleSub && existing.googleSub !== google.sub)
        throw new ApiError(403, 'google_mismatch', 'This account is linked to a different Google account.');
      const patch: Parameters<AuthStore['patchUser']>[1] = {};
      if (google && !existing.googleSub) patch.googleSub = google.sub;
      if (!existing.emailVerifiedAt) patch.emailVerifiedAt = now;
      if (Object.keys(patch).length > 0) await this.store.patchUser(existing.id, patch);
      return { ...existing, ...patch };
    }
    // Only the setup form creates an account (register), so an address nobody registered is simply refused.
    throw new ApiError(
      403,
      'no_account',
      `There is no account for ${email}. Sign in with the address the account was created with.`,
    );
  }

  private async startSession(user: UserRow, method: SessionMethod): Promise<Signed> {
    const token = newToken();
    const now = this.deps.now();
    await this.store.createSession(token, user.id, method, now, this.cfg.sessionTtlMs);
    await this.store.patchUser(user.id, { lastLoginAt: now });
    return { user: userView(user), token };
  }
}
