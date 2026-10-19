import type { GoogleConfig } from './google';
import { ConsoleMailer, type Mailer, SmtpMailer } from './mailer';

/** Everything sign-in needs from the outside world. `ServerDeps.auth === null` means the login requirement is off. */
export interface AuthConfig {
  /** `APP_URL` (e.g. https://app.example.com): the one non-loopback address this server answers on, or null. */
  publicOrigin: string | null;
  /** The loopback address of this server, shown when the first account has to be created from the machine itself. */
  localUrl: string;
  google: GoogleConfig | null;
  mailer: Mailer;
  sessionTtlMs: number;
  linkTtlMs: number;
}

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const LINK_TTL_MS = 15 * 60 * 1000;

/** The origin of `APP_URL`, or null when unset or not a plain http(s) address (a bad value must not widen the Host check). */
export function publicOriginOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Reads the sign-in settings from the environment. `OT_AUTH=off` returns null (no login; only for a machine nobody else
 * can reach: with it off the server also refuses the public `APP_URL` host).
 */
export function authConfigFromEnv(
  env: NodeJS.ProcessEnv,
  port: number,
  log: (line: string) => void,
): AuthConfig | null {
  if ((env.OT_AUTH ?? 'on').toLowerCase() === 'off') return null;
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  const smtp = env.OT_SMTP_URL?.trim();
  const mailer: Mailer = smtp
    ? new SmtpMailer(smtp, env.OT_MAIL_FROM?.trim() || 'Option Trading <no-reply@localhost>')
    : new ConsoleMailer(log);
  return {
    publicOrigin: publicOriginOf(env.APP_URL),
    localUrl: `http://127.0.0.1:${port}`,
    google: id && secret ? { clientId: id, clientSecret: secret } : null,
    mailer,
    sessionTtlMs: SESSION_TTL_MS,
    linkTtlMs: LINK_TTL_MS,
  };
}
