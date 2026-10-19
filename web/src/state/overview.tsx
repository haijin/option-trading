import { createContext, type ReactNode, useContext } from 'react';
import { api } from '../api/endpoints';
import type { OverviewView } from '../api/types';
import { type Resource, useResource } from '../hooks/useResource';

const REFRESH_MS = 60_000;

const OverviewContext = createContext<Resource<OverviewView>>({
  data: undefined,
  error: null,
  loading: false,
  refreshing: false,
  refresh: () => undefined,
});

/** Overview for the top bar: refetched after every write (data version) and every 60 seconds. */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const resource = useResource((signal) => api.overview(signal), [], {
    pollWhile: () => true,
    pollMs: REFRESH_MS,
  });
  return <OverviewContext.Provider value={resource}>{children}</OverviewContext.Provider>;
}

export function useOverview(): Resource<OverviewView> {
  return useContext(OverviewContext);
}
