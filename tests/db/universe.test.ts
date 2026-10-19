import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Market } from '../../src/core/calendar';
import { addToWatchlist, findInstrument, removeFromWatchlist } from '../../src/db/repos';
import {
  corporateEvents,
  positions,
  recommendations,
  researchRuns,
  universeMembers,
  watchlist,
} from '../../src/db/schema';
import {
  activeUniverseCounts,
  listUniverseInstruments,
  syncUniverse,
  type UniverseMember,
} from '../../src/db/universe';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.db.delete(universeMembers);
  await db.db.delete(watchlist);
});

const us = (symbol: string, indexCode: UniverseMember['indexCode'] = 'SPX', extra: Partial<UniverseMember> = {}) =>
  ({
    market: 'US',
    symbol,
    name: `${symbol} Corp`,
    sector: 'Industrials',
    indexCode,
    ...extra,
  }) satisfies UniverseMember;
const hk = (symbol: string, indexCode: UniverseMember['indexCode'] = 'HSI', stockLot?: number): UniverseMember => ({
  market: 'HK',
  symbol,
  name: `HK ${symbol}`,
  sector: null,
  indexCode,
  ...(stockLot ? { stockLot } : {}),
});
const names = (prefix: string, n: number, indexCode: UniverseMember['indexCode'] = 'SPX'): UniverseMember[] =>
  Array.from({ length: n }, (_v, i) => us(`${prefix}${String(i).padStart(2, '0')}`, indexCode));

const membershipsOf = async (symbol: string, market: Market = 'US') => {
  const inst = await findInstrument(db.db, market, symbol);
  if (!inst) return [];
  return db.db
    .select()
    .from(universeMembers)
    .where(eq(universeMembers.instrumentId, inst.id))
    .orderBy(universeMembers.indexCode);
};

describe('adding names', () => {
  it('creates instruments (no listed options, default lot) and one membership per index; a second run changes nothing', async () => {
    const members = [us('AAA1', 'SPX'), us('AAA2', 'SPX'), us('AAA2', 'NDX'), us('AAA3', 'MID')];
    const first = await syncUniverse(db.db, members, '2026-10-13');
    expect(first).toMatchObject({ added: 4, reactivated: 0, removed: 0, flagged: [], instruments: 3, created: 3 });
    expect([...first.changes.added].sort()).toEqual(['MID:AAA3', 'NDX:AAA2', 'SPX:AAA1', 'SPX:AAA2']);
    const a1 = await findInstrument(db.db, 'US', 'AAA1');
    expect(a1).toMatchObject({ name: 'AAA1 Corp', sector: 'Industrials', hasListedOptions: false, multiplier: 100 });
    expect(await membershipsOf('AAA2')).toMatchObject([
      { indexCode: 'NDX', addedAt: '2026-10-13', removedAt: null },
      { indexCode: 'SPX', addedAt: '2026-10-13', removedAt: null },
    ]);
    const again = await syncUniverse(db.db, members, '2026-10-14');
    expect(again).toMatchObject({ added: 0, reactivated: 0, removed: 0, flagged: [], created: 0 });
    expect((await membershipsOf('AAA1'))[0]?.addedAt).toBe('2026-10-13'); // not re-stamped
  });

  it('a name entering a second index is an addition of that membership only', async () => {
    await syncUniverse(db.db, [us('AAB1', 'SPX')], '2026-10-13');
    const r = await syncUniverse(db.db, [us('AAB1', 'SPX'), us('AAB1', 'NDX')], '2026-10-20');
    expect(r).toMatchObject({ added: 1, created: 0 });
    expect((await membershipsOf('AAB1')).map((m) => [m.indexCode, m.addedAt])).toEqual([
      ['NDX', '2026-10-20'],
      ['SPX', '2026-10-13'],
    ]);
  });

  it('the sector of an S&P list wins over the Nasdaq-100 industry for a name in both', async () => {
    await syncUniverse(
      db.db,
      [us('AAC1', 'NDX', { sector: 'Technology-ish' }), us('AAC1', 'SPX', { sector: 'Communication Services' })],
      '2026-10-13',
    );
    expect((await findInstrument(db.db, 'US', 'AAC1'))?.sector).toBe('Communication Services');
  });

  it('stores the provider symbol only when it is not the standard spelling', async () => {
    await syncUniverse(
      db.db,
      [us('BRK.B', 'SPX', { yahoo: 'BRK-B' }), us('FOO', 'SPX', { yahoo: 'FOO-X.L' })],
      '2026-10-13',
    );
    expect((await findInstrument(db.db, 'US', 'BRK.B'))?.providerSymbols).toEqual({});
    expect((await findInstrument(db.db, 'US', 'FOO'))?.providerSymbols).toEqual({ yahoo: 'FOO-X.L' });
  });

  it('refreshed names and sectors replace the old ones on a name that is not followed', async () => {
    await syncUniverse(db.db, [us('AAD1')], '2026-10-13');
    await syncUniverse(db.db, [us('AAD1', 'SPX', { name: 'Renamed Inc.', sector: 'Energy' })], '2026-10-20');
    expect(await findInstrument(db.db, 'US', 'AAD1')).toMatchObject({ name: 'Renamed Inc.', sector: 'Energy' });
  });
});

describe('removing and reactivating', () => {
  it('stamps removed_at for a name no longer listed, leaves other indexes of it alone, and lists only active members', async () => {
    const base = [...names('RMA', 20, 'SPX'), us('RMA00', 'NDX')];
    await syncUniverse(db.db, base, '2026-10-13');
    // RMA00 leaves SPX but stays in NDX; RMA01 leaves everything (2 of 21 memberships: under the 10% limit)
    const next = [...names('RMA', 20, 'SPX').slice(2), us('RMA00', 'NDX')];
    const r = await syncUniverse(db.db, next, '2026-10-20');
    expect(r).toMatchObject({ added: 0, reactivated: 0, removed: 2, flagged: [] });
    expect([...r.changes.removed].sort()).toEqual(['SPX:RMA00', 'SPX:RMA01']);
    expect((await membershipsOf('RMA00')).map((m) => [m.indexCode, m.removedAt])).toEqual([
      ['NDX', null],
      ['SPX', '2026-10-20'],
    ]);
    expect((await membershipsOf('RMA01')).map((m) => m.removedAt)).toEqual(['2026-10-20']);
    const active = (await listUniverseInstruments(db.db, 'US')).map((i) => i.symbol);
    expect(active).toContain('RMA00');
    expect(active).not.toContain('RMA01');
    expect(await findInstrument(db.db, 'US', 'RMA01')).not.toBeNull(); // instruments are never deleted
  });

  it('lists a name again: removed_at cleared, added_at kept, counted as reactivated not added', async () => {
    await syncUniverse(db.db, names('RAA', 30), '2026-10-13');
    await syncUniverse(db.db, names('RAA', 30).slice(1), '2026-10-20');
    expect((await membershipsOf('RAA00'))[0]).toMatchObject({ addedAt: '2026-10-13', removedAt: '2026-10-20' });
    const r = await syncUniverse(db.db, names('RAA', 30), '2026-10-27');
    expect(r).toMatchObject({ added: 0, reactivated: 1, removed: 0 });
    expect(r.changes).toEqual({ added: [], reactivated: ['SPX:RAA00'], removed: [] });
    expect((await membershipsOf('RAA00'))[0]).toMatchObject({ addedAt: '2026-10-13', removedAt: null });
  });

  it('only reconciles the indexes it was given: an index that failed to load keeps its members', async () => {
    await syncUniverse(db.db, [...names('RIA', 20, 'SPX'), ...names('RIB', 20, 'NDX')], '2026-10-13');
    // NDX list not fetched this run (empty), SPX fetched and unchanged
    const r = await syncUniverse(db.db, names('RIA', 20, 'SPX'), '2026-10-20');
    expect(r.removed).toBe(0);
    expect((await membershipsOf('RIB00'))[0]?.removedAt).toBeNull();
    // an explicit reconcile list leaves every other index alone, even ones present in `members`
    const r2 = await syncUniverse(
      db.db,
      [...names('RIA', 20, 'SPX').slice(1), ...names('RIB', 5, 'NDX')],
      '2026-10-27',
      {
        reconcile: ['SPX'],
      },
    );
    expect(r2.removed).toBe(1);
    expect((await membershipsOf('RIB19'))[0]?.removedAt).toBeNull();
  });

  it('an empty list for an index is treated as a failed source, never as "everyone left"', async () => {
    await syncUniverse(db.db, names('REA', 20, 'SPX'), '2026-10-13');
    const r = await syncUniverse(db.db, [us('REB1', 'NDX')], '2026-10-20', { reconcile: ['SPX', 'NDX'] });
    expect(r.removed).toBe(0);
    expect((await membershipsOf('REA00'))[0]?.removedAt).toBeNull();
  });
});

describe('the 10% guard', () => {
  it('flags instead of removing when a refresh would drop more than 10% of a market, and applies nothing for that market', async () => {
    await syncUniverse(db.db, names('FLA', 20), '2026-10-13');
    const r = await syncUniverse(db.db, names('FLA', 20).slice(5), '2026-10-20'); // 5 of 20 = 25%
    expect(r.removed).toBe(0);
    expect(r.flagged).toMatchObject([{ market: 'US', wouldRemove: 5, of: 20 }]);
    expect((await listUniverseInstruments(db.db, 'US')).filter((i) => i.symbol.startsWith('FLA'))).toHaveLength(20);
  });

  it('exactly 10% is allowed; the limit and a deliberate override are options', async () => {
    await syncUniverse(db.db, names('FLB', 20), '2026-10-13');
    const ok = await syncUniverse(db.db, names('FLB', 20).slice(2), '2026-10-20'); // 2 of 20 = 10%
    expect(ok).toMatchObject({ removed: 2, flagged: [] });
    const flagged = await syncUniverse(db.db, names('FLB', 20).slice(6), '2026-10-27', { maxRemovalShare: 0.1 }); // 4 of 18
    expect(flagged.flagged).toMatchObject([{ market: 'US', wouldRemove: 4, of: 18 }]);
    const forced = await syncUniverse(db.db, names('FLB', 20).slice(6), '2026-10-27', { force: true });
    expect(forced).toMatchObject({ removed: 4, flagged: [] });
  });

  it('is per market: a flagged US refresh does not stop the HK removals of the same run', async () => {
    await syncUniverse(
      db.db,
      [...names('FLC', 10), ...Array.from({ length: 20 }, (_v, i) => hk(String(1100 + i), 'HSI', 100))],
      '2026-10-13',
    );
    const r = await syncUniverse(
      db.db,
      [
        ...names('FLC', 10).slice(5),
        ...Array.from({ length: 20 }, (_v, i) => hk(String(1100 + i), 'HSI', 100)).slice(1),
      ],
      '2026-10-20',
      { reconcile: ['SPX', 'HSI'] },
    );
    expect(r.flagged).toMatchObject([{ market: 'US', wouldRemove: 5, of: 10 }]);
    expect(r.removed).toBe(1); // 1 of 20 HK
  });
});

describe('names on the watchlist', () => {
  it('keeps the option listing, multiplier, provider symbol, name and sector the watchlist ingest set, and merges the stock lot', async () => {
    const tencent = await seedInstrument(db.db, 'HK', '0700', {
      name: 'Tencent Holdings Limited',
      sector: 'Communication Services',
      boardLot: 100,
      hasListedOptions: true,
      providerSymbols: { yahoo: '0700.HK', financialCurrency: 'CNY', solvencySource: 'inferred' },
    });
    const alibaba = await seedInstrument(db.db, 'HK', '9988', {
      name: 'Alibaba Group Holding Limited',
      sector: 'Consumer Cyclical',
      boardLot: 500, // the OPTION contract size
      hasListedOptions: true,
      providerSymbols: { yahoo: '9988.HK', financialCurrency: 'CNY' },
    });
    await addToWatchlist(db.db, tencent.id);
    await addToWatchlist(db.db, alibaba.id);
    const r = await syncUniverse(
      db.db,
      [
        { ...hk('0700', 'HSI', 100), name: 'TENCENT', yahoo: '0700-ALT.HK' },
        { ...hk('9988', 'HSI', 100), name: 'BABA-W', sector: 'Other' },
      ],
      '2026-10-13',
    );
    expect(r).toMatchObject({ added: 2, created: 0 });
    expect(await findInstrument(db.db, 'HK', '0700')).toMatchObject({
      name: 'Tencent Holdings Limited',
      sector: 'Communication Services',
      multiplier: 100,
      hasListedOptions: true,
      providerSymbols: { yahoo: '0700.HK', financialCurrency: 'CNY', solvencySource: 'inferred', stockLot: 100 },
    });
    expect(await findInstrument(db.db, 'HK', '9988')).toMatchObject({
      name: 'Alibaba Group Holding Limited',
      sector: 'Consumer Cyclical',
      multiplier: 500, // the contract size is untouched; the stock lot is a separate key
      hasListedOptions: true,
      providerSymbols: { yahoo: '9988.HK', financialCurrency: 'CNY', stockLot: 100 },
    });
  });

  it('an inactive watchlist name is still protected, and only the ACTIVE watchlist sets onWatchlist', async () => {
    const aapl = await seedInstrument(db.db, 'US', 'WLA1', {
      name: 'Apple',
      sector: 'Technology',
      hasListedOptions: true,
    });
    const msft = await seedInstrument(db.db, 'US', 'WLA2', { name: 'Microsoft', hasListedOptions: true });
    await addToWatchlist(db.db, aapl.id);
    await addToWatchlist(db.db, msft.id);
    await removeFromWatchlist(db.db, msft.id);
    await syncUniverse(
      db.db,
      [
        us('WLA1', 'SPX', { name: 'Apple Inc.', sector: 'Information Technology' }),
        us('WLA2', 'SPX', { name: 'Microsoft Corp' }),
        us('WLA3'),
      ],
      '2026-10-13',
    );
    expect(await findInstrument(db.db, 'US', 'WLA1')).toMatchObject({
      name: 'Apple',
      sector: 'Technology',
      hasListedOptions: true,
    });
    // a protected name is only filled where it has nothing
    expect(await findInstrument(db.db, 'US', 'WLA2')).toMatchObject({
      name: 'Microsoft',
      sector: 'Industrials',
      hasListedOptions: true,
    });
    const listed = new Map((await listUniverseInstruments(db.db, 'US')).map((i) => [i.symbol, i.onWatchlist]));
    expect(listed.get('WLA1')).toBe(true);
    expect(listed.get('WLA2')).toBe(false);
    expect(listed.get('WLA3')).toBe(false);
  });
});

describe('HK stock lots', () => {
  it('stores the stock lot, marks a name without one as assumed, and never lets an unknown lot erase a known one', async () => {
    await syncUniverse(db.db, [hk('1201', 'HSCI', 2000), hk('1202', 'HSCI')], '2026-10-13');
    expect((await findInstrument(db.db, 'HK', '1201'))?.providerSymbols).toEqual({ stockLot: 2000 });
    expect((await findInstrument(db.db, 'HK', '1202'))?.providerSymbols).toEqual({ lotAssumed: true });
    // board_lot stays at the default for both
    expect((await findInstrument(db.db, 'HK', '1201'))?.multiplier).toBe(100);
    // the lot is found later: stockLot set, the assumed flag goes away
    await syncUniverse(db.db, [hk('1201', 'HSCI'), hk('1202', 'HSCI', 500)], '2026-10-20');
    expect((await findInstrument(db.db, 'HK', '1201'))?.providerSymbols).toEqual({ stockLot: 2000 });
    expect((await findInstrument(db.db, 'HK', '1202'))?.providerSymbols).toEqual({ stockLot: 500 });
    // a lot that changes is updated
    await syncUniverse(db.db, [hk('1201', 'HSCI', 1000), hk('1202', 'HSCI', 500)], '2026-10-27');
    expect((await findInstrument(db.db, 'HK', '1201'))?.providerSymbols).toEqual({ stockLot: 1000 });
  });

  it('US names never get lot keys', async () => {
    await syncUniverse(db.db, [us('LOT1')], '2026-10-13');
    expect((await findInstrument(db.db, 'US', 'LOT1'))?.providerSymbols).toEqual({});
  });
});

describe('reading the universe', () => {
  it('lists one row per instrument across indexes, ordered by symbol, with its index codes and stock lot', async () => {
    await syncUniverse(
      db.db,
      [
        us('LSB1', 'NDX'),
        us('LSB1', 'SPX'),
        us('LSA1', 'MID'),
        hk('1301', 'HSI', 200),
        hk('1301', 'HSCI', 200),
        hk('1302', 'HSCI'),
      ],
      '2026-10-13',
    );
    const usList = (await listUniverseInstruments(db.db, 'US')).filter((i) => i.symbol.startsWith('LS'));
    expect(usList.map((i) => [i.symbol, i.indexCodes])).toEqual([
      ['LSA1', ['MID']],
      ['LSB1', ['NDX', 'SPX']],
    ]);
    const hkList = (await listUniverseInstruments(db.db, 'HK')).filter((i) => i.symbol.startsWith('130'));
    expect(hkList.map((i) => [i.symbol, i.indexCodes, i.stockLot])).toEqual([
      ['1301', ['HSCI', 'HSI'], 200],
      ['1302', ['HSCI'], null],
    ]);
  });

  it('counts active memberships per index and distinct instruments per market', async () => {
    await syncUniverse(
      db.db,
      [us('CNT1', 'SPX'), us('CNT1', 'NDX'), us('CNT2', 'SPX'), hk('1401', 'HSI', 100), hk('1401', 'HSCI', 100)],
      '2026-10-13',
    );
    const c = await activeUniverseCounts(db.db);
    expect(c.byIndex).toEqual({ SPX: 2, NDX: 1, HSI: 1, HSCI: 1 });
    expect(c.byMarket).toEqual({ US: 2, HK: 1 });
  });
});

describe('what it never touches', () => {
  it('writes no recommendations, positions, research runs, corporate events or watchlist rows', async () => {
    const tables = [recommendations, positions, researchRuns, corporateEvents, watchlist];
    const before = await Promise.all(tables.map(async (t) => (await db.db.select({ n: count() }).from(t))[0]?.n ?? 0));
    await syncUniverse(db.db, [...names('NTA', 20), hk('1501', 'HSI', 100)], '2026-10-13');
    await syncUniverse(db.db, names('NTA', 20).slice(1), '2026-10-20');
    const after = await Promise.all(tables.map(async (t) => (await db.db.select({ n: count() }).from(t))[0]?.n ?? 0));
    expect(after).toEqual(before);
  });
});
