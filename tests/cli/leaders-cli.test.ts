import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from '../helpers/cli';
import { seedLeadersWorld } from '../helpers/leaders-world';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let dataDir: string;
// Saturday: the last completed US session is Friday 2026-10-09, the last HK session too
const NOW = new Date('2026-10-10T08:00:00Z');

beforeAll(async () => {
  db = await createTestDb();
  dataDir = mkdtempSync(join(tmpdir(), 'ot-lcli-'));
  await seedLeadersWorld(db.db);
});
afterAll(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  await db.drop();
});

const cli = () => cliHarness(db.url, { now: NOW, dataDir });

describe('pnpm cli leaders', () => {
  it('before any scan it says so, and the JSON is flagged stale with no list', async () => {
    const text = await cli().run(['leaders']);
    expect(text.code).toBe(0);
    expect(text.out.join('\n')).toMatch(/no scan yet/);
    const json = await cli().run(['leaders', '--json']);
    const v = JSON.parse(json.out.join('\n'));
    expect(v).toMatchObject({ stale: true, asOf: null, candidates: [], record: { setups: 0 } });
  });

  it('scan --no-ingest scans both markets in this process (no model, no network) and prints the list', async () => {
    const r = await cli().run(['leaders', 'scan', '--no-ingest']);
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toMatch(/^HK 2026-10-09: 0 names/m);
    expect(text).toMatch(
      /^US 2026-10-09: 63 names, 63 screened, 3 leaders, 2 consolidating, 2 listed \(1 setup \/ 1 watch\)/m,
    );
    expect(text).toMatch(
      /Funnel: 63 screened \(US 63 \/ HK 0\) → 3 leaders → 2 consolidating → 2 listed \(1 Setup \/ 1 Watch\)/,
    );
    expect(text).toMatch(/LEAD1\s+setup/);
    expect(text).toMatch(/Turn-up bar: closed in the top third/);
    expect(text).toMatch(/plan: entry 96\.8, stop 9\d\.\d+ \(\d\.\d%\), 3R/);
    expect(text).toMatch(/the app never places orders/);
  });

  it('--json prints the Leaders view (the API shape) with the stale flag and the record; progress goes to stderr', async () => {
    const r = await cli().run(['leaders', '--json']);
    const v = JSON.parse(r.out.join('\n'));
    expect(v).toMatchObject({
      stale: false,
      asOf: '2026-10-09',
      stage: 'shortlist',
      funnel: { leaders: 3, shortlist: 2, setup: 1 },
      status: { stale: false },
      record: { window: '60', setups: 1 },
    });
    expect(v.candidates.map((c: { symbol: string }) => c.symbol)).toEqual(['LEAD1', 'LEAD2']);
    expect(v.candidates[0].spark.closes).toHaveLength(70);
    const scan = await cli().run(['leaders', 'scan', '--json', '--no-ingest', '--market', 'US']);
    expect(() => JSON.parse(scan.out.join('\n'))).not.toThrow();
    expect(scan.err.join('\n')).toMatch(/US 2026-10-09: 63 names/);
  });

  it('--market and --stage narrow the listing; a bad stage or market is a user error', async () => {
    const hk = JSON.parse((await cli().run(['leaders', '--json', '--market', 'HK'])).out.join('\n'));
    expect(hk.candidates).toEqual([]);
    const stage = JSON.parse((await cli().run(['leaders', '--json', '--stage', 'leaders'])).out.join('\n'));
    expect(stage.candidates.map((c: { symbol: string }) => c.symbol)).toEqual(['LEAD3']);
    expect((await cli().run(['leaders', '--stage', 'nope'])).code).toBe(1);
    expect((await cli().run(['leaders', '--market', 'XX'])).code).not.toBe(0);
  });

  it('universe --seed loads the seed CSVs without the network', async () => {
    writeFileSync(
      join(dataDir, 'universe-us.csv'),
      'index_code,symbol,name,sector,yahoo,stock_lot\nSPX,ZZZA,Zed A,Technology,,\nNDX,ZZZB,Zed B,Technology,,\n',
    );
    writeFileSync(
      join(dataDir, 'universe-hk.csv'),
      'index_code,symbol,name,sector,yahoo,stock_lot\nHSI,0001,Test HK,,,500\n',
    );
    const r = await cli().run(['leaders', 'universe', '--seed']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/universe-us\.csv: 2 memberships/);
    expect(r.out.join('\n')).toMatch(/universe-hk\.csv: 1 memberships/);
  });
});
