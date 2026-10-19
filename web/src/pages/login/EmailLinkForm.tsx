import { type FormEvent, useState } from 'react';
import { authApi } from '../../api/endpoints';
import type { EmailLinkRequestView } from '../../api/types';
import { Callout } from '../../components/Callout';
import { LoginField } from './LoginField';
import { useSubmit } from './useSubmit';

/**
 * Asks for a one-time sign-in link. The server answers the same way whether or not the address has an account, so
 * the wording after sending never claims that a mail was sent.
 */
export function EmailLinkForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ email: string; view: EmailLinkRequestView } | null>(null);
  const submit = useSubmit();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const view = await submit.run(() => authApi.requestEmailLink(email));
    if (view) setSent({ email: email.trim(), view });
  };

  if (sent) {
    return (
      <div className="login-form" role="status">
        <h2>Check your email</h2>
        <p>
          If <b>{sent.email}</b> has an account, a sign-in link is on its way. It works once and expires in 15 minutes.
        </p>
        {sent.view.delivery === 'console' ? (
          <Callout kind="blue">
            This server has no mail account set up, so nothing was mailed. The link was printed in the terminal where
            the server runs.
          </Callout>
        ) : (
          <p className="note">Nothing after a few minutes? Check your spam folder.</p>
        )}
        <button type="button" className="btn wide" onClick={() => setSent(null)}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form className="login-form" onSubmit={onSubmit}>
      <LoginField label="Email" hint="We email you a link that signs you in. No password needed.">
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
      {submit.error ? (
        <p className="field-error" role="alert">
          {submit.error}
        </p>
      ) : null}
      <button type="submit" className="btn primary wide" disabled={submit.busy}>
        {submit.busy ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}
