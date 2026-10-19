import { useCallback, useState } from 'react';
import { errorMessage } from '../../api/client';

/**
 * One form submission: a busy flag and the failure to show inline. The login forms render their own error (next to the
 * field that caused it), so this does not toast like `useMutation`, which also refreshes data that is not loaded yet.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
}
