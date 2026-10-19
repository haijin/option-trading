import type {
  ChainImportView,
  DataStatusRow,
  DataStatusView,
  EventAddInput,
  FairValueImportView,
  ISODate,
  Market,
} from '../../src/server/api-types';
import { csvHeaderError, firstErrors } from './csv-helpers';
import { lastIngestView } from './ingest';
import { fundamentalsInfo } from './kpi';
import { keyOf } from './model';
import { HK_LOTS } from './seed-ref';
import { activeRows, nextEarnings, requireRow, rowKey, store } from './state';
import { parseSymbol } from './symbols';
import { ASOF, conflict, daysBetween, invalid, isIsoDate, normaliseHeader, parseCsv, parseNum, round } from './util';
import { Body } from './validate';
import { valueBadge } from './value';
import { watchStatus } from './watchlist';

// ------------------------------------------------------------------------------------------------ data status
export function buildDataStatus(): DataStatusView {
  const names: DataStatusRow[] = activeRows()
    .sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol))
    .map((row) => {
      const p = row.profile;
      const chain = store.chains.get(rowKey(row));
      return {
        symbol: row.symbol,
        market: row.market,
        name: row.name,
        lastBar: p?.lastBar ?? null,
        lastClose: p?.spot ?? null,
        chain: chain
          ? { source: chain.source, date: chain.date }
          : p && row.market === 'US'
            ? { source: 'yahoo', date: ASOF }
            : null,
        nextEarnings: nextEarnings(row.market, row.symbol, p),
        fundamentals: fundamentalsInfo(row),
        stale: p !== null && p.lastBar < ASOF,
        priceVsIv: p ? valueBadge(p, null) : null,
        status: watchStatus(row),
      };
    });
  return {
    lastIngest: lastIngestView(),
    names,
    providers: [
      { id: 'yahoo', label: 'Yahoo', state: 'ok', detail: 'bars, fundamentals, US chains, earnings, FX' },
      { id: 'stooq', label: 'Stooq', state: 'fail', detail: 'answers scripts with HTTP 403' },
      { id: 'moomoo', label: 'moomoo OpenD', state: 'warn', detail: 'not reachable: start OpenD to pull HK chains' },
      {
        id: 'vhsi',
        label: 'VHSI file',
        state: 'warn',
        detail: 'data/vhsi.csv not found: HK regime runs without a vol index',
      },
    ],
    files: {
      boardLots: { path: 'data/hk-board-lots.csv', rows: Object.keys(HK_LOTS).length },
      vhsi: { path: 'data/vhsi.csv', found: false },
    },
  };
}

// ------------------------------------------------------------------------------------------------ chain import
const chainFailure = (errors: string[]): ChainImportView => ({
  ok: false,
  stored: 0,
  expiries: [],
  iv30: null,
  warnings: [],
  errors: firstErrors(errors),
});

interface ChainRow {
  expiry: ISODate;
  strike: number;
  put: boolean;
  bid: number;
  ask: number;
  iv: number | null;
}

/** IV near 30 days: the quoted IVs of puts within 15% of spot, or a rough at-the-money estimate from the mid price. */
function estimateIv30(rows: ChainRow[], spot: number, date: ISODate): number | null {
  const puts = rows.filter((r) => r.put);
  if (puts.length === 0) return null;
  const nearest = [...new Set(puts.map((r) => r.expiry))].sort(
    (a, b) => Math.abs(daysBetween(date, a) - 30) - Math.abs(daysBetween(date, b) - 30),
  )[0];
  const inExpiry = puts.filter((r) => r.expiry === nearest);
  const quoted = inExpiry
    .filter((r) => r.iv !== null && Math.abs(r.strike / spot - 1) <= 0.15)
    .map((r) => r.iv as number);
  if (quoted.length > 0) return round(quoted.reduce((a, b) => a + b, 0) / quoted.length, 3);
  const atm = [...inExpiry].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  const mid = (atm.bid + atm.ask) / 2;
  if (mid <= 0) return null;
  const years = Math.max(1, daysBetween(date, nearest)) / 365;
  return round(Math.min(1.5, Math.max(0.08, mid / (0.4 * spot * Math.sqrt(years)))), 3);
}

export function importChain(raw: unknown): ChainImportView {
  const b = Body.from(raw);
  const parsed = parseSymbol(b.string('symbol'), b.optOneOf('market', ['US', 'HK'] as const) ?? 'auto');
  if (!parsed.ok) throw invalid(parsed.error);
  const row = requireRow(parsed.market, parsed.symbol);
  const spot = b.number('spot', { positive: true });
  const date = b.date('date');
  const csv = b.string('csv');
  if (csv.length > 2_000_000) throw invalid('Field "csv" is too large (max 2 MB).');
  if (!row.profile)
    throw conflict(
      'no_price_data',
      `${parsed.market}:${parsed.symbol} has no price data yet: run an ingest before pasting a chain.`,
    );

  const records = parseCsv(csv);
  if (records.length === 0) return chainFailure(['The CSV is empty: expected a header line and one line per option.']);
  const header = records[0].cells.map(normaliseHeader);
  const headerError = csvHeaderError(
    header,
    ['expiry', 'strike', 'right', 'bid', 'ask'],
    'expiry,strike,right,bid,ask,last,volume,oi[,iv][,delta]',
  );
  if (headerError) return chainFailure([`line ${records[0].line}: ${headerError}`]);
  const col = (name: string) => header.indexOf(name);
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: ChainRow[] = [];

  for (const rec of records.slice(1)) {
    const cell = (name: string): string => (col(name) < 0 ? '' : (rec.cells[col(name)] ?? ''));
    const err = (msg: string) => errors.push(`line ${rec.line}: ${msg}`);
    const before = errors.length;
    const expiry = cell('expiry');
    if (!isIsoDate(expiry)) err(`expiry "${expiry}" is not a date (expected YYYY-MM-DD)`);
    else if (expiry <= date) err(`expiry ${expiry} is not after the chain date ${date}`);
    const strike = parseNum(cell('strike'));
    if (!(strike > 0)) err(`strike "${cell('strike')}" is not a positive number`);
    else if (strike < spot * 0.4 || strike > spot * 1.6) err(`strike ${strike} is outside 40-160% of spot ${spot}`);
    const right = cell('right').toUpperCase();
    if (!['P', 'C', 'PUT', 'CALL'].includes(right)) err(`right "${cell('right')}" must be P or C`);
    const bid = parseNum(cell('bid'));
    const ask = parseNum(cell('ask'));
    if (!(bid >= 0)) err(`bid "${cell('bid')}" is not a number`);
    if (!(ask >= 0)) err(`ask "${cell('ask')}" is not a number`);
    if (bid >= 0 && ask >= 0 && bid > ask) err(`bid ${bid} is above ask ${ask} (crossed quote)`);
    for (const name of ['last', 'volume', 'oi', 'iv', 'delta']) {
      if (cell(name) !== '' && Number.isNaN(parseNum(cell(name)))) err(`${name} "${cell(name)}" is not a number`);
    }
    for (const name of ['volume', 'oi']) {
      const n = parseNum(cell(name));
      if (cell(name) !== '' && !Number.isNaN(n) && !(Number.isInteger(n) && n >= 0))
        err(`${name} "${cell(name)}" must be a whole number of contracts`);
    }
    if (errors.length > before) continue;
    if (bid === 0) warnings.push(`line ${rec.line}: bid = 0, kept as illiquid`);
    const ivRaw = cell('iv') === '' ? null : parseNum(cell('iv'));
    rows.push({
      expiry,
      strike,
      put: right.startsWith('P'),
      bid,
      ask,
      iv: ivRaw === null ? null : ivRaw > 3 ? ivRaw / 100 : ivRaw,
    });
  }
  if (errors.length === 0 && rows.length === 0) errors.push('The CSV has a header but no option rows.');
  if (errors.length > 0) return chainFailure(errors);

  const expiries = [...new Set(rows.map((r) => r.expiry))].sort();
  const iv30 = estimateIv30(rows, spot, date);
  if (iv30 === null) warnings.push('No puts with a usable quote: iv30 was not computed.');
  if (date !== ASOF) warnings.push(`Chain dated ${date}; the last stored session is ${ASOF}.`);
  if (Math.abs(spot / row.profile.spot - 1) > 0.05)
    warnings.push(`Spot ${spot} differs from the stored close ${row.profile.spot} by more than 5%.`);
  store.chains.set(keyOf(parsed.market, parsed.symbol), {
    source: 'csv',
    date,
    spot,
    stored: rows.length,
    expiries,
    iv30,
  });
  return { ok: true, stored: rows.length, expiries, iv30, warnings: firstErrors(warnings), errors: [] };
}

// ------------------------------------------------------------------------------------------------ events
const EVENT_TYPES = [
  'earnings',
  'ex_dividend',
  'agm',
  'rights_issue',
  'spin_off',
  'split',
  'index_rebalance',
  'other',
] as const satisfies readonly EventAddInput['type'][];

export function addEvent(raw: unknown): { ok: true } {
  const b = Body.from(raw);
  const parsed = parseSymbol(b.string('symbol'), b.optOneOf('market', ['US', 'HK'] as const) ?? 'auto');
  if (!parsed.ok) throw invalid(parsed.error);
  const row = requireRow(parsed.market, parsed.symbol);
  const type = b.oneOf('type', EVENT_TYPES);
  const date = b.date('date');
  const confirmed = b.optBool('confirmed') ?? true;
  if (type === 'earnings' && date < ASOF)
    throw invalid(
      `Field "date" (${date}) is before the last stored session (${ASOF}): an earnings date must be upcoming.`,
    );
  const key = rowKey(row);
  const kept = (store.events.get(key) ?? []).filter(
    (e) => !(type === 'earnings' ? e.type === 'earnings' && e.source === 'user' : e.type === type && e.date === date),
  );
  store.events.set(key, [...kept, { type, date, confirmed, source: 'user' }]);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ fair values
const ALIASES = {
  symbol: ['symbol', 'ticker', 'code'],
  market: ['market', 'exchange', 'region'],
  fair: ['fair_value', 'fairvalue', 'fv', 'fair', 'morningstar_fair_value', 'fair_value_usd'],
  moat: ['moat', 'moat_rating', 'economic_moat'],
  uncertainty: ['uncertainty', 'uncertainty_rating'],
};
const find = (header: string[], names: string[]): number => header.findIndex((h) => names.includes(h));
const titleCase = (s: string): string | null =>
  s === '' ? null : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function importFairValues(raw: unknown): FairValueImportView {
  const b = Body.from(raw);
  const csv = b.string('csv');
  const asOf = b.optDate('asOf') ?? ASOF;
  const records = parseCsv(csv);
  if (records.length === 0) throw invalid('The CSV is empty: expected symbol,market,fair_value,moat,uncertainty.');
  const first = records[0].cells.map(normaliseHeader);
  // No header line at all (the third cell is already a number): read symbol,market,fair_value,moat,uncertainty by position.
  const hasHeader = Number.isNaN(parseNum(records[0].cells[2]));
  let at = { symbol: 0, market: 1, fair: 2, moat: 3, uncertainty: 4 };
  if (hasHeader) {
    at = {
      symbol: find(first, ALIASES.symbol),
      market: find(first, ALIASES.market),
      fair: find(first, ALIASES.fair),
      moat: find(first, ALIASES.moat),
      uncertainty: find(first, ALIASES.uncertainty),
    };
    if (at.symbol < 0 || at.fair < 0)
      throw invalid(`The CSV needs a symbol column and a fair_value column (found: ${first.join(', ')}).`);
  }
  const data = hasHeader ? records.slice(1) : records;
  if (data.length === 0) throw invalid('The CSV has a header but no data rows.');
  let matched = 0;
  const unmatched: string[] = [];
  for (const rec of data) {
    const at2 = (i: number): string => (i < 0 ? '' : (rec.cells[i] ?? ''));
    const token = at2(at.symbol).replace(/\.US$/i, '');
    const marketCell = at2(at.market).toUpperCase();
    const parsed = parseSymbol(token, marketCell === 'US' || marketCell === 'HK' ? (marketCell as Market) : 'auto');
    const value = parseNum(at2(at.fair));
    if (!parsed.ok || !store.watch.has(keyOf(parsed.market, parsed.symbol))) {
      unmatched.push(token || '(blank symbol)');
      continue;
    }
    if (!(value > 0)) {
      unmatched.push(`${token} (fair_value "${at2(at.fair)}" is not a positive number)`);
      continue;
    }
    store.fairValues.set(keyOf(parsed.market, parsed.symbol), {
      value,
      asOf,
      moat: titleCase(at2(at.moat)),
      uncertainty: titleCase(at2(at.uncertainty)),
      source: 'Morningstar CSV',
    });
    matched++;
  }
  return { matched, unmatched, asOf };
}
