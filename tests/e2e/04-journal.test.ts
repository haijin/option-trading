import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { positions } from '../../src/db/schema';
import { cliHarness } from '../helpers/cli';
import { bootstrap, shortlistSymbols, withDbs } from './harness';

const LIVE = '2026-10-09';
const _REPLAY = '2026-09-04'; // a historical replay where both markets rank names and several FAIL with named rules
const { fresh, tmp } = withDbs();

describe('e2e 5: journal import, open-position exclusion, positions close', () => {
  it('reproduces the fixture P&L to the cent; the open row blocks 0700 in the next scan; positions close unblocks it without an ingest', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const before = await cli.run(['scan', '--as-of', LIVE]);
    expect(shortlistSymbols(before.out, 'HK')).toContain('0700');

    const imp = await cli.run(['journal', 'import', 'tests/fixtures/e2e/journal.csv']);
    expect(imp.code, imp.err.join('\n')).toBe(0);
    const text = imp.out.join('\n');
    expect(text).toContain('imported 5 leg(s)');
    expect(text).toMatch(/US \(USD\):.*realised P&L 264\.80 USD/);
    expect(text).toMatch(/HK \(HKD\):.*realised P&L 750\.00 HKD/);
    expect(text).toContain('Open positions (1) block new recommendations on these names');

    const all = (await cli.run(['positions', 'list', '--all'])).out.join('\n');
    expect(all).toMatch(/NVDA\s+170\.00\s+2026-09-18\s+1\s+4\.000\s+2026-08-17\s+assigned\s+-401\.30/); // booked at the intrinsic loss, not a full win
    expect(all).toMatch(/AAPL\s+300\.00\s+2026-09-04\s+2\s+3\.500\s+2026-08-03\s+closed\s+457\.40/);
    const [open] = await db.db.select().from(positions).where(eq(positions.status, 'open'));
    expect(open?.expiry).toBe('2026-10-29');

    const blocked = await cli.run(['scan', '--as-of', LIVE]);
    expect(shortlistSymbols(blocked.out, 'HK')).not.toContain('0700');
    expect(blocked.out.join('\n')).toMatch(/Skipped, open put already on the name \(portfolio\.alreadyOpen\): .*0700/);

    const closed = await cli.run(['positions', 'close', String(open?.id), '--price', '3.00', '--date', LIVE]);
    expect(closed.code).toBe(0);
    expect(closed.out.join('\n')).toContain('realised P&L');
    // (6.00 - 3.00) x 100 x 2 = 600.00 - 30 fees = 570.00
    const [p] = await db.db
      .select()
      .from(positions)
      .where(eq(positions.id, open?.id as number));
    expect(Number(p?.realizedPnl)).toBe(570);

    const after = await cli.run(['scan', '--as-of', LIVE]);
    expect(shortlistSymbols(after.out, 'HK')).toContain('0700');
    expect(after.out[0]).toMatch(/\d+ cached \+ 0 computed skill results/); // no ingest, no recompute of S0-S4
  });

  it('re-importing the same journal is idempotent', async () => {
    const db = await fresh();
    const cli = cliHarness(db.url);
    expect((await cli.run(['journal', 'import', 'tests/fixtures/e2e/journal.csv'])).code).toBe(0);
    const again = await cli.run(['journal', 'import', 'tests/fixtures/e2e/journal.csv']);
    expect(again.out.join('\n')).toContain('imported 0 leg(s), 5 already present');
    const n = await db.db.select({ n: count() }).from(positions);
    expect(n[0]?.n).toBe(5);
  });
});

describe('e2e 7: journal calibrate', () => {
  it('prints "uncalibrated" below 10 samples, then a ratio per market and delta bucket once a pasted chain exists', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    expect((await cli.run(['journal', 'import', 'tests/fixtures/e2e/journal.csv'])).code).toBe(0);

    const few = (await cli.run(['journal', 'calibrate'])).out.join('\n');
    expect(few).toContain('HK: uncalibrated');
    expect(few).toContain('US: uncalibrated');
    expect(few).toContain('Excluded:');

    expect(
      (
        await cli.run([
          'chain',
          'import',
          '0700',
          'HK',
          'tests/fixtures/chains/hk-valid.csv',
          '--spot',
          '420',
          '--date',
          '2026-10-07',
        ])
      ).code,
    ).toBe(0);
    const rep = await cli.run(['journal', 'calibrate']);
    expect(rep.code, rep.err.join('\n')).toBe(0);
    const text = rep.out.join('\n');
    expect(text).toMatch(/HK: calibrated \(\d+ chain samples >= 10\)/);
    const hkRows = rep.out.filter((l) => /^HK\s+(0-10|10-20|20-30|30\+)\s+\d+\s+\d+\.\d{3}/.test(l));
    expect(hkRows.length).toBeGreaterThanOrEqual(1);
    for (const l of hkRows) {
      const ratio = Number(l.trim().split(/\s+/)[3]);
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5);
    }
  });

  it('T13: journal rows without a spot column are excluded from calibration', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const dir = tmp();
    const file = join(dir, 'nospot.csv');
    writeFileSync(
      file,
      [
        'open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row',
        '2026-08-03,AAPL,US,2026-09-04,300,100,1,3.50,0,2026-08-21,1.20,0,closed,',
        '2026-08-10,MSFT,US,2026-09-18,440,100,1,2.10,0,,,0,expired,',
      ].join('\n'),
    );
    expect((await cli.run(['journal', 'import', file])).code).toBe(0);
    const out = (await cli.run(['journal', 'calibrate'])).out.join('\n');
    expect(out).toContain('Excluded: 2 journal fill(s) without spot');
    expect(out).toContain('0 calibration sample(s) written');
  });
});
