import { readdirSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultParams, paramsHash } from '../../src/core/params';
import { stableStringify } from '../../src/core/util';
import { dbCheck } from '../../src/db/check';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';
import { createTestDb, type TestDb } from '../helpers/test-db';

const EXPECTED_TABLES = [
  'instruments',
  'watchlist',
  'exchange_calendar',
  'portfolio_settings',
  'fx_rates',
  'price_bars',
  'fundamental_statements',
  'corporate_events',
  'option_contracts',
  'option_quotes',
  'pricing_calibration',
  'iv_daily',
  'market_regime',
  'strategy_params',
  'skill_definitions',
  'scan_runs',
  'skill_runs',
  'recommendations',
  'positions',
  'stock_lots',
  'position_marks',
  'backtest_runs',
  'backtest_trades',
  'job_runs',
  'valuation_overrides',
  'fair_values',
  'research_runs',
  'app_users',
  'app_sessions',
  'login_links',
  'journal_entries',
  'journal_revisions',
  'journal_entry_instruments',
  'journal_assets',
  'journal_ai_runs',
  'news_items',
  'news_briefs',
  'universe_members',
  'leaders_runs',
  'leaders_candidates',
  'leaders_mutes',
];

describe('T1: migrations create the schema and both seed rows', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('creates every table of the design', async () => {
    const r = await db.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = (r.rows as { table_name: string }[])
      .map((x) => x.table_name)
      .filter((n) => !n.startsWith('__drizzle'));
    for (const t of EXPECTED_TABLES) expect(names).toContain(t);
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });

  it('seeds strategy_params default v1 to v5; the latest version matches the code defaults and its hash', async () => {
    const r = await db.db.execute(
      sql`select params, params_hash, version from strategy_params where name = 'default' order by version`,
    );
    const rows = r.rows as { params: unknown; params_hash: string; version: number }[];
    expect(rows.map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
    // v1 is history: it keeps the original single-number dteMax so old scan runs stay reproducible.
    const v1 = rows[0]?.params as { 'option.select': { dteMax: unknown } };
    expect(v1['option.select'].dteMax).toBe(45);
    // The latest version is what the code produces today; a changed default needs a new version, not an edited one.
    const latest = rows[rows.length - 1] as { params: unknown; params_hash: string; version: number };
    expect(stableStringify(latest.params)).toBe(stableStringify(defaultParams()));
    expect(latest.params_hash).toBe(paramsHash(defaultParams()));
  });

  it('seeds the single portfolio_settings row with equity NULL and the drawdown governor off', async () => {
    const r = await db.db.execute(
      sql`select id, equity, base_currency, daily_loss_limit, consecutive_loss_halt, degear_tiers from portfolio_settings`,
    );
    expect(r.rows).toEqual([
      {
        id: 1,
        equity: null,
        base_currency: 'HKD',
        daily_loss_limit: null,
        consecutive_loss_halt: null,
        degear_tiers: [],
      },
    ]);
    await expect(db.db.execute(sql`insert into portfolio_settings (id) values (2)`)).rejects.toThrow();
  });

  it('seeds exchange calendars and the five index instruments', async () => {
    const cal = await db.db.execute(
      sql`select market, count(*)::int as n from exchange_calendar group by market order by market::text`,
    );
    const counts = Object.fromEntries((cal.rows as { market: string; n: number }[]).map((x) => [x.market, x.n]));
    expect(counts.HK).toBeGreaterThan(4500);
    expect(counts.US).toBeGreaterThan(4500);
    const idx = await db.db.execute(
      sql`select market, symbol from instruments where sector = 'INDEX' order by market::text, symbol`,
    );
    expect(idx.rows).toEqual([
      { market: 'HK', symbol: '2800' },
      { market: 'HK', symbol: 'HSI' },
      { market: 'HK', symbol: 'VHSI' },
      { market: 'US', symbol: 'SPY' },
      { market: 'US', symbol: 'VIX' },
    ]);
  });

  it('db:check passes against the migrated database', async () => {
    const res = await dbCheck(db.url);
    expect(res.ok).toBe(true);
    expect(res.lines.join('\n')).toContain('PostgreSQL 16');
  });

  it('T7: no is_financial column anywhere; solvency_model is the only switch', async () => {
    const r = await db.db.execute(
      sql`select column_name from information_schema.columns where table_schema = 'public' and column_name = 'is_financial'`,
    );
    expect(r.rows).toHaveLength(0);
    const c = await db.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'instruments' and column_name = 'solvency_model'`,
    );
    expect(c.rows).toHaveLength(1);
  });

  it('option_quotes.mid is a generated column', async () => {
    const r = await db.db.execute(
      sql`select is_generated from information_schema.columns where table_name = 'option_quotes' and column_name = 'mid'`,
    );
    expect(r.rows).toEqual([{ is_generated: 'ALWAYS' }]);
  });
});

describe('T7: source tree has no is_financial / isFinancial', () => {
  it('grep over src and drizzle returns nothing', () => {
    const hits: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|sql)$/.test(e.name) && /is_?financial/i.test(readFileSync(p, 'utf8'))) hits.push(p.pathname);
      }
    };
    walk(new URL('../../src/', import.meta.url));
    walk(new URL(`file:///${MIGRATIONS_FOLDER.replace(/\\/g, '/')}/`));
    expect(hits).toEqual([]);
  });
});
