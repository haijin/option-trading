import { createHash } from 'node:crypto';

/** JSON with sorted object keys, so equal values always serialise identically (cache keys, hashes). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashParams(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 32);
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Linear interpolation of x between (lo -> 0) and (hi -> 100), clamped. Works for hi < lo (lower is better). */
export function lerpScore(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 100 : 0;
  return clamp(((x - lo) / (hi - lo)) * 100, 0, 100);
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Number or null from a pg numeric string / JSON value; never NaN. */
export function num(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export class UserError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}
