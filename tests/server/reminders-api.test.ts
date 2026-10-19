import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addToWatchlist } from '../../src/db/repos';
import { corporateEvents } from '../../src/db/schema';
import { startApp, type TestApp } from '../helpers/app';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

const NOW = new Date('2026-10-17T02:00:00Z'); // 10:00 HKT

let db: TestDb;
let tmp: string;
let t: TestApp;

beforeAll(async () => {
  db = await createTestDb();
  tmp = mkdtempSync(join(tmpdir(), 'ot-rem-'));
  const tsla = await seedInstrument(db.db, 'US', 'TSLA');
  await addToWatchlist(db.db, tsla.id);
  await db.db.insert(corporateEvents).values({
    instrumentId: tsla.id,
    eventType: 'earnings',
    eventDate: '2026-10-22',
    confirmed: true,
    knownAt: NOW,
  });
  t = await startApp(db, { tmp, now: NOW });
});

afterAll(async () => {
  await t.close();
  rmSync(tmp, { recursive: true, force: true });
  await db.drop();
});

describe('GET /api/reminders', () => {
  it('returns the correct shape and includes the earnings date', async () => {
    const r = await t.get('/api/reminders');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ asOf: '2026-10-17', today: [], upcoming: expect.any(Array) });
    const upcoming = r.json.upcoming as { kind: string; symbol: string; date: string }[];
    const earnings = upcoming.find((i) => i.kind === 'results' && i.symbol === 'TSLA');
    expect(earnings).toBeDefined();
    expect(earnings?.date).toBe('2026-10-22');
  });

  it('respects the days query parameter', async () => {
    const r = await t.get('/api/reminders?days=3');
    expect(r.status).toBe(200);
    // TSLA earnings on 2026-10-22 is 5 days out — outside the 3-day window
    const upcoming = r.json.upcoming as { kind: string; symbol: string }[];
    expect(upcoming.find((i) => i.kind === 'results' && i.symbol === 'TSLA')).toBeUndefined();
  });
});
