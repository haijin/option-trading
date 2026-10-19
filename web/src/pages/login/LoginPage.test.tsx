import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionView, AuthUserView } from '../../api/types';
import { AuthProvider, useAuth } from '../../state/auth';
import { ToastProvider } from '../../state/toast';
import { AuthGate } from './AuthGate';

const USER: AuthUserView = { id: 'u1', username: 'haijin', email: 'owner@example.com' };

const signedOut = (over: Partial<AuthSessionView> = {}): AuthSessionView => ({
  authRequired: true,
  user: null,
  setupRequired: false,
  canSetup: false,
  localUrl: 'http://127.0.0.1:3004',
  providers: { password: true, google: false, emailLink: true, emailDelivery: 'console' },
  ...over,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
/** What each endpoint answers; a test replaces entries to change the server's behaviour. */
let server: Record<string, (body: unknown) => { status: number; json: unknown }>;

const ok = (json: unknown) => ({ status: 200, json });
const fail = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

beforeEach(() => {
  calls = [];
  server = {
    'GET /api/auth/session': () => ok(signedOut()),
    'POST /api/auth/logout': () => ok({ ok: true }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const handler = server[`${method} ${url}`];
      const { status, json } = handler ? handler(body) : fail(404, 'not_found', `no stub for ${method} ${url}`);
      return new Response(JSON.stringify(json), { status });
    }),
  );
  window.history.replaceState(null, '', '#');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#');
});

function SignedInApp() {
  const { user, signOut } = useAuth();
  return (
    <div>
      <p>The app, for {user?.username ?? 'nobody'}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

function renderGate() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <AuthGate>
          <SignedInApp />
        </AuthGate>
      </AuthProvider>
    </ToastProvider>,
  );
}

const posted = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

describe('the login gate', () => {
  it('shows the app straight away when the server needs no login', async () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ authRequired: false }));
    renderGate();
    expect(await screen.findByText('The app, for nobody')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows the login page, not the app, to a browser the server does not know', async () => {
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/The app, for/)).not.toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/session']);
  });

  it('shows the app to a browser that is already signed in', async () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ user: USER }));
    renderGate();
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
  });

  it('offers a retry when the server cannot be reached', async () => {
    server['GET /api/auth/session'] = () => fail(500, 'internal', 'boom');
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    server['GET /api/auth/session'] = () => ok(signedOut());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('returns to the login page when the server says the session ended', async () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ user: USER }));
    server['GET /api/overview'] = () => fail(401, 'unauthenticated', 'Sign in to continue.');
    renderGate();
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    server['GET /api/auth/session'] = () => ok(signedOut());
    const { api } = await import('../../api/endpoints');
    await expect(api.overview()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/The app, for/)).not.toBeInTheDocument();
  });

  it('signs out and shows the login page again', async () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ user: USER }));
    renderGate();
    await screen.findByText('The app, for haijin');
    server['GET /api/auth/session'] = () => ok(signedOut());
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(posted('/api/auth/logout')).toHaveLength(1);
  });
});

describe('username and password', () => {
  it('signs in and shows the app', async () => {
    server['POST /api/auth/login'] = () => ok(USER);
    renderGate();
    await userEvent.type(await screen.findByLabelText('Username or email'), 'haijin');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    expect(posted('/api/auth/login')[0]?.body).toEqual({ identifier: 'haijin', password: 'correct horse battery' });
  });

  it('shows the server’s reason next to the form and stays on the page', async () => {
    server['POST /api/auth/login'] = () => fail(401, 'invalid_credentials', 'Wrong username or password.');
    renderGate();
    await userEvent.type(await screen.findByLabelText('Username or email'), 'haijin');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('can show and hide the password', async () => {
    renderGate();
    const field = await screen.findByLabelText('Password');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'current-password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field).toHaveAttribute('type', 'password');
  });
});

describe('Google', () => {
  it('is disabled, with the reason, until the server has Google credentials', async () => {
    renderGate();
    const button = await screen.findByRole('button', { name: /Continue with Google/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/not set up on this server/);
  });

  it('is a plain link to the server’s Google start address when it is set up', async () => {
    server['GET /api/auth/session'] = () =>
      ok(signedOut({ providers: { password: true, google: true, emailLink: true, emailDelivery: 'smtp' } }));
    renderGate();
    const link = await screen.findByRole('link', { name: /Continue with Google/ });
    expect(link).toHaveAttribute('href', '/api/auth/google/start');
  });

  it('explains why Google sent the browser back, and clears the address bar', async () => {
    window.history.replaceState(null, '', '#/login?error=no_account');
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent(/no account for that Google address/i);
    expect(window.location.hash).toBe('#/login');
  });
});

describe('email link', () => {
  const openEmailTab = async () => {
    renderGate();
    await userEvent.click(await screen.findByRole('tab', { name: 'Email link' }));
  };

  it('asks for a link and says the mail only arrives if the address has an account', async () => {
    server['POST /api/auth/email/request'] = () => ok({ sent: true, delivery: 'smtp' });
    await openEmailTab();
    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const heading = await screen.findByRole('heading', { name: 'Check your email' });
    expect(heading.parentElement).toHaveTextContent(/If owner@example.com has an account/);
    expect(screen.queryByText(/printed in the terminal/)).not.toBeInTheDocument();
    expect(posted('/api/auth/email/request')[0]?.body).toEqual({ email: 'owner@example.com' });
    await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('tells the truth when no mail server is set up: the link is in the server terminal', async () => {
    server['POST /api/auth/email/request'] = () => ok({ sent: true, delivery: 'console' });
    await openEmailTab();
    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText(/nothing was mailed/)).toHaveTextContent(/printed in the terminal/);
  });

  it('shows the server’s refusal, such as too many requests', async () => {
    server['POST /api/auth/email/request'] = () => fail(429, 'too_many_attempts', 'A link was just sent.');
    await openEmailTab();
    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A link was just sent.');
  });

  it('signs in from an emailed link, once, and removes the token from the address bar', async () => {
    window.history.replaceState(null, '', '#/login?token=tok_abcdefghijklmnopqrstuvwxyz');
    server['POST /api/auth/email/verify'] = () => ok(USER);
    renderGate();
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    expect(posted('/api/auth/email/verify')).toHaveLength(1);
    expect(posted('/api/auth/email/verify')[0]?.body).toEqual({ token: 'tok_abcdefghijklmnopqrstuvwxyz' });
    expect(window.location.hash).toBe('#/today');
  });

  it('signs in from a link pasted into a tab that already shows the login page', async () => {
    server['POST /api/auth/email/verify'] = () => ok(USER);
    renderGate();
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(posted('/api/auth/email/verify')).toHaveLength(0);
    act(() => {
      window.location.hash = '#/login?token=tok_abcdefghijklmnopqrstuvwxyz';
    });
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    expect(posted('/api/auth/email/verify')).toHaveLength(1);
    expect(window.location.hash).toBe('#/today');
  });

  it('explains a Google error that arrives while the page is open', async () => {
    renderGate();
    await screen.findByRole('heading', { name: 'Sign in' });
    act(() => {
      window.location.hash = '#/login?error=google_denied';
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in was cancelled.');
    expect(window.location.hash).toBe('#/login');
  });

  it('says so when the link has expired and offers a new one', async () => {
    window.history.replaceState(null, '', '#/login?token=tok_abcdefghijklmnopqrstuvwxyz');
    server['POST /api/auth/email/verify'] = () =>
      fail(401, 'invalid_link', 'This link has expired or was already used.');
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login');
  });
});

describe('first run', () => {
  const firstRun = () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ setupRequired: true, canSetup: true }));
  };
  const fillSetup = async (over: { again?: string; password?: string } = {}) => {
    await userEvent.type(await screen.findByLabelText('Username'), 'haijin');
    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.type(screen.getByLabelText('Confirm email'), over.again ?? 'owner@example.com');
    await userEvent.type(screen.getByLabelText('Password'), over.password ?? 'correct horse battery');
    await userEvent.type(screen.getByLabelText('Setup code'), 'ABCD-EFGH');
  };

  it('creates the account from the machine itself, with the code from the server terminal', async () => {
    firstRun();
    server['POST /api/auth/register'] = () => ok(USER);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Setup code')).toHaveAccessibleDescription(/terminal where the server runs/);
    await fillSetup();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    expect(posted('/api/auth/register')[0]?.body).toEqual({
      username: 'haijin',
      email: 'owner@example.com',
      password: 'correct horse battery',
      setupCode: 'ABCD-EFGH',
    });
  });

  it('offers nothing but the setup form: Google and email links have no account to match yet', async () => {
    firstRun();
    renderGate();
    await screen.findByRole('heading', { name: 'Create your account' });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText(/Continue with Google/)).not.toBeInTheDocument();
  });

  it('does not send an address that was typed two different ways', async () => {
    firstRun();
    renderGate();
    await fillSetup({ again: 'owner@exampel.com' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The two email addresses do not match.');
    expect(posted('/api/auth/register')).toHaveLength(0);
  });

  it('shows what is wrong with the new account and keeps what was typed', async () => {
    firstRun();
    server['POST /api/auth/register'] = () => fail(400, 'invalid_password', 'Use at least 8 characters.');
    renderGate();
    await fillSetup({ password: 'short' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 8 characters.');
    expect(screen.getByLabelText('Username')).toHaveValue('haijin');
    expect(screen.getByLabelText('Setup code')).toHaveValue('ABCD-EFGH');
  });

  it('says when the setup code is wrong', async () => {
    firstRun();
    server['POST /api/auth/register'] = () =>
      fail(
        403,
        'invalid_setup_code',
        'That setup code is not right. It is printed in the terminal where the server runs.',
      );
    renderGate();
    await fillSetup();
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That setup code is not right.');
  });

  it('sends a remote visitor to the server’s own machine instead of offering setup', async () => {
    server['GET /api/auth/session'] = () => ok(signedOut({ setupRequired: true, canSetup: false }));
    renderGate();
    const note = await screen.findByText(/open/i);
    expect(note).toHaveTextContent('http://127.0.0.1:3004');
    expect(note).toHaveTextContent(/setup code printed in its terminal/);
    await waitFor(() => expect(screen.queryByLabelText('Password')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Continue with Google/ })).not.toBeInTheDocument();
  });
});

describe('an emailed link opened in a browser that is already signed in', () => {
  it('is removed from the address bar without being used', async () => {
    window.history.replaceState(null, '', '#/login?token=tok_abcdefghijklmnopqrstuvwxyz');
    server['GET /api/auth/session'] = () => ok(signedOut({ user: USER }));
    renderGate();
    expect(await screen.findByText('The app, for haijin')).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(posted('/api/auth/email/verify')).toHaveLength(0);
    // ...and one pasted later, into the open app, is dropped too.
    act(() => {
      window.location.hash = '#/login?token=tok_zyxwvutsrqponmlkjihgfedcba';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(posted('/api/auth/email/verify')).toHaveLength(0);
  });
});
