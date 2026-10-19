import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | null;
const STORAGE_KEY = 'ot-theme';

function readStored(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    if (choice) window.localStorage.setItem(STORAGE_KEY, choice);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the choice just lasts for this session.
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

interface ThemeValue {
  /** What the user picked; null follows the system. */
  choice: ThemeChoice;
  /** What is actually shown. */
  effective: 'light' | 'dark';
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue>({ choice: null, effective: 'light', toggle: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
  }, [choice]);

  const effective = choice ?? (systemDark ? 'dark' : 'light');
  const toggle = useCallback(() => {
    const next = effective === 'dark' ? 'light' : 'dark';
    setChoice(next);
    writeStored(next);
  }, [effective]);

  const value = useMemo(() => ({ choice, effective, toggle }), [choice, effective, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
