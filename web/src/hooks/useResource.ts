import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbort } from '../api/client';
import { useDataVersion } from '../state/dataVersion';

export interface ResourceOptions<T> {
  /** Skip fetching (e.g. nothing selected yet). Default true. */
  enabled?: boolean;
  /** Refetch after every write anywhere in the app (the data version counter). Default true. */
  refetchOnWrite?: boolean;
  /** While this returns true for the latest data, refetch every `pollMs`. */
  pollWhile?: (data: T) => boolean;
  pollMs?: number;
  /**
   * Like `deps`, a change refetches, but the previous data stays on screen until the new data arrives
   * (a slider that re-prices the same stock). Keep its length constant between renders.
   */
  softDeps?: readonly unknown[];
}

export interface Resource<T> {
  /** The latest data for the current deps. Kept (stale) while a refetch is in flight or has failed. */
  data: T | undefined;
  error: Error | null;
  /** First load for these deps: no data to show yet. */
  loading: boolean;
  /** A refetch is in flight and `data` is the previous result (stale-while-revalidate). */
  refreshing: boolean;
  refresh: () => void;
}

interface State<T> {
  deps: readonly unknown[];
  data: T | undefined;
  error: Error | null;
  pending: boolean;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Fetch-on-mount hook with abort on unmount, stale-while-revalidate and refetch after writes.
 * `deps` is the cache key: when it changes the old data is dropped (it belongs to another stock/page),
 * while `refresh()`, the write counter and polling keep showing the previous result until the new one arrives.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: ResourceOptions<T> = {},
): Resource<T> {
  const { enabled = true, refetchOnWrite = true, pollWhile, pollMs = 1500, softDeps = [] } = options;
  const { version } = useDataVersion();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State<T>>({ deps, data: undefined, error: null, pending: enabled });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const pollRef = useRef(pollWhile);
  pollRef.current = pollWhile;

  const writeKey = refetchOnWrite ? version : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's cache key, spread on purpose
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.pending ? { ...s, pending: false } : s));
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ deps, data: sameDeps(s.deps, deps) ? s.data : undefined, error: null, pending: true }));
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ deps, data, error: null, pending: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setState((s) => ({
          deps,
          data: sameDeps(s.deps, deps) ? s.data : undefined,
          error: toError(error),
          pending: false,
        }));
      },
    );
    return () => controller.abort();
  }, [...deps, ...softDeps, enabled, tick, writeKey]);

  useEffect(() => {
    const poll = pollRef.current;
    if (!enabled || !poll || state.data === undefined || state.pending || !poll(state.data)) return;
    const timer = setTimeout(() => setTick((t) => t + 1), pollMs);
    return () => clearTimeout(timer);
  }, [enabled, state.data, state.pending, pollMs]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const current = sameDeps(state.deps, deps);
  const data = current ? state.data : undefined;
  const pending = enabled && (current ? state.pending : true);
  return {
    data,
    error: current ? state.error : null,
    loading: pending && data === undefined,
    refreshing: pending && data !== undefined,
    refresh,
  };
}
