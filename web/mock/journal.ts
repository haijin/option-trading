import type { JournalImportView, Market } from '../../src/server/api-types';
import { csvHeaderError, firstErrors } from './csv-helpers';
import type { PositionRec } from './model';
import { HK_LOTS } from './seed-ref';
import { currencySymbol, findRow, pnlOf, store } from './state';
import { marketCurrency, parseSymbol } from './symbols';
import { ASOF, daysBetween, invalid, isIsoDate, normaliseHeader, parseCsv, parseNum, signed } from './util';
import { Body } from './validate';

const REQUIRED = [
  'open_date',
  'symbol',
  'market',
  'expiry',
  'strike',
  'multiplier',
  'contracts',
  'credit',
  'close_date',
  'close_price',
  'outcome',
];
const OUTCOMES = ['open', 'expired', 'bought_back', 'assigned', 'rolled'] as const;
type Outcome = (typeof OUTCOMES)[number];

const failure = (errors: string[]): JournalImportView => ({
  ok: false,
  imported: 0,
  skippedExisting: 0,
  quotesWritten: 0,
  totals: [],
  warnings: [],
  errors: firstErrors(errors),
});

const dupKey = (r: Pick<PositionRec, 'market' | 'symbol' | 'expiry' | 'strike' | 'openDate' | 'quantity'>) =>
  `${r.market}:${r.symbol}|${r.expiry}|${r.strike}|${r.openDate}|${r.quantity}`;

/** Parse a journal CSV all-or-nothing: the first rule violations are reported with their line numbers and nothing is stored. */
export function importJournal(raw: unknown): JournalImportView {
  const csv = Body.from(raw).string('csv');
  if (csv.length > 1_000_000) throw invalid('Field "csv" is too large (max 1 MB).');
  const records = parseCsv(csv);
  if (records.length === 0) return failure(['The CSV is empty: expected a header line and one line per trade.']);
  const header = records[0].cells.map(normaliseHeader);
  const missing = csvHeaderError(
    header,
    REQUIRED,
    'open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row',
  );
  if (missing) return failure([`line ${records[0].line}: ${missing}`]);
  const col = (name: string) => header.indexOf(name);
  const dataRows = records.slice(1);

  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed: PositionRec[] = [];
  const warnedSymbols = new Set<string>();
  let skippedExisting = 0;
  let quotes = 0;
  const seen = new Set(store.positions.map(dupKey));
  let nextId = store.nextPositionId;

  dataRows.forEach((rec, i) => {
    const cell = (name: string): string => rec.cells[col(name)] ?? '';
    const err = (msg: string) => errors.push(`line ${rec.line}: ${msg}`);
    const before = errors.length;

    const openDate = cell('open_date');
    if (!isIsoDate(openDate)) err(`open_date "${openDate}" is not a date (expected YYYY-MM-DD)`);
    const marketText = cell('market').toUpperCase();
    if (marketText !== 'US' && marketText !== 'HK') err(`market "${cell('market')}" must be US or HK`);
    const market = (marketText === 'HK' ? 'HK' : 'US') as Market;
    const sym = parseSymbol(cell('symbol'), market);
    if (!sym.ok) err(sym.error);
    const expiry = cell('expiry');
    if (!isIsoDate(expiry)) err(`expiry "${expiry}" is not a date (expected YYYY-MM-DD)`);
    else if (isIsoDate(openDate) && expiry < openDate) err(`expiry ${expiry} is before open_date ${openDate}`);
    const strike = parseNum(cell('strike'));
    if (!(strike > 0)) err(`strike "${cell('strike')}" is not a positive number`);
    const known = sym.ok && market === 'HK' ? HK_LOTS[sym.symbol]?.[0] : market === 'US' ? 100 : undefined;
    let multiplier = parseNum(cell('multiplier'));
    if (cell('multiplier') === '') {
      if (known === undefined)
        err(`multiplier is blank and no board lot is known for ${sym.ok ? `HK:${sym.symbol}` : 'this symbol'}`);
      else multiplier = known;
    } else if (!(Number.isInteger(multiplier) && multiplier > 0))
      err(`multiplier "${cell('multiplier')}" is not a positive whole number`);
    const quantity = parseNum(cell('contracts'));
    if (!(Number.isInteger(quantity) && quantity > 0))
      err(`contracts "${cell('contracts')}" is not a positive whole number`);
    const credit = parseNum(cell('credit'));
    if (!(credit >= 0)) err(`credit "${cell('credit')}" is not a number (premium per share)`);
    const openFees = cell('open_fees') === '' ? 0 : parseNum(cell('open_fees'));
    const closeFees = cell('close_fees') === '' ? 0 : parseNum(cell('close_fees'));
    if (!(openFees >= 0)) err(`open_fees "${cell('open_fees')}" is not a number`);
    if (!(closeFees >= 0)) err(`close_fees "${cell('close_fees')}" is not a number`);

    const outcomeText = (cell('outcome') || 'open').toLowerCase();
    const outcome = OUTCOMES.find((o) => o === outcomeText) as Outcome | undefined;
    if (!outcome) err(`outcome "${cell('outcome')}" is not one of: ${OUTCOMES.join(', ')}`);
    let closeDate: string | null = null;
    let closePrice: number | null = null;
    if (outcome && outcome !== 'open') {
      closeDate = cell('close_date') || (outcome === 'expired' ? expiry : '');
      if (!isIsoDate(closeDate)) err(`close_date "${cell('close_date')}" is not a date (expected YYYY-MM-DD)`);
      else if (isIsoDate(openDate) && closeDate < openDate)
        err(`close_date ${closeDate} is before open_date ${openDate}`);
      const px = parseNum(cell('close_price'));
      if (outcome === 'expired') closePrice = 0;
      else if (outcome === 'assigned') {
        if (!(px > 0)) err('outcome "assigned" needs the underlying close in close_price');
        else closePrice = Math.max(0, strike - px);
      } else if (!(px >= 0))
        err(`outcome "${outcome}" needs the buy-back price in close_price (got "${cell('close_price')}")`);
      else closePrice = px;
      if (outcome === 'rolled') {
        const target = parseNum(cell('rolled_to_row'));
        if (!(Number.isInteger(target) && target >= 1 && target <= dataRows.length))
          err(`rolled_to_row "${cell('rolled_to_row')}" does not point at a data row (1 to ${dataRows.length})`);
        else if (target === i + 1) err('rolled_to_row points at the same row');
      }
    }
    if (errors.length > before || !sym.ok || !outcome) return;

    const rowOut: PositionRec = {
      id: nextId,
      symbol: sym.symbol,
      market: sym.market,
      strike,
      expiry,
      quantity,
      multiplier,
      openDate,
      openPrice: credit,
      openFees,
      status:
        outcome === 'open'
          ? 'open'
          : outcome === 'expired'
            ? 'expired'
            : outcome === 'assigned'
              ? 'assigned'
              : outcome === 'rolled'
                ? 'rolled'
                : 'closed',
      closeDate,
      closePrice,
      closeFees,
      realizedPnl: null,
      source: 'journal_import',
      spotHint: null,
    };
    if (seen.has(dupKey(rowOut))) {
      skippedExisting++;
      return;
    }
    seen.add(dupKey(rowOut));
    nextId++;
    if (rowOut.status !== 'open') rowOut.realizedPnl = pnlOf(rowOut);
    parsed.push(rowOut);
    quotes += 1 + (closePrice !== null && closePrice > 0 ? 1 : 0);

    const label = `${sym.market}:${sym.symbol}`;
    if (!findRow(sym.market, sym.symbol) && !warnedSymbols.has(label)) {
      warnedSymbols.add(label);
      warnings.push(
        `line ${rec.line}: ${label} is not on the watchlist: its trades are imported but the name is not scanned.`,
      );
    }
    if (sym.market === 'HK' && known !== undefined && multiplier !== known)
      warnings.push(`line ${rec.line}: multiplier ${multiplier} differs from the board lot ${known} for ${label}.`);
    if (outcome === 'open' && expiry <= ASOF)
      warnings.push(
        `line ${rec.line}: still marked open but it expired on ${expiry} (${daysBetween(expiry, ASOF)} days ago): set its outcome.`,
      );
  });

  if (errors.length > 0) return failure(errors);
  store.positions.push(...parsed);
  store.nextPositionId = nextId;

  const totals: string[] = [];
  for (const m of ['HK', 'US'] as const) {
    const done = parsed.filter((p) => p.market === m && p.realizedPnl !== null);
    if (done.length === 0) continue;
    const pnl = done.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    totals.push(`${m} realised ${currencySymbol(marketCurrency(m))}${signed(Math.round(pnl))}`);
  }
  const stillOpen = parsed.filter((p) => p.status === 'open').length;
  totals.push(`${parsed.length} trade${parsed.length === 1 ? '' : 's'} imported, ${stillOpen} still open`);
  return {
    ok: true,
    imported: parsed.length,
    skippedExisting,
    quotesWritten: quotes,
    totals,
    warnings: firstErrors(warnings),
    errors: [],
  };
}
