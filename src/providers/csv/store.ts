/**
 * Storage side of the CSV importers. Parsing and every semantic rule live in the pure modules (chain.ts, journal.ts);
 * here a file that passes is written, and a file that does not is rejected with its line-numbered report and nothing stored.
 */
import { and, eq } from 'drizzle-orm';
import type { Market } from '../../core/calendar';
import type { ISODate } from '../../core/dates';
import type { Instrument, OptionChainSnapshot } from '../../core/types';
import type { Db } from '../../db/client';
import { loadBars } from '../../db/history';
import { findInstrument, insertPosition, upsertInstrument } from '../../db/repos';
import { positions } from '../../db/schema';
import { ensureOptionContracts, writeIvDaily, writeOptionChain } from '../../db/writers';
import { iv30, skew25d } from '../../indicators';
import { chainToSnapshot, formatViolations, parseChainCsv } from './chain';
import { canonicalSymbol, formatTotals, type JournalLeg, parseJournalCsv } from './journal';
import { readCsv } from './read';

export interface ChainImportResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stored: number;
  snapshotDate: ISODate;
  expiries: ISODate[];
  iv30: number | null;
}

export async function importChain(
  db: Db,
  inst: Instrument,
  text: string,
  o: { spot: number; date: ISODate; now: Date; riskFree: number },
): Promise<ChainImportResult> {
  const opts = { market: inst.market, symbol: inst.symbol, spot: o.spot, date: o.date, multiplier: inst.multiplier };
  const parsed = parseChainCsv(text, opts);
  const base = { snapshotDate: o.date, expiries: [] as ISODate[], iv30: null as number | null, stored: 0 };
  if (!parsed.ok) {
    return { ...base, ok: false, errors: formatViolations(parsed.errors), warnings: formatViolations(parsed.warnings) };
  }
  const snapshot: OptionChainSnapshot = chainToSnapshot(parsed.rows, opts);
  const w = await writeOptionChain(db, inst.id, snapshot, o.now);
  const iv = iv30(snapshot, o.riskFree);
  if (iv) {
    await writeIvDaily(db, inst.id, {
      day: o.date,
      iv30: iv.iv30,
      iv60: iv.iv60,
      skew25d: skew25d(snapshot, o.riskFree),
      termRatio: iv.termRatio,
      tier: 'real',
    });
  }
  return {
    ok: true,
    errors: [],
    warnings: formatViolations(parsed.warnings),
    stored: w.inserted + w.updated,
    snapshotDate: o.date,
    expiries: [...new Set(snapshot.quotes.map((q) => q.expiry))].sort(),
    iv30: iv?.iv30 ?? null,
  };
}

// ------------------------------------------------------------------ journal
export interface JournalImportResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  totals: string[];
  imported: number;
  skippedExisting: number;
  quotesWritten: number;
  quotesSkipped: number;
  openLegs: { market: Market; symbol: string; expiry: ISODate; strike: number; contracts: number }[];
}

export async function importJournal(db: Db, text: string, now: Date): Promise<JournalImportResult> {
  // Pre-scan the file for the names it mentions so assigned rows can look up the stored underlying close.
  const pre = readCsv(text);
  const names = new Map<string, { market: Market; symbol: string }>();
  for (const r of pre.rows) {
    const market = (r.cells.market ?? '').toUpperCase();
    if (market !== 'US' && market !== 'HK') continue;
    const sym = canonicalSymbol(market, r.cells.symbol ?? '');
    if (sym) names.set(`${market}|${sym}`, { market, symbol: sym });
  }
  const closes = new Map<string, number>();
  const instIds = new Map<string, number>();
  for (const [key, { market, symbol }] of names) {
    const inst = await findInstrument(db, market, symbol);
    if (!inst) continue;
    instIds.set(key, inst.id);
    for (const b of await loadBars(db, inst.id)) closes.set(`${key}|${b.day}`, b.close);
  }
  const closeOn = (market: Market, symbol: string, day: ISODate): number | null =>
    closes.get(`${market}|${symbol}|${day}`) ?? null;

  const parsed = parseJournalCsv(text, { underlyingClose: closeOn });
  const empty = {
    totals: [] as string[],
    imported: 0,
    skippedExisting: 0,
    quotesWritten: 0,
    quotesSkipped: 0,
    openLegs: [],
  };
  if (!parsed.ok) {
    return {
      ...empty,
      ok: false,
      errors: formatViolations(parsed.errors),
      warnings: formatViolations(parsed.warnings),
    };
  }

  const warnings = formatViolations(parsed.warnings);
  let imported = 0;
  let skippedExisting = 0;
  let quotesWritten = 0;
  let quotesSkipped = 0;
  const openLegs: JournalImportResult['openLegs'] = [];

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const ids = new Map<number, number>(); // leg id -> position id
    const instrumentOf = new Map<string, Instrument>();
    for (const leg of parsed.legs) {
      const key = `${leg.market}|${leg.symbol}`;
      if (!instrumentOf.has(key)) {
        const existing = await findInstrument(txDb, leg.market, leg.symbol);
        instrumentOf.set(
          key,
          existing ??
            (await upsertInstrument(txDb, {
              market: leg.market,
              symbol: leg.symbol,
              boardLot: leg.market === 'HK' ? leg.multiplier : 100,
            })),
        );
      }
    }

    for (const leg of parsed.legs) {
      const inst = instrumentOf.get(`${leg.market}|${leg.symbol}`) as Instrument;
      const note = [
        leg.notes,
        leg.outcome === 'assigned'
          ? `assigned: ${leg.contracts * leg.multiplier} shares at ${leg.strike} not tracked as a holding (milestone 1)`
          : null,
      ]
        .filter(Boolean)
        .join(' | ');
      const id = await insertPosition(txDb, {
        instrumentId: inst.id,
        strike: leg.strike,
        expiry: leg.expiry,
        multiplier: leg.multiplier,
        quantity: leg.contracts,
        openDate: leg.openDate,
        openPrice: leg.credit,
        openFees: leg.openFeesCents / 100,
        spotAtOpen: leg.spot,
        notes: note || null,
        source: 'journal_import',
        status: leg.status,
        closeDate: leg.closeDate,
        closePrice: leg.closePrice,
        closeFees: leg.status === 'open' ? null : leg.closeFeesCents / 100,
        realizedPnl: leg.pnlCents === null ? null : leg.pnlCents / 100,
        pnlBasis: leg.pnlBasis,
        importKey: leg.importKey,
      });
      if (id === null) {
        skippedExisting++;
        const [existing] = await txDb
          .select({ id: positions.id })
          .from(positions)
          .where(eq(positions.importKey, leg.importKey));
        ids.set(leg.id, (existing as { id: number }).id);
      } else {
        imported++;
        ids.set(leg.id, id);
      }
      if (leg.status === 'open')
        openLegs.push({
          market: leg.market,
          symbol: leg.symbol,
          expiry: leg.expiry,
          strike: leg.strike,
          contracts: leg.contracts,
        });
    }
    for (const leg of parsed.legs) {
      if (leg.rolledToLeg !== null) {
        await txDb
          .update(positions)
          .set({ rolledTo: ids.get(leg.rolledToLeg) as number })
          .where(eq(positions.id, ids.get(leg.id) as number));
      }
    }

    // journal-tier quotes: the first real HK option prices in the database (bid = ask = the fill)
    for (const leg of parsed.legs) {
      const inst = instrumentOf.get(`${leg.market}|${leg.symbol}`) as Instrument;
      const contractIds = await ensureOptionContracts(txDb, inst.id, [
        { strike: leg.strike, expiry: leg.expiry, multiplier: leg.multiplier },
      ]);
      const contractId = contractIds.get(`P|${leg.strike}|${leg.expiry}`) as number;
      await txDb
        .update(positions)
        .set({ contractId })
        .where(and(eq(positions.id, ids.get(leg.id) as number)));
      const fills: { day: ISODate; price: number; underlying: number | null }[] = [
        { day: leg.openDate, price: leg.credit, underlying: leg.spot ?? closeOn(leg.market, leg.symbol, leg.openDate) },
      ];
      if ((leg.status === 'closed' || leg.status === 'rolled') && leg.closeDate && leg.closePrice !== null) {
        fills.push({
          day: leg.closeDate,
          price: leg.closePrice,
          underlying: closeOn(leg.market, leg.symbol, leg.closeDate),
        });
      }
      for (const f of fills) {
        if (f.underlying === null) {
          quotesSkipped++;
          continue;
        }
        const w = await writeOptionChain(
          txDb,
          inst.id,
          {
            snapshotDate: f.day,
            underlyingPrice: f.underlying,
            source: 'journal',
            tier: 'real',
            quotes: [
              {
                expiry: leg.expiry,
                strike: leg.strike,
                right: 'P',
                bid: f.price,
                ask: f.price,
                last: f.price,
                volume: null,
                openInterest: null,
                iv: null,
                delta: null,
                gamma: null,
                theta: null,
                vega: null,
                multiplier: leg.multiplier,
              },
            ],
          },
          now,
        );
        quotesWritten += w.inserted;
      }
    }
  });

  if (quotesSkipped > 0) {
    warnings.push(
      `file: journal.noUnderlyingForQuote ${quotesSkipped} fill(s) had neither a spot value nor a stored bar close for that day: their option quotes were not stored (the positions and P&L are unaffected)`,
    );
  }
  return {
    ok: true,
    errors: [],
    warnings,
    totals: formatTotals(parsed.totals),
    imported,
    skippedExisting,
    quotesWritten,
    quotesSkipped,
    openLegs,
  };
}

export type { JournalLeg };
