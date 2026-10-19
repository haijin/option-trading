import { type ReactNode, useEffect } from 'react';
import { useAuth } from '../../state/auth';
import { LoginPage } from './LoginPage';
import { leaveLoginHash } from './loginHash';

/**
 * Shows the login page instead of the app until the server says this browser is signed in (or needs no login).
 * Once the app is showing, a `#/login...` address (an emailed link opened in a browser that is already signed in) is
 * replaced at once, so its one-time token does not stay in the address bar or the history.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const inApp = session !== undefined && (!session.authRequired || session.user !== null);

  useEffect(() => {
    if (!inApp) return;
    leaveLoginHash();
    window.addEventListener('hashchange', leaveLoginHash);
    return () => window.removeEventListener('hashchange', leaveLoginHash);
  }, [inApp]);

  if (session?.authRequired && !session.user) return <LoginPage session={session} />;
  return <>{children}</>;
}
