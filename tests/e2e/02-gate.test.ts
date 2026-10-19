/**
 * End-to-end scenarios (PROMPT-build-milestone-1.md). Each describe gets its own throwaway database, created and dropped
 * by the test; HTTP is replayed from recorded Yahoo fixtures (never the network). The recordings were taken on Friday
 * 2026-10-09 after the US close; "now" is the following Saturday morning. The scenarios are spread over several files so
 * each runs in its own short-lived worker process.
 */
import { spawnSync } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { findInstrument } from '../../src/db/repos';
import { priceBars } from '../../src/db/schema';
import { cliHarness, RECORDED_NOW } from '../helpers/cli';
import { bootstrap, shortlistSymbols, withDbs } from './harness';

const LIVE = '2026-10-09';
const _REPLAY = '2026-09-04'; // a historical replay where both markets rank names and several FAIL with named rules
const { fresh } = withDbs();

describe('e2e 2: scan with equity unset refuses', () => {
  it('prints one line and exits 1 (in-process and through the real entry point)', async () => {
    const db = await fresh();
    const cli = cliHarness(db.url);
    const r = await cli.run(['scan']);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/^equity is not set: run `pnpm cli settings set equity <amount> --base HKD`/);

    const p = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'scan'], {
      env: { ...process.env, DATABASE_URL: db.url, OT_NOW: RECORDED_NOW.toISOString() },
      encoding: 'utf8',
    });
    expect(p.status).toBe(1);
    expect(p.stdout).toBe('');
    expect(p.stderr.trim().split(/\r?\n/)).toHaveLength(1);
    expect(p.stderr).toContain('equity is not set');
  });
});

describe('e2e 3: a stale name is dropped, --allow-stale tags it', () => {
  it('drops the name with data.stale naming the input and date; --allow-stale ranks it tagged STALE', async () => {
    const db = await fresh();
    const cli = await bootstrap(db);
    const hk = (await findInstrument(db.db, 'HK', '0700')) as { id: number };
    const before = await cli.run(['scan', '--as-of', LIVE]);
    expect(shortlistSymbols(before.out, 'HK')).toContain('0700');

    await db.db.delete(priceBars).where(and(eq(priceBars.instrumentId, hk.id), eq(priceBars.day, LIVE)));
    const r = await cli.run(['scan', '--as-of', LIVE]);
    expect(r.code).toBe(0);
    const dropped = r.out.find((l) => l.includes('0700 (HK): data.stale'));
    expect(dropped).toContain('data.stale bars 2026-10-08, required 2026-10-09');
    expect(shortlistSymbols(r.out, 'HK')).not.toContain('0700');

    const allowed = await cli.run(['scan', '--as-of', LIVE, '--allow-stale']);
    expect(allowed.out.some((l) => l.startsWith('STALE-tagged') && l.includes('0700'))).toBe(true);
    const row = allowed.out.find((l) => /^\s*\d+\s+0700\s/.test(l));
    expect(row).toBeDefined();
    expect(row).toContain('STALE');
  });
});
