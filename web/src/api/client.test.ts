import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildUrl, isApiError, request } from './client';

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('builds URLs under /api and skips empty query values', () => {
    expect(buildUrl('/scan')).toBe('/api/scan');
    expect(buildUrl('/stocks/US/KO/value', { rate: undefined })).toBe('/api/stocks/US/KO/value');
    expect(buildUrl('/watchlist/preview', { raw: '0700', market: 'HK' })).toBe(
      '/api/watchlist/preview?raw=0700&market=HK',
    );
    expect(buildUrl('/watchlist/preview', { raw: 'BRK.B & co' })).toBe('/api/watchlist/preview?raw=BRK.B+%26+co');
  });

  it('sends GET requests without a body or content type', async () => {
    const fetchMock = stubFetch(() => json({ ok: true }));
    await expect(request('/health')).resolves.toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sets Content-Type: application/json and a JSON body on every write', async () => {
    const fetchMock = stubFetch(() => json({ done: 1 }));
    for (const method of ['POST', 'PUT', 'PATCH'] as const) {
      await request('/x', { method, body: { a: 1 } });
    }
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(init.body).toBe('{"a":1}');
    }
  });

  it('sends an empty object for a body-less write and null for an explicit null body', async () => {
    const fetchMock = stubFetch(() => json({}));
    await request('/scan/run', { method: 'POST' });
    await request('/stocks/US/KO/valuation', { method: 'PUT', body: null });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[1].body).toBe('{}');
    expect(calls[1]?.[1].body).toBe('null');
    const headers = (calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('turns an ApiErrorBody into an ApiError with code, message and status', async () => {
    stubFetch(() => json({ error: { code: 'equity_not_set', message: 'Equity is not set.', details: { a: 1 } } }, 409));
    const error = await request('/scan').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isApiError(error)).toBe(true);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('equity_not_set');
    expect(apiError.message).toBe('Equity is not set.');
    expect(apiError.status).toBe(409);
    expect(apiError.details).toEqual({ a: 1 });
  });

  it('reports a non-JSON error response (for example a proxy 502) instead of swallowing it', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const error = (await request('/scan').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('http_error');
    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });

  it('reports an unreachable server', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await request('/scan').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
  });

  it('rejects a success response that is not JSON', async () => {
    stubFetch(() => new Response('hello', { status: 200 }));
    const error = (await request('/scan').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('bad_response');
  });

  it('rethrows aborts untouched', async () => {
    stubFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await request('/scan').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(isApiError(error)).toBe(false);
  });
});

describe('keepalive', () => {
  it('passes keepalive to fetch for a small write and leaves it off by default', async () => {
    const fetchMock = stubFetch(() => json({ ok: true }));
    await request('/journal/entries/2026-10-13', { method: 'PUT', body: { a: 1 }, keepalive: true });
    await request('/journal/entries/2026-10-13', { method: 'PUT', body: { a: 1 } });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[1].keepalive).toBe(true);
    expect(calls[1]?.[1].keepalive).toBeUndefined();
  });

  it('sends a body over the 64 KB keepalive cap as a normal request (a keepalive one would be rejected)', async () => {
    const fetchMock = stubFetch(() => json({ ok: true }));
    await request('/x', { method: 'PUT', body: { text: 'a'.repeat(70_000) }, keepalive: true });
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].keepalive).toBeUndefined();
  });
});
