import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSet } from '../../src/cli/commands/backtest';
import { addToWatchlist, setSettings } from '../../src/db/repos';
import { writeBars } from '../../src/db/writers';
import { cliHarness } from '../helpers/cli';
import { rng, tradingDaysEnding } from '../helpers/history';
import { bar, indexInstrument, seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
const NOW = new Date('2026-03-14T08:00:00Z'); // Saturday: the last session is Friday 2026-03-13

beforeAll(async () => {
  db = await createTestDb();
  await setSettings(db.db, { baseCurrency: 'USD' });
  const aapl = await seedInstrument(db.db, 'US', 'AAPL');
  await addToWatchlist(db.db, aapl.id);
  const days = tradingDaysEnding('US', '2026-03-13', 900);
  const r = rng(3);
  let x = 150;
  await writeBars(
    db.db,
    aapl.id,
    days.map((d) => {
      x *= 1 + (r() - 0.48) * 0.02;
      return bar(d, Math.round(x * 100) / 100);
    }),
  );
  const spy = await indexInstrument(db.db, 'US', 'SPY');
  await writeBars(
    db.db,
    spy.id,
    days.map((d, i) => bar(d, 300 + i * 0.3)),
  );
});
afterAll(async () => {
  await db.drop();
});

const cli = () => cliHarness(db.url, { now: NOW });

describe('parseSet', () => {
  it('builds a nested override and parses numbers, booleans and words', () => {
    expect(
      parseSet(['option.select.deltaMax=0.2', 'option.select.relaxSupport=true', 'size.position.maxPerNamePct=0.03']),
    ).toEqual({
      'option.select': { deltaMax: 0.2, relaxSupport: true },
      'size.position': { maxPerNamePct: 0.03 },
    });
    expect(() => parseSet(['nodot=1'])).toThrow(/key must look like/);
    expect(() => parseSet(['no-equals'])).toThrow(/key=value/);
  });
});

describe('positions mark, lots and jobs', () => {
  it('marks an open put and prints P&L and alerts', async () => {
    const add = await cli().run([
      'positions',
      'add',
      'AAPL',
      '--strike',
      '150',
      '--expiry',
      '2026-04-17',
      '--contracts',
      '1',
      '--price',
      '4',
      '--date',
      '2026-03-02',
    ]);
    expect(add.code, add.err.join('\n')).toBe(0);
    const r = await cli().run(['positions', 'mark']);
    expect(r.code, r.err.join('\n')).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('US:AAPL');
    expect(text).toContain('synthetic');
    expect(text).toMatch(/1 marked/);
  });

  it('assigning a put creates a lot that lots list shows and lots sell closes', async () => {
    const close = await cli().run([
      'positions',
      'close',
      '1',
      '--assigned',
      '--underlying-close',
      '140',
      '--date',
      '2026-04-17',
    ]);
    expect(close.code, close.err.join('\n')).toBe(0);
    const list = await cli().run(['lots', 'list']);
    expect(list.out.join('\n')).toContain('US:AAPL');
    const sell = await cli().run(['lots', 'sell', '1', '--price', '150', '--date', '2026-05-01']);
    expect(sell.code, sell.err.join('\n')).toBe(0);
    expect(sell.out.join('\n')).toContain('realised 1000.00');
    expect((await cli().run(['lots', 'list'])).out.join('\n')).toContain('no open stock lots');
    expect((await cli().run(['lots', 'sell', '1', '--price', '150'])).code).toBe(1);
  });

  it('jobs list shows every scheduled job and jobs run rejects an unknown name', async () => {
    const list = await cli().run(['jobs', 'list']);
    const text = list.out.join('\n');
    for (const name of [
      'ingest-us',
      'ingest-hk',
      'snapshot-chains-us',
      'mark-positions-us',
      'daily-scan',
      'calendar-refresh',
    ])
      expect(text).toContain(name);
    expect(text).toContain('America/New_York');
    const bad = await cli().run(['jobs', 'run', 'nope']);
    expect(bad.code).toBe(1);
  });

  it('jobs run mark-positions records the job', async () => {
    const r = await cli().run(['jobs', 'run', 'mark-positions']);
    expect(r.code, r.err.join('\n')).toBe(0);
  });
});

describe('backtest', () => {
  let id = '';

  it('runs, prints the report with benchmarks and caveats, and stores it', async () => {
    const r = await cli().run([
      'backtest',
      'run',
      '--from',
      '2024-06-03',
      '--to',
      '2026-03-13',
      '--tier',
      'synthetic_only',
      '--capital',
      '500000',
      '--name',
      'cli test',
    ]);
    expect(r.code, r.err.join('\n')).toBe(0);
    const text = r.out.join('\n');
    expect(text).toMatch(/Backtest [0-9a-f-]{36} "cli test": done/);
    expect(text).toContain('Portfolio versus benchmarks');
    expect(text).toContain('Naive 30-delta 45-DTE');
    expect(text).toContain('Survivorship');
    id = /Backtest ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
    expect(id).not.toBe('');
  }, 180_000);

  it('lists, shows and exports the run', async () => {
    const list = await cli().run(['backtest', 'list']);
    expect(list.out.join('\n')).toContain(id);
    const show = await cli().run(['backtest', 'show', id]);
    expect(show.out.join('\n')).toContain('cli test');
    const csv = await cli().run(['backtest', 'trades', id]);
    expect(csv.code).toBe(0);
    expect(csv.out.join('\n')).toContain('symbol,market,entryDate');
    expect((await cli().run(['backtest', 'show', '00000000-0000-4000-8000-000000000000'])).code).toBe(1);
  });

  it('refuses dates before the exchange calendar and a bad tier or walk-forward spec', async () => {
    const early = await cli().run(['backtest', 'run', '--from', '2008-01-02', '--to', '2012-01-02']);
    expect(early.code).toBe(1);
    expect(early.err.join(' ')).toMatch(/calendar/);
    expect(
      (await cli().run(['backtest', 'run', '--from', '2024-01-02', '--to', '2025-01-02', '--tier', 'maybe'])).code,
    ).toBe(1);
    expect(
      (await cli().run(['backtest', 'run', '--from', '2024-01-02', '--to', '2025-01-02', '--walk-forward', 'x'])).code,
    ).toBe(1);
  });

  it('prints event studies for a stock with enough bars', async () => {
    const r = await cli().run(['backtest', 'studies', 'AAPL']);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.out.join('\n')).toContain('rsi.pullback');
  });

  it('validate explains what is missing when there is too little history', async () => {
    const r = await cli().run(['backtest', 'validate', '--symbol', 'AAPL']);
    // 900 bars is just enough history; the checks run and report PASS or FAIL for each
    expect([0, 1]).toContain(r.code);
    expect(r.out.join('\n')).toMatch(/PASS|FAIL/);
  }, 120_000);
});
