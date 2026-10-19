import { type FormEvent, useState } from 'react';
import { authApi } from '../../api/endpoints';
import type { AuthUserView } from '../../api/types';
import { LoginField } from './LoginField';
import { useSubmit } from './useSubmit';

/** A password input with a Show/Hide switch, so a long passphrase can be checked on a phone keyboard. */
function PasswordInput({
  value,
  onChange,
  autoComplete,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <LoginField label="Password" hint={hint}>
      {(field) => (
        <span className="pw">
          <input
            {...field}
            type={shown ? 'text' : 'password'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoComplete={autoComplete}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <button
            type="button"
            className="btn sm ghost pw-toggle"
            onClick={() => setShown((s) => !s)}
            aria-pressed={shown}
            aria-label={shown ? 'Hide password' : 'Show password'}
          >
            {shown ? 'Hide' : 'Show'}
          </button>
        </span>
      )}
    </LoginField>
  );
}

function FormError({ message }: { message: string | null }) {
  return message ? (
    <p className="field-error" role="alert">
      {message}
    </p>
  ) : null;
}

/** Username or email, plus password. */
export function SignInForm({ onSignedIn }: { onSignedIn: (user: AuthUserView) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const submit = useSubmit();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const user = await submit.run(() => authApi.login({ identifier, password }));
    if (user) onSignedIn(user);
  };

  return (
    <form className="login-form" onSubmit={onSubmit}>
      <LoginField label="Username or email">
        {(field) => (
          <input
            {...field}
            type="text"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        )}
      </LoginField>
      <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
      <FormError message={submit.error} />
      <button type="submit" className="btn primary wide" disabled={submit.busy}>
        {submit.busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="note">No password yet? Use Google or an email link.</p>
    </form>
  );
}

/** First run: the account that will own this app. */
export function SetupForm({ onSignedIn }: { onSignedIn: (user: AuthUserView) => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [again, setAgain] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const submit = useSubmit();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    // Email sign-in and Google match this address later, so a typo that is someone else's real address would let them in.
    const same = email.trim().toLowerCase() === again.trim().toLowerCase();
    setMismatch(!same);
    if (!same) return;
    const user = await submit.run(() => authApi.register({ username, email, password, setupCode }));
    if (user) onSignedIn(user);
  };

  return (
    <form className="login-form" onSubmit={onSubmit}>
      <LoginField label="Username" hint="3 to 32 letters, digits, dots, dashes or underscores.">
        {(field) => (
          <input
            {...field}
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        )}
      </LoginField>
      <LoginField label="Email" hint="Used for email sign-in links and Google sign-in.">
        {(field) => (
          <input
            {...field}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            required
          />
        )}
      </LoginField>
      <LoginField label="Confirm email">
        {(field) => (
          <input
            {...field}
            type="email"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            required
          />
        )}
      </LoginField>
      <PasswordInput
        hint="At least 8 characters."
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <LoginField label="Setup code" hint="Printed in the terminal where the server runs, like ABCD-EFGH.">
        {(field) => (
          <input
            {...field}
            type="text"
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        )}
      </LoginField>
      <FormError message={mismatch ? 'The two email addresses do not match.' : submit.error} />
      <button type="submit" className="btn primary wide" disabled={submit.busy}>
        {submit.busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}
