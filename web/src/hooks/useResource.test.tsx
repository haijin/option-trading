import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataVersionProvider, useDataVersion } from '../state/dataVersion';
import { useResource } from './useResource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useResource', () => {
  it('loads data and reports loading, then done', async () => {
    const { result } = renderHook(() => useResource(async () => 'hello', []));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe('hello'));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('keeps the previous data while refreshing (stale-while-revalidate)', async () => {
    let call = 0;
    const gates = [deferred<string>(), deferred<string>()];
    const fetcher = vi.fn(async () => (gates[call++] as ReturnType<typeof deferred<string>>).promise);
    const { result } = renderHook(() => useResource(fetcher, []));
    await act(async () => gates[0]?.resolve('first'));
    await waitFor(() => expect(result.current.data).toBe('first'));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.data).toBe('first');
    expect(result.current.loading).toBe(false);

    await act(async () => gates[1]?.resolve('second'));
    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(result.current.refreshing).toBe(false);
  });

  it('drops the old data when the deps change (it belongs to another stock)', async () => {
    const gate = deferred<string>();
    const { result, rerender } = renderHook(
      ({ symbol }) =>
        useResource(() => (symbol === 'KO' ? Promise.resolve(`data for ${symbol}`) : gate.promise), [symbol]),
      { initialProps: { symbol: 'KO' } },
    );
    await waitFor(() => expect(result.current.data).toBe('data for KO'));
    rerender({ symbol: 'CSCO' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => gate.resolve('data for CSCO'));
    await waitFor(() => expect(result.current.data).toBe('data for CSCO'));
  });

  it('keeps data across softDeps changes', async () => {
    const gate = deferred<string>();
    const { result, rerender } = renderHook(
      ({ rate }) =>
        useResource(() => (rate === 8 ? Promise.resolve('at 8') : gate.promise), ['KO'], { softDeps: [rate] }),
      { initialProps: { rate: 8 } },
    );
    await waitFor(() => expect(result.current.data).toBe('at 8'));
    rerender({ rate: 10 });
    expect(result.current.data).toBe('at 8');
    expect(result.current.refreshing).toBe(true);
    await act(async () => gate.resolve('at 10'));
    await waitFor(() => expect(result.current.data).toBe('at 10'));
  });

  it('keeps stale data and exposes the error when a refetch fails', async () => {
    let fail = false;
    const { result } = renderHook(() =>
      useResource(async () => {
        if (fail) throw new Error('boom');
        return 'ok';
      }, []),
    );
    await waitFor(() => expect(result.current.data).toBe('ok'));
    fail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.data).toBe('ok');
  });

  it('aborts the in-flight request on unmount and does not update afterwards', async () => {
    let seen: AbortSignal | undefined;
    const gate = deferred<string>();
    const { unmount } = renderHook(() =>
      useResource((signal) => {
        seen = signal;
        return gate.promise;
      }, []),
    );
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    unmount();
    expect(seen?.aborted).toBe(true);
    await act(async () => gate.resolve('late'));
  });

  it('does not fetch while disabled', async () => {
    const fetcher = vi.fn(async () => 'x');
    const { result } = renderHook(() => useResource(fetcher, [], { enabled: false }));
    await act(async () => undefined);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('refetches after a write bumps the data version', async () => {
    let calls = 0;
    const wrapper = ({ children }: { children: ReactNode }) => <DataVersionProvider>{children}</DataVersionProvider>;
    const { result } = renderHook(
      () => ({ resource: useResource(async () => ++calls, []), version: useDataVersion() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.resource.data).toBe(1));
    act(() => result.current.version.bump());
    await waitFor(() => expect(result.current.resource.data).toBe(2));
  });

  it('polls while the predicate says so and stops afterwards', async () => {
    let calls = 0;
    const { result } = renderHook(() => useResource(async () => ++calls, [], { pollMs: 20, pollWhile: (n) => n < 3 }));
    await waitFor(() => expect(result.current.data).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(3);
  });
});
