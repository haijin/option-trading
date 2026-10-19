import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Open sheets, topmost last: only the topmost one reacts to Escape and Tab. */
const stack: symbol[] = [];

/**
 * The prototype's sheet: a bottom sheet on a phone (grab handle, 92 dvh at most, the body scrolls and the footer stays
 * put), a centred dialog on desktop. Same accessibility as `components/Modal`: `role="dialog"`, `aria-modal`, a label,
 * focus moves in and is trapped, Escape and the scrim close it, focus goes back to where it was.
 * `dismissible={false}` is for a choice that must be made (the 409 dialog): no close button, no Escape, no scrim.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  badge,
  dismissible = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  badge?: ReactNode;
  dismissible?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const token = Symbol('sheet');
    stack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = () => (dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    const first = dialog?.querySelector<HTMLElement>('.jr-sb button, .jr-sb a[href], .jr-sb input, .jr-sb textarea');
    (first ?? focusables()[0] ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        if (!dismissibleRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    // A click, not a pointerdown: closing on touch-start would let the same tap fall through to what is underneath.
    const scrim = scrimRef.current;
    const onScrim = (event: MouseEvent) => {
      if (dismissibleRef.current && event.target === scrim) onCloseRef.current();
    };
    scrim?.addEventListener('click', onScrim);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      scrim?.removeEventListener('click', onScrim);
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.indexOf(token);
      if (index >= 0) stack.splice(index, 1);
      // Do not hand focus back to a button that has gone (the sheet was opened from a menu that closed with it).
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div className="jr-layer">
      <div className="jr-scrim" ref={scrimRef} data-testid="jr-scrim" />
      <div ref={dialogRef} className="jr-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="jr-grab" aria-hidden="true" />
        <div className="jr-sh">
          <h3 id={titleId}>{title}</h3>
          {badge}
          {dismissible ? (
            <button type="button" className="jr-x" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="jr-sb">{children}</div>
        {footer ? <div className="jr-sf">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
