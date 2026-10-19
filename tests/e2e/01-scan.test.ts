import { beforeAll, describe, expect, it } from 'vitest';
import { findInstrument } from '../../src/db/repos';
import type { cliHarness } from '../helpers/cli';
import type { TestDb } from '../helpers/test-db';
import { bootstrap, shortlistSymbols, WATCHLIST, withDbs } from './harness';

const _LIVE = '2026-10-09';
const REPLAY = '2026-09-04'; // a historical replay where both markets rank names and several FAIL with named rules
const { fresh } = withDbs();

describe('e2e 1: equity -> watchlist -> ingest from fixtures -> scan', () => {
  let db: TestDb;
  let cli: ReturnType<typeof cliHarness>;
  let startedAt = 0;
  let scanLines: string[] = [];
  let elapsedMs = 0;

  beforeAll(async () => {
    startedAt = Date.now();
    db = await fresh();
    cli = await bootstrap(db);
    const r = await cli.run(['scan', '--as-of', REPLAY]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    scanLines = r.out;
    elapsedMs = Date.now() - startedAt;
  });

  it('the watchlist carries the real board lots and the requested solvency models', async () => {
    const lots: Record<string, number> = {
      '0700': 100,
      '0005': 400,
      '0941': 500,
      '0016': 500,
      '2318': 500,
      AAPL: 100,
      MSFT: 100,
      NVDA: 100,
      JPM: 100,
      XOM: 100,
    };
    for (const w of WATCHLIST) {
      const inst = await findInstrument(db.db, w.market, w.symbol);
      expect(inst?.multiplier, `${w.symbol} lot`).toBe(lots[w.symbol]);
      expect(inst?.solvencyModel, `${w.symbol} solvency`).toBe(w.solvency);
    }
  });

  it('prints two market tables with ranked rows', () => {
    expect(scanLines.some((l) => l.startsWith('US shortlist'))).toBe(true);
    expect(scanLines.some((l) => l.startsWith('HK shortlist'))).toBe(true);
    expect(shortlistSymbols(scanLines, 'US').length).toBeGreaterThanOrEqual(3);
    expect(shortlistSymbols(scanLines, 'HK').length).toBeGreaterThanOrEqual(2);
  });

  it('every ranked row carries a data tier and a reasons block', () => {
    for (const market of ['US', 'HK'] as const) {
      for (const sym of shortlistSymbols(scanLines, market)) {
        const row = scanLines.find((l) => new RegExp(`^\\s*\\d+\\s+${sym}\\s`).test(l)) as string;
        expect(row, `${sym} row`).toMatch(/\b(real|proxy|synthetic)\b/);
        const at = scanLines.findIndex((l) => l.startsWith(`  Why ${sym} (rank`));
        expect(at, `${sym} Why block`).toBeGreaterThan(-1);
        expect(scanLines[at]).toMatch(/data tier (real|proxy|synthetic)/);
        let reasons = 0;
        for (let i = at + 1; i < scanLines.length && !(scanLines[i] as string).startsWith('  Why '); i++) {
          if (/^ {6}\[( ok |warn|FAIL)\]/.test(scanLines[i] as string)) reasons++;
        }
        expect(reasons, `${sym} reason lines`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('every FAIL row names its binding rule', () => {
    const at = scanLines.findIndex((l) => l.startsWith('Not recommended (FAIL)'));
    expect(at).toBeGreaterThan(-1);
    const rows = scanLines.slice(at + 3).filter((l) => /^ {2}\S+\s+(US|HK)\s+/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const l of rows) expect(l).toMatch(/^ {2}\S+\s+(US|HK)\s+[a-z]+\.[A-Za-z]+/);
  });

  it('--json carries dataTier and non-empty reasons on every ranked row', async () => {
    const r = await cli.run(['scan', '--as-of', REPLAY, '--json']);
    const j = JSON.parse(r.out.join('\n')) as {
      shortlist: Record<
        string,
        { symbol: string; dataTier: string; reasons: unknown[]; contract: { strike: number } }[]
      >;
    };
    for (const rows of Object.values(j.shortlist))
      for (const row of rows) {
        expect(['real', 'proxy', 'synthetic']).toContain(row.dataTier);
        expect(row.reasons.length).toBeGreaterThan(8);
        expect(row.contract.strike).toBeGreaterThan(0);
      }
  });

  it('solvency models switch the test: property names get gearing, banks get the skipped note, no Altman Z for either', async () => {
    const r = await cli.run(['explain', '0016', '--as-of', REPLAY]);
    const text = r.out.join('\n');
    expect(text).toContain('solvency.gearing');
    expect(text).not.toContain('solvency.altmanZ');
    const bank = (await cli.run(['explain', '0005', '--as-of', REPLAY])).out.join('\n');
    expect(bank).toContain('solvency.financialSkipped');
    expect(bank).not.toContain('solvency.altmanZ');
  });

  it('the whole flow (settings, watchlist, ingest, scan) finishes in under 60 seconds', () => {
    expect(elapsedMs).toBeLessThan(60_000);
  });
});

describe('Phase 1 check: the fundamentals coverage report', () => {
  it('lists every watchlist name with the periods available and what S1 can run on them', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const r = await cli.run(['report', 'coverage']);
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    for (const w of WATCHLIST) expect(text).toContain(`${w.market}:${w.symbol}`);
    expect(text).toContain('S1 tests supported');
    expect(text).toMatch(/\d+\/10 names have a usable F-score input set from free data/);
  });
});
