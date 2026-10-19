import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Opaque random value for a cookie or an emailed link: 256 bits, URL-safe. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** What the database stores in place of a token, so a leaked table cannot be replayed. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** `ABCD-EFGH`: about 40 bits, typed once by a person reading it off a terminal. */
export function newSetupCode(): string {
  const pick = (): string => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)] as string;
  const half = (): string => Array.from({ length: 4 }, pick).join('');
  return `${half()}-${half()}`;
}

export const SESSION_COOKIE = 'ot_session';

/** The session token a request carries, or undefined. */
export const sessionTokenOf = (cookieHeader: string | undefined): string | undefined =>
  parseCookies(cookieHeader)[SESSION_COOKIE];

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name === '') continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] ??= decodeURIComponent(value);
    } catch {
      out[name] ??= value;
    }
  }
  return out;
}

export interface CookieOptions {
  /** Seconds; omit for a browser-session cookie, 0 to delete. */
  maxAge?: number;
  path?: string;
  secure?: boolean;
}

/** HttpOnly (script cannot read it) and SameSite=Lax (not sent on cross-site POSTs) on every cookie this server sets. */
export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

const MAX_KEYS = 10_000;

/** Sliding-window counter for failed attempts, kept in memory (a restart forgives; this is a brake, not a ledger). */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length > 0) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** Seconds until another attempt is allowed, or 0 when the key is not blocked. */
  retryAfter(key: string, now: number): number {
    const kept = this.recent(key, now);
    if (kept.length < this.max) return 0;
    return Math.max(1, Math.ceil((kept[0]! + this.windowMs - now) / 1000));
  }

  record(key: string, now: number): void {
    // A spray of unique names must not grow memory without bound, and must not wipe the counters of real ones: drop the oldest.
    if (!this.hits.has(key) && this.hits.size >= MAX_KEYS) this.hits.delete(this.hits.keys().next().value as string);
    const kept = this.recent(key, now);
    kept.push(now);
    this.hits.set(key, kept);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
