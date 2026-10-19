import { UserError } from '../core/util';
import type { ApiErrorBody } from './api-types';

/** An error that maps to an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(400, code, message, details);
export const notFound = (message: string, code = 'not_found'): ApiError => new ApiError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(409, code, message, details);
export const unavailable = (code: string, message: string): ApiError => new ApiError(503, code, message);

/** Turns anything thrown below the routes into a response body. User-facing errors keep their message; bugs do not leak a stack. */
export function toErrorResponse(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: {
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      },
    };
  }
  if (err instanceof UserError) {
    let code = 'user_error';
    if (err.message.startsWith('equity is not set')) code = 'equity_not_set';
    else if (err.message.startsWith('the watchlist is empty')) code = 'watchlist_empty';
    return { status: 400, body: { error: { code, message: err.message } } };
  }
  // A table the code expects is missing: the database has not been migrated for this version of the app.
  const pg = (err as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null) ?? {};
  if (pg.code === '42P01' || pg.cause?.code === '42P01') {
    return {
      status: 503,
      body: {
        error: {
          code: 'migration_needed',
          message: 'The database is missing a table this version needs: run `pnpm db:migrate`, then reload.',
        },
      },
    };
  }
  // Postgres class 22 (data exception): a value the database cannot store (a NUL character, a number out of range).
  if (/^22[0-9A-Z]{3}$/.test(String(pg.code ?? pg.cause?.code ?? ''))) {
    return {
      status: 400,
      body: {
        error: {
          code: 'invalid_value',
          message: 'A value in the request cannot be stored: check for control characters or numbers out of range.',
        },
      },
    };
  }
  const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return {
      status: e.statusCode,
      body: { error: { code: e.code ?? 'bad_request', message: e.message ?? 'bad request' } },
    };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'internal error: see the server log' } } };
}
