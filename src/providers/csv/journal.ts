/**
 * Trade-journal importer and realised P&L (docs/01-methodology.md G2, docs/02-architecture.md section 3, tasks T6+T10).
 *
 * Pure: text in, legs out. All money arithmetic is exact: decimals are parsed to integer micro-units (BigInt), the
 * row P&L is computed in micro-units and rounded half away from zero to whole cents. No floating point touches P&L.
 *
 * Processing order (the spec is explicit about it):
 *   1. read and shape-validate every source row (1-based DATA-row number d, plus the physical line);
 *   2. resolve rolled_to_row (a data-row number, header and comments not counted) BEFORE anything is merged or split;
 *   3. merge same-day fills on the same contract into one leg (contract-weighted averages, fees summed);
 *   4. split partial closes (closed_contracts) into a closed leg and a remaining open leg.
 * Any error rejects the whole file (ok=false, no legs); warnings never reject.
 */
import type { Market } from '../../core/calendar';
import { type ISODate, isISODate } from '../../core/dates';
import { sha256, stableStringify } from '../../core/util';
import {
  centsToMicros,
  divRound,
  formatCents,
  formatMicros,
  microsToCents,
  microsToNumber,
  parseMicros,
} from './decimal';
import { expiryDayProblem } from './expiry';
import { type CsvRow, readCsv, sortViolations, type Violation, violation } from './read';

export { formatViolations, type Violation } from './read';

export type JournalOutcome = 'closed' | 'expired' | 'assigned' | 'rolled' | 'open';
export type JournalPnlBasis = 'cash' | 'mtm_at_assignment';

export interface JournalLeg {
  /** 0-based index in legs[]. */
  id: number;
  /** 1-based data-row numbers (header, comments and blank lines not counted) merged into this leg. */
  srcRows: number[];
  /** Physical 1-based file lines of those rows. */
  lines: number[];
  market: Market;
  symbol: string;
  openDate: ISODate;
  expiry: ISODate;
  strike: number;
  multiplier: number;
  contracts: number;
  /** Per-share option price received (contract-weighted average when fills were merged, 6 dp). */
  credit: number;
  /** Total opening fees for the leg, whole cents, instrument currency. */
  openFeesCents: number;
  closeDate: ISODate | null;
  /** Per-share buy-back price: 0 for expired, null for open and assigned legs. */
  closePrice: number | null;
  /** Total closing fees for the leg, whole cents. */
  closeFeesCents: number;
  outcome: JournalOutcome;
  status: 'open' | 'closed' | 'rolled' | 'assigned' | 'expired';
  /** Leg id of the new leg this one was rolled into (the first leg when that row was itself split). */
  rolledToLeg: number | null;
  spot: number | null;
  underlyingClose: number | null;
  notes: string | null;
  pnlCents: number | null;
  /** pnlCents as '1234.50'; null for open legs. */
  pnl: string | null;
  pnlBasis: JournalPnlBasis | null;
  /** sha256 hex of the canonical leg content; stable across runs and independent of row order. */
  importKey: string;
}

export interface JournalTotals {
  market: Market;
  legs: number;
  open: number;
  closed: number;
  expired: number;
  assigned: number;
  rolled: number;
  realizedPnlCents: number;
  realizedPnl: string;
  currencyNote: string;
}

export interface JournalParseResult {
  ok: boolean;
  /** Legs in source order (a split row yields its closed leg then its remaining leg); empty when rejected. */
  legs: JournalLeg[];
  errors: Violation[];
  warnings: Violation[];
  /** One per market present, US then HK; empty when rejected. */
  totals: JournalTotals[];
}

export interface JournalOptions {
  /** Underlying close on a day, used for `assigned` rows whose underlying_close cell is blank. */
  underlyingClose?: (market: Market, symbol: string, day: ISODate) => number | null;
}

const REQUIRED_COLUMNS = [
  'open_date',
  'symbol',
  'market',
  'expiry',
  'strike',
  'multiplier',
  'contracts',
  'credit',
  'open_fees',
  'close_date',
  'close_price',
  'close_fees',
  'outcome',
  'rolled_to_row',
] as const;
const OPTIONAL_COLUMNS = ['spot', 'underlying_close', 'closed_contracts', 'notes'] as const;
const KNOWN_COLUMNS: readonly string[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];
const OUTCOMES: readonly JournalOutcome[] = ['closed', 'expired', 'assigned', 'rolled', 'open'];
const CENT_MICROS = 10_000n;

/** A shape-validated source row. */
interface SrcRow {
  d: number;
  line: number;
  market: Market;
  symbol: string;
  openDate: ISODate;
  expiry: ISODate;
  strikeM: bigint;
  multiplier: number;
  contracts: number;
  creditM: bigint;
  openFeesC: bigint;
  closeDate: ISODate | null;
  closePriceM: bigint | null;
  closeFeesC: bigint;
  outcome: JournalOutcome;
  rolledToRow: number | null;
  /** Contracts this row closes (see closedQty rules in parseRow). */
  closedQty: number;
  spotM: bigint | null;
  underlyingCloseM: bigint | null;
  notes: string | null;
}

/** What stage 2 needs from every data row, even when the row failed shape validation. */
interface RowInfo {
  d: number;
  line: number;
  market: Market | null;
  symbol: string | null;
  outcome: JournalOutcome | null;
  /** null = blank, undefined = unparseable (already reported). */
  rolledToRow: number | null | undefined;
}

interface Ctx {
  line: number;
  cells: Record<string, string>;
  errors: Violation[];
  warnings: Violation[];
}

const get = (c: Ctx, name: string): string => c.cells[name] ?? '';

function fail(c: Ctx, code: string, detail: string): undefined {
  c.errors.push(violation(c.line, code, detail));
  return undefined;
}

function warn(c: Ctx, code: string, detail: string): void {
  c.warnings.push(violation(c.line, code, detail));
}

/** undefined = invalid (violation recorded), null = blank. */
function dateField(c: Ctx, name: string, required: boolean): ISODate | null | undefined {
  const t = get(c, name);
  if (t === '') return required ? fail(c, 'journal.missingField', `${name} is required`) : null;
  return isISODate(t) ? t : fail(c, 'journal.badDate', `${name} "${t}" is not a valid YYYY-MM-DD date`);
}

/** Non-negative exact decimal in micro-units. undefined = invalid, null = blank. */
function moneyField(
  c: Ctx,
  name: string,
  opts: { required?: boolean; positive?: boolean } = {},
): bigint | null | undefined {
  const t = get(c, name);
  if (t === '') return opts.required ? fail(c, 'journal.missingField', `${name} is required`) : null;
  const p = parseMicros(t);
  if (!p.ok) {
    return fail(
      c,
      'journal.badNumber',
      p.reason === 'format'
        ? `${name} "${t}" is not a plain decimal number (no thousands separators, currency symbols or exponents)`
        : `${name} ${t} has more than 6 decimal places`,
    );
  }
  if (p.micros < 0n) return fail(c, 'journal.badNumber', `${name} ${t} is negative`);
  if (opts.positive && p.micros === 0n) return fail(c, 'journal.badNumber', `${name} ${t} must be greater than zero`);
  return p.micros;
}

/** Fee cell in whole cents; blank = 0. undefined = invalid. */
function feeField(c: Ctx, name: string): bigint | undefined {
  const v = moneyField(c, name);
  if (v === null) return 0n;
  if (v === undefined) return undefined;
  if (v % CENT_MICROS !== 0n) {
    return fail(
      c,
      'journal.badNumber',
      `${name} ${get(c, name)} has more than 2 decimal places (fees are whole cents)`,
    );
  }
  return v / CENT_MICROS;
}

/** Positive integer (digits only, optional trailing .0). undefined = invalid, null = blank. */
function intField(c: Ctx, name: string, required: boolean, noun: string): number | null | undefined {
  const t = get(c, name);
  if (t === '') return required ? fail(c, 'journal.missingField', `${name} is required`) : null;
  if (!/^\d+(\.0+)?$/.test(t)) return fail(c, 'journal.badNumber', `${name} "${t}" must be ${noun}`);
  const n = Number(t.split('.')[0]);
  if (!Number.isSafeInteger(n) || n < 1) return fail(c, 'journal.badNumber', `${name} ${t} must be ${noun}`);
  return n;
}

/** Canonical symbol: US upper-case; HK digits without leading zeros, left-padded to 4 ('00700', '0700.HK' -> '0700'). */
export function canonicalSymbol(market: Market, raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (market === 'HK') {
    const digits = t.replace(/^HK\./, '').replace(/\.HK$/, '');
    if (!/^\d{1,5}$/.test(digits)) return null;
    const stripped = digits.replace(/^0+/, '');
    return stripped === '' ? null : stripped.padStart(4, '0');
  }
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(t) ? t : null;
}

function micros6(n: number): bigint | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = parseMicros(n.toFixed(6));
  return p.ok ? p.micros : null;
}

function parseRow(
  d: number,
  row: CsvRow,
  opts: JournalOptions,
  errors: Violation[],
  warnings: Violation[],
): { info: RowInfo; src: SrcRow | null } {
  const c: Ctx = { line: row.line, cells: row.cells, errors, warnings };
  const before = errors.length;

  // identity
  const marketText = get(c, 'market').toUpperCase();
  let market: Market | undefined;
  if (marketText === '') fail(c, 'journal.missingField', 'market is required (US or HK)');
  else if (marketText === 'US' || marketText === 'HK') market = marketText;
  else fail(c, 'journal.badMarket', `market "${get(c, 'market')}" must be US or HK`);

  const symbolText = get(c, 'symbol');
  let symbol: string | undefined;
  if (symbolText === '') {
    fail(c, 'journal.missingField', 'symbol is required');
  } else if (market) {
    const canon = canonicalSymbol(market, symbolText);
    if (canon === null) fail(c, 'journal.badSymbol', `symbol "${symbolText}" is not a valid ${market} symbol`);
    else symbol = canon;
  }

  const outcomeText = get(c, 'outcome').toLowerCase();
  const outcome = (OUTCOMES as readonly string[]).includes(outcomeText) ? (outcomeText as JournalOutcome) : undefined;
  if (!outcome) {
    fail(c, 'journal.badOutcome', `outcome "${get(c, 'outcome')}" must be one of ${OUTCOMES.join(' | ')}`);
  }

  // contract terms
  const openDate = dateField(c, 'open_date', true);
  const expiry = dateField(c, 'expiry', true);
  const strikeM = moneyField(c, 'strike', { required: true, positive: true });
  const multiplier = intField(c, 'multiplier', true, 'a positive integer');
  const contracts = intField(c, 'contracts', true, 'a positive integer');
  const creditM = moneyField(c, 'credit', { required: true });
  const openFeesC = feeField(c, 'open_fees');
  const closeFeesC = feeField(c, 'close_fees');

  // closed_contracts: integer in [1, contracts]
  let closedContracts: number | null | undefined = intField(
    c,
    'closed_contracts',
    false,
    'an integer from 1 to contracts',
  );
  if (typeof closedContracts === 'number' && typeof contracts === 'number' && closedContracts > contracts) {
    closedContracts = fail(
      c,
      'journal.badNumber',
      `closed_contracts ${closedContracts} exceeds contracts ${contracts}`,
    );
  }

  // optional close fields, validated for shape wherever present
  const closeDateRaw = dateField(c, 'close_date', false);
  const closePriceRaw = moneyField(c, 'close_price');

  // rolled_to_row: 1-based data-row number
  let rolledToRow: number | null | undefined = null;
  if (get(c, 'rolled_to_row') !== '') {
    rolledToRow = intField(
      c,
      'rolled_to_row',
      false,
      'a 1-based data-row number (header, comments and blank lines are not counted)',
    );
  }

  const spotM = moneyField(c, 'spot', { positive: true });
  const underlyingColumnM = moneyField(c, 'underlying_close', { positive: true });
  const notesText = get(c, 'notes');

  if (get(c, 'spot') === '') {
    warn(c, 'journal.noSpot', `row ${d} has no spot: excluded from calibration, still used for P&L and attribution`);
  }

  const info: RowInfo = {
    d,
    line: row.line,
    market: market ?? null,
    symbol: symbol ?? null,
    outcome: outcome ?? null,
    rolledToRow,
  };

  // closed quantity carried by this row
  const carved =
    outcome === 'open' &&
    typeof closedContracts === 'number' &&
    typeof contracts === 'number' &&
    closedContracts < contracts;
  let closedQty = 0;
  if (typeof contracts === 'number') {
    if (outcome === 'open') closedQty = carved ? (closedContracts as number) : 0;
    else closedQty = typeof closedContracts === 'number' ? closedContracts : contracts;
  }

  // outcome-specific close fields
  let closeDate: ISODate | null = null;
  let closePriceM: bigint | null = null;
  let closeFeesKept: bigint | undefined = closeFeesC;
  if (outcome === 'closed' || outcome === 'rolled') {
    if (closeDateRaw === null) fail(c, 'journal.missingField', `close_date is required when outcome is ${outcome}`);
    if (closePriceRaw === null) fail(c, 'journal.missingField', `close_price is required when outcome is ${outcome}`);
    closeDate = closeDateRaw ?? null;
    closePriceM = closePriceRaw ?? null;
  } else if (outcome === 'expired') {
    closeDate = closeDateRaw === undefined ? null : (closeDateRaw ?? expiry ?? null);
    closePriceM = 0n;
    if (typeof closePriceRaw === 'bigint' && closePriceRaw !== 0n) {
      warn(
        c,
        'journal.expiredClosePriceIgnored',
        `close_price ${get(c, 'close_price')} is ignored for an expired row (booked as 0)`,
      );
    }
  } else if (outcome === 'assigned') {
    if (closeDateRaw === null)
      fail(c, 'journal.missingField', 'close_date (the assignment date) is required when outcome is assigned');
    closeDate = closeDateRaw ?? null;
    if (typeof closePriceRaw === 'bigint' && closePriceRaw !== 0n) {
      warn(
        c,
        'journal.assignedClosePriceIgnored',
        `close_price ${get(c, 'close_price')} is ignored for an assigned row (P&L is credit minus intrinsic value at assignment)`,
      );
    }
  } else if (outcome === 'open') {
    if (carved) {
      if (closeDateRaw === null)
        fail(c, 'journal.missingField', 'close_date is required for the closed part (closed_contracts) of an open row');
      if (closePriceRaw === null)
        fail(
          c,
          'journal.missingField',
          'close_price is required for the closed part (closed_contracts) of an open row',
        );
      closeDate = closeDateRaw ?? null;
      closePriceM = closePriceRaw ?? null;
    } else {
      const hasClose =
        closeDateRaw !== null || closePriceRaw !== null || (typeof closeFeesC === 'bigint' && closeFeesC !== 0n);
      if (hasClose)
        warn(c, 'journal.openHasClose', 'row is open: its close_date, close_price and close_fees are ignored');
      closeFeesKept = 0n;
    }
  }

  // date relations
  if (typeof openDate === 'string' && typeof expiry === 'string' && expiry < openDate) {
    fail(c, 'journal.badDate', `expiry ${expiry} is before open_date ${openDate}`);
  }
  if (typeof openDate === 'string' && closeDate !== null && closeDate < openDate) {
    fail(c, 'journal.badDate', `close_date ${closeDate} is before open_date ${openDate}`);
  }
  if (
    (outcome === 'closed' || outcome === 'rolled') &&
    closeDate !== null &&
    typeof expiry === 'string' &&
    closeDate > expiry
  ) {
    fail(c, 'journal.badDate', `close_date ${closeDate} is after expiry ${expiry} but the outcome is ${outcome}`);
  }

  // expiry must be an expiry day on the market's calendar
  if (market && typeof expiry === 'string') {
    const problem = expiryDayProblem(market, expiry);
    if (problem) fail(c, 'journal.badExpiry', `expiry ${expiry} ${problem}`);
  }

  // underlying close for assignment
  let underlyingCloseM: bigint | null = typeof underlyingColumnM === 'bigint' ? underlyingColumnM : null;
  if (outcome === 'assigned' && underlyingColumnM === null && closeDate !== null && market && symbol) {
    const looked = opts.underlyingClose?.(market, symbol, closeDate);
    underlyingCloseM = typeof looked === 'number' ? micros6(looked) : null;
    if (underlyingCloseM === null) {
      fail(
        c,
        'journal.assignedNoUnderlying',
        `no underlying close for ${market} ${symbol} on ${closeDate}: fill the underlying_close column or ingest price bars first`,
      );
    }
  }

  if (errors.length > before) return { info, src: null };
  if (
    !market ||
    !symbol ||
    !outcome ||
    typeof openDate !== 'string' ||
    typeof expiry !== 'string' ||
    typeof strikeM !== 'bigint' ||
    typeof multiplier !== 'number' ||
    typeof contracts !== 'number' ||
    typeof creditM !== 'bigint' ||
    openFeesC === undefined ||
    closeFeesKept === undefined ||
    rolledToRow === undefined ||
    spotM === undefined
  ) {
    return { info, src: null }; // unreachable: every undefined above recorded an error
  }
  return {
    info,
    src: {
      d,
      line: row.line,
      market,
      symbol,
      openDate,
      expiry,
      strikeM,
      multiplier,
      contracts,
      creditM,
      openFeesC,
      closeDate,
      closePriceM,
      closeFeesC: closeFeesKept,
      outcome,
      rolledToRow,
      closedQty,
      spotM,
      underlyingCloseM,
      notes: notesText === '' ? null : notesText,
    },
  };
}

/** One merged leg before it is (possibly) split. */
interface Group {
  index: number;
  members: SrcRow[];
  /** Index of the group this one rolled into, when resolved. */
  rolledToGroup: number | null;
}

interface WorkLeg {
  group: Group;
  market: Market;
  symbol: string;
  openDate: ISODate;
  expiry: ISODate;
  strikeM: bigint;
  multiplier: number;
  contracts: number;
  creditM: bigint;
  openFeesC: bigint;
  closeDate: ISODate | null;
  closePriceM: bigint | null;
  closeFeesC: bigint;
  outcome: JournalOutcome;
  rolledToGroup: number | null;
  spotM: bigint | null;
  underlyingCloseM: bigint | null;
  notes: string | null;
}

const sumBig = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** Merge the members of one group into legs (closed leg, then remaining open leg when partially closed). */
function legsOfGroup(g: Group): WorkLeg[] {
  const first = g.members[0] as SrcRow;
  const total = g.members.reduce((a, m) => a + m.contracts, 0);
  const closed = g.members.reduce((a, m) => a + m.closedQty, 0);
  const totalB = BigInt(total);

  const creditM = divRound(sumBig(g.members.map((m) => m.creditM * BigInt(m.contracts))), totalB);
  let closePriceM: bigint | null = null;
  if (first.outcome === 'expired') {
    closePriceM = 0n;
  } else if (first.outcome !== 'assigned' && closed > 0) {
    closePriceM = divRound(sumBig(g.members.map((m) => (m.closePriceM ?? 0n) * BigInt(m.closedQty))), BigInt(closed));
  }
  const spots = g.members.map((m) => m.spotM);
  const spotM = spots.every((s): s is bigint => s !== null)
    ? divRound(sumBig(g.members.map((m) => (m.spotM as bigint) * BigInt(m.contracts))), totalB)
    : null;
  const notes = [...new Set(g.members.map((m) => m.notes).filter((n): n is string => n !== null))].join(' | ') || null;
  const openFeesTotal = sumBig(g.members.map((m) => m.openFeesC));
  const closeFeesTotal = sumBig(g.members.map((m) => m.closeFeesC));
  const underlyingCloseM = g.members.map((m) => m.underlyingCloseM).find((u): u is bigint => u !== null) ?? null;

  const base = {
    group: g,
    market: first.market,
    symbol: first.symbol,
    openDate: first.openDate,
    expiry: first.expiry,
    strikeM: first.strikeM,
    multiplier: first.multiplier,
    spotM,
    notes,
  };

  if (closed === 0) {
    // wholly open
    return [
      {
        ...base,
        contracts: total,
        creditM,
        openFeesC: openFeesTotal,
        closeDate: null,
        closePriceM: null,
        closeFeesC: 0n,
        outcome: 'open',
        rolledToGroup: g.rolledToGroup,
        underlyingCloseM,
      },
    ];
  }
  if (closed >= total) {
    return [
      {
        ...base,
        contracts: total,
        creditM,
        openFeesC: openFeesTotal,
        closeDate: first.closeDate,
        closePriceM,
        closeFeesC: closeFeesTotal,
        outcome: first.outcome,
        rolledToGroup: g.rolledToGroup,
        underlyingCloseM,
      },
    ];
  }
  // partial close: two legs, fees allocated exactly (closed share rounded half up to the cent, remainder to the rest)
  const closedOpenFee = divRound(openFeesTotal * BigInt(closed), totalB);
  return [
    {
      ...base,
      contracts: closed,
      creditM,
      openFeesC: closedOpenFee,
      closeDate: first.closeDate,
      closePriceM,
      closeFeesC: closeFeesTotal,
      outcome: first.outcome === 'open' ? 'closed' : first.outcome,
      rolledToGroup: g.rolledToGroup,
      underlyingCloseM,
    },
    {
      ...base,
      contracts: total - closed,
      creditM,
      openFeesC: openFeesTotal - closedOpenFee,
      closeDate: null,
      closePriceM: null,
      closeFeesC: 0n,
      outcome: 'open',
      rolledToGroup: null,
      underlyingCloseM: null,
    },
  ];
}

/** Realised P&L in whole cents, or null for an open leg. */
function legPnl(l: WorkLeg): { cents: bigint; basis: JournalPnlBasis } | null {
  if (l.outcome === 'open') return null;
  let perShare: bigint;
  if (l.outcome === 'assigned') {
    const u = l.underlyingCloseM as bigint;
    perShare = l.creditM - (l.strikeM > u ? l.strikeM - u : 0n);
  } else {
    perShare = l.creditM - (l.closePriceM ?? 0n);
  }
  const gross = perShare * BigInt(l.multiplier) * BigInt(l.contracts);
  const net = gross - centsToMicros(l.openFeesC + l.closeFeesC);
  return { cents: microsToCents(net), basis: l.outcome === 'assigned' ? 'mtm_at_assignment' : 'cash' };
}

function groupKey(m: SrcRow): string {
  return [m.market, m.symbol, m.expiry, formatMicros(m.strikeM), m.openDate, m.closeDate ?? '', m.outcome].join('|');
}

export function parseJournalCsv(text: string, opts: JournalOptions = {}): JournalParseResult {
  const csv = readCsv(text);
  const errors: Violation[] = [...csv.errors];
  const warnings: Violation[] = [];
  const rejected = (): JournalParseResult => ({
    ok: false,
    legs: [],
    errors: sortViolations(errors),
    warnings: sortViolations(warnings),
    totals: [],
  });

  if (csv.header.length === 0) {
    errors.push(violation(0, 'journal.header', 'the file has no header row'));
    return rejected();
  }
  const missing = REQUIRED_COLUMNS.filter((col) => !csv.header.includes(col));
  if (missing.length > 0) {
    errors.push(violation(0, 'journal.header', `missing required column(s): ${missing.join(', ')}`));
    return rejected();
  }
  for (const col of csv.header) {
    if (!KNOWN_COLUMNS.includes(col)) {
      warnings.push(violation(csv.headerLine, 'journal.unknownColumn', `unknown column "${col}" is ignored`));
    }
  }
  if (csv.rows.length === 0) {
    warnings.push(violation(0, 'journal.empty', 'the file has a header but no data rows; nothing to import'));
    return {
      ok: errors.length === 0,
      legs: [],
      errors: sortViolations(errors),
      warnings: sortViolations(warnings),
      totals: [],
    };
  }

  // Stage 1: shape-validate every source row.
  const infos: RowInfo[] = [];
  const sources = new Map<number, SrcRow>();
  const seenRows = new Map<string, CsvRow>();
  csv.rows.forEach((row, i) => {
    const d = i + 1;
    const { info, src } = parseRow(d, row, opts, errors, warnings);
    infos.push(info);
    if (src) sources.set(d, src);
    const fingerprint = KNOWN_COLUMNS.map((col) => row.cells[col] ?? '').join('\u0001');
    const twin = seenRows.get(fingerprint);
    if (twin) {
      warnings.push(
        violation(
          row.line,
          'journal.duplicateRow',
          `identical to line ${twin.line}: the two rows are merged into one leg and their contracts add up (delete one if this is a double paste)`,
        ),
      );
    } else {
      seenRows.set(fingerprint, row);
    }
  });

  // Stage 2: resolve rolled_to_row against the SOURCE data-row numbers, before any merge or split.
  const linkOk = new Set<number>();
  for (const info of infos) {
    if (info.rolledToRow === undefined) continue;
    if (info.rolledToRow === null) {
      if (info.outcome === 'rolled') {
        errors.push(
          violation(
            info.line,
            'journal.rolledToUnresolved',
            `rolled_to_row is blank but the outcome is rolled (give the data-row number of the new leg)`,
          ),
        );
      }
      continue;
    }
    const target = infos[info.rolledToRow - 1];
    if (!target) {
      errors.push(
        violation(
          info.line,
          'journal.rolledToUnresolved',
          `rolled_to_row ${info.rolledToRow} does not exist: the file has ${infos.length} data rows (header, comments and blank lines are not counted)`,
        ),
      );
    } else if (target.d === info.d) {
      errors.push(
        violation(
          info.line,
          'journal.rolledToUnresolved',
          `rolled_to_row ${info.rolledToRow} points at the row itself`,
        ),
      );
    } else if (
      info.market &&
      info.symbol &&
      target.market &&
      target.symbol &&
      (info.market !== target.market || info.symbol !== target.symbol)
    ) {
      errors.push(
        violation(
          info.line,
          'journal.rolledToUnresolved',
          `rolled_to_row ${info.rolledToRow} (line ${target.line}) is ${target.market} ${target.symbol}, not ${info.market} ${info.symbol}`,
        ),
      );
    } else {
      linkOk.add(info.d);
    }
  }

  // Stage 3: merge same-day fills on one contract. Group key as specified; roll links are re-pointed afterwards.
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const groupOfRow = new Map<number, Group>();
  for (const src of sources.values()) {
    const key = groupKey(src);
    let g = byKey.get(key);
    if (!g) {
      g = { index: groups.length, members: [], rolledToGroup: null };
      groups.push(g);
      byKey.set(key, g);
    }
    g.members.push(src);
    groupOfRow.set(src.d, g);
  }
  for (const g of groups) {
    const first = g.members[0] as SrcRow;
    for (const m of g.members.slice(1)) {
      if (m.multiplier !== first.multiplier) {
        errors.push(
          violation(
            m.line,
            'journal.badNumber',
            `multiplier ${m.multiplier} differs from ${first.multiplier} on line ${first.line} for the same contract and day`,
          ),
        );
      }
      if (
        m.underlyingCloseM !== null &&
        first.underlyingCloseM !== null &&
        m.underlyingCloseM !== first.underlyingCloseM
      ) {
        errors.push(
          violation(
            m.line,
            'journal.badNumber',
            `underlying_close differs from line ${first.line} for the same contract and day`,
          ),
        );
      }
    }
    let target: { group: Group; member: SrcRow } | null = null;
    for (const m of g.members) {
      if (m.rolledToRow === null || !linkOk.has(m.d)) continue;
      const tg = groupOfRow.get(m.rolledToRow);
      if (!tg) continue; // target row failed validation; reported there
      if (tg === g) {
        errors.push(
          violation(
            m.line,
            'journal.rolledToUnresolved',
            `rolled_to_row ${m.rolledToRow} is merged into the same leg as this row (same-day fills)`,
          ),
        );
      } else if (!target) {
        target = { group: tg, member: m };
      } else if (target.group !== tg) {
        errors.push(
          violation(
            m.line,
            'journal.rolledToConflict',
            `rows ${target.member.d} (line ${target.member.line}) and ${m.d} are merged into one leg but roll to different legs (rows ${target.member.rolledToRow} and ${m.rolledToRow})`,
          ),
        );
      }
    }
    g.rolledToGroup = target ? target.group.index : null;
  }

  if (errors.length > 0) return rejected();

  // Stage 4: split partial closes, then number the legs and compute P&L.
  const work: WorkLeg[] = [];
  const firstLegOfGroup = new Map<number, number>();
  for (const g of groups) {
    firstLegOfGroup.set(g.index, work.length);
    work.push(...legsOfGroup(g));
  }

  const occurrence = new Map<string, number>();
  const legs: JournalLeg[] = work.map((w, id) => {
    const members = w.group.members;
    const content = {
      market: w.market,
      symbol: w.symbol,
      expiry: w.expiry,
      strike: formatMicros(w.strikeM),
      openDate: w.openDate,
      contracts: w.contracts,
      credit: formatMicros(w.creditM),
      closeDate: w.closeDate,
      closePrice: w.closePriceM === null ? null : formatMicros(w.closePriceM),
      outcome: w.outcome,
    };
    const base = stableStringify(content);
    const nth = occurrence.get(base) ?? 0;
    occurrence.set(base, nth + 1);
    const pnl = legPnl(w);
    return {
      id,
      srcRows: members.map((m) => m.d),
      lines: members.map((m) => m.line),
      market: w.market,
      symbol: w.symbol,
      openDate: w.openDate,
      expiry: w.expiry,
      strike: microsToNumber(w.strikeM),
      multiplier: w.multiplier,
      contracts: w.contracts,
      credit: microsToNumber(w.creditM),
      openFeesCents: Number(w.openFeesC),
      closeDate: w.closeDate,
      closePrice: w.closePriceM === null ? null : microsToNumber(w.closePriceM),
      closeFeesCents: Number(w.closeFeesC),
      outcome: w.outcome,
      status: w.outcome,
      rolledToLeg: w.rolledToGroup === null ? null : (firstLegOfGroup.get(w.rolledToGroup) ?? null),
      spot: w.spotM === null ? null : microsToNumber(w.spotM),
      underlyingClose: w.underlyingCloseM === null ? null : microsToNumber(w.underlyingCloseM),
      notes: w.notes,
      pnlCents: pnl ? Number(pnl.cents) : null,
      pnl: pnl ? formatCents(pnl.cents) : null,
      pnlBasis: pnl ? pnl.basis : null,
      importKey: sha256(stableStringify({ ...content, occurrence: nth })),
    };
  });

  return { ok: true, legs, errors: [], warnings: sortViolations(warnings), totals: totalsOf(legs) };
}

function totalsOf(legs: JournalLeg[]): JournalTotals[] {
  const out: JournalTotals[] = [];
  for (const market of ['US', 'HK'] as const) {
    const mine = legs.filter((l) => l.market === market);
    if (mine.length === 0) continue;
    const count = (s: JournalLeg['status']): number => mine.filter((l) => l.status === s).length;
    const cents = mine.reduce((a, l) => a + (l.pnlCents ?? 0), 0);
    out.push({
      market,
      legs: mine.length,
      open: count('open'),
      closed: count('closed'),
      expired: count('expired'),
      assigned: count('assigned'),
      rolled: count('rolled'),
      realizedPnlCents: cents,
      realizedPnl: formatCents(cents),
      currencyNote: market === 'HK' ? 'HKD' : 'USD',
    });
  }
  return out;
}

/** One printable line per market, for the user to check against the broker statement. */
export function formatTotals(totals: JournalTotals[]): string[] {
  return totals.map(
    (t) =>
      `${t.market} (${t.currencyNote}): ${t.legs} legs (${t.open} open, ${t.closed} closed, ${t.expired} expired, ` +
      `${t.assigned} assigned, ${t.rolled} rolled); realised P&L ${t.realizedPnl} ${t.currencyNote}`,
  );
}
