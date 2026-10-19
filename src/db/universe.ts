/**
 * The Leaders universe (docs/designs/leaders-pullback.md, "Universe and data"): index constituents as ordinary
 * `instruments` rows plus a `universe_members` row per (instrument, index). The watchlist stays the list of names the
 * user follows; a name that is on it keeps everything the watchlist ingest set (option listing, multiplier, provider
 * symbol, name, sector). This module never writes recommendations, positions, research verdicts or corporate events.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Market } from '../core/calendar';
import type { ISODate } from '../core/dates';
import { yahooSymbol } from '../core/symbols';
import type { Instrument } from '../core/types';
import type { DbOrTx } from './client';
import { toInstrument, upsertInstrument } from './repos';
import { instruments, universeMembers, watchlist } from './schema';

export const INDEX_CODES = ['SPX', 'NDX', 'MID', 'HSI', 'HSCEI', 'HSTECH', 'HSCI'] as const;
export type IndexCode = (typeof INDEX_CODES)[number];

export const INDEX_MARKET: Record<IndexCode, Market> = {
  SPX: 'US',
  NDX: 'US',
  MID: 'US',
  HSI: 'HK',
  HSCEI: 'HK',
  HSTECH: 'HK',
  HSCI: 'HK',
};

export const isIndexCode = (s: string): s is IndexCode => (INDEX_CODES as readonly string[]).includes(s);

/** One constituent of one index, as a provider (or the seed CSV) reports it. */
export interface UniverseMember {
  market: Market;
  /** Canonical symbol: US with '.' for class shares ('BRK.B'), HK four-digit zero-padded ('0700'). */
  symbol: string;
  name: string;
  sector: string | null;
  indexCode: IndexCode;
  /** Provider symbol, only when it differs from `yahooSymbol(market, symbol)`. */
  yahoo?: string;
  /** HK only: the stock board lot (shares per trading lot), NOT the option contract size. */
  stockLot?: number;
}

export interface SyncOptions {
  /**
   * Indexes whose list is complete in this run: removals are evaluated only for these. Default: every index that has at
   * least one member in `members` (an empty list is a failed source, never "every name left the index").
   */
  reconcile?: readonly IndexCode[];
  /** Largest share of a market's active memberships one run may stamp as removed before it flags instead (default 0.1). */
  maxRemovalShare?: number;
  /** Apply the removals even when the share is above the limit (a deliberate override, never used by the jobs). */
  force?: boolean;
}

export interface SyncFlag {
  market: Market;
  /** Memberships the refresh would have stamped as removed. */
  wouldRemove: number;
  /** Active memberships of that market in the reconciled indexes. */
  of: number;
  /** The memberships that would have been removed, as `INDEX:symbol` (for the log). */
  names: string[];
}

/** What changed, as `INDEX:symbol` strings (the jobs log a sample of it). */
export interface SyncChanges {
  added: string[];
  reactivated: string[];
  removed: string[];
}

export interface SyncResult {
  /** Memberships that did not exist before (new instrument or a name entering another index). */
  added: number;
  /** Memberships that had been stamped removed and are listed again. */
  reactivated: number;
  /** Memberships stamped `removed_at = today`. */
  removed: number;
  flagged: SyncFlag[];
  /** Distinct instruments in the synced lists. */
  instruments: number;
  /** Instrument rows created by this run. */
  created: number;
  changes: SyncChanges;
}

/** Which list's sector wins when a name is in several (GICS from S&P before the ICB industry of the Nasdaq-100). */
const SECTOR_RANK: Record<IndexCode, number> = { SPX: 0, MID: 1, NDX: 2, HSI: 3, HSCEI: 4, HSTECH: 5, HSCI: 6 };

const keyOf = (market: Market, symbol: string): string => `${market}:${symbol}`;

interface Merged {
  market: Market;
  symbol: string;
  name: string | null;
  sector: string | null;
  yahoo: string | undefined;
  stockLot: number | undefined;
  indexes: Set<IndexCode>;
}

function mergeMembers(members: readonly UniverseMember[]): Map<string, Merged> {
  const out = new Map<string, Merged>();
  const sectorRank = new Map<string, number>();
  for (const m of members) {
    const k = keyOf(m.market, m.symbol);
    let cur = out.get(k);
    if (!cur) {
      cur = {
        market: m.market,
        symbol: m.symbol,
        name: null,
        sector: null,
        yahoo: undefined,
        stockLot: undefined,
        indexes: new Set(),
      };
      out.set(k, cur);
    }
    cur.indexes.add(m.indexCode);
    if (!cur.name && m.name.trim()) cur.name = m.name.trim();
    if (m.sector && SECTOR_RANK[m.indexCode] < (sectorRank.get(k) ?? Number.POSITIVE_INFINITY)) {
      cur.sector = m.sector;
      sectorRank.set(k, SECTOR_RANK[m.indexCode]);
    }
    if (m.yahoo && !cur.yahoo) cur.yahoo = m.yahoo;
    if (m.stockLot && !cur.stockLot) cur.stockLot = m.stockLot;
  }
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Brings `instruments` and `universe_members` in line with the constituent lists.
 *
 * - New names become instruments with `has_listed_options = false` and the default board lot; the HK stock lot goes in
 *   `provider_symbols.stockLot` (`lotAssumed = true` when the source has no lot for the name).
 * - A name that exists already keeps `has_listed_options`, `board_lot` and `provider_symbols.yahoo`; if it is on the
 *   watchlist (active or not) its name and sector are kept too. Only `stockLot` / `lotAssumed` are merged into its
 *   provider symbols, without touching other keys.
 * - A membership absent from a reconciled index is stamped `removed_at = today`, unless that would remove more than
 *   `maxRemovalShare` of a market's memberships in this run: then nothing is removed for that market and the market is
 *   returned in `flagged` (a parse or format change, not an index review).
 */
export async function syncUniverse(
  db: DbOrTx,
  members: readonly UniverseMember[],
  today: ISODate,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const merged = mergeMembers(members);
  const result: SyncResult = {
    added: 0,
    reactivated: 0,
    removed: 0,
    flagged: [],
    instruments: merged.size,
    created: 0,
    changes: { added: [], reactivated: [], removed: [] },
  };
  if (merged.size === 0) return result;

  const markets = [...new Set([...merged.values()].map((m) => m.market))];
  const existingRows = await db.select().from(instruments).where(inArray(instruments.market, markets));
  const byKey = new Map(existingRows.map((r) => [keyOf(r.market, r.symbol), r]));
  const symbolById = new Map(existingRows.map((r) => [r.id, r.symbol]));
  const watched = new Set((await db.select({ id: watchlist.instrumentId }).from(watchlist)).map((r) => r.id));

  // ---- instruments
  const idOf = new Map<string, number>();
  for (const m of merged.values()) {
    const k = keyOf(m.market, m.symbol);
    const row = byKey.get(k);
    if (!row) {
      const providerSymbols: Record<string, unknown> = {};
      if (m.yahoo && m.yahoo !== yahooSymbol(m.market, m.symbol)) providerSymbols.yahoo = m.yahoo;
      if (m.market === 'HK') {
        if (m.stockLot !== undefined) providerSymbols.stockLot = m.stockLot;
        else providerSymbols.lotAssumed = true;
      }
      const inst = await upsertInstrument(db, {
        market: m.market,
        symbol: m.symbol,
        name: m.name,
        sector: m.sector,
        hasListedOptions: false,
        providerSymbols,
      });
      idOf.set(k, inst.id);
      symbolById.set(inst.id, inst.symbol);
      result.created++;
      continue;
    }
    idOf.set(k, row.id);
    const protectedRow = watched.has(row.id) || row.sector === 'INDEX';
    const patch: { name?: string; sector?: string; providerSymbols?: Record<string, unknown> } = {};
    if (protectedRow) {
      if (!row.name && m.name) patch.name = m.name;
      if (!row.sector && m.sector) patch.sector = m.sector;
    } else {
      if (m.name && m.name !== row.name) patch.name = m.name;
      if (m.sector && m.sector !== row.sector) patch.sector = m.sector;
    }
    const ps: Record<string, unknown> = { ...row.providerSymbols };
    if (!protectedRow && m.yahoo && m.yahoo !== yahooSymbol(m.market, m.symbol)) ps.yahoo = m.yahoo;
    if (m.market === 'HK') {
      if (m.stockLot !== undefined) {
        ps.stockLot = m.stockLot;
        delete ps.lotAssumed;
      } else if (typeof ps.stockLot !== 'number') {
        ps.lotAssumed = true;
      }
    }
    if (!sameJson(ps, row.providerSymbols)) patch.providerSymbols = ps;
    if (Object.keys(patch).length > 0) await upsertInstrument(db, { market: m.market, symbol: m.symbol, ...patch });
  }

  // ---- memberships: add / reactivate what the lists say
  const listed = new Map<IndexCode, Set<number>>();
  for (const m of merged.values()) {
    const id = idOf.get(keyOf(m.market, m.symbol)) as number;
    for (const ic of m.indexes) {
      let s = listed.get(ic);
      if (!s) {
        s = new Set();
        listed.set(ic, s);
      }
      s.add(id);
    }
  }
  const reconcile = (opts.reconcile ?? [...listed.keys()]).filter((ic) => (listed.get(ic)?.size ?? 0) > 0);
  const touchedIndexes = [...new Set([...listed.keys(), ...reconcile])];
  const rows = await db.select().from(universeMembers).where(inArray(universeMembers.indexCode, touchedIndexes));
  const rowOf = new Map(rows.map((r) => [`${r.instrumentId}:${r.indexCode}`, r]));

  const toInsert: (typeof universeMembers.$inferInsert)[] = [];
  const toReactivate: { instrumentId: number; indexCode: IndexCode }[] = [];
  for (const [ic, ids] of listed) {
    for (const id of ids) {
      const row = rowOf.get(`${id}:${ic}`);
      if (!row) toInsert.push({ instrumentId: id, indexCode: ic, addedAt: today, removedAt: null });
      else if (row.removedAt !== null) toReactivate.push({ instrumentId: id, indexCode: ic });
    }
  }
  for (let i = 0; i < toInsert.length; i += 500)
    await db
      .insert(universeMembers)
      .values(toInsert.slice(i, i + 500))
      .onConflictDoNothing();
  for (const r of toReactivate)
    await db
      .update(universeMembers)
      .set({ removedAt: null })
      .where(and(eq(universeMembers.instrumentId, r.instrumentId), eq(universeMembers.indexCode, r.indexCode)));
  result.added = toInsert.length;
  result.reactivated = toReactivate.length;
  const label = (id: number, ic: string): string => `${ic}:${symbolById.get(id) ?? id}`;
  result.changes.added = toInsert.map((r) => label(r.instrumentId, r.indexCode));
  result.changes.reactivated = toReactivate.map((r) => label(r.instrumentId, r.indexCode));

  // ---- memberships: stamp what dropped out (per market, with the 10% guard)
  const limit = opts.maxRemovalShare ?? 0.1;
  for (const market of markets) {
    const codes = reconcile.filter((ic) => INDEX_MARKET[ic] === market);
    if (codes.length === 0) continue;
    const active = rows.filter((r) => r.removedAt === null && codes.includes(r.indexCode as IndexCode));
    const gone = active.filter((r) => !listed.get(r.indexCode as IndexCode)?.has(r.instrumentId));
    if (gone.length === 0) continue;
    if (!opts.force && gone.length > limit * active.length) {
      result.flagged.push({
        market,
        wouldRemove: gone.length,
        of: active.length,
        names: gone.map((r) => label(r.instrumentId, r.indexCode)),
      });
      continue;
    }
    for (const r of gone)
      await db
        .update(universeMembers)
        .set({ removedAt: today })
        .where(
          and(
            eq(universeMembers.instrumentId, r.instrumentId),
            eq(universeMembers.indexCode, r.indexCode),
            isNull(universeMembers.removedAt),
          ),
        );
    result.removed += gone.length;
    result.changes.removed.push(...gone.map((r) => label(r.instrumentId, r.indexCode)));
  }
  return result;
}

export interface UniverseInstrument extends Instrument {
  /** Active index memberships of the name. */
  indexCodes: IndexCode[];
  /** True when the name is on the ACTIVE watchlist (its bars come from the normal watchlist ingest). */
  onWatchlist: boolean;
  /** HK stock board lot from `provider_symbols.stockLot`, null when unknown. */
  stockLot: number | null;
}

/** Active universe members of one market, one row per instrument however many indexes list it. Ordered by symbol. */
export async function listUniverseInstruments(db: DbOrTx, market: Market): Promise<UniverseInstrument[]> {
  const rows = await db
    .select({ i: instruments, code: universeMembers.indexCode, w: watchlist.active })
    .from(universeMembers)
    .innerJoin(instruments, eq(instruments.id, universeMembers.instrumentId))
    .leftJoin(watchlist, eq(watchlist.instrumentId, instruments.id))
    .where(and(eq(instruments.market, market), isNull(universeMembers.removedAt)))
    .orderBy(asc(instruments.symbol), asc(universeMembers.indexCode));
  const out = new Map<number, UniverseInstrument>();
  for (const { i, code, w } of rows) {
    let u = out.get(i.id);
    if (!u) {
      const lot = i.providerSymbols.stockLot;
      u = {
        ...toInstrument(i),
        indexCodes: [],
        onWatchlist: w === true,
        stockLot: typeof lot === 'number' ? lot : null,
      };
      out.set(i.id, u);
    }
    u.indexCodes.push(code as IndexCode);
  }
  return [...out.values()];
}

export interface UniverseCounts {
  /** Active memberships per index code (an index with none is absent). */
  byIndex: Partial<Record<IndexCode, number>>;
  /** Distinct active instruments per market. */
  byMarket: Record<Market, number>;
}

export async function activeUniverseCounts(db: DbOrTx): Promise<UniverseCounts> {
  const perIndex = await db
    .select({ code: universeMembers.indexCode, n: sql<number>`count(*)::int` })
    .from(universeMembers)
    .where(isNull(universeMembers.removedAt))
    .groupBy(universeMembers.indexCode);
  const perMarket = await db
    .select({ market: instruments.market, n: sql<number>`count(distinct ${universeMembers.instrumentId})::int` })
    .from(universeMembers)
    .innerJoin(instruments, eq(instruments.id, universeMembers.instrumentId))
    .where(isNull(universeMembers.removedAt))
    .groupBy(instruments.market);
  const byIndex: Partial<Record<IndexCode, number>> = {};
  for (const r of perIndex) if (isIndexCode(r.code)) byIndex[r.code] = r.n;
  const byMarket: Record<Market, number> = { US: 0, HK: 0 };
  for (const r of perMarket) byMarket[r.market] = r.n;
  return { byIndex, byMarket };
}
