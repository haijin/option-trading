import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect, type DbHandle } from './client';
import { seedReferenceData } from './seed';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies pending migrations (schema + seed rows), then the idempotent reference data. */
export async function migrateDatabase(h: DbHandle): Promise<void> {
  await migrate(h.db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seedReferenceData(h.db);
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  const h = connect();
  migrateDatabase(h)
    .then(async () => {
      console.log('migrations applied; reference data seeded');
      await h.close();
    })
    .catch(async (err) => {
      console.error(`migration failed: ${(err as Error).message}`);
      await h.close();
      process.exit(1);
    });
}
