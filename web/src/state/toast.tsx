import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type ToastKind = 'info' | 'error';

/** An optional button on a toast ("Undo"). Pressing it dismisses the toast and runs `onAction`. */
export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  /** How long the toast stays, ms. Default 3.6 s (7 s for errors, 8 s when there is an action). */
  ms?: number;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind, options?: ToastOptions) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined, error: () => undefined });

const LIFETIME_MS: Record<ToastKind, number> = { info: 3600, error: 7000 };
const ACTION_LIFETIME_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (message: string, kind: ToastKind = 'info', options: ToastOptions = {}) => {
      const id = nextId.current++;
      const hasAction = Boolean(options.actionLabel && options.onAction);
      setItems((current) => [
        ...current.slice(-3),
        { id, kind, message, actionLabel: hasAction ? options.actionLabel : undefined, onAction: options.onAction },
      ]);
      const ms = options.ms ?? (hasAction ? ACTION_LIFETIME_MS : LIFETIME_MS[kind]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, error: (message) => push(message, 'error') }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false" role="status">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <span style={item.actionLabel ? { alignSelf: 'center' } : undefined}>{item.message}</span>
            {item.actionLabel ? (
              <button
                type="button"
                className="toast-x"
                style={{ opacity: 1, fontWeight: 700, textDecoration: 'underline', padding: '10px 8px', minHeight: 44 }}
                onClick={() => {
                  dismiss(item.id);
                  item.onAction?.();
                }}
              >
                {item.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-x"
              aria-label="Dismiss message"
              style={item.actionLabel ? { alignSelf: 'center' } : undefined}
              onClick={() => dismiss(item.id)}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
