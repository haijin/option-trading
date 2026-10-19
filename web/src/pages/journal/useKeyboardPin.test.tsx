import { act, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardPin } from './useKeyboardPin';

/** A visual viewport that tests can resize and scroll, like iOS does when the keyboard opens. */
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

function fakeEditor(dom: HTMLElement) {
  const handlers = new Map<string, Set<() => void>>();
  const editor = {
    isDestroyed: false,
    view: { dom },
    on: (name: string, fn: () => void) => void (handlers.get(name) ?? handlers.set(name, new Set()).get(name))?.add(fn),
    off: (name: string, fn: () => void) => void handlers.get(name)?.delete(fn),
  };
  return {
    editor: editor as unknown as Editor,
    emit: (name: string) => {
      for (const fn of handlers.get(name) ?? []) fn();
    },
  };
}

function Harness({ editor, layoutKey }: { editor: Editor; layoutKey: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeyboardPin(ref, editor, layoutKey);
  return <div ref={ref} data-testid="toolbar" />;
}

let vv: FakeViewport;

beforeEach(() => {
  vv = new FakeViewport();
  vi.stubGlobal('visualViewport', vv);
  // jsdom has no matchMedia: the hook treats that as "not desktop"; make it explicit for each test
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('innerHeight', 800);
  document.body.className = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.className = '';
});

function setup(layoutKey: unknown = 0) {
  const dom = document.createElement('div');
  dom.tabIndex = 0;
  document.body.appendChild(dom);
  const { editor, emit } = fakeEditor(dom);
  const view = render(<Harness editor={editor} layoutKey={layoutKey} />);
  return { dom, emit, toolbar: view.getByTestId('toolbar'), view, editor };
}

describe('useKeyboardPin', () => {
  it('pins the toolbar to the top edge of the keyboard and hides the tab bar while the document has focus', () => {
    const { dom, emit, toolbar } = setup();
    dom.focus();
    act(() => {
      vv.height = 500; // a 300 px keyboard
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).toHaveClass('kb');
    // jsdom has no layout, so the toolbar is 0 px tall: its top is the keyboard's top edge
    expect(toolbar.style.top).toBe('500px');
    expect(toolbar.style.bottom).toBe('auto');
    emit('focus');
    expect(document.body).toHaveClass('kb');
  });

  it('follows the visual viewport when iOS scrolls it', () => {
    const { dom, toolbar } = setup();
    dom.focus();
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    act(() => {
      vv.offsetTop = 120;
      vv.height = 380; // still the same keyboard: 800 - 380 - 120 = 300
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(toolbar.style.top).toBe('500px');
    expect(document.body).toHaveClass('kb');
  });

  it('does nothing while a field outside the document has focus', () => {
    const { toolbar } = setup();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).not.toHaveClass('kb');
    expect(toolbar.style.top).toBe('');
  });

  it('does nothing while the viewport is full height (no keyboard)', () => {
    const { dom } = setup();
    dom.focus();
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).not.toHaveClass('kb');
  });

  it('puts everything back when the keyboard closes and when the page goes away', () => {
    const { dom, toolbar, view } = setup();
    dom.focus();
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).toHaveClass('kb');
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).not.toHaveClass('kb');
    expect(toolbar.style.top).toBe('');
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    view.unmount();
    expect(document.body).not.toHaveClass('kb');
  });

  it('leaves the toolbar inline on desktop', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { dom, toolbar } = setup();
    dom.focus();
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(document.body).not.toHaveClass('kb');
    expect(toolbar.style.top).toBe('');
  });

  it('works without a visual viewport (older browsers)', () => {
    vi.stubGlobal('visualViewport', undefined);
    const { dom, toolbar } = setup();
    expect(() => dom.focus()).not.toThrow();
    expect(toolbar.style.top).toBe('');
    expect(document.body).not.toHaveClass('kb');
  });
});
