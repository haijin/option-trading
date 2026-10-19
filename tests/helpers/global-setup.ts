import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect } from '../../src/db/client';
import { migrateDatabase } from '../../src/db/migrate';
import { adminUrl, withDatabase } from './urls';

/**
 * Creates one migrated template database per test run; each test file clones it (CREATE DATABASE ... TEMPLATE),
 * which is far cheaper than re-running migrations. Dropped in teardown. Needs PG_ADMIN_URL or DATABASE_URL.
 */
let templateName = '';

export default async function setup(): Promise<() => Promise<void>> {
  templateName = `ot_tpl_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`create database ${templateName}`);
  await admin.end();

  const h = connect(withDatabase(adminUrl(), templateName));
  await migrateDatabase(h);
  await h.close();
  process.env.OT_TEST_TEMPLATE_DB = templateName;

  return async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`drop database if exists ${templateName} with (force)`);
    await a.end();
  };
}
