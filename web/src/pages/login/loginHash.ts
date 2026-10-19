/** What the login page can be opened with: an emailed one-time token, or the reason a Google sign-in came back empty. */
export interface LoginHash {
  token: string | null;
  error: string | null;
}

/** Reads `#/login?token=...` or `#/login?error=...`. Anything else (including the app's own routes) yields nothing. */
export function readLoginHash(hash: string): LoginHash {
  const none: LoginHash = { token: null, error: null };
  const match = /^#\/login\?(.*)$/.exec(hash);
  if (!match) return none;
  const params = new URLSearchParams(match[1]);
  return { token: params.get('token') || null, error: params.get('error') || null };
}

/** Messages for the `?error=` codes the server's Google callback redirects with. */
const GOOGLE_ERRORS: Record<string, string> = {
  google_denied: 'Google sign-in was cancelled.',
  google_state: 'The Google sign-in expired or was started in another browser window. Try again.',
  google_rejected: 'Google did not accept the sign-in. Try again.',
  google_unverified: 'That Google account has no verified email address.',
  google_unreachable: 'Could not reach Google. Try again in a moment.',
  google_mismatch: 'This account is linked to a different Google account.',
  google_not_configured: 'Google sign-in is not set up on this server.',
  no_account: 'There is no account for that Google address. Use the address the account was created with.',
};

export function loginErrorMessage(code: string): string {
  return GOOGLE_ERRORS[code] ?? 'Sign-in failed. Try again.';
}

/** Drops the token or error from the address bar (and the history entry) as soon as it has been read. */
export function clearLoginHash(): void {
  if (/^#\/login/.test(window.location.hash)) window.history.replaceState(null, '', '#/login');
}

/** After signing in, leave `#/login` for the app; a deep link to another page is kept. */
export function leaveLoginHash(): void {
  if (/^#\/login/.test(window.location.hash)) window.history.replaceState(null, '', '#/today');
}
