import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api as http } from '../../api/endpoints';
import { type AiApi, AiRunController, type AiRunDeps, type AiState } from './aiRun';

/** The rewrite API over HTTP. */
export const httpAiApi: AiApi = {
  latest: (date) => http.journalAiLatest(date),
  start: (date, input) => http.startJournalAi(date, input),
  get: (runId) => http.journalAiRun(runId),
  cancel: (runId) => http.cancelJournalAi(runId),
  accept: (runId) => http.acceptJournalAi(runId),
  reject: (runId) => http.rejectJournalAi(runId),
};

type Host = Pick<AiRunDeps, 'ensureSaved' | 'onAccepted' | 'onCancelled'>;

/**
 * One rewrite controller per open day. The host's callbacks may change on every render; the controller always calls the
 * latest ones. `api` is only replaced in tests.
 */
export function useAiRun(
  date: string,
  host: Host,
  api: AiApi = httpAiApi,
): { controller: AiRunController; state: AiState } {
  const hostRef = useRef(host);
  hostRef.current = host;
  const [controller] = useState(
    () =>
      new AiRunController({
        date,
        api,
        ensureSaved: () => hostRef.current.ensureSaved(),
        onAccepted: (result) => hostRef.current.onAccepted(result),
        onCancelled: () => hostRef.current.onCancelled(),
      }),
  );
  useEffect(() => {
    controller.attach();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { controller, state };
}
