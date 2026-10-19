import type { ISODate } from '../../src/server/api-types';
import { invalid, isIsoDate, isRecord } from './util';

interface NumOpts {
  min?: number;
  max?: number;
  int?: boolean;
  /** Strictly greater than zero. */
  positive?: boolean;
}

/** Typed reader over a parsed JSON body. Every failure is a 422 `validation_error` naming the field. */
export class Body {
  private readonly obj: Record<string, unknown>;

  private constructor(obj: Record<string, unknown>) {
    this.obj = obj;
  }

  static from(value: unknown): Body {
    if (value === undefined) return new Body({});
    if (!isRecord(value)) throw invalid('The request body must be a JSON object.');
    return new Body(value);
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined;
  }

  raw(key: string): unknown {
    return this.obj[key];
  }

  string(key: string): string {
    const v = this.obj[key];
    if (typeof v !== 'string' || v.trim() === '')
      throw invalid(`Field "${key}" is required and must be a non-empty string.`);
    return v.trim();
  }

  /** Absent or null gives undefined. */
  optString(key: string): string | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw invalid(`Field "${key}" must be a string.`);
    return v;
  }

  /** undefined = absent, null = explicitly cleared. */
  nullableString(key: string, maxLen = 2000): string | null | undefined {
    const v = this.obj[key];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') throw invalid(`Field "${key}" must be a string or null.`);
    if (v.length > maxLen) throw invalid(`Field "${key}" is too long (max ${maxLen} characters).`);
    return v.trim() === '' ? null : v;
  }

  number(key: string, opts: NumOpts = {}): number {
    const v = this.obj[key];
    if (v === undefined || v === null) throw invalid(`Field "${key}" is required and must be a number.`);
    return checkNumber(key, v, opts);
  }

  optNumber(key: string, opts: NumOpts = {}): number | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    return checkNumber(key, v, opts);
  }

  nullableNumber(key: string, opts: NumOpts = {}): number | null | undefined {
    const v = this.obj[key];
    if (v === undefined) return undefined;
    if (v === null) return null;
    return checkNumber(key, v, opts);
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.obj[key];
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw invalid(`Field "${key}" must be one of: ${values.join(', ')}.`);
    }
    return v as T;
  }

  optOneOf<T extends string>(key: string, values: readonly T[]): T | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    return this.oneOf(key, values);
  }

  optDate(key: string): ISODate | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    if (!isIsoDate(v)) throw invalid(`Field "${key}" must be a calendar date as YYYY-MM-DD.`);
    return v;
  }

  date(key: string): ISODate {
    const v = this.obj[key];
    if (!isIsoDate(v)) throw invalid(`Field "${key}" is required and must be a calendar date as YYYY-MM-DD.`);
    return v;
  }

  optBool(key: string): boolean | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') throw invalid(`Field "${key}" must be true or false.`);
    return v;
  }

  bool(key: string): boolean {
    const v = this.optBool(key);
    if (v === undefined) throw invalid(`Field "${key}" is required and must be true or false.`);
    return v;
  }

  array(key: string): unknown[] {
    const v = this.obj[key];
    if (!Array.isArray(v)) throw invalid(`Field "${key}" is required and must be an array.`);
    return v;
  }

  optArray(key: string): unknown[] | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw invalid(`Field "${key}" must be an array.`);
    return v;
  }
}

export function checkNumber(key: string, v: unknown, opts: NumOpts = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`Field "${key}" must be a number.`);
  if (opts.int && !Number.isInteger(v)) throw invalid(`Field "${key}" must be a whole number.`);
  if (opts.positive && v <= 0) throw invalid(`Field "${key}" must be greater than zero.`);
  if (opts.min !== undefined && v < opts.min) throw invalid(`Field "${key}" must be at least ${opts.min}.`);
  if (opts.max !== undefined && v > opts.max) throw invalid(`Field "${key}" must be at most ${opts.max}.`);
  return v;
}

/** A tuple of exactly three finite numbers, e.g. [bull, base, bear]. */
export function triple(key: string, v: unknown, opts: NumOpts): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3)
    throw invalid(`Field "${key}" must be an array of three numbers [bull, base, bear].`);
  return [
    checkNumber(`${key}[0]`, v[0], opts),
    checkNumber(`${key}[1]`, v[1], opts),
    checkNumber(`${key}[2]`, v[2], opts),
  ];
}
