import { join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import type { Market } from '../../core/calendar';
import { type ISODate, isISODate } from '../../core/dates';
import { canonicalSymbol } from '../../core/symbols';
import type { Instrument } from '../../core/types';
import { UserError } from '../../core/util';
import { findInstrument } from '../../db/repos';
import { parseBoardLotsCsv } from '../../providers/seed-files';
import type { CliContext } from '../context';

/** HK symbols are digits (700, 0700.HK); everything else is a US ticker. */
export function inferMarket(raw: string): Market {
  return /^\d{1,5}(\.HK)?$/i.test(raw.trim()) ? 'HK' : 'US';
}

export function parseMarket(raw: string): Market {
  const m = raw.trim().toUpperCase();
  if (m !== 'US' && m !== 'HK') throw new InvalidArgumentError('market must be US or HK');
  return m;
}

export function parseDateArg(raw: string): ISODate {
  if (!isISODate(raw)) throw new InvalidArgumentError(`"${raw}" is not a valid YYYY-MM-DD date`);
  return raw;
}

export function parsePositive(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`"${raw}" must be a positive number`);
  return n;
}

export function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`"${raw}" must be a positive integer`);
  return n;
}

export async function requireInstrument(ctx: CliContext, raw: string, market?: Market): Promise<Instrument> {
  const m = market ?? inferMarket(raw);
  let symbol: string;
  try {
    symbol = canonicalSymbol(m, raw);
  } catch (err) {
    throw new UserError((err as Error).message);
  }
  const inst = await findInstrument(ctx.db().db, m, symbol);
  if (!inst) throw new UserError(`${m}:${symbol} is not in the database; add it with \`watchlist add ${raw} ${m}\``);
  return inst;
}

export async function boardLotFromSeed(ctx: CliContext, symbol: string): Promise<number | null> {
  const file = join(ctx.dataDir, 'hk-board-lots.csv');
  if (!(await ctx.fileExists(file))) return null;
  return parseBoardLotsCsv(await ctx.readFile(file)).get(symbol) ?? null;
}
