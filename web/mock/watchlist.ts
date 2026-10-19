import type {
  Market,
  ReportingFrequency,
  SolvencyModel,
  StockKey,
  WatchBoardView,
  WatchEntryView,
  WatchPasteRow,
  WatchPasteView,
  WatchPreviewView,
  WatchStatus,
} from '../../src/server/api-types';
import { buildBoardRow, compareBoardRows, SPARKLINE_BARS } from '../../src/server/watch-board';
import { evaluate } from './engine';
import { buildValueView } from './kpi';
import { keyOf, type WatchRow } from './model';
import { HK_LOTS } from './seed-ref';
import { priceSeries } from './series';
import { findRow, nextEarnings, openFor, requireRow, rows, store } from './state';
import { directoryName, directorySector, marketCurrency, parseSymbol } from './symbols';
import { ASOF, conflict, csvCell, invalid, isRecord, nowIso, weekdaysEndingAt } from './util';
import { Body } from './validate';
import { valueBadge } from './value';

const MARKETS = ['US', 'HK'] as const;
const SOLVENCY = ['altman', 'property', 'financial', 'reit'] as const satisfies readonly SolvencyModel[];
const FREQUENCY = ['quarterly', 'semiannual'] as const satisfies readonly ReportingFrequency[];

export function watchStatus(row: WatchRow): WatchStatus {
  if (!row.active)
    return { kind: 'paused', label: 'not watching', detail: 'Skipped by ingest, scan and research; history is kept.' };
  if (row.ingest === 'pending')
    return {
      kind: 'pending_first_ingest',
      label: 'waiting for first ingest',
      detail: 'Prices are fetched at the next ingest, then it is scored.',
    };
  if (row.ingest === 'no_data')
    return {
      kind: 'no_data',
      label: 'no data from provider',
      detail: 'The last ingest found no prices for this symbol.',
    };
  const ev = evaluate(row);
  if (ev.state === 'open') return { kind: 'open_put', label: 'open put: no new ideas', detail: null };
  if (ev.profile && ev.profile.lastBar < ASOF)
    return {
      kind: 'stale',
      label: `stale: last bar ${ev.profile.lastBar}`,
      detail: 'Run an ingest to refresh prices.',
    };
  if (ev.state === 'reject') return { kind: 'rejected', label: 'not recommended', detail: ev.reject?.detail ?? null };
  const c = ev.contract;
  return {
    kind: 'idea',
    label: 'idea today',
    detail: c ? `${c.strike}P ${c.expiry}, ${c.annRocPct.toFixed(1)}% annualised` : null,
  };
}

export function entryView(row: WatchRow): WatchEntryView {
  return {
    symbol: row.symbol,
    market: row.market,
    name: row.name,
    sector: row.sector,
    currency: marketCurrency(row.market),
    boardLot: row.boardLot,
    solvencyModel: row.solvencyModel,
    solvencyInferred: row.solvencyInferred,
    reportingFrequency: row.reportingFrequency,
    conviction: row.conviction,
    notes: row.notes,
    maxCollateralPct: row.maxCollateralPct,
    active: row.active,
    addedAt: row.addedAt,
    hasOpenPut: openFor(row.market, row.symbol).length > 0,
    nextEarnings: nextEarnings(row.market, row.symbol, row.profile),
    status: watchStatus(row),
  };
}

/** Watching first, then by market and symbol. */
const sorted = (): WatchRow[] =>
  rows().sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol),
  );

export const listWatchlist = (): WatchEntryView[] => sorted().map(entryView);

// ------------------------------------------------------------------------------------------------ board
/** Watched names with price, KPIs, highlights and the scan's verdict: the same rows the real server builds (src/server/watch-board.ts). */
export function watchBoard(): WatchBoardView {
  const scored = store.equity !== null;
  const active = sorted().filter((r) => r.active);
  const evaluated = new Map(active.map((r) => [keyOf(r.market, r.symbol), evaluate(r)]));
  // Ranks are per market, by composite, over the names that are ideas (like the scan's shortlist).
  const rank = new Map<string, number>();
  for (const m of MARKETS) {
    [...evaluated.values()]
      .filter((e) => e.state === 'idea' && e.row.market === m)
      .sort((a, b) => b.composite - a.composite)
      .forEach((e, i) => {
        rank.set(e.key, i + 1);
      });
  }
  const rows = active.map((row) => {
    const key = keyOf(row.market, row.symbol);
    const ev = evaluated.get(key);
    const p = row.profile;
    let entry = entryView(row);
    // Without equity the real scan cannot run: everything it would have decided reads "not scored yet".
    if (!scored && ['idea', 'rejected', 'stale', 'no_data'].includes(entry.status.kind))
      entry = { ...entry, status: { kind: 'unscored', label: 'not scored yet', detail: null } };
    if (!p || !ev) {
      return buildBoardRow({
        entry,
        asOf: ASOF,
        closes: [],
        technical: null,
        ivRank: null,
        kpis: null,
        value: null,
        screen: null,
        idea: null,
        binding: null,
        staleLastBar: null,
      });
    }
    const series = priceSeries(p).slice(-SPARKLINE_BARS);
    const days = weekdaysEndingAt(p.lastBar, series.length);
    const vv = buildValueView(row, null);
    const stale = ev.reject?.status === 'dropped_stale';
    return buildBoardRow({
      entry,
      asOf: ASOF,
      closes: series.map((close, i) => ({ day: days[i] as string, close })),
      technical: { support: p.tech.support, trendState: ev.trend, rsi14: p.tech.rsi },
      ivRank: p.vol.ivr,
      // the real KPI table calls the free-cash-flow yield 'fcf_yield'; this mock's older name is 'fcfy'
      kpis: vv.kpis.map((k) => (k.key === 'fcfy' ? { ...k, key: 'fcf_yield' } : k)),
      value: valueBadge(p, null),
      screen: vv.screen.verdict,
      idea:
        ev.state === 'idea' && ev.contract
          ? { rank: rank.get(key) ?? 0, composite: ev.composite, contract: ev.contract, ruleWarns: ev.ruleWarns }
          : null,
      binding: ev.reject
        ? { skillId: ev.reject.skillId || null, rule: ev.reject.rule, detail: ev.reject.detail }
        : null,
      staleLastBar: stale ? p.lastBar : null,
    });
  });
  rows.sort(compareBoardRows);
  return { asOf: ASOF, generatedAt: nowIso(), rows, scored };
}

// ------------------------------------------------------------------------------------------------ preview
export function previewWatch(raw: string, marketParam: string | null): WatchPreviewView {
  if (
    marketParam !== null &&
    marketParam !== '' &&
    marketParam !== 'auto' &&
    marketParam !== 'US' &&
    marketParam !== 'HK'
  ) {
    throw invalid('Query parameter "market" must be US, HK or auto.');
  }
  const forced = marketParam === 'US' || marketParam === 'HK' ? marketParam : 'auto';
  const text = raw.trim();
  const parsed = parseSymbol(text, forced);
  const blank = {
    raw: text,
    symbol: null,
    yahooSymbol: null,
    name: null,
    boardLot: null,
    lotSource: null,
    duplicate: null,
  } as const;
  if (!parsed.ok) return { ok: false, error: text === '' ? null : parsed.error, market: parsed.market, ...blank };
  const existing = findRow(parsed.market, parsed.symbol);
  const lot = HK_LOTS[parsed.symbol]?.[0];
  const hk = parsed.market === 'HK';
  return {
    ok: true,
    error: null,
    raw: text,
    market: parsed.market,
    symbol: parsed.symbol,
    yahooSymbol: parsed.yahoo,
    name: existing?.name ?? directoryName(parsed.market, parsed.symbol),
    boardLot: existing ? existing.boardLot : hk ? (lot ?? null) : 100,
    lotSource: existing ? 'existing' : !hk ? 'us_default' : lot !== undefined ? 'seed_file' : 'missing',
    duplicate: existing ? (existing.active ? 'watching' : 'paused') : null,
  };
}

// ------------------------------------------------------------------------------------------------ add / patch / bulk
function newRow(market: Market, symbol: string, o: Partial<WatchRow> & { boardLot: number }): WatchRow {
  const row: WatchRow = {
    symbol,
    market,
    name: directoryName(market, symbol),
    sector: directorySector(market, symbol),
    solvencyModel: 'altman',
    solvencyInferred: true,
    reportingFrequency: market === 'HK' ? 'semiannual' : 'quarterly',
    conviction: null,
    notes: null,
    maxCollateralPct: null,
    active: true,
    addedAt: nowIso(),
    ingest: 'pending',
    profile: null,
    ...o,
  };
  store.watch.set(keyOf(market, symbol), row);
  return row;
}

const conviction = (b: Body) => b.nullableNumber('conviction', { int: true, min: 1, max: 5 });
const maxCollateral = (b: Body) => b.nullableNumber('maxCollateralPct', { positive: true, max: 100 });

export function addWatch(raw: unknown): WatchEntryView {
  const b = Body.from(raw);
  const parsed = parseSymbol(b.string('symbol'), b.optOneOf('market', MARKETS) ?? 'auto');
  if (!parsed.ok) throw invalid(parsed.error);
  const existing = findRow(parsed.market, parsed.symbol);
  if (existing) {
    throw existing.active
      ? conflict('already_watching', `${parsed.market}:${parsed.symbol} is already on the watchlist.`)
      : conflict(
          'paused_duplicate',
          `${parsed.market}:${parsed.symbol} is on the watchlist but paused: resume it instead.`,
        );
  }
  let boardLot = 100;
  if (parsed.market === 'HK') {
    const given = b.optNumber('boardLot', { int: true, positive: true });
    const known = HK_LOTS[parsed.symbol]?.[0];
    if (given === undefined && known === undefined) {
      throw invalid(
        `Field "boardLot" is required: HK:${parsed.symbol} is not in data/hk-board-lots.csv, and the board lot is the multiplier of every HK number.`,
      );
    }
    boardLot = given ?? (known as number);
  }
  const model = b.optOneOf('solvencyModel', SOLVENCY);
  const row = newRow(parsed.market, parsed.symbol, {
    boardLot,
    solvencyModel: model ?? 'altman',
    solvencyInferred: model === undefined,
    reportingFrequency:
      b.optOneOf('reportingFrequency', FREQUENCY) ?? (parsed.market === 'HK' ? 'semiannual' : 'quarterly'),
    conviction: conviction(b) ?? null,
    notes: b.nullableString('notes') ?? null,
    maxCollateralPct: maxCollateral(b) ?? null,
  });
  return entryView(row);
}

export function patchWatch(market: Market, symbol: string, raw: unknown): WatchEntryView {
  const row = requireRow(market, symbol);
  const b = Body.from(raw);
  const next: Partial<WatchRow> = {};
  const active = b.optBool('active');
  if (active !== undefined) next.active = active;
  const lot = b.optNumber('boardLot', { int: true, positive: true });
  if (lot !== undefined) {
    if (row.market === 'US' && lot !== 100)
      throw invalid('US contracts are 100 shares: boardLot cannot be changed for a US stock.');
    next.boardLot = lot;
  }
  const model = b.optOneOf('solvencyModel', SOLVENCY);
  if (model) {
    next.solvencyModel = model;
    next.solvencyInferred = false;
  }
  const freq = b.optOneOf('reportingFrequency', FREQUENCY);
  if (freq) next.reportingFrequency = freq;
  const conv = conviction(b);
  if (conv !== undefined) next.conviction = conv;
  const notes = b.nullableString('notes');
  if (notes !== undefined) next.notes = notes;
  const max = maxCollateral(b);
  if (max !== undefined) next.maxCollateralPct = max;
  const name = b.nullableString('name', 120);
  if (name !== undefined) next.name = name;
  Object.assign(row, next);
  return entryView(row);
}

function toKeys(items: unknown[]): StockKey[] {
  return items.map((k, i) => {
    if (!isRecord(k) || (k.market !== 'US' && k.market !== 'HK') || typeof k.symbol !== 'string') {
      throw invalid(`Field "keys[${i}]" must be { market: 'US' | 'HK', symbol: string }.`);
    }
    const parsed = parseSymbol(k.symbol, k.market);
    if (!parsed.ok) throw invalid(`Field "keys[${i}]": ${parsed.error}`);
    return { market: parsed.market, symbol: parsed.symbol };
  });
}

export function bulkWatch(raw: unknown): WatchEntryView[] {
  const b = Body.from(raw);
  const op = b.oneOf('op', ['stop', 'resume'] as const);
  const keys = toKeys(b.array('keys'));
  if (keys.length === 0) throw invalid('Field "keys" must list at least one stock.');
  const targets = keys.map((k) => requireRow(k.market, k.symbol));
  for (const row of targets) row.active = op === 'resume';
  return targets.map(entryView);
}

// ------------------------------------------------------------------------------------------------ paste
export function pasteWatch(raw: unknown): WatchPasteView {
  const b = Body.from(raw);
  const text = b.optString('text') ?? '';
  const apply = b.bool('apply');
  const tokens = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  if (tokens.length > 200) throw invalid('Too many symbols: paste at most 200 at a time.');
  const seen = new Set<string>();
  const out: WatchPasteRow[] = [];
  let added = 0;
  let resumed = 0;
  let skipped = 0;
  let invalidCount = 0;
  for (const token of tokens) {
    const parsed = parseSymbol(token, 'auto');
    if (!parsed.ok) {
      invalidCount++;
      out.push({
        raw: token,
        ok: false,
        error: parsed.error,
        market: parsed.market,
        symbol: null,
        name: null,
        boardLot: null,
        result: 'invalid',
      });
      continue;
    }
    const { market, symbol } = parsed;
    const key = keyOf(market, symbol);
    const existing = findRow(market, symbol);
    const lot = market === 'US' ? 100 : (existing?.boardLot ?? HK_LOTS[symbol]?.[0] ?? null);
    let result: WatchPasteRow['result'];
    if (seen.has(key) || existing?.active) result = 'already_watching';
    else if (existing) result = 'resume';
    else if (lot === null) result = 'lot_unknown';
    else result = 'new';
    seen.add(key);
    out.push({
      raw: token,
      ok: true,
      error: null,
      market,
      symbol,
      name: existing?.name ?? directoryName(market, symbol),
      boardLot: lot,
      result,
    });
    if (result === 'already_watching' || result === 'lot_unknown') skipped++;
    if (!apply) continue;
    if (result === 'new' && lot !== null) {
      newRow(market, symbol, { boardLot: lot });
      added++;
    } else if (result === 'resume' && existing) {
      existing.active = true;
      resumed++;
    }
  }
  return { rows: out, added, resumed, skipped: apply ? skipped : 0, invalid: apply ? invalidCount : 0 };
}

// ------------------------------------------------------------------------------------------------ export
export function exportCsv(): string {
  const header = 'symbol,market,watching,board_lot,solvency_model,reporting,conviction,max_collateral_pct,notes';
  const lines = sorted().map((r) =>
    [
      r.symbol,
      r.market,
      r.active ? 'yes' : 'no',
      r.boardLot,
      r.solvencyModel,
      r.reportingFrequency,
      r.conviction,
      r.maxCollateralPct,
      r.notes,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}
