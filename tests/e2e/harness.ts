import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';
import { type CliHarness, cliHarness } from '../helpers/cli';
import { createTestDb, type TestDb } from '../helpers/test-db';

/** The prompt's watchlist: 5 US and 5 HK names with their real board lots and solvency models. */
export const WATCHLIST: { symbol: string; market: 'US' | 'HK'; solvency: string }[] = [
  { symbol: 'AAPL', market: 'US', solvency: 'altman' },
  { symbol: 'MSFT', market: 'US', solvency: 'altman' },
  { symbol: 'NVDA', market: 'US', solvency: 'altman' },
  { symbol: 'JPM', market: 'US', solvency: 'financial' },
  { symbol: 'XOM', market: 'US', solvency: 'altman' },
  { symbol: '0700', market: 'HK', solvency: 'altman' },
  { symbol: '0005', market: 'HK', solvency: 'financial' },
  { symbol: '0941', market: 'HK', solvency: 'altman' },
  { symbol: '0016', market: 'HK', solvency: 'property' },
  { symbol: '2318', market: 'HK', solvency: 'financial' },
];

export interface World {
  db: TestDb;
  cli: CliHarness;
}

export async function newDb(): Promise<TestDb> {
  return createTestDb();
}

export async function addWatchlist(cli: CliHarness): Promise<void> {
  for (const w of WATCHLIST) {
    const r = await cli.run(['watchlist', 'add', w.symbol, w.market, '--solvency', w.solvency]);
    expect(r.code, `watchlist add ${w.symbol}: ${r.err.join(' ')}`).toBe(0);
  }
}

/** equity -> watchlist -> `ingest --all` from the recorded fixtures. */
export async function bootstrap(db: TestDb, equity = '20000000'): Promise<CliHarness> {
  const cli = cliHarness(db.url);
  expect((await cli.run(['settings', 'set', 'equity', equity, '--base', 'HKD'])).code).toBe(0);
  await addWatchlist(cli);
  const ing = await cli.run(['ingest', '--all']);
  expect(ing.code, ing.err.join('\n') + ing.out.slice(-5).join('\n')).toBe(0);
  return cli;
}

/** Symbols in the "SHORTLIST" table of one market, from the text output. */
export function shortlistSymbols(lines: string[], market: 'US' | 'HK'): string[] {
  const start = lines.findIndex((l) => l.startsWith(`${market} shortlist`));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 3; i < lines.length; i++) {
    const m = /^\s*(\d+)\s+(\S+)\s/.exec(lines[i] as string);
    if (!m) break;
    out.push(m[2] as string);
  }
  return out;
}

/** Per-file bookkeeping: databases and temp dirs created by a test file are dropped and removed when it finishes. */
export function withDbs(): { fresh(): Promise<TestDb>; tmp(): string } {
  const dbs: TestDb[] = [];
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.drop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  return {
    async fresh() {
      const d = await newDb();
      dbs.push(d);
      return d;
    },
    tmp() {
      const d = mkdtempSync(join(tmpdir(), 'ot-e2e-'));
      dirs.push(d);
      return d;
    },
  };
}
