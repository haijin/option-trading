import { join } from 'node:path';
import { defaultAsOf } from '../../cli/asof';
import type { Market } from '../../core/calendar';
import { canonicalSymbol } from '../../core/symbols';
import {
  dataStatusFor,
  getWatchRow,
  listWatchlistAll,
  updateInstrument,
  updateWatchRow,
  type WatchRow,
} from '../../db/app-repos';
import { invalidateSkillRuns } from '../../db/invalidate';
import { addToWatchlist, listOpenPositions, upsertInstrument } from '../../db/repos';
import { parseBoardLotRows } from '../../providers/seed-files';
import type {
  StockKey,
  WatchAddInput,
  WatchBulkInput,
  WatchEntryView,
  WatchPasteRow,
  WatchPasteView,
  WatchPatch,
  WatchPreviewView,
  WatchStatus,
} from '../api-types';
import type { ServerDeps } from '../deps';
import { badRequest, conflict, notFound } from '../errors';
import type { ScanService } from './scan-service';
import type { AppState } from './state';

const HK_DIGITS = /^\d{1,5}(\.HK)?$/i;
export const inferMarket = (raw: string): Market =>
  HK_DIGITS.test(raw.trim()) || /\.HK$/i.test(raw.trim()) ? 'HK' : 'US';

export function parseMarketSymbol(raw: string, market?: Market): { market: Market; symbol: string } {
  let text = raw.trim();
  let m = market ?? null;
  const prefix = /^(US|HK)[:.]/i.exec(text);
  if (prefix) {
    m = m ?? (prefix[1]?.toUpperCase() as Market);
    text = text.slice(prefix[0].length);
  }
  const mk = m ?? inferMarket(text);
  try {
    return { market: mk, symbol: canonicalSymbol(mk, text) };
  } catch (err) {
    throw badRequest('invalid_symbol', (err as Error).message);
  }
}

function checkConviction(c: number | null | undefined): void {
  if (c !== undefined && c !== null && (!Number.isInteger(c) || c < 1 || c > 5))
    throw badRequest('invalid_conviction', 'conviction must be a whole number from 1 to 5');
}
function checkMaxPct(p: number | null | undefined): void {
  if (p !== undefined && p !== null && !(p > 0 && p <= 100))
    throw badRequest('invalid_max_collateral', 'max collateral must be a percentage above 0 and up to 100');
}
function checkLot(n: number | undefined): void {
  if (n !== undefined && (!Number.isInteger(n) || n <= 0))
    throw badRequest('invalid_board_lot', 'board lot must be a whole number above 0');
}

export class WatchService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly state: AppState,
    private readonly scan: ScanService,
  ) {}

  private async lotFile(): Promise<Map<string, { lot: number; name: string | null }>> {
    const file = join(this.deps.dataDir, 'hk-board-lots.csv');
    const map = new Map<string, { lot: number; name: string | null }>();
    if (!(await this.deps.fileExists(file))) return map;
    for (const r of parseBoardLotRows(await this.deps.readFile(file))) map.set(r.symbol, { lot: r.lot, name: r.name });
    return map;
  }

  async lotFileRows(): Promise<number> {
    return (await this.lotFile()).size;
  }

  async preview(raw: string, market?: Market): Promise<WatchPreviewView> {
    const base = {
      raw,
      market: null,
      symbol: null,
      yahooSymbol: null,
      name: null,
      boardLot: null,
      lotSource: null,
      duplicate: null,
    } as const;
    if (!raw.trim()) return { ok: false, error: null, ...base };
    let parsed: { market: Market; symbol: string };
    try {
      parsed = parseMarketSymbol(raw, market);
    } catch (err) {
      return { ok: false, error: (err as Error).message, ...base };
    }
    const existing = await getWatchRow(this.deps.db, parsed.market, parsed.symbol);
    const lots = parsed.market === 'HK' ? await this.lotFile() : new Map();
    const seeded = lots.get(parsed.symbol);
    let lotSource: WatchPreviewView['lotSource'];
    let boardLot: number | null;
    if (existing) {
      lotSource = 'existing';
      boardLot = existing.multiplier;
    } else if (parsed.market === 'US') {
      lotSource = 'us_default';
      boardLot = 100;
    } else if (seeded) {
      lotSource = 'seed_file';
      boardLot = seeded.lot;
    } else {
      lotSource = 'missing';
      boardLot = null;
    }
    return {
      ok: true,
      error: null,
      raw,
      market: parsed.market,
      symbol: parsed.symbol,
      yahooSymbol: parsed.market === 'HK' ? `${parsed.symbol}.HK` : parsed.symbol.replace('.', '-'),
      name: existing?.name ?? seeded?.name ?? null,
      boardLot,
      lotSource,
      duplicate: existing ? (existing.active ? 'watching' : 'paused') : null,
    };
  }

  // ------------------------------------------------------------------------------------------ list and status
  async list(): Promise<WatchEntryView[]> {
    const rows = await listWatchlistAll(this.deps.db);
    return this.toViews(rows);
  }

  private async toViews(rows: WatchRow[]): Promise<WatchEntryView[]> {
    if (rows.length === 0) return [];
    const asOf = defaultAsOf(this.deps.now());
    const status = await dataStatusFor(
      this.deps.db,
      rows.map((r) => r.id),
      asOf,
    );
    const open = new Set((await listOpenPositions(this.deps.db)).map((p) => p.instrumentId));
    let scan = this.scan.peek();
    if (!scan) {
      try {
        scan = await this.scan.get();
      } catch {
        scan = null; // equity not set or nothing scannable yet: statuses fall back to data-based ones
      }
    }
    const ideas = new Set(scan?.ideas.map((i) => `${i.market}|${i.symbol}`));
    const rejects = new Map(scan?.rejected.map((r) => [`${r.market}|${r.symbol}`, r]));
    const waiting = new Set(scan?.waitingForData.map((w) => `${w.market}|${w.symbol}`));
    const openNames = new Set(scan?.openNames.map((o) => `${o.market}|${o.symbol}`));
    return rows.map((r) => {
      const key = `${r.market}|${r.symbol}`;
      const raw = status.get(r.id);
      const hasOpenPut = open.has(r.id);
      let st: WatchStatus;
      if (!r.active) st = { kind: 'paused', label: 'not watching', detail: 'history is kept; resume any time' };
      else if (!raw?.lastBar || waiting.has(key))
        st = {
          kind: 'pending_first_ingest',
          label: 'waiting for first ingest',
          detail: 'run ingest to fetch its prices and filings',
        };
      else if (hasOpenPut || openNames.has(key))
        st = { kind: 'open_put', label: 'open put: no new ideas', detail: null };
      else if (ideas.has(key)) st = { kind: 'idea', label: 'idea today', detail: null };
      else if (rejects.get(key)?.status === 'dropped_stale')
        st = {
          kind: 'stale',
          label: `stale: last bar ${rejects.get(key)?.staleLastBar ?? 'unknown'}`,
          detail: 'run ingest',
        };
      else if (rejects.has(key))
        st = { kind: 'rejected', label: 'not recommended', detail: rejects.get(key)?.bindingRule ?? null };
      else
        st = { kind: scan ? 'no_data' : 'unscored', label: scan ? 'no result today' : 'not scored yet', detail: null };
      return {
        symbol: r.symbol,
        market: r.market,
        name: r.name,
        sector: r.sector,
        currency: r.currency,
        boardLot: r.multiplier,
        solvencyModel: r.solvencyModel,
        solvencyInferred: r.solvencySource !== 'user',
        reportingFrequency: r.reportingFrequency,
        conviction: r.conviction,
        notes: r.notes,
        maxCollateralPct: r.maxCollateralPct,
        active: r.active,
        addedAt: r.addedAt.toISOString(),
        hasOpenPut,
        nextEarnings: raw?.nextEarnings ?? null,
        status: st,
      };
    });
  }

  async get(market: Market, symbol: string): Promise<WatchEntryView> {
    const row = await getWatchRow(this.deps.db, market, symbol);
    if (!row) throw notFound(`${market}:${symbol} is not on the watchlist`);
    return (await this.toViews([row]))[0] as WatchEntryView;
  }

  // ------------------------------------------------------------------------------------------ writes
  async add(input: WatchAddInput): Promise<WatchEntryView> {
    const { market, symbol } = parseMarketSymbol(input.symbol, input.market);
    checkConviction(input.conviction);
    checkMaxPct(input.maxCollateralPct);
    checkLot(input.boardLot);
    const existing = await getWatchRow(this.deps.db, market, symbol);
    if (existing?.active) throw conflict('already_watching', `${market}:${symbol} is already on your watchlist`);
    if (existing) {
      // Resuming a paused name keeps its history; any fields given now are applied.
      return this.patch(market, symbol, {
        active: true,
        ...(input.boardLot !== undefined ? { boardLot: input.boardLot } : {}),
        ...(input.solvencyModel ? { solvencyModel: input.solvencyModel } : {}),
        ...(input.reportingFrequency ? { reportingFrequency: input.reportingFrequency } : {}),
        ...(input.conviction !== undefined ? { conviction: input.conviction } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.maxCollateralPct !== undefined ? { maxCollateralPct: input.maxCollateralPct } : {}),
      });
    }
    let lot = 100;
    let name: string | undefined;
    if (market === 'HK') {
      const seeded = (await this.lotFile()).get(symbol);
      const chosen = input.boardLot ?? seeded?.lot;
      if (!chosen)
        throw badRequest(
          'board_lot_required',
          `${symbol} is not in data/hk-board-lots.csv: enter its board lot (it is the multiplier behind every HK number)`,
        );
      lot = chosen;
      if (seeded?.name) name = seeded.name;
    }
    const inst = await upsertInstrument(this.deps.db, {
      market,
      symbol,
      boardLot: lot,
      ...(name ? { name } : {}),
      ...(input.solvencyModel
        ? { solvencyModel: input.solvencyModel, providerSymbols: { solvencySource: 'user' } }
        : {}),
      ...(input.reportingFrequency ? { reportingFrequency: input.reportingFrequency } : {}),
    });
    await addToWatchlist(this.deps.db, inst.id, { notes: input.notes ?? null, conviction: input.conviction ?? null });
    if (input.maxCollateralPct !== undefined && input.maxCollateralPct !== null)
      await updateWatchRow(this.deps.db, inst.id, { maxCollateralPct: input.maxCollateralPct });
    this.state.bump();
    return this.get(market, symbol);
  }

  async patch(market: Market, symbol: string, patch: WatchPatch): Promise<WatchEntryView> {
    const row = await getWatchRow(this.deps.db, market, symbol);
    if (!row) throw notFound(`${market}:${symbol} is not on the watchlist`);
    checkConviction(patch.conviction);
    checkMaxPct(patch.maxCollateralPct);
    checkLot(patch.boardLot);
    if (patch.boardLot !== undefined && market === 'US' && patch.boardLot !== 100)
      throw badRequest('invalid_board_lot', 'US contracts are always 100 shares');
    const instrumentPatch = {
      ...(patch.boardLot !== undefined ? { boardLot: patch.boardLot } : {}),
      ...(patch.solvencyModel !== undefined ? { solvencyModel: patch.solvencyModel } : {}),
      ...(patch.reportingFrequency !== undefined ? { reportingFrequency: patch.reportingFrequency } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    await updateInstrument(this.deps.db, row.id, instrumentPatch);
    await updateWatchRow(this.deps.db, row.id, {
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.conviction !== undefined ? { conviction: patch.conviction } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.maxCollateralPct !== undefined ? { maxCollateralPct: patch.maxCollateralPct } : {}),
    });
    // A lot, solvency model or reporting frequency changes what the cached skill results mean.
    if (patch.boardLot !== undefined || patch.solvencyModel !== undefined || patch.reportingFrequency !== undefined)
      await invalidateSkillRuns(this.deps.db, row.id, '1900-01-01');
    this.state.bump();
    return this.get(market, symbol);
  }

  async bulk(input: WatchBulkInput): Promise<WatchEntryView[]> {
    const out: WatchEntryView[] = [];
    for (const k of input.keys)
      out.push(await this.patch(k.market, canonicalSymbol(k.market, k.symbol), { active: input.op === 'resume' }));
    return out;
  }

  async paste(text: string, apply: boolean): Promise<WatchPasteView> {
    const toks = [
      ...new Set(
        text
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (toks.length > 200) throw badRequest('too_many', 'paste at most 200 symbols at once');
    const lots = await this.lotFile();
    const rows: WatchPasteRow[] = [];
    const todo: {
      market: Market;
      symbol: string;
      lot: number | null;
      name: string | null;
      existing: WatchRow | null;
    }[] = [];
    for (const raw of toks) {
      let parsed: { market: Market; symbol: string };
      try {
        parsed = parseMarketSymbol(raw);
      } catch (err) {
        rows.push({
          raw,
          ok: false,
          error: (err as Error).message,
          market: null,
          symbol: null,
          name: null,
          boardLot: null,
          result: 'invalid',
        });
        continue;
      }
      const existing = await getWatchRow(this.deps.db, parsed.market, parsed.symbol);
      const seeded = parsed.market === 'HK' ? lots.get(parsed.symbol) : undefined;
      const lot = existing ? existing.multiplier : parsed.market === 'US' ? 100 : (seeded?.lot ?? null);
      const result: WatchPasteRow['result'] = existing
        ? existing.active
          ? 'already_watching'
          : 'resume'
        : lot === null
          ? 'lot_unknown'
          : 'new';
      rows.push({
        raw,
        ok: true,
        error: null,
        market: parsed.market,
        symbol: parsed.symbol,
        name: existing?.name ?? seeded?.name ?? null,
        boardLot: lot,
        result,
      });
      todo.push({ ...parsed, lot, name: seeded?.name ?? null, existing });
    }
    let added = 0;
    let resumed = 0;
    let skipped = 0;
    if (apply) {
      for (const t of todo) {
        if (t.existing?.active) skipped++;
        else if (t.existing) {
          await this.patch(t.market, t.symbol, { active: true });
          resumed++;
        } else if (t.lot === null)
          skipped++; // never guess a board lot: it multiplies every HK number
        else {
          await this.add({ symbol: t.symbol, market: t.market, ...(t.market === 'HK' ? { boardLot: t.lot } : {}) });
          added++;
        }
      }
    }
    return { rows, added, resumed, skipped, invalid: rows.filter((r) => !r.ok).length };
  }

  async exportCsv(): Promise<string> {
    const rows = await listWatchlistAll(this.deps.db);
    const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const lines = ['symbol,market,watching,board_lot,solvency_model,reporting,conviction,max_collateral_pct,notes'];
    for (const r of rows)
      lines.push(
        [
          r.symbol,
          r.market,
          r.active ? 'yes' : 'no',
          r.multiplier,
          r.solvencyModel,
          r.reportingFrequency,
          r.conviction ?? '',
          r.maxCollateralPct ?? '',
          esc(r.notes ?? ''),
        ].join(','),
      );
    return `${lines.join('\n')}\n`;
  }

  async requireRow(key: StockKey): Promise<WatchRow> {
    const row = await getWatchRow(this.deps.db, key.market, canonicalSymbol(key.market, key.symbol));
    if (!row) throw notFound(`${key.market}:${key.symbol} is not on the watchlist`);
    return row;
  }
}
