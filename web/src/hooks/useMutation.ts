import { useCallback, useRef, useState } from 'react';
import { ApiError, errorMessage, isApiError } from '../api/client';
import { useDataVersion } from '../state/dataVersion';
import { useToast } from '../state/toast';

export interface RunOptions<T> {
  /** Toast shown on success; a function gets the result. */
  success?: string | ((value: T) => string);
  /** Bump the data version so every page refetches. Default true. */
  bump?: boolean;
  /** Do not toast a failure (the caller renders `error` inline). */
  inlineError?: boolean;
}

export interface Mutation {
  busy: boolean;
  /** The last failure of `run`, cleared by the next run. */
  error: ApiError | null;
  /** Runs a write. Resolves with the value, or undefined after a failure (which is toasted, never swallowed). */
  run: <T>(action: () => Promise<T>, options?: RunOptions<T>) => Promise<T | undefined>;
  clearError: () => void;
}

/**
 * Wraps a write: busy flag, error toast, success toast, and the data-version bump that refreshes the overview
 * and whatever page is open.
 */
export function useMutation(): Mutation {
  const toast = useToast();
  const { bump } = useDataVersion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef(0);

  const run = useCallback(
    async <T>(action: () => Promise<T>, options: RunOptions<T> = {}): Promise<T | undefined> => {
      inFlight.current++;
      setBusy(true);
      setError(null);
      try {
        const value = await action();
        if (options.success)
          toast.push(typeof options.success === 'function' ? options.success(value) : options.success);
        if (options.bump !== false) bump();
        return value;
      } catch (caught) {
        const apiError = isApiError(caught) ? caught : new ApiError('client_error', errorMessage(caught), 0);
        setError(apiError);
        if (!options.inlineError) toast.error(apiError.message);
        return undefined;
      } finally {
        inFlight.current--;
        if (inFlight.current === 0) setBusy(false);
      }
    },
    [toast, bump],
  );

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
