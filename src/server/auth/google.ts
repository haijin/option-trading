import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from '../errors';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/** What the browser keeps between "go to Google" and "back from Google": it is compared with what Google echoes back. */
export interface OAuthTransaction {
  state: string;
  verifier: string;
  nonce: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
}

export const callbackPath = '/api/auth/google/callback';

export function newTransaction(): OAuthTransaction {
  return {
    state: randomBytes(16).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
}

/** Authorization-code flow with PKCE (S256): the code alone is useless without the verifier only this browser holds. */
export function authorizationUrl(cfg: GoogleConfig, origin: string, t: OAuthTransaction): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${origin}${callbackPath}`,
    response_type: 'code',
    scope: 'openid email profile',
    state: t.state,
    nonce: t.nonce,
    code_challenge: createHash('sha256').update(t.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

const fail = (code: string, message: string): ApiError => new ApiError(401, code, message);

/**
 * Trades the code for tokens and reads the ID token's claims.
 * The ID token arrives straight from Google's token endpoint over TLS together with our client secret, which Google's
 * documentation accepts in place of checking its signature; issuer, audience, expiry, nonce and `email_verified`
 * are still checked here.
 */
export async function exchangeCode(
  cfg: GoogleConfig,
  fetcher: typeof fetch,
  origin: string,
  code: string,
  t: OAuthTransaction,
  now: Date,
): Promise<GoogleProfile> {
  let res: Response;
  try {
    res = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: `${origin}${callbackPath}`,
        grant_type: 'authorization_code',
        code_verifier: t.verifier,
      }).toString(),
    });
  } catch {
    throw new ApiError(502, 'google_unreachable', 'Could not reach Google. Try again in a moment.');
  }
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!res.ok || typeof body?.id_token !== 'string')
    throw fail('google_rejected', 'Google did not accept the sign-in. Try again.');

  const payload = body.id_token.split('.')[1];
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
  } catch {
    throw fail('google_rejected', 'Google answered with something unreadable.');
  }
  const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(cfg.clientId) : claims.aud === cfg.clientId;
  const fresh = typeof claims.exp === 'number' && claims.exp * 1000 > now.getTime();
  if (!issuerOk || !audOk || !fresh || claims.nonce !== t.nonce)
    throw fail('google_rejected', 'The Google sign-in could not be verified. Try again.');
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string')
    throw fail('google_rejected', 'Google did not share an email address.');
  if (claims.email_verified !== true)
    throw fail('google_unverified', 'That Google account has no verified email address.');
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name : null,
  };
}
