import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { findInstrument } from '../../src/db/repos';
import { optionQuotes } from '../../src/db/schema';
import { bootstrap, withDbs } from './harness';

const LIVE = '2026-10-09';
const _REPLAY = '2026-09-04'; // a historical replay where both markets rank names and several FAIL with named rules
const { fresh } = withDbs();

describe('e2e 4: pasted HK chains', () => {
  it('rejects a crossed quote with its line number (nothing stored) and accepts bid = 0 rows with warnings', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const bad = await cli.run([
      'chain',
      'import',
      '0700',
      'HK',
      'tests/fixtures/chains/hk-crossed.csv',
      '--spot',
      '420',
      '--date',
      LIVE,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toMatch(/line 12: chain\.crossed bid 5\.06 > ask 4\.86/);
    expect(bad.err.join('\n')).toContain('nothing stored');
    const hk = (await findInstrument(db.db, 'HK', '0700')) as { id: number };
    const none = await db.db.execute(
      `select count(*)::int as n from option_quotes q join option_contracts c on c.id = q.contract_id where c.instrument_id = ${hk.id}` as never,
    );
    expect((none.rows[0] as { n: number }).n).toBe(0);

    const ok = await cli.run([
      'chain',
      'import',
      '0700',
      'HK',
      'tests/fixtures/chains/hk-illiquid.csv',
      '--spot',
      '420',
      '--date',
      LIVE,
    ]);
    expect(ok.code).toBe(0);
    const warnings = ok.out.filter((l) => l.includes('warning') && l.includes('chain.illiquid'));
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('line 3');
    const stored = await db.db.select({ n: count() }).from(optionQuotes);
    expect(stored[0]?.n).toBeGreaterThan(0);
  });

  it('a 2-day-old pasted chain passes the freshness gate; a 5-day-old one is ignored (synthetic) and joins the paste block', async () => {
    const dbA = await fresh();
    const a = await bootstrap(dbA);
    expect(
      (
        await a.run([
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
    const ex = (await a.run(['explain', '0700', '--as-of', LIVE])).out.join('\n');
    expect(ex).toContain('Freshness: all inputs current');
    expect(ex).toContain('Chain: fresh real chain');
    const scan = await a.run(['scan', '--as-of', LIVE]);
    expect(scan.out.join('\n')).not.toMatch(/Paste chains for these HK names[\s\S]*\n {2}0700 /);

    const dbB = await fresh();
    const b = await bootstrap(dbB);
    expect(
      (
        await b.run([
          'chain',
          'import',
          '0700',
          'HK',
          'tests/fixtures/chains/hk-valid.csv',
          '--spot',
          '420',
          '--date',
          '2026-10-04',
        ])
      ).code,
    ).toBe(0);
    const exB = (await b.run(['explain', '0700', '--as-of', LIVE])).out.join('\n');
    expect(exB).toContain('Freshness: all inputs current'); // an old paste is not "stale", it is simply not used
    expect(exB).toMatch(/Chain: pasted chain 5 days old .* priced synthetically/);
    const scanB = await b.run(['scan', '--as-of', LIVE]);
    expect(scanB.out.join('\n')).toMatch(/Paste chains for these HK names[\s\S]*\n {2}0700 /);
  });
});
