import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from '../helpers/app';
import { createTestDb, type TestDb } from '../helpers/test-db';

describe('the gate cannot be skipped by how the path is spelled', () => {
  let db: TestDb;
  let tmp: string;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-gate-'));
    t = await startApp(db, { tmp, auth: {} });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('answers the plain path with 401 (control)', async () => {
    expect((await t.get('/api/settings')).status).toBe(401);
  });

  it.each([
    '/%61pi/settings',
    '/%61%70%69/settings',
    '/api%2Fsettings',
    '/api/%73ettings',
    '/api/./settings',
    '/x/../api/settings',
  ])('GET %s never returns data without a session', async (url) => {
    const r = await t.get(url);
    expect(r.status, `${url} -> ${r.text.slice(0, 80)}`).not.toBe(200);
  });

  it('does not let an encoded write path skip the gate or the JSON requirement', async () => {
    const r = await t.post('/%61pi/scan/run');
    expect(r.status).toBe(401);
    const form = await t.post('/%61pi/scan/run', undefined, { 'content-type': 'text/plain' });
    expect(form.status).toBe(415);
  });

  it('does not let an absolute-form request line skip the gate', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: 'http://127.0.0.1:4317/api/settings',
      headers: { host: '127.0.0.1:4317' },
    });
    expect(r.statusCode).toBe(401);
  });
});
