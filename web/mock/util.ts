import type { ISODate } from '../../src/server/api-types';

/** Last stored session of the sample data, and the fixed FX rate used everywhere. */
export const ASOF: ISODate = '2026-10-09';
export const FX_USD_HKD = 7.78;
export const DISCLAIMER =
  'Decision support only: statistics about rules you configured, not investment advice. The app never places orders.';

/** An error that becomes an `ApiErrorBody` response with a stable machine code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Extra response headers, e.g. Allow on a 405. */
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string): HttpError => new HttpError(409, code, message);
export const invalid = (message: string, details?: unknown): HttpError =>
  new HttpError(422, 'validation_error', message, details);

// ------------------------------------------------------------------------------------------------ randomness
export function hash(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32): the same seed always gives the same sequence. */
export function mulberry(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randBetween = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------------ dates
export function parseIso(d: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return Number.NaN;
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) return t;
  return new Date(t).toISOString().slice(0, 10) === d ? t : Number.NaN;
}

export const isIsoDate = (d: unknown): d is ISODate => typeof d === 'string' && !Number.isNaN(parseIso(d));
export const addDays = (d: ISODate, n: number): ISODate =>
  new Date(parseIso(d) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: ISODate, b: ISODate): number => Math.round((parseIso(b) - parseIso(a)) / 86_400_000);
export const nowIso = (): string => new Date().toISOString();
export const isoAt = (ms: number): string => new Date(ms).toISOString();

function isWeekend(d: ISODate): boolean {
  const w = new Date(parseIso(d)).getUTCDay();
  return w === 0 || w === 6;
}

/** `count` weekday dates in ascending order, the last one on or before `end`. */
export function weekdaysEndingAt(end: ISODate, count: number): ISODate[] {
  const out: ISODate[] = [];
  let d = end;
  while (out.length < count) {
    if (!isWeekend(d)) out.push(d);
    d = addDays(d, -1);
  }
  return out.reverse();
}

// ------------------------------------------------------------------------------------------------ numbers and text
export const round = (x: number, dp = 2): number => Math.round(x * 10 ** dp) / 10 ** dp;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
export const fmt0 = (x: number): string => Math.round(x).toLocaleString('en-US');
export const fmt2 = (x: number): string => x.toFixed(2);
export const pctText = (x: number, dp = 1): string => `${x.toFixed(dp)}%`;
export const signed = (x: number, dp = 0): string =>
  `${x < 0 ? '-' : '+'}${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ------------------------------------------------------------------------------------------------ CSV
export interface CsvRecord {
  /** 1-based physical line of the record in the pasted text. */
  line: number;
  cells: string[];
}

/** Small RFC-4180 reader: quotes, doubled quotes, CRLF, BOM. Blank records are dropped but still counted for `line`. */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.replace(/^﻿/, '');
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) out.push({ line: recordLine, cells: cells.map((c) => c.trim()) });
    cells = [];
    recordLine = line;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') endCell();
    else if (ch === '\n') {
      line++;
      endRecord();
    } else if (ch !== '\r') cell += ch;
  }
  endRecord();
  return out;
}

export const normaliseHeader = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** Quote a CSV cell only when it needs it. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Strict decimal parse: '' and 'abc' give NaN (Number('') would give 0). */
export function parseNum(s: string | undefined): number {
  if (s === undefined || s.trim() === '') return Number.NaN;
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s.trim()) ? Number(s) : Number.NaN;
}

export const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
