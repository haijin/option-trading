import { useCallback, useEffect, useState } from 'react';
import { parseHash, type Route, sameRoute, toHash } from '../lib/route';

function current(): Route {
  return parseHash(window.location.hash);
}

/**
 * Tiny hash router. `navigate` pushes a history entry; `replace` swaps the current one (used for keyboard
 * selection so Back does not step through every arrow press).
 */
export function useRoute(): { route: Route; navigate: (route: Route) => void; replace: (route: Route) => void } {
  const [route, setRoute] = useState<Route>(current);

  useEffect(() => {
    const onChange = () =>
      setRoute((previous) => {
        const next = current();
        return sameRoute(previous, next) ? previous : next;
      });
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = toHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  const replace = useCallback((next: Route) => {
    const hash = toHash(next);
    if (window.location.hash === hash) return;
    const url = new URL(window.location.href);
    url.hash = hash;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, []);

  return { route, navigate, replace };
}
