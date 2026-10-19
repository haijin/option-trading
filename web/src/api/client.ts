import type { ApiErrorBody } from './types';

/** An error answered by the server (or a failure to reach it). Never swallowed: callers toast or render it. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Human text for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: Method;
  /** JSON body for writes. `null` is sent as the JSON value null (used to clear valuation overrides). */
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /**
   * Lets the request outlive the page (the journal's save on `pagehide`). Browsers cap a keepalive body at 64 KB and
   * reject larger ones, so it is only set when the body is small enough; a bigger body is sent as a normal request.
   */
  keepalive?: boolean;
}

/** Below the 64 KB keepalive cap with room for headers. */
export const KEEPALIVE_MAX_BYTES = 60_000;

export const API_BASE = '/api';

const unauthenticatedListeners = new Set<() => void>();

/**
 * Subscribes to "the server no longer knows this browser": any answer of 401 `unauthenticated` (the session expired or
 * was ended elsewhere). The auth gate uses it to bring the login page back instead of leaving a page full of errors.
 */
export function onUnauthenticated(listener: () => void): () => void {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
}

/** Tells the auth gate the session is gone (a 401 `unauthenticated` from any request, including the image upload). */
export function notifyUnauthenticated(): void {
  for (const listener of unauthenticatedListeners) listener();
}

export function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${url}?${text}` : url;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * The one place that talks to the server. Sends and receives JSON, sets `Content-Type: application/json` on every
 * write (the server rejects writes without it) and turns an `ApiErrorBody` into an `ApiError`.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, signal: options.signal };
  if (isWrite) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body === undefined ? {} : options.body);
    if (options.keepalive && new TextEncoder().encode(init.body).length <= KEEPALIVE_MAX_BYTES) init.keepalive = true;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError('network_error', 'Cannot reach the server. Is it running?', 0, errorMessage(error));
  }

  const text = await response.text();
  let payload: unknown;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    if (isErrorBody(payload)) {
      const { code, message, details } = payload.error;
      if (response.status === 401 && code === 'unauthenticated') notifyUnauthenticated();
      throw new ApiError(code, message || `Request failed (HTTP ${response.status})`, response.status, details);
    }
    throw new ApiError(
      'http_error',
      `The server answered HTTP ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  if (payload === undefined) {
    throw new ApiError('bad_response', 'The server answered with something that is not JSON.', response.status);
  }
  return payload as T;
}
