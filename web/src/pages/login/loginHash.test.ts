import { afterEach, describe, expect, it } from 'vitest';
import { clearLoginHash, leaveLoginHash, loginErrorMessage, readLoginHash } from './loginHash';

describe('readLoginHash', () => {
  it('reads an emailed token', () => {
    expect(readLoginHash('#/login?token=abc_DEF-123')).toEqual({ token: 'abc_DEF-123', error: null });
  });

  it('reads the reason a Google sign-in came back empty', () => {
    expect(readLoginHash('#/login?error=no_account')).toEqual({ token: null, error: 'no_account' });
  });

  it('ignores the app routes, an empty login hash and anything else', () => {
    for (const hash of [
      '',
      '#',
      '#/today',
      '#/positions/US/KO',
      '#/login',
      '#/login?',
      '#/login?other=1',
      '#/loginx?token=a',
    ])
      expect(readLoginHash(hash), hash).toEqual({ token: null, error: null });
  });
});

describe('loginErrorMessage', () => {
  it('explains the codes the server redirects with and never shows an unknown code raw', () => {
    expect(loginErrorMessage('google_denied')).toMatch(/cancelled/);
    expect(loginErrorMessage('no_account')).toMatch(/no account/i);
    expect(loginErrorMessage('<script>')).toBe('Sign-in failed. Try again.');
  });
});

describe('address bar', () => {
  afterEach(() => window.history.replaceState(null, '', '#'));

  it('drops a one-time token from the address bar once it has been read', () => {
    window.history.replaceState(null, '', '#/login?token=secret');
    clearLoginHash();
    expect(window.location.hash).toBe('#/login');
  });

  it('leaves the login for the app, but keeps a deep link to another page', () => {
    window.history.replaceState(null, '', '#/login');
    leaveLoginHash();
    expect(window.location.hash).toBe('#/today');
    window.history.replaceState(null, '', '#/positions');
    leaveLoginHash();
    expect(window.location.hash).toBe('#/positions');
  });
});
