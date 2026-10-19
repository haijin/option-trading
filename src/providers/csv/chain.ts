/**
 * CSV option-chain importer (docs/02-architecture.md section 3, task T6).
 * Pure: text in, parsed rows plus line-numbered violations out. The file is rejected as a whole when ANY error exists.
 */
import type { Market } from '../../core/calendar';
import { type ISODate, isISODate } from '../../core/dates';
import type { OptionChainSnapshot, OptionQuote } from '../../core/types';
import { decimalToNumber } from './decimal';
import { expiryDayProblem } from './expiry';
import { readCsv, sortViolations, type Violation, violation } from './read';

export { formatViolations, type Violation } from './read';

export interface ChainCsvOptions {
  market: Market;
  symbol: string;
  spot: number;
  date: ISODate;
  multiplier: number;
}

export interface ParsedChainRow {
  /** Physical 1-based line of the row in the source file. */
  line: number;
  expiry: ISODate;
  strike: number;
  right: 'P' | 'C';
  bid: number;
  ask: number;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  /** Normalised sign: negative for puts, positive for calls. */
  delta: number | null;
}

export interface ChainParseResult {
  ok: boolean;
  /** Parsed rows; empty when the file is rejected. */
  rows: ParsedChainRow[];
  errors: Violation[];
  warnings: Violation[];
}

const REQUIRED_COLUMNS = ['expiry', 'strike', 'right', 'bid', 'ask', 'last', 'volume', 'oi'] as const;
const OPTIONAL_COLUMNS = ['iv', 'delta'] as const;
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

/** Strike window around spot, inclusive: 40% to 160%. */
const STRIKE_MIN_RATIO = 0.4;
const STRIKE_MAX_RATIO = 1.6;
const EPS = 1e-9;

/** undefined = invalid (violation already recorded), null = blank, number = value. */
type Parsed<T> = T | null | undefined;

const THOUSANDS_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;

function fmt(x: number): string {
  return x.toFixed(2);
}

function badNumber(errors: Violation[], line: number, detail: string): void {
  errors.push(violation(line, 'chain.badNumber', detail));
}

/** Non-negative plain decimal. Required cells may not be blank; optional cells accept '' and '-' as null. */
function parseNonNegative(
  label: string,
  text: string,
  required: boolean,
  line: number,
  errors: Violation[],
): Parsed<number> {
  if (!required && (text === '' || text === '-')) return null;
  if (text === '') {
    badNumber(errors, line, `${label} is required but blank`);
    return undefined;
  }
  const v = decimalToNumber(text);
  if (v === null) {
    const hint = THOUSANDS_RE.test(text) ? ' (thousands separators are not allowed)' : '';
    badNumber(errors, line, `${label} "${text}" is not a plain number${hint}`);
    return undefined;
  }
  if (v < 0) {
    badNumber(errors, line, `${label} ${text} is negative`);
    return undefined;
  }
  return v;
}

/** iv as fraction: '0.325', '32.5%' and a bare '32.5' (anything above 3 is read as percent) all give 0.325. */
function parseIv(text: string, line: number, errors: Violation[]): Parsed<number> {
  if (text === '' || text === '-') return null;
  const isPercent = text.endsWith('%');
  const body = isPercent ? text.slice(0, -1).trim() : text;
  const raw = decimalToNumber(body);
  if (raw === null) {
    badNumber(errors, line, `iv "${text}" is not a number (units: write 0.325, 32.5 or 32.5%)`);
    return undefined;
  }
  const iv = isPercent || raw > 3 ? decimalToNumber(body, -2) : raw;
  if (iv === null || !(iv > 0 && iv <= 5)) {
    badNumber(
      errors,
      line,
      `iv "${text}" is outside (0, 5] after unit normalisation, read as ${iv} (units: write 0.325, 32.5 or 32.5%)`,
    );
    return undefined;
  }
  return iv;
}

function parseDelta(text: string, line: number, errors: Violation[]): Parsed<number> {
  if (text === '' || text === '-') return null;
  const d = decimalToNumber(text);
  if (d === null) {
    badNumber(errors, line, `delta "${text}" is not a number`);
    return undefined;
  }
  if (d < -1 || d > 1) {
    badNumber(errors, line, `delta ${text} is outside [-1, 1] (units: write a fraction such as -0.25, not -25)`);
    return undefined;
  }
  return d;
}

function parseRight(text: string): 'P' | 'C' | null {
  const t = text.toUpperCase();
  if (t === 'P' || t === 'PUT') return 'P';
  if (t === 'C' || t === 'CALL') return 'C';
  return null;
}

/** Why `expiry` is not acceptable for this market and snapshot date, or null when it is fine. */
function expiryProblem(market: Market, expiry: ISODate, snapshotDate: ISODate): string | null {
  const reasons: string[] = [];
  const calendar = expiryDayProblem(market, expiry);
  if (calendar) reasons.push(calendar);
  if (expiry < snapshotDate) reasons.push(`is before the snapshot date ${snapshotDate}`);
  return reasons.length > 0 ? `expiry ${expiry} ${reasons.join(' and ')}` : null;
}

function checkOptions(opts: ChainCsvOptions): Violation[] {
  const errors: Violation[] = [];
  if (!Number.isFinite(opts.spot) || opts.spot <= 0) {
    errors.push(violation(0, 'chain.options', `spot must be a positive number, got ${opts.spot}`));
  }
  if (typeof opts.date !== 'string' || !isISODate(opts.date)) {
    errors.push(violation(0, 'chain.options', `date must be a valid YYYY-MM-DD date, got "${opts.date}"`));
  }
  if (!Number.isInteger(opts.multiplier) || opts.multiplier <= 0) {
    errors.push(violation(0, 'chain.options', `multiplier must be a positive integer, got ${opts.multiplier}`));
  }
  return errors;
}

export function parseChainCsv(text: string, opts: ChainCsvOptions): ChainParseResult {
  const optionErrors = checkOptions(opts);
  if (optionErrors.length > 0) return { ok: false, rows: [], errors: optionErrors, warnings: [] };

  const csv = readCsv(text);
  const errors: Violation[] = [...csv.errors];
  const warnings: Violation[] = [];

  if (csv.header.length === 0) {
    errors.push(violation(0, 'chain.empty', 'the file has no header and no data rows'));
    return { ok: false, rows: [], errors: sortViolations(errors), warnings };
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !csv.header.includes(c));
  if (missing.length > 0) {
    errors.push(
      violation(
        0,
        'chain.header',
        `missing required column(s): ${missing.join(', ')} (expected expiry,strike,right,bid,ask,last,volume,oi[,iv][,delta])`,
      ),
    );
    return { ok: false, rows: [], errors: sortViolations(errors), warnings };
  }
  for (const col of csv.header) {
    if (!KNOWN_COLUMNS.has(col)) {
      warnings.push(violation(csv.headerLine, 'chain.unknownColumn', `unknown column "${col}" is ignored`));
    }
  }
  if (csv.rows.length === 0) {
    errors.push(violation(0, 'chain.empty', 'the file has a header but no data rows'));
    return { ok: false, rows: [], errors: sortViolations(errors), warnings: sortViolations(warnings) };
  }

  const lo = opts.spot * STRIKE_MIN_RATIO;
  const hi = opts.spot * STRIKE_MAX_RATIO;
  const rows: ParsedChainRow[] = [];
  const firstSeen = new Map<string, number>();

  for (const { line, cells } of csv.rows) {
    const cell = (name: string): string => cells[name] ?? '';
    const before = errors.length;

    // expiry: date text, then calendar validity
    const expiryText = cell('expiry');
    let expiry: ISODate | undefined;
    if (isISODate(expiryText)) {
      expiry = expiryText;
    } else {
      badNumber(errors, line, `expiry "${expiryText}" is not a valid YYYY-MM-DD date`);
    }

    // strike
    const strikeText = cell('strike');
    let strike: number | undefined;
    const strikeVal = strikeText === '' ? null : decimalToNumber(strikeText);
    if (strikeVal === null) {
      badNumber(
        errors,
        line,
        strikeText === '' ? 'strike is required but blank' : `strike "${strikeText}" is not a plain number`,
      );
    } else if (strikeVal <= 0) {
      badNumber(errors, line, `strike ${strikeText} must be positive`);
    } else {
      strike = strikeVal;
    }

    // right
    const rightText = cell('right');
    const right = parseRight(rightText);
    if (right === null) {
      errors.push(violation(line, 'chain.badRight', `right "${rightText}" must be P, C, PUT or CALL`));
    }

    const bid = parseNonNegative('bid', cell('bid'), true, line, errors);
    const ask = parseNonNegative('ask', cell('ask'), true, line, errors);
    const last = parseNonNegative('last', cell('last'), false, line, errors);
    const volume = parseNonNegative('volume', cell('volume'), false, line, errors);
    const oi = parseNonNegative('oi', cell('oi'), false, line, errors);
    const iv = parseIv(cell('iv'), line, errors);
    const rawDelta = parseDelta(cell('delta'), line, errors);

    // chain.badExpiry
    if (expiry !== undefined) {
      const problem = expiryProblem(opts.market, expiry, opts.date);
      if (problem) errors.push(violation(line, 'chain.badExpiry', problem));
    }

    // chain.strikeRange
    if (strike !== undefined && (strike < lo - EPS * opts.spot || strike > hi + EPS * opts.spot)) {
      errors.push(
        violation(
          line,
          'chain.strikeRange',
          `strike ${strikeText} is outside 40%-160% of spot ${fmt(opts.spot)} (${fmt(lo)} to ${fmt(hi)})`,
        ),
      );
    }

    // chain.crossed
    if (typeof bid === 'number' && typeof ask === 'number' && bid > ask) {
      errors.push(violation(line, 'chain.crossed', `bid ${cell('bid')} > ask ${cell('ask')}`));
    }

    // chain.duplicate (reported on every later occurrence)
    if (expiry !== undefined && strike !== undefined && right !== null) {
      const key = `${expiry}|${strike}|${right}`;
      const first = firstSeen.get(key);
      if (first === undefined) {
        firstSeen.set(key, line);
      } else {
        errors.push(
          violation(
            line,
            'chain.duplicate',
            `duplicates line ${first} (expiry ${expiry}, strike ${strikeText}, ${right === 'P' ? 'put' : 'call'})`,
          ),
        );
      }
    }

    // chain.illiquid (warning, row kept)
    const illiquid: string[] = [];
    if (bid === 0) illiquid.push('bid is 0');
    if (oi === 0) illiquid.push('open interest is 0');
    if (illiquid.length > 0) {
      warnings.push(violation(line, 'chain.illiquid', `${illiquid.join(' and ')} (row kept; liquidity rules decide)`));
    }

    if (errors.length > before) continue;
    if (
      expiry === undefined ||
      strike === undefined ||
      right === null ||
      typeof bid !== 'number' ||
      typeof ask !== 'number' ||
      last === undefined ||
      volume === undefined ||
      oi === undefined ||
      iv === undefined ||
      rawDelta === undefined
    ) {
      continue; // unreachable: every undefined above recorded an error
    }
    const delta =
      rawDelta === null || rawDelta === 0 ? rawDelta : right === 'P' ? -Math.abs(rawDelta) : Math.abs(rawDelta);
    rows.push({ line, expiry, strike, right, bid, ask, last, volume, openInterest: oi, iv, delta });
  }

  const ok = errors.length === 0;
  return {
    ok,
    rows: ok ? rows : [],
    errors: sortViolations(errors),
    warnings: sortViolations(warnings),
  };
}

/** Real-tier snapshot from parsed rows (source 'csv'). Greeks other than delta are left for the app to compute. */
export function chainToSnapshot(rows: ParsedChainRow[], opts: ChainCsvOptions): OptionChainSnapshot {
  const quotes: OptionQuote[] = rows.map((r) => ({
    expiry: r.expiry,
    strike: r.strike,
    right: r.right,
    bid: r.bid,
    ask: r.ask,
    last: r.last,
    volume: r.volume,
    openInterest: r.openInterest,
    iv: r.iv,
    delta: r.delta,
    gamma: null,
    theta: null,
    vega: null,
    multiplier: opts.multiplier,
  }));
  return { snapshotDate: opts.date, underlyingPrice: opts.spot, source: 'csv', tier: 'real', quotes };
}
