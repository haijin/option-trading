import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { futuStatus } from '../../src/cli/commands/futu';
import { createContext } from '../../src/cli/context';
import type { FutuSource } from '../../src/providers/futu';
import { cliHarness } from '../helpers/cli';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  const h = cliHarness(db.url);
  for (const a of [
    ['watchlist', 'add', '0700', 'HK'],
    ['watchlist', 'add', '0005', 'HK'],
    ['watchlist', 'add', 'AAPL', 'US'],
  ]) {
    expect((await h.run(a)).code).toBe(0);
  }
});
afterAll(async () => {
  await db.drop();
});

describe('futu status', () => {
  it('refuses with a hint when FUTU_PORT is not configured (tests always run without OpenD)', async () => {
    const r = await cliHarness(db.url).run(['futu', 'status']);
    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toContain('FUTU_PORT is not set');
  });

  it('reports the gateway, the quota and every HK watchlist name as OpenD knows it', async () => {
    const source: FutuSource = {
      globalState: async () => ({ qotLogined: true, trdLogined: false, marketHK: 6, marketUS: 3, serverVer: 1011 }),
      historyQuota: async () => ({ used: 2, remaining: 998 }),
      staticInfo: async (insts) =>
        insts
          .filter((i) => i.symbol === '0700')
          .map((i) => ({
            security: { market: 1, code: i.symbol.padStart(5, '0') },
            name: 'TENCENT',
            lotSize: 100,
            secType: 3,
            listTime: '2004-06-16',
            delisting: false,
          })),
      putChain: async () => {
        throw new Error('not used');
      },
      dailyBars: async () => {
        throw new Error('not used');
      },
      ivHistory: async () => {
        throw new Error('not used');
      },
      close: () => {},
    };
    const ctx = createContext({ databaseUrl: db.url, out: () => {}, err: () => {} });
    try {
      const report = await futuStatus(ctx, source);
      const text = report.lines.join('\n');
      expect(text).toContain('OpenD v1011 quote login yes, trade login no');
      expect(text).toContain('HK market closed; US market morning session');
      expect(text).toContain('history-bar quota: 2 used, 998 securities left');
      expect(text).toMatch(/0700\s+TENCENT\s+100\s+100\s+yes/);
      expect(text).toMatch(/0005\s+\(not found\)\s+\?\s+400\s+yes\s+unknown to OpenD/);
      expect(text).not.toContain('AAPL');
    } finally {
      await ctx.closeDb();
    }
  });
});
