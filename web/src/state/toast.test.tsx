import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './toast';

function setup() {
  let api: ReturnType<typeof useToast> | undefined;
  function Capture() {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>,
  );
  return () => api as ReturnType<typeof useToast>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('toast', () => {
  it('shows a message and removes it after the default time', () => {
    const api = setup();
    act(() => api().push('Saved.'));
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3700);
    });
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('keeps an action toast for the time it asks for, and the action runs once and closes it', () => {
    const api = setup();
    const onAction = vi.fn();
    act(() => api().push('Deleted.', 'info', { actionLabel: 'Undo', onAction, ms: 10_000 }));
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.getByText('Deleted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Deleted.')).toBeNull();
  });

  it('removes an unused action toast after its time (8 s by default)', () => {
    const api = setup();
    act(() => api().push('Replaced.', 'info', { actionLabel: 'Undo', onAction: () => undefined }));
    act(() => {
      vi.advanceTimersByTime(7_900);
    });
    expect(screen.getByText('Replaced.')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Replaced.')).toBeNull();
  });

  it('ignores an action label without a handler (a plain toast)', () => {
    const api = setup();
    act(() => api().push('Hello', 'info', { actionLabel: 'Undo' }));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
