import type { Editor } from '@tiptap/core';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

const DESKTOP_QUERY = '(min-width: 900px)';

/**
 * iOS keeps `position: fixed` elements behind the keyboard. The visual viewport says where the keyboard starts, so while
 * the document has focus and the keyboard is open the toolbar sits on its top edge and the tab bar hides (body class
 * `kb`). On desktop the toolbar is inline and none of this applies. This is the prototype's `placeToolbar`; it needs the
 * real-device pass on iOS Safari and the home-screen app (a desktop browser has no on-screen keyboard).
 *
 * `layoutKey` changes when the bar's height changes (the table tools appear) so the pinned position is recomputed.
 */
export function useKeyboardPin(
  wrapRef: RefObject<HTMLElement | null>,
  editor: Editor | null,
  layoutKey: unknown,
): void {
  const place = (): void => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const vv = window.visualViewport;
    const reset = () => {
      document.body.classList.remove('kb');
      wrap.style.top = '';
      wrap.style.bottom = '';
    };
    let desktop = false;
    try {
      desktop = window.matchMedia(DESKTOP_QUERY).matches;
    } catch {
      desktop = false;
    }
    if (desktop || !vv || !editor || editor.isDestroyed) {
      reset();
      return;
    }
    const editing = editor.view.dom.contains(document.activeElement);
    const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
    const open = editing && keyboardHeight > 60;
    document.body.classList.toggle('kb', open);
    if (open) {
      wrap.style.top = `${vv.offsetTop + vv.height - wrap.offsetHeight}px`;
      wrap.style.bottom = 'auto';
    } else {
      wrap.style.top = '';
      wrap.style.bottom = '';
    }
  };

  // The latest `place` for the listeners below, which are attached once.
  const latest = useRef(place);
  latest.current = place;

  useEffect(() => {
    if (!editor) return;
    const vv = window.visualViewport;
    const onChange = () => latest.current();
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onBlur = () => {
      blurTimer = setTimeout(onChange, 80);
    };
    vv?.addEventListener('resize', onChange);
    vv?.addEventListener('scroll', onChange);
    window.addEventListener('resize', onChange);
    editor.on('focus', onChange);
    editor.on('blur', onBlur);
    return () => {
      vv?.removeEventListener('resize', onChange);
      vv?.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
      editor.off('focus', onChange);
      editor.off('blur', onBlur);
      if (blurTimer) clearTimeout(blurTimer);
      document.body.classList.remove('kb');
      const wrap = wrapRef.current;
      if (wrap) {
        wrap.style.top = '';
        wrap.style.bottom = '';
      }
    };
  }, [editor, wrapRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `layoutKey` is the trigger
  useLayoutEffect(() => {
    place();
  }, [layoutKey]);
}
