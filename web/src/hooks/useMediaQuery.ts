import { useEffect, useState } from 'react';

/** Below this width the app switches to the phone layout: bottom tab bar, one pane at a time. Keep in sync with layout.css. */
export const MOBILE_QUERY = '(max-width: 899px)';

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setValue(event.matches);
    setValue(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return value;
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
