import { createReplayFetch } from '../providers/http-replay';

/**
 * OT_HTTP_REPLAY_DIR (one or more directories separated by `;`) replays recorded HTTP fixtures instead of calling
 * Yahoo or Stooq: used by the offline e2e suite. Unset, the real `fetch` is used.
 */
export function replayFetchFromEnv(): typeof fetch {
  const dirs = process.env.OT_HTTP_REPLAY_DIR;
  return dirs ? createReplayFetch(dirs.split(';').filter(Boolean)) : fetch;
}
