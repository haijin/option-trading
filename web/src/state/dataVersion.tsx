import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

interface DataVersionValue {
  /** Bumped after every successful write; resources refetch when it changes. */
  version: number;
  bump: () => void;
}

const DataVersionContext = createContext<DataVersionValue>({ version: 0, bump: () => undefined });

export function DataVersionProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return <DataVersionContext.Provider value={value}>{children}</DataVersionContext.Provider>;
}

export function useDataVersion(): DataVersionValue {
  return useContext(DataVersionContext);
}
