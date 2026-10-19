import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Callout({
  kind = '',
  action,
  children,
  role,
}: {
  kind?: 'blue' | 'fail' | 'ok' | '';
  action?: ReactNode;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`callout ${kind}`.trim()} role={role}>
      <span className="ctext">{children}</span>
      {action}
    </div>
  );
}

/** A failed fetch, with a retry button. */
export function ErrorBanner({ error, onRetry, title }: { error: Error; onRetry?: () => void; title?: string }) {
  const code = error instanceof ApiError ? error.code : null;
  return (
    <Callout
      kind="fail"
      role="alert"
      action={
        onRetry ? (
          <button type="button" className="btn sm" onClick={onRetry}>
            Retry
          </button>
        ) : undefined
      }
    >
      <b>{title ?? 'Could not load this.'}</b> {error.message}
      {code && code !== 'network_error' ? <span className="mono"> ({code})</span> : null}
    </Callout>
  );
}
