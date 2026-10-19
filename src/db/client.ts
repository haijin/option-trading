import 'dotenv/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A drizzle handle or an open transaction: writers accept either. */
export type DbOrTx = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env and fill it in)');
  return url;
}

export function connect(url: string = databaseUrl()): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // numeric/bigint columns stay strings on the wire (drizzle maps them); dates are returned as strings by the schema.
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export { schema };
