import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, type DbHandle } from '../../src/db/client';
import { adminUrl, withDatabase } from './urls';

export interface TestDb extends DbHandle {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** A private, migrated database cloned from the per-run template. Call `drop()` in afterAll. */
export async function createTestDb(): Promise<TestDb> {
  const template = process.env.OT_TEST_TEMPLATE_DB;
  if (!template)
    throw new Error('OT_TEST_TEMPLATE_DB missing: tests must run through the vitest configs (globalSetup)');
  const name = `ot_t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`create database ${name} template ${template}`);
  await admin.end();
  const url = withDatabase(adminUrl(), name);
  const h = connect(url);
  return {
    ...h,
    url,
    name,
    async drop() {
      await h.close();
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
