import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { errorMessage, isAbort, onUnauthenticated } from '../api/client';
import { authApi } from '../api/endpoints';
import type { AuthSessionView, AuthUserView } from '../api/types';
import { ErrorBanner } from '../components/Callout';
import { LoginShell } from '../pages/login/LoginShell';
import { leaveLoginHash } from '../pages/login/loginHash';
import { useToast } from './toast';

interface AuthValue {
  /** What the server said about this browser; undefined until the first answer. */
  session: AuthSessionView | undefined;
  /** The signed-in account, or null when signed out or when the server runs without a login. */
  user: AuthUserView | null;
  /** Called by the login forms once the server has set the session cookie. */
  signedIn: (user: AuthUserView) => void;
  signOut: () => Promise<void>;
  /** Asks the server again (after an error, or when the session ended). */
  reload: () => void;
}

const AuthContext = createContext<AuthValue>({
  session: undefined,
  user: null,
  signedIn: () => undefined,
  signOut: async () => undefined,
  reload: () => undefined,
});

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

/**
 * Knows who is signed in. It asks `/api/auth/session` once, listens for the server answering 401 `unauthenticated`
 * (the session ended), and hands the login forms a way to say "signed in now".
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [session, setSession] = useState<AuthSessionView>();
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    const controller = new AbortController();
    authApi
      .session(controller.signal)
      .then((view) => {
        setSession(view);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!isAbort(caught)) setError(caught instanceof Error ? caught : new Error(errorMessage(caught)));
      });
    return () => controller.abort();
  }, [attempt]);

  // The server stopped recognising this browser: show the login page again (and learn whether setup is needed).
  useEffect(() => onUnauthenticated(reload), [reload]);

  const signedIn = useCallback((user: AuthUserView) => {
    setSession((current) => (current ? { ...current, user, setupRequired: false, canSetup: false } : current));
    leaveLoginHash();
  }, []);

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (caught) {
      toast.error(errorMessage(caught));
      return;
    }
    setSession((current) => (current ? { ...current, user: null } : current));
    reload();
  }, [toast, reload]);

  const value = useMemo<AuthValue>(
    () => ({ session, user: session?.user ?? null, signedIn, signOut, reload }),
    [session, signedIn, signOut, reload],
  );

  if (!session) {
    return (
      <LoginShell>
        {error ? (
          <ErrorBanner error={error} onRetry={reload} title="Could not reach the server." />
        ) : (
          <p className="muted" role="status">
            Loading&hellip;
          </p>
        )}
      </LoginShell>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
