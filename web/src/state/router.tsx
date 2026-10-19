import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useRoute } from '../hooks/useRoute';
import { DEFAULT_ROUTE, type Route } from '../lib/route';

interface RouterValue {
  route: Route;
  navigate: (route: Route) => void;
  replace: (route: Route) => void;
}

const RouterContext = createContext<RouterValue>({
  route: DEFAULT_ROUTE,
  navigate: () => undefined,
  replace: () => undefined,
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const { route, navigate, replace } = useRoute();
  const value = useMemo(() => ({ route, navigate, replace }), [route, navigate, replace]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}
