import { useEffect, useRef } from 'react';

/** True when the element takes typed text or arrow keys itself (inputs, selects, editable regions, range sliders). */
export function isTypingTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

/**
 * ArrowUp / ArrowDown while nothing that uses those keys has focus (and no modal is open).
 * The handlers are read through a ref so the listener is attached once.
 */
export function useArrowKeys(onUp: () => void, onDown: () => void, enabled = true): void {
  const handlers = useRef({ onUp, onDown });
  handlers.current = { onUp, onDown };

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      if (isTypingTarget(document.activeElement) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (event.key === 'ArrowUp') handlers.current.onUp();
      else handlers.current.onDown();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}
