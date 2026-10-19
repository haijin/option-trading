import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Open modals, topmost last: only the topmost one reacts to Escape and Tab. */
const stack: symbol[] = [];

/**
 * Dialog with a focus trap: focus moves in on open (first form control, else the first button), Tab cycles inside,
 * Escape and a click on the backdrop close it, and focus returns to what had it before.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Extra class on the dialog, for a page that styles its own sheet. */
  className?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const token = Symbol('modal');
    stack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = () => (dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    const firstControl = dialog?.querySelector<HTMLElement>('.mb input:not([disabled]), .mb select, .mb textarea');
    (firstControl ?? focusables()[0] ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === 'Escape') {
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
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // A press on the backdrop itself (not on the dialog) closes the modal.
    const overlay = overlayRef.current;
    const onBackdrop = (event: MouseEvent) => {
      if (event.target === overlay) onCloseRef.current();
    };
    overlay?.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      overlay?.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.indexOf(token);
      if (index >= 0) stack.splice(index, 1);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="overlay" ref={overlayRef}>
      <div
        ref={dialogRef}
        className={`${wide ? 'modal wide' : 'modal'} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="mh">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="btn ghost" aria-label="Close" onClick={onClose}>
            {'✕'}
          </button>
        </div>
        <div className="mb">{children}</div>
        {footer ? <div className="mf">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
