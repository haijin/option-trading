import { useCallback, useEffect, useState } from 'react';
import { isAbort, isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import type { JournalEntryView } from '../../api/types';
import { type LocalCopy, readLocalCopy } from './localCopy';

export type EntryLoad =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | {
      kind: 'ready';
      /** The server's entry; null when the day has none yet (404) or the server cannot be reached. */
      server: JournalEntryView | null;
      /** What this phone kept for the day. */
      local: LocalCopy | null;
      /** The server could not be reached and there is a copy on the phone to work from. */
      offline: boolean;
    };

/**
 * Loads one day: the server's entry (404 means "empty, local only"), plus the copy kept on the phone. When the server
 * cannot be reached but the phone has a copy, the editor opens on that copy and says so; with no copy it shows the error.
 */
export function useEntryLoad(date: string): { load: EntryLoad; retry: () => void } {
  const [load, setLoad] = useState<EntryLoad>({ kind: 'loading' });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the retry trigger
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: 'loading' });
    api.journalEntry(date, controller.signal).then(
      (server) => {
        if (!controller.signal.aborted) setLoad({ kind: 'ready', server, local: readLocalCopy(date), offline: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        if (isApiError(error) && error.status === 404) {
          setLoad({ kind: 'ready', server: null, local: readLocalCopy(date), offline: false });
          return;
        }
        const local = isApiError(error) && error.code === 'network_error' ? readLocalCopy(date) : null;
        if (local) setLoad({ kind: 'ready', server: null, local, offline: true });
        else setLoad({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => controller.abort();
  }, [date, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { load, retry };
}
