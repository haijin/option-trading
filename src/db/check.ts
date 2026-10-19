import { sql } from 'drizzle-orm';
import { connect } from './client';

/** `pnpm db:check`: verifies the connection, server version, migration state and the two seed rows. */
export async function dbCheck(url?: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const h = connect(url);
  try {
    const v = await h.db.execute(sql`select current_setting('server_version') as v, current_database() as d`);
    const row = v.rows[0] as { v: string; d: string };
    lines.push(`connected: database ${row.d}, PostgreSQL ${row.v}`);
    const tables = await h.db.execute(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const nTables = (tables.rows[0] as { n: number }).n;
    lines.push(`tables: ${nTables}`);
    if (nTables < 20) {
      lines.push('schema missing: run `pnpm db:migrate`');
      return { ok: false, lines };
    }
    const params = await h.db.execute(
      sql`select count(*)::int as n from strategy_params where name = 'default' and version = 1`,
    );
    const settings = await h.db.execute(
      sql`select count(*)::int as n, bool_or(equity is null) as unset from portfolio_settings`,
    );
    const nParams = (params.rows[0] as { n: number }).n;
    const s = settings.rows[0] as { n: number; unset: boolean };
    lines.push(`seed strategy_params default v1: ${nParams === 1 ? 'present' : 'MISSING'}`);
    lines.push(
      `seed portfolio_settings: ${s.n === 1 ? 'present' : 'MISSING'}${s.unset ? ' (equity not set yet)' : ''}`,
    );
    return { ok: nParams === 1 && s.n === 1, lines };
  } catch (err) {
    lines.push(`connection failed: ${(err as Error).message}`);
    return { ok: false, lines };
  } finally {
    await h.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check.ts')) {
  dbCheck().then(({ ok, lines }) => {
    for (const l of lines) console.log(l);
    process.exit(ok ? 0 : 1);
  });
}
