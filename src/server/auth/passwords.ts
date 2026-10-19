import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no native dependency). The stored form is self-describing,
 * `scrypt$N$r$p$salt$hash` (base64url), so the cost can be raised later and old hashes still verify.
 * N = 2^16, r = 8, p = 1 is the OWASP-recommended scrypt cost class (about 64 MiB and 0.1 s per hash).
 */
const N = 1 << 16;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAX_MEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** True when the password matches. A malformed stored hash never matches (and never throws). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const params = [Number(n), Number(r), Number(p)];
  if (params.some((x) => !Number.isInteger(x) || x < 1)) return false;
  const expected = Buffer.from(hash, 'base64url');
  try {
    const actual = await derive(
      password,
      Buffer.from(salt, 'base64url'),
      params[0]!,
      params[1]!,
      params[2]!,
      expected.length,
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A hash nobody knows the password of: verifying against it costs the same as a real check, so an unknown user is not faster. */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(18).toString('base64url'));
  return decoy;
}

/** Rules for a new password: length only (NIST 800-63B), no composition rules. Returns the reason it is refused, or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}
