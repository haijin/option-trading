import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { api } from '../api/endpoints';
import type { ReminderView } from '../api/types';
import { useResource } from '../hooks/useResource';
import { dueToday } from '../lib/reminders';

export type { ReminderView };

export interface RemindersValue {
  /** Hong Kong calendar day the list is built for. */
  today: string;
  items: ReminderView[];
  due: number;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

const RemindersContext = createContext<RemindersValue>({
  today: '',
  items: [],
  due: 0,
  loading: false,
  error: null,
  refresh: () => undefined,
});

/** Hong Kong's calendar date right now. */
export const hkToday = (): string => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

/**
 * Fetches GET /api/reminders (a server-built list from corporate events, open puts and classified news)
 * and shares it between the bell, the Home panel and the Reminders page. Refetched after every write.
 */
export function RemindersProvider({ children }: { children: ReactNode }) {
  const resource = useResource((signal) => api.reminders(30, signal), []);
  const today = hkToday();
  const value = useMemo<RemindersValue>(() => {
    const data = resource.data;
    const items: ReminderView[] = data ? [...(data.today ?? []), ...(data.upcoming ?? [])] : [];
    return {
      today: data?.asOf ?? today,
      items,
      due: dueToday(items, data?.asOf ?? today),
      loading: resource.loading,
      error: resource.error,
      refresh: resource.refresh,
    };
  }, [resource, today]);
  return <RemindersContext.Provider value={value}>{children}</RemindersContext.Provider>;
}

export function useReminders(): RemindersValue {
  return useContext(RemindersContext);
}
