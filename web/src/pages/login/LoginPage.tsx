import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { authApi } from '../../api/endpoints';
import type { AuthSessionView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { type TabDef, Tabs } from '../../components/Tabs';
import { useAuth } from '../../state/auth';
import { EmailLinkForm } from './EmailLinkForm';
import { GoogleButton } from './GoogleButton';
import { LoginShell } from './LoginShell';
import { clearLoginHash, loginErrorMessage, readLoginHash } from './loginHash';
import { SetupForm, SignInForm } from './PasswordForms';

type Method = 'password' | 'email';

/**
 * The page shown to a browser the server does not know: Google, a password, or an emailed link. On a brand-new
 * install it creates the account instead, but only from the server's own machine (the server enforces that; the page
 * just explains it).
 */
export function LoginPage({ session }: { session: AuthSessionView }) {
  const { signedIn } = useAuth();
  const [method, setMethod] = useState<Method>('password');
  // Start in "checking" when the page opens on an emailed link, so the form does not flash first.
  const [verifying, setVerifying] = useState(() => readLoginHash(window.location.hash).token !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const spent = useRef(new Set<string>());

  useEffect(() => {
    // The address can carry a one-time token (emailed link) or a reason (Google came back empty), either when the page
    // loads or later, when a link is pasted into a tab that already shows this page. Both are read once and removed
    // from the address bar; a token is never sent twice (React's dev double-run, a repeated hashchange).
    const consume = () => {
      const found = readLoginHash(window.location.hash);
      clearLoginHash();
      if (found.error) setNotice(loginErrorMessage(found.error));
      if (!found.token || spent.current.has(found.token)) return;
      spent.current.add(found.token);
      setVerifying(true);
      authApi
        .verifyEmailLink(found.token)
        .then(signedIn)
        .catch((caught: unknown) => {
          setNotice(errorMessage(caught));
          setMethod('email');
        })
        .finally(() => setVerifying(false));
    };
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, [signedIn]);

  if (verifying)
    return (
      <LoginShell title="Signing you in">
        <p className="muted" role="status">
          Checking your sign-in link&hellip;
        </p>
      </LoginShell>
    );

  if (session.setupRequired && !session.canSetup)
    return (
      <LoginShell title="Set up Option Trading">
        <Callout kind="blue" role="status">
          No account exists yet. To create it, open <span className="mono">{session.localUrl}</span> on the computer
          that runs this server and enter the setup code printed in its terminal. Setup is not offered through a public
          address.
        </Callout>
      </LoginShell>
    );

  // First run: there is no account to sign in to, so Google and email links have nothing to match. Only the setup form
  // (which needs the code from the server's terminal) can create the account.
  if (session.setupRequired)
    return (
      <LoginShell title="Create your account" subtitle="First run: this account owns the app">
        {notice ? (
          <Callout kind="fail" role="alert">
            {notice}
          </Callout>
        ) : null}
        <SetupForm onSignedIn={signedIn} />
      </LoginShell>
    );

  const tabs: readonly TabDef<Method>[] = [
    { id: 'password', label: 'Password' },
    { id: 'email', label: 'Email link' },
  ];

  return (
    <LoginShell title="Sign in" subtitle="Sell-put decision support">
      {notice ? (
        <Callout kind="fail" role="alert">
          {notice}
        </Callout>
      ) : null}
      <GoogleButton enabled={session.providers.google} />
      <div className="login-or" aria-hidden="true">
        or
      </div>
      <Tabs tabs={tabs} value={method} onChange={setMethod} label="Sign-in method" />
      {method === 'password' ? <SignInForm onSignedIn={signedIn} /> : <EmailLinkForm />}
    </LoginShell>
  );
}
