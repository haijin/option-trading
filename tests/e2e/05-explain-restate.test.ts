import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { findInstrument } from '../../src/db/repos';
import { instruments, priceBars, skillRuns } from '../../src/db/schema';
import { fixtureFileName, requestKey, writeReplayFixture } from '../../src/providers/http-replay';
import { cliHarness, HTTP_BASE } from '../helpers/cli';
import { bootstrap, withDbs } from './harness';

const LIVE = '2026-10-09';
const _REPLAY = '2026-09-04'; // a historical replay where both markets rank names and several FAIL with named rules
const { fresh, tmp } = withDbs();

describe('e2e 6: explain on a name that FAILs the fundamental gate', () => {
  it('still prints the technical, volatility and option sections; scan names the binding rule', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    expect((await cli.run(['events', 'add', '0016', 'rights_issue', '2026-10-20'])).code).toBe(0);

    const scan = await cli.run(['scan', '--as-of', LIVE]);
    const row = scan.out.find((l) => /^ {2}0016\s+HK\s+events\.pendingCorporateAction/.test(l));
    expect(row, 'scan FAIL row for 0016').toBeDefined();

    const ex = await cli.run(['explain', '0016', '--as-of', LIVE]);
    const text = ex.out.join('\n');
    expect(text).toMatch(/-- fundamental\.gate v\S+\s+verdict FAIL/);
    expect(text).toMatch(/-- technical\.timing v\S+/);
    expect(text).toMatch(/-- volatility\.edge v\S+/);
    expect(text).toMatch(/-- option\.select v\S+/);
    expect(text).toContain('events.pendingCorporateAction');
    expect(text).toContain('Status: failed');
  });
});

describe('e2e 8: restated bars invalidate cached results', () => {
  it('re-ingesting restated bars deletes cached skill_runs for that instrument from the earliest changed date; the next scan recomputes', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const aapl = (await findInstrument(db.db, 'US', 'AAPL')) as { id: number };
    const msft = (await findInstrument(db.db, 'US', 'MSFT')) as { id: number };
    expect((await cli.run(['scan', '--as-of', '2026-02-27'])).code).toBe(0); // before the restatement date
    const first = await cli.run(['scan', '--as-of', LIVE]);
    expect(first.out[0]).toMatch(/0 cached \+ \d+ computed/);
    const rowsOf = async (id: number) =>
      (await db.db.select({ d: skillRuns.asOf }).from(skillRuns).where(eq(skillRuns.instrumentId, id))).map((r) => r.d);
    expect(new Set(await rowsOf(aapl.id))).toEqual(new Set(['2026-02-27', LIVE]));

    // Yahoo restates AAPL's adjusted closes from 2026-03-02 (a dividend)
    const url = 'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&events=div|split|earn&useYfid=true';
    const doc = JSON.parse(
      (JSON.parse(readFileSync(join(HTTP_BASE, fixtureFileName(requestKey('GET', url))), 'utf8')) as { body: string })
        .body,
    );
    const res = doc.chart.result[0];
    const ts: number[] = res.timestamp;
    const cut = Date.parse('2026-03-02T00:00:00Z') / 1000;
    res.indicators.adjclose[0].adjclose = (res.indicators.adjclose[0].adjclose as number[]).map((v, i) =>
      (ts[i] as number) >= cut ? v * 0.99 : v,
    );
    const overlay = tmp();
    writeReplayFixture(overlay, { url, body: JSON.stringify(doc) });
    const ing = await cliHarness(db.url, { replayDirs: [overlay, HTTP_BASE] }).run([
      'ingest',
      '--steps',
      'bars',
      '--only',
      'AAPL',
    ]);
    expect(ing.code).toBe(0);
    expect(ing.out.join('\n')).toMatch(/\d+ restated, \d+ cached results dropped/);

    expect(new Set(await rowsOf(aapl.id))).toEqual(new Set(['2026-02-27'])); // from the earliest changed day on: gone; earlier results kept
    expect(new Set(await rowsOf(msft.id))).toEqual(new Set(['2026-02-27', LIVE])); // other names untouched

    const next = await cli.run(['scan', '--as-of', LIVE]);
    const m = /(\d+) cached \+ (\d+) computed/.exec(next.out[0] as string);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(2); // AAPL recomputed (it FAILs the gate at this date, so the scan runs S0 and S1)
    expect(Number(m?.[1])).toBeGreaterThan(0); // everything else served from cache
    expect((await rowsOf(aapl.id)).includes(LIVE)).toBe(true);
  });
});

describe('sanity: the recorded fixtures keep the scenarios honest', () => {
  it('the watchlist names exist as instruments after bootstrap and the four indices have bars', async () => {
    const db = await fresh();
    await bootstrap(db);
    const idx = await db.db
      .select({ s: instruments.symbol })
      .from(priceBars)
      .innerJoin(instruments, eq(instruments.id, priceBars.instrumentId))
      .where(inArray(instruments.symbol, ['SPY', 'VIX', '2800', 'HSI']))
      .groupBy(instruments.symbol);
    expect(idx.map((x) => x.s).sort()).toEqual(['2800', 'HSI', 'SPY', 'VIX']);
  });
});
