import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalSymbol,
  formatTotals,
  formatViolations,
  type JournalLeg,
  type JournalParseResult,
  parseJournalCsv,
} from '../../src/providers/csv/journal';

const fixtureText = (name: string): string =>
  readFileSync(new URL(`../fixtures/journal/${name}`, import.meta.url), 'utf8');

const COLS = [
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
  'spot',
  'underlying_close',
  'closed_contracts',
  'notes',
] as const;
type Col = (typeof COLS)[number];
type RowSpec = Partial<Record<Col, string | number>>;

/** A valid closed US put: 1 AAPL 300P sold 2026-08-03 at 2.00, bought back 2026-08-20 at 0.50. */
const BASE: Record<Col, string> = {
  open_date: '2026-08-03',
  symbol: 'AAPL',
  market: 'US',
  expiry: '2026-09-04',
  strike: '300',
  multiplier: '100',
  contracts: '1',
  credit: '2.00',
  open_fees: '1.00',
  close_date: '2026-08-20',
  close_price: '0.50',
  close_fees: '1.00',
  outcome: 'closed',
  rolled_to_row: '',
  spot: '320',
  underlying_close: '',
  closed_contracts: '',
  notes: '',
};
const HEADER = COLS.join(',');
const row = (over: RowSpec = {}): string => COLS.map((c) => String(over[c] ?? BASE[c])).join(',');
/** Header on physical line 1, so data row d sits on line d + 1. */
const journal = (...rows: (RowSpec | string)[]): string =>
  [HEADER, ...rows.map((r) => (typeof r === 'string' ? r : row(r)))].join('\n');
const parse = (...rows: (RowSpec | string)[]): JournalParseResult => parseJournalCsv(journal(...rows));

/** An open row on a later contract (used as a roll target and as a plain open position). */
const OPEN: RowSpec = {
  open_date: '2026-08-20',
  expiry: '2026-09-18',
  outcome: 'open',
  close_date: '',
  close_price: '',
  close_fees: '',
};
const HK_ROW: RowSpec = { symbol: '0700', market: 'HK', expiry: '2026-09-29', strike: '440' };

const lc = (vs: { line: number; code: string }[]): [number, string][] => vs.map((v) => [v.line, v.code]);
const only = (r: JournalParseResult): JournalLeg => {
  expect(r.errors).toEqual([]);
  expect(r.legs).toHaveLength(1);
  return r.legs[0] as JournalLeg;
};

describe('P&L fixture (hand-computed, re-derived by tests/fixtures/gen/gen_journal_expected.py)', () => {
  const expected = JSON.parse(fixtureText('pnl-fixture.expected.json')) as {
    legs: Record<string, unknown>[];
    totals: unknown[];
    noSpotLines: number[];
  };
  const r = parseJournalCsv(fixtureText('pnl-fixture.csv'));
  const six = (x: number | null): string | null => (x === null ? null : x.toFixed(6));

  it('is accepted, with only the expected spot warnings', () => {
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['journal.noSpot', 'journal.noSpot']);
    expect(r.warnings.map((w) => w.line)).toEqual(expected.noSpotLines);
    expect(r.warnings[0]?.message).toMatch(/^line 7: journal\.noSpot .*excluded from calibration/);
  });

  it('every leg equals the hand-computed expectation to the cent', () => {
    const actual = r.legs.map((l) => ({
      id: l.id,
      srcRows: l.srcRows,
      lines: l.lines,
      market: l.market,
      symbol: l.symbol,
      openDate: l.openDate,
      expiry: l.expiry,
      strike: six(l.strike),
      multiplier: l.multiplier,
      contracts: l.contracts,
      credit: six(l.credit),
      closePrice: six(l.closePrice),
      openFeesCents: l.openFeesCents,
      closeFeesCents: l.closeFeesCents,
      closeDate: l.closeDate,
      outcome: l.outcome,
      rolledToLeg: l.rolledToLeg,
      spot: six(l.spot),
      underlyingClose: six(l.underlyingClose),
      notes: l.notes,
      pnlCents: l.pnlCents,
      pnl: l.pnl,
      pnlBasis: l.pnlBasis,
    }));
    expect(actual).toEqual(expected.legs);
  });

  it('per-market totals equal the expectation and print as lines', () => {
    expect(r.totals).toEqual(expected.totals);
    expect(formatTotals(r.totals)).toEqual([
      'US (USD): 8 legs (1 open, 4 closed, 1 expired, 1 assigned, 1 rolled); realised P&L 955.73 USD',
      'HK (HKD): 7 legs (2 open, 2 closed, 1 expired, 1 assigned, 1 rolled); realised P&L 1188.97 HKD',
    ]);
  });

  it('proves the arithmetic is exact: 1.15 - 0.35 is inexact in floating point, the importer books 240.00', () => {
    expect(1.15 - 0.35).not.toBe(0.8);
    expect((1.15 - 0.35) * 300).not.toBe(240); // 239.99999999999997 in IEEE doubles
    const leg = only(parse({ credit: '1.15', close_price: '0.35', contracts: 3, open_fees: '', close_fees: '' }));
    expect(leg.pnlCents).toBe(24000);
    expect(leg.pnl).toBe('240.00');
  });

  it('status mirrors outcome and the legs carry a distinct import key each', () => {
    expect(r.legs.every((l) => l.status === l.outcome)).toBe(true);
    expect(new Set(r.legs.map((l) => l.importKey)).size).toBe(r.legs.length);
  });
});

describe('journal.rolledToUnresolved (error)', () => {
  it('rolled_to_row pointing past the last data row', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 99 }, OPEN);
    expect(r.ok).toBe(false);
    expect(r.legs).toEqual([]);
    expect(lc(r.errors)).toEqual([[2, 'journal.rolledToUnresolved']]);
    expect(r.errors[0]?.message).toMatch(/^line 2: journal\.rolledToUnresolved rolled_to_row 99 does not exist/);
  });

  it('rolled_to_row pointing at the row itself', () => {
    const r = parse(OPEN, { outcome: 'rolled', rolled_to_row: 2 });
    expect(lc(r.errors)).toEqual([[3, 'journal.rolledToUnresolved']]);
    expect(r.errors[0]?.message).toContain('itself');
  });

  it('rolled_to_row pointing at another symbol or another market', () => {
    const otherSymbol = parse({ outcome: 'rolled', rolled_to_row: 2 }, { ...OPEN, symbol: 'MSFT' });
    expect(lc(otherSymbol.errors)).toEqual([[2, 'journal.rolledToUnresolved']]);
    expect(otherSymbol.errors[0]?.message).toContain('not US AAPL');
    const otherMarket = parse({ outcome: 'rolled', rolled_to_row: 2 }, { ...OPEN, ...HK_ROW, outcome: 'open' });
    expect(lc(otherMarket.errors)).toEqual([[2, 'journal.rolledToUnresolved']]);
  });

  it('a rolled row without rolled_to_row', () => {
    const r = parse({ outcome: 'rolled' }, OPEN);
    expect(lc(r.errors)).toEqual([[2, 'journal.rolledToUnresolved']]);
    expect(r.errors[0]?.message).toContain('blank');
  });

  it('a non-integer rolled_to_row is a badNumber, not a silent skip', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 'row two' }, OPEN);
    expect(lc(r.errors)).toEqual([[2, 'journal.badNumber']]);
  });
});

describe('journal.rolledToConflict (error)', () => {
  it('two fills merged into one leg that roll to different legs', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 3 }, { outcome: 'rolled', rolled_to_row: 4 }, OPEN, {
      ...OPEN,
      strike: '310',
    });
    expect(r.ok).toBe(false);
    expect(lc(r.errors)).toEqual([[3, 'journal.rolledToConflict']]);
  });

  it('two fills that roll into two members of the same merged target are fine', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 3 }, { outcome: 'rolled', rolled_to_row: 4 }, OPEN, OPEN);
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => l.rolledToLeg)).toEqual([1, null]);
  });

  it('a link that lands in the leg the row itself is merged into is rejected after merging', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 2 }, { outcome: 'rolled', rolled_to_row: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['journal.rolledToUnresolved', 'journal.rolledToUnresolved']);
    expect(r.errors[0]?.message).toContain('same leg');
  });
});

describe('journal.badExpiry (error)', () => {
  it('HK accepts the monthly expiry only', () => {
    expect(only(parse({ ...HK_ROW })).expiry).toBe('2026-09-29');
    const weekly = parse({ ...HK_ROW, expiry: '2026-09-18' });
    expect(weekly.ok).toBe(false);
    expect(lc(weekly.errors)).toEqual([[2, 'journal.badExpiry']]);
    expect(weekly.errors[0]?.message).toContain('2026-09-29');
  });

  it('US accepts Fridays and the Thursday before a Friday holiday, rejects the rest', () => {
    const wed = parse({ expiry: '2026-09-02' });
    expect(lc(wed.errors)).toEqual([[2, 'journal.badExpiry']]);
    const holidayFriday = parse({ open_date: '2026-06-01', expiry: '2026-07-03', close_date: '2026-06-20' });
    expect(lc(holidayFriday.errors)).toEqual([[2, 'journal.badExpiry']]);
    const holidayThursday = parse({ open_date: '2026-06-01', expiry: '2026-07-02', close_date: '2026-06-20' });
    expect(holidayThursday.errors).toEqual([]);
  });

  it('a date outside the calendar tables is a badExpiry, not an exception', () => {
    const r = parse({ open_date: '2031-01-05', expiry: '2031-01-17', close_date: '2031-01-10' });
    expect(lc(r.errors)).toEqual([[2, 'journal.badExpiry']]);
    expect(r.errors[0]?.message).toContain('calendar tables');
  });
});

describe('journal.badNumber (error)', () => {
  const badOn = (over: RowSpec, line = 2): void => {
    const r = parse(over);
    expect(r.ok, JSON.stringify(over)).toBe(false);
    expect(
      r.errors.map((e) => [e.line, e.code]),
      JSON.stringify(over),
    ).toContainEqual([line, 'journal.badNumber']);
  };

  it('strike must be a positive number', () => {
    badOn({ strike: '0' });
    badOn({ strike: '-300' });
    badOn({ strike: 'three hundred' });
  });

  it('contracts and multiplier must be positive integers', () => {
    badOn({ contracts: '0' });
    badOn({ contracts: '1.5' });
    badOn({ contracts: '-2' });
    badOn({ multiplier: '0' });
    badOn({ multiplier: 'abc' });
    badOn({ multiplier: '"1,000"' });
  });

  it('credit and close_price may not be negative or non-numeric', () => {
    badOn({ credit: '-0.10' });
    badOn({ credit: 'free' });
    badOn({ close_price: '-0.01' });
    badOn({ close_price: 'n/a' });
  });

  it('fees: whole cents, not negative, not text', () => {
    badOn({ open_fees: '-1.00' });
    badOn({ close_fees: '1.005' });
    badOn({ open_fees: 'abc' });
  });

  it('more than 6 decimals and thousands separators are rejected', () => {
    badOn({ credit: '1.1234567' });
    badOn({ strike: '"1,250.5"' });
    expect(parse({ credit: '1.1234560' }).errors).toEqual([]);
  });

  it('closed_contracts must be an integer in [1, contracts]', () => {
    badOn({ contracts: '3', closed_contracts: '0' });
    badOn({ contracts: '3', closed_contracts: '4' });
    badOn({ contracts: '3', closed_contracts: '1.5' });
    badOn({ contracts: '3', closed_contracts: 'x' });
  });

  it('spot and underlying_close must be positive when present', () => {
    badOn({ spot: '0' });
    badOn({ underlying_close: '-4' });
  });

  it('same-day fills on one contract may not disagree on the multiplier', () => {
    const r = parse({ ...HK_ROW, multiplier: '100' }, { ...HK_ROW, multiplier: '500' });
    expect(lc(r.errors)).toEqual([[3, 'journal.badNumber']]);
  });
});

describe('journal.badDate (error)', () => {
  it('rejects invalid ISO dates', () => {
    for (const over of [
      { open_date: '2026-13-01' },
      { open_date: '08/03/2026' },
      { expiry: '2026-02-30' },
      { close_date: 'yesterday' },
    ]) {
      const r = parse(over);
      expect(r.ok, JSON.stringify(over)).toBe(false);
      expect(r.errors[0], JSON.stringify(over)).toMatchObject({ line: 2, code: 'journal.badDate' });
    }
  });

  it('expiry before open_date', () => {
    const r = parse({ open_date: '2026-09-11', expiry: '2026-09-04', close_date: '2026-09-11' });
    expect(r.errors.map((e) => [e.line, e.code])).toContainEqual([2, 'journal.badDate']);
    expect(r.errors[0]?.message).toContain('before open_date');
  });

  it('close_date before open_date', () => {
    const r = parse({ close_date: '2026-08-01' });
    expect(lc(r.errors)).toEqual([[2, 'journal.badDate']]);
    expect(r.errors[0]?.message).toContain('close_date 2026-08-01 is before open_date');
  });

  it('closed and rolled rows may not close after expiry', () => {
    const closed = parse({ close_date: '2026-09-08' });
    expect(lc(closed.errors)).toEqual([[2, 'journal.badDate']]);
    expect(closed.errors[0]?.message).toContain('after expiry');
    const rolled = parse({ outcome: 'rolled', close_date: '2026-09-08', rolled_to_row: 2 }, OPEN);
    expect(lc(rolled.errors)).toEqual([[2, 'journal.badDate']]);
  });

  it('close on the expiry day itself is fine', () => {
    expect(parse({ close_date: '2026-09-04' }).errors).toEqual([]);
  });
});

describe('journal.badOutcome (error)', () => {
  it('rejects an unknown or blank outcome', () => {
    const r = parse({ outcome: 'exercised' });
    expect(lc(r.errors)).toEqual([[2, 'journal.badOutcome']]);
    expect(r.errors[0]?.message).toContain('closed | expired | assigned | rolled | open');
    expect(lc(parse({ outcome: '' }).errors)).toEqual([[2, 'journal.badOutcome']]);
  });

  it('outcome is case-insensitive', () => {
    expect(only(parse({ outcome: 'CLOSED' })).outcome).toBe('closed');
  });
});

describe('journal.missingField (error)', () => {
  it('closed and rolled need close_date and close_price', () => {
    expect(lc(parse({ close_date: '' }).errors)).toEqual([[2, 'journal.missingField']]);
    expect(lc(parse({ close_price: '' }).errors)).toEqual([[2, 'journal.missingField']]);
    const both = parse({ outcome: 'rolled', close_date: '', close_price: '', rolled_to_row: 2 }, OPEN);
    expect(lc(both.errors)).toEqual([
      [2, 'journal.missingField'],
      [2, 'journal.missingField'],
    ]);
  });

  it('assigned needs a close_date (the assignment date)', () => {
    const r = parse({ outcome: 'assigned', close_date: '', underlying_close: '290' });
    expect(lc(r.errors)).toEqual([[2, 'journal.missingField']]);
    expect(r.errors[0]?.message).toContain('assignment date');
  });

  it('always-required cells', () => {
    for (const col of [
      'open_date',
      'symbol',
      'market',
      'expiry',
      'strike',
      'multiplier',
      'contracts',
      'credit',
    ] as const) {
      const r = parse({ [col]: '' });
      expect(r.ok, col).toBe(false);
      expect(r.errors[0]?.code, col).toBe('journal.missingField');
      expect(r.errors[0]?.line, col).toBe(2);
    }
  });

  it('the closed part of a partially closed open row needs close_date and close_price', () => {
    const r = parse({ outcome: 'open', contracts: 3, closed_contracts: 1, close_date: '', close_price: '' });
    expect(lc(r.errors)).toEqual([
      [2, 'journal.missingField'],
      [2, 'journal.missingField'],
    ]);
  });
});

describe('journal.assignedNoUnderlying (error)', () => {
  it('rejects an assigned row with neither underlying_close nor a lookup result', () => {
    const r = parse({ outcome: 'assigned', close_price: '', close_date: '2026-09-04' });
    expect(r.ok).toBe(false);
    expect(lc(r.errors)).toEqual([[2, 'journal.assignedNoUnderlying']]);
    expect(r.errors[0]?.message).toContain('underlying_close');
    expect(r.errors[0]?.message).toContain('ingest price bars');
  });

  it('a lookup that returns null (or garbage) is the same error', () => {
    for (const looked of [null, Number.NaN, 0, -1]) {
      const r = parseJournalCsv(journal({ outcome: 'assigned', close_price: '' }), { underlyingClose: () => looked });
      expect(lc(r.errors), String(looked)).toEqual([[2, 'journal.assignedNoUnderlying']]);
    }
  });
});

describe('assigned P&L (T10): credit minus intrinsic value at assignment', () => {
  const assigned = (over: RowSpec): RowSpec => ({
    outcome: 'assigned',
    strike: '100',
    credit: '2.00',
    contracts: 3,
    open_fees: '',
    close_fees: '',
    close_price: '',
    close_date: '2026-09-04',
    ...over,
  });

  it('subtracts the intrinsic loss: credit 2.00, strike 100, U 92 -> (2 - 8) x 100 x 3', () => {
    const leg = only(parse(assigned({ underlying_close: '92' })));
    expect(leg.pnlCents).toBe(-180000);
    expect(leg.pnl).toBe('-1800.00');
    expect(leg.pnlBasis).toBe('mtm_at_assignment');
    expect(leg.status).toBe('assigned');
    expect(leg.underlyingClose).toBe(92);
    expect(leg.closePrice).toBeNull();
  });

  it('fees are deducted on top', () => {
    const leg = only(parse(assigned({ underlying_close: '92', open_fees: '3.90', close_fees: '25.00' })));
    expect(leg.pnl).toBe('-1828.90');
  });

  it('with U above the strike the full credit is booked', () => {
    const above = only(parse(assigned({ underlying_close: '105' })));
    expect(above.pnl).toBe('600.00');
    expect(above.pnlBasis).toBe('mtm_at_assignment');
    const at = only(parse(assigned({ underlying_close: '100' })));
    expect(at.pnl).toBe('600.00');
  });

  it('uses the injected underlyingClose lookup when the column is blank, with canonical symbol and the assignment date', () => {
    const calls: [string, string, string][] = [];
    const r = parseJournalCsv(
      journal(assigned({ ...HK_ROW, symbol: '700.HK', strike: '100', expiry: '2026-09-29', close_date: '2026-09-29' })),
      {
        underlyingClose: (m, s, d) => {
          calls.push([m, s, d]);
          return 92.5;
        },
      },
    );
    expect(r.errors).toEqual([]);
    expect(calls).toEqual([['HK', '0700', '2026-09-29']]);
    expect(r.legs[0]?.pnl).toBe('-1650.00'); // (2.00 - 7.50) x 100 x 3
  });

  it('the underlying_close column wins over the lookup and non-assigned rows never call it', () => {
    let calls = 0;
    const lookup = (): number => {
      calls++;
      return 50;
    };
    const r = parseJournalCsv(journal(assigned({ underlying_close: '92' }), { outcome: 'closed' }, { ...OPEN }), {
      underlyingClose: lookup,
    });
    expect(r.errors).toEqual([]);
    expect(calls).toBe(0);
    expect(r.legs[0]?.pnl).toBe('-1800.00');
  });
});

describe('journal.assignedClosePriceIgnored / expiredClosePriceIgnored / openHasClose (warnings)', () => {
  const warnCodes = (r: JournalParseResult): [number, string][] =>
    lc(r.warnings.filter((w) => w.code !== 'journal.noSpot'));

  it('assigned with a non-zero close_price: warn, ignore the price, keep the row', () => {
    const r = parse({
      outcome: 'assigned',
      underlying_close: '92',
      close_price: '1.00',
      strike: '100',
      close_date: '2026-09-04',
    });
    expect(r.ok).toBe(true);
    expect(warnCodes(r)).toEqual([[2, 'journal.assignedClosePriceIgnored']]);
    expect(r.legs[0]?.pnl).toBe('-602.00'); // (2.00 - 8.00) x 100 - fees 2.00
  });

  it('assigned with close_price 0 or blank: no warning', () => {
    const r = parse(
      { outcome: 'assigned', underlying_close: '92', close_price: '0', strike: '100', close_date: '2026-09-04' },
      {
        outcome: 'assigned',
        underlying_close: '92',
        close_price: '',
        strike: '100',
        close_date: '2026-09-04',
        open_date: '2026-08-04',
      },
    );
    expect(warnCodes(r)).toEqual([]);
  });

  it('expired with a non-zero close_price: warn and book 0', () => {
    const r = parse({ outcome: 'expired', close_price: '0.05', close_date: '', close_fees: '' });
    expect(r.ok).toBe(true);
    expect(warnCodes(r)).toEqual([[2, 'journal.expiredClosePriceIgnored']]);
    expect(r.legs[0]?.closePrice).toBe(0);
  });

  it('open with close fields: warn and ignore them', () => {
    const r = parse({ ...OPEN, close_date: '2026-08-25', close_price: '0.40', close_fees: '1.00' });
    expect(r.ok).toBe(true);
    expect(warnCodes(r)).toEqual([[2, 'journal.openHasClose']]);
    const leg = r.legs[0] as JournalLeg;
    expect(leg).toMatchObject({
      outcome: 'open',
      closeDate: null,
      closePrice: null,
      closeFeesCents: 0,
      pnl: null,
      pnlCents: null,
      pnlBasis: null,
    });
  });

  it('a clean open row has no warning and null P&L', () => {
    const r = parse({ ...OPEN });
    expect(warnCodes(r)).toEqual([]);
    expect(r.legs[0]).toMatchObject({ status: 'open', pnl: null, pnlCents: null, closeDate: null });
  });
});

describe('expired rows', () => {
  it('close_price is 0 and close_date defaults to the expiry', () => {
    const leg = only(
      parse({
        outcome: 'expired',
        close_date: '',
        close_price: '',
        close_fees: '',
        contracts: 2,
        credit: '2.40',
        open_fees: '2.60',
      }),
    );
    expect(leg).toMatchObject({
      closePrice: 0,
      closeDate: '2026-09-04',
      pnl: '477.40',
      pnlBasis: 'cash',
      status: 'expired',
    });
  });

  it('an explicit close_date on an expired row is kept', () => {
    const leg = only(parse({ outcome: 'expired', close_date: '2026-09-03', close_price: '' }));
    expect(leg.closeDate).toBe('2026-09-03');
  });
});

describe('journal.duplicateRow (warning)', () => {
  it('two fully identical rows warn on the second, and are still merged', () => {
    const r = parse({}, {});
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'journal.duplicateRow').map((w) => w.line)).toEqual([3]);
    expect(r.warnings.find((w) => w.code === 'journal.duplicateRow')?.message).toContain('line 2');
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({
      contracts: 2,
      srcRows: [1, 2],
      lines: [2, 3],
      openFeesCents: 200,
      closeFeesCents: 200,
    });
  });

  it('rows that differ in any cell are not duplicates', () => {
    const r = parse({}, { notes: 'second fill' });
    expect(r.warnings.some((w) => w.code === 'journal.duplicateRow')).toBe(false);
    expect(r.legs).toHaveLength(1);
  });
});

describe('journal.noSpot (warning)', () => {
  it('one warning per row with a blank spot, none otherwise', () => {
    const r = parse({ spot: '' }, { open_date: '2026-08-04' }, { open_date: '2026-08-05', spot: '' });
    expect(r.ok).toBe(true);
    expect(lc(r.warnings)).toEqual([
      [2, 'journal.noSpot'],
      [4, 'journal.noSpot'],
    ]);
    expect(r.warnings[0]?.message).toBe(
      'line 2: journal.noSpot row 1 has no spot: excluded from calibration, still used for P&L and attribution',
    );
    expect(r.legs.map((l) => l.spot)).toEqual([null, 320, null]);
    expect(r.legs.every((l) => l.pnl !== null)).toBe(true);
  });

  it('a file without a spot column warns for every row', () => {
    const cols = COLS.filter((c) => c !== 'spot');
    const text = [cols.join(','), cols.map((c) => BASE[c]).join(',')].join('\n');
    const r = parseJournalCsv(text);
    expect(r.ok).toBe(true);
    expect(lc(r.warnings)).toEqual([[2, 'journal.noSpot']]);
  });
});

describe('journal.unknownColumn and header errors', () => {
  it('unknown column: warning at the header line, column ignored', () => {
    const text = ['# note', `${HEADER},broker_ref`, `${row()},XYZ-1`].join('\n');
    const r = parseJournalCsv(text);
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'journal.unknownColumn')).toEqual([
      expect.objectContaining({
        line: 2,
        message: 'line 2: journal.unknownColumn unknown column "broker_ref" is ignored',
      }),
    ]);
    expect(r.legs).toHaveLength(1);
  });

  it('a missing required column is a file-level journal.header error', () => {
    const text = [COLS.filter((c) => c !== 'credit').join(','), 'x'].join('\n');
    const r = parseJournalCsv(text);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 0, code: 'journal.header' });
    expect(r.errors[0]?.message).toContain('credit');
  });

  it('optional columns may be absent entirely', () => {
    const cols = COLS.filter((c) => !['spot', 'underlying_close', 'closed_contracts', 'notes'].includes(c));
    const r = parseJournalCsv([cols.join(','), cols.map((c) => BASE[c]).join(',')].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.legs[0]?.notes).toBeNull();
  });

  it('a header-only file imports nothing and says so', () => {
    const r = parseJournalCsv(`${HEADER}\n`);
    expect(r.ok).toBe(true);
    expect(r.legs).toEqual([]);
    expect(r.warnings[0]).toMatchObject({ line: 0, code: 'journal.empty' });
  });

  it('market and symbol must be valid', () => {
    expect(lc(parse({ market: 'JP' }).errors)).toEqual([[2, 'journal.badMarket']]);
    expect(lc(parse({ ...HK_ROW, symbol: 'TENCENT' }).errors)).toEqual([[2, 'journal.badSymbol']]);
    expect(lc(parse({ symbol: '??' }).errors)).toEqual([[2, 'journal.badSymbol']]);
  });
});

describe('all violations are collected over the whole file with physical lines; any error rejects everything', () => {
  it('reports every rule in one pass, ordered by line, and imports nothing', () => {
    const text = [
      '# comment on line 1',
      HEADER, // line 2
      row(), // 3 valid
      row({ strike: '0' }), // 4 badNumber
      row({ expiry: '2026-09-02' }), // 5 badExpiry
      row({ outcome: 'bogus' }), // 6 badOutcome
      row({ close_date: '' }), // 7 missingField
      row({ close_date: '2026-08-01' }), // 8 badDate
      row({ outcome: 'assigned', close_price: '' }), // 9 assignedNoUnderlying
      row({ outcome: 'rolled', rolled_to_row: 99 }), // 10 rolledToUnresolved
      row({ spot: '' }), // 11 warning only
    ].join('\n');
    const r = parseJournalCsv(text);
    expect(r.ok).toBe(false);
    expect(r.legs).toEqual([]);
    expect(r.totals).toEqual([]);
    expect(lc(r.errors)).toEqual([
      [4, 'journal.badNumber'],
      [5, 'journal.badExpiry'],
      [6, 'journal.badOutcome'],
      [7, 'journal.missingField'],
      [8, 'journal.badDate'],
      [9, 'journal.assignedNoUnderlying'],
      [10, 'journal.rolledToUnresolved'],
    ]);
    expect(lc(r.warnings)).toEqual([[11, 'journal.noSpot']]);
    for (const e of r.errors) expect(e.message.startsWith(`line ${e.line}: ${e.code} `)).toBe(true);
    expect(formatViolations(r.errors)).toEqual(r.errors.map((e) => e.message));
  });

  it('several problems on one row are all reported', () => {
    const r = parse({ strike: '-1', credit: 'x', contracts: '0', expiry: '2026-09-02' });
    expect(r.errors.map((e) => e.code).sort()).toEqual([
      'journal.badExpiry',
      'journal.badNumber',
      'journal.badNumber',
      'journal.badNumber',
    ]);
    expect(r.errors.every((e) => e.line === 2)).toBe(true);
  });

  it('warnings alone never reject', () => {
    const r = parse({ spot: '' }, { spot: '', notes: 'x', open_date: '2026-08-04' });
    expect(r.ok).toBe(true);
    expect(r.legs.length).toBeGreaterThan(0);
  });
});

describe('processing order: rolled_to_row is a data-row number, resolved before merge and split', () => {
  it('counts data rows, not physical lines: comments and blank lines before and between the data are ignored', () => {
    const text = [
      '# first comment',
      '',
      HEADER,
      row({ outcome: 'rolled', rolled_to_row: 2 }),
      '# a comment',
      '',
      row({ ...OPEN }),
    ].join('\n');
    // physical lines: 1 comment, 2 blank, 3 header, 4 data row 1, 5 comment, 6 blank, 7 data row 2
    const r = parseJournalCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => l.lines)).toEqual([[4], [7]]);
    expect(r.legs.map((l) => l.srcRows)).toEqual([[1], [2]]);
    expect(r.legs[0]?.rolledToLeg).toBe(1);
  });

  it('a physical line number is not accepted in place of the data-row number', () => {
    const text = [
      '# first comment',
      '',
      HEADER,
      row({ outcome: 'rolled', rolled_to_row: 7 }),
      '# a comment',
      '',
      row({ ...OPEN }),
    ].join('\n');
    const r = parseJournalCsv(text);
    expect(r.ok).toBe(false);
    expect(lc(r.errors)).toEqual([[4, 'journal.rolledToUnresolved']]);
  });

  it('after a MERGE the link points at the merged leg, not at row-number minus one', () => {
    // data rows: 1 old AAPL leg -> row 4; 2+3 same-day MSFT fills (one leg); 4 the new AAPL leg
    const msft: RowSpec = { symbol: 'MSFT', strike: '400' };
    const r = parse({ outcome: 'rolled', rolled_to_row: 4 }, msft, msft, { ...OPEN });
    expect(r.errors).toEqual([]);
    expect(r.legs).toHaveLength(3);
    expect(r.legs.map((l) => l.symbol)).toEqual(['AAPL', 'MSFT', 'AAPL']);
    expect(r.legs[1]?.srcRows).toEqual([2, 3]);
    expect(r.legs[0]?.rolledToLeg).toBe(2);
    expect(r.legs[2]?.srcRows).toEqual([4]);
  });

  it('a link to ANY member of a merged group resolves to the merged leg', () => {
    const second = parse({ outcome: 'rolled', rolled_to_row: 3 }, { ...OPEN }, { ...OPEN });
    const first = parse({ outcome: 'rolled', rolled_to_row: 2 }, { ...OPEN }, { ...OPEN });
    expect(second.errors).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(second.legs.map((l) => l.rolledToLeg)).toEqual([1, null]);
    expect(first.legs.map((l) => l.rolledToLeg)).toEqual([1, null]);
    expect(second.legs[1]).toMatchObject({ contracts: 2, srcRows: [2, 3] });
  });

  it('after a SPLIT the later legs are renumbered and the link still lands on the right leg', () => {
    // row 1 is split into legs 0 and 1; row 2 (old AAPL) becomes leg 2; row 3 (new AAPL) becomes leg 3
    const split: RowSpec = { symbol: 'KO', strike: '66', contracts: 3, closed_contracts: 1 };
    const r = parse(split, { outcome: 'rolled', rolled_to_row: 3 }, { ...OPEN });
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.symbol, l.outcome, l.contracts])).toEqual([
      ['KO', 'closed', 1],
      ['KO', 'open', 2],
      ['AAPL', 'rolled', 1],
      ['AAPL', 'open', 1],
    ]);
    expect(r.legs[2]?.rolledToLeg).toBe(3);
  });

  it('a rolled_to_row on a row that is split stays on the closed leg only', () => {
    const r = parse({ outcome: 'rolled', rolled_to_row: 2, contracts: 3, closed_contracts: 2 }, { ...OPEN });
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.outcome, l.contracts, l.rolledToLeg])).toEqual([
      ['rolled', 2, 2],
      ['open', 1, null],
      ['open', 1, null],
    ]);
  });

  it('a link to a row that is itself split lands on its closed (first) leg', () => {
    const r = parse(
      { outcome: 'rolled', rolled_to_row: 2 },
      { ...OPEN, contracts: 3, closed_contracts: 1, close_date: '2026-09-01', close_price: '0.20' },
    );
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.outcome, l.contracts])).toEqual([
      ['rolled', 1],
      ['closed', 1],
      ['open', 2],
    ]);
    expect(r.legs[0]?.rolledToLeg).toBe(1);
  });

  it('is resolved against the source rows: a merge cannot make an unresolved link look valid', () => {
    // row 3 does not exist in a 2-row file even though the two rows merge into a single leg
    const r = parse({ outcome: 'rolled', rolled_to_row: 3 }, { outcome: 'rolled', rolled_to_row: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['journal.rolledToUnresolved', 'journal.rolledToUnresolved']);
  });
});

describe('same-day fills are merged into one leg', () => {
  it('averages credit and close_price weighted by contracts, sums contracts and fees', () => {
    const r = parse(
      { contracts: 1, credit: '1.20', close_price: '0.40', open_fees: '1.30', close_fees: '0.65' },
      { contracts: 2, credit: '1.25', close_price: '0.45', open_fees: '2.60', close_fees: '1.30' },
      { contracts: 1, credit: '1.30', close_price: '0.50', open_fees: '1.30', close_fees: '0.65' },
    );
    const leg = only(r);
    expect(leg).toMatchObject({
      contracts: 4,
      credit: 1.25,
      closePrice: 0.45,
      openFeesCents: 520,
      closeFeesCents: 260,
      srcRows: [1, 2, 3],
      lines: [2, 3, 4],
      pnl: '312.20',
    });
  });

  it('keeps 6 decimals, rounded half up: 1.10, 1.10, 1.11 average 1.103333', () => {
    const leg = only(parse({ credit: '1.10' }, { credit: '1.10' }, { credit: '1.11' }));
    expect(leg.credit).toBe(1.103333);
    expect(leg.contracts).toBe(3);
  });

  it('rounds the average half up at the sixth decimal', () => {
    const leg = only(parse({ credit: '0.000001', close_price: '0' }, { credit: '0.000002', close_price: '0' }));
    expect(leg.credit).toBe(0.000002);
  });

  it('merges non-adjacent fills, and symbols are compared in canonical form', () => {
    const r = parse(
      { ...HK_ROW, symbol: '700' },
      { symbol: 'MSFT' },
      { ...HK_ROW, symbol: '0700.HK' },
      { ...HK_ROW, symbol: '00700' },
    );
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.symbol, l.contracts, l.srcRows])).toEqual([
      ['0700', 3, [1, 3, 4]],
      ['MSFT', 1, [2]],
    ]);
  });

  it('does not merge rows that differ in strike, open_date, close_date or outcome', () => {
    const r = parse(
      {},
      { strike: '310' },
      { open_date: '2026-08-04' },
      { close_date: '2026-08-21' },
      { outcome: 'rolled', rolled_to_row: 1 },
    );
    expect(r.errors).toEqual([]);
    expect(r.legs).toHaveLength(5);
  });

  it('spot is the contract-weighted average when every fill has one, else unknown', () => {
    expect(only(parse({ spot: '320' }, { spot: '321' }, { spot: '321' })).spot).toBeCloseTo(320.666667, 6);
    expect(only(parse({ spot: '320' }, { spot: '' })).spot).toBeNull();
  });

  it('notes are joined once each', () => {
    expect(only(parse({ notes: 'a' }, { notes: 'b' }, { notes: 'a' })).notes).toBe('a | b');
  });
});

describe('partial closes are split into a closed leg and a remaining open leg', () => {
  const split = (over: RowSpec = {}) =>
    parse({
      contracts: 4,
      closed_contracts: 1,
      open_fees: '22.10',
      close_fees: '5.50',
      credit: '2.10',
      close_price: '0.65',
      ...over,
    });

  it('creates two adjacent legs: closed first, remaining open second', () => {
    const r = split();
    expect(r.errors).toEqual([]);
    expect(r.legs).toHaveLength(2);
    const [closed, rest] = r.legs as [JournalLeg, JournalLeg];
    expect(closed).toMatchObject({
      id: 0,
      outcome: 'closed',
      contracts: 1,
      closePrice: 0.65,
      closeDate: '2026-08-20',
      pnl: '133.97',
    });
    expect(rest).toMatchObject({
      id: 1,
      outcome: 'open',
      status: 'open',
      contracts: 3,
      closePrice: null,
      closeDate: null,
      closeFeesCents: 0,
      pnl: null,
      pnlCents: null,
    });
    expect(closed.srcRows).toEqual([1]);
    expect(rest.srcRows).toEqual([1]);
  });

  it('allocates the opening fee round-half-up to the cent and the remainder to the open leg; close fees stay on the closed leg', () => {
    const [closed, rest] = split().legs as [JournalLeg, JournalLeg];
    expect(closed.openFeesCents).toBe(553); // 22.10 x 1/4 = 5.525 -> 5.53
    expect(rest.openFeesCents).toBe(1657);
    expect(closed.openFeesCents + rest.openFeesCents).toBe(2210);
    expect(closed.closeFeesCents).toBe(550);
    expect(rest.closeFeesCents).toBe(0);
  });

  it('the parts always sum to the original fee', () => {
    const cases: [string, number, number][] = [
      ['0.01', 3, 1],
      ['0.05', 2, 1],
      ['2.00', 3, 1],
      ['2.00', 3, 2],
      ['9.99', 7, 3],
      ['1.30', 3, 2],
      ['100.00', 6, 5],
      ['0.00', 4, 1],
      ['', 4, 1],
    ];
    for (const [fee, contracts, closedN] of cases) {
      const [closed, rest] = parse({ open_fees: fee, contracts, closed_contracts: closedN }).legs as [
        JournalLeg,
        JournalLeg,
      ];
      const total = fee === '' ? 0 : Math.round(Number(fee) * 100);
      expect(closed.openFeesCents + rest.openFeesCents, `${fee} ${closedN}/${contracts}`).toBe(total);
      expect(closed.contracts + rest.contracts).toBe(contracts);
    }
    // ties round up: 0.05 x 1/2 = 0.025 -> 0.03 on the closed leg
    const [c, r] = parse({ open_fees: '0.05', contracts: 2, closed_contracts: 1 }).legs as [JournalLeg, JournalLeg];
    expect([c.openFeesCents, r.openFeesCents]).toEqual([3, 2]);
  });

  it('an open row with closed_contracts closes that part as outcome closed', () => {
    const r = parse({
      outcome: 'open',
      contracts: 3,
      closed_contracts: 2,
      close_date: '2026-08-20',
      close_price: '0.50',
    });
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.outcome, l.contracts])).toEqual([
      ['closed', 2],
      ['open', 1],
    ]);
    expect(r.legs[0]?.pnl).toBe('298.33'); // 1.50 x 100 x 2 - 0.67 - 1.00
  });

  it('closed_contracts blank or equal to contracts does not split', () => {
    expect(parse({ contracts: 3 }).legs).toHaveLength(1);
    expect(parse({ contracts: 3, closed_contracts: 3 }).legs).toHaveLength(1);
  });

  it('an expired or assigned row can also be partial: the closed part keeps the outcome', () => {
    const r = parse({
      outcome: 'expired',
      close_date: '',
      close_price: '',
      close_fees: '',
      contracts: 3,
      closed_contracts: 2,
    });
    expect(r.legs.map((l) => [l.outcome, l.contracts])).toEqual([
      ['expired', 2],
      ['open', 1],
    ]);
  });

  it('the split happens after the merge: merged fills are split on the summed quantities', () => {
    const r = parse({ contracts: 2, closed_contracts: 1 }, { contracts: 2 });
    expect(r.errors).toEqual([]);
    expect(r.legs.map((l) => [l.outcome, l.contracts, l.srcRows])).toEqual([
      ['closed', 3, [1, 2]],
      ['open', 1, [1, 2]],
    ]);
  });
});

describe('exact money arithmetic', () => {
  it('rounds the row P&L half away from zero to the cent (0.005 -> 0.01, -0.005 -> -0.01)', () => {
    const win = only(parse({ credit: '0.00005', close_price: '0', open_fees: '', close_fees: '' }));
    expect(win.pnlCents).toBe(1);
    expect(win.pnl).toBe('0.01');
    const loss = only(parse({ credit: '0', close_price: '0.00005', open_fees: '', close_fees: '' }));
    expect(loss.pnlCents).toBe(-1);
    expect(loss.pnl).toBe('-0.01');
    const flat = only(parse({ credit: '1', close_price: '1', open_fees: '', close_fees: '' }));
    expect(flat.pnl).toBe('0.00');
    expect(flat.pnlCents).toBe(0);
  });

  it('totals are the sum of the already-rounded row P&L', () => {
    const r = parse(
      { credit: '0.00005', close_price: '0', open_fees: '', close_fees: '' },
      { credit: '0.00005', close_price: '0', open_fees: '', close_fees: '', open_date: '2026-08-04' },
    );
    expect(r.legs.map((l) => l.pnlCents)).toEqual([1, 1]);
    expect(r.totals[0]).toMatchObject({ realizedPnlCents: 2, realizedPnl: '0.02' });
  });

  it('formats negative cents without a stray sign on zero and with 2 decimals', () => {
    const r = parse({ credit: '1.00', close_price: '3.505', open_fees: '', close_fees: '' });
    expect(r.legs[0]?.pnl).toBe('-250.50');
    expect(r.legs[0]?.pnlCents).toBe(-25050);
  });

  it('large HK multipliers and counts stay exact', () => {
    const leg = only(
      parse({
        ...HK_ROW,
        multiplier: '500',
        contracts: 37,
        credit: '1.235',
        close_price: '0.115',
        open_fees: '123.45',
        close_fees: '67.89',
      }),
    );
    // (1.235 - 0.115) x 500 x 37 = 20720.00 ; minus 191.34
    expect(leg.pnl).toBe('20528.66');
  });
});

describe('importKey', () => {
  const rows: RowSpec[] = [
    {},
    { symbol: 'MSFT', strike: '400' },
    { ...HK_ROW },
    { ...OPEN },
    { contracts: 3, closed_contracts: 1, open_date: '2026-08-04' },
  ];

  it('is a stable sha256 hex across runs', () => {
    const a = parse(...rows);
    const b = parse(...rows);
    expect(a.legs.map((l) => l.importKey)).toEqual(b.legs.map((l) => l.importKey));
    for (const l of a.legs) expect(l.importKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of row order', () => {
    const forward = parse(...rows);
    const reversed = parse(...[...rows].reverse());
    const keyOf = (r: JournalParseResult) =>
      new Map(
        r.legs.map((l) => [
          `${l.market}|${l.symbol}|${l.expiry}|${l.strike}|${l.openDate}|${l.outcome}|${l.contracts}`,
          l.importKey,
        ]),
      );
    const f = keyOf(forward);
    const b = keyOf(reversed);
    expect(f.size).toBe(forward.legs.length);
    expect([...f.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of f) expect(b.get(k)).toBe(v);
    expect([...new Set(forward.legs.map((l) => l.importKey))].sort()).toEqual(
      [...new Set(reversed.legs.map((l) => l.importKey))].sort(),
    );
  });

  it('is distinct across different legs', () => {
    const r = parse(...rows);
    expect(new Set(r.legs.map((l) => l.importKey)).size).toBe(r.legs.length);
    const base = only(parse({})).importKey;
    for (const over of [
      { strike: '310' },
      { credit: '2.01' },
      { contracts: 2 },
      { close_price: '0.51' },
      { open_date: '2026-08-04' },
      { expiry: '2026-09-11' },
      { symbol: 'MSFT' },
    ] as RowSpec[]) {
      expect(only(parse(over)).importKey, JSON.stringify(over)).not.toBe(base);
    }
    expect(only(parse({ outcome: 'expired', close_price: '', close_date: '', close_fees: '' })).importKey).not.toBe(
      base,
    );
  });

  it('ignores fees, spot and notes, so editing them does not create a new key', () => {
    const base = only(parse({})).importKey;
    expect(only(parse({ open_fees: '9.99', close_fees: '8.88', spot: '1', notes: 'edited' })).importKey).toBe(base);
  });

  it('is independent of how the numbers are written (1.5 vs 1.500)', () => {
    expect(only(parse({ credit: '2' })).importKey).toBe(only(parse({ credit: '2.000' })).importKey);
  });

  it('identical-content legs get distinct keys via the occurrence index', () => {
    // the remaining leg of the partial close is content-identical to the plain open row below it
    const r = parse(
      { contracts: 3, closed_contracts: 1 },
      { contracts: 2, outcome: 'open', close_date: '', close_price: '', close_fees: '' },
    );
    expect(r.errors).toEqual([]);
    const remaining = r.legs[1] as JournalLeg;
    const plain = r.legs[2] as JournalLeg;
    expect([remaining.outcome, remaining.contracts, plain.outcome, plain.contracts]).toEqual(['open', 2, 'open', 2]);
    expect(remaining.importKey).not.toBe(plain.importKey);
  });
});

describe('totals', () => {
  it('one entry per market present, US before HK regardless of file order', () => {
    const r = parse({ ...HK_ROW }, { ...OPEN }, { credit: '3.00' });
    expect(r.totals.map((t) => t.market)).toEqual(['US', 'HK']);
    const us = r.totals[0];
    expect(us).toMatchObject({ legs: 2, open: 1, closed: 1, expired: 0, assigned: 0, rolled: 0, currencyNote: 'USD' });
    expect(us?.realizedPnlCents).toBe(
      r.legs.filter((l) => l.market === 'US').reduce((a, l) => a + (l.pnlCents ?? 0), 0),
    );
    expect(r.totals[1]).toMatchObject({ market: 'HK', currencyNote: 'HKD', legs: 1, closed: 1 });
  });

  it('only the markets present appear; open legs count as legs but add no P&L', () => {
    const r = parse({ ...OPEN });
    expect(r.totals).toHaveLength(1);
    expect(r.totals[0]).toMatchObject({ market: 'US', legs: 1, open: 1, realizedPnlCents: 0, realizedPnl: '0.00' });
  });

  it('formatTotals prints one readable line per market, negative P&L with a minus sign', () => {
    const r = parse({ ...HK_ROW, credit: '1.00', close_price: '4.00', open_fees: '', close_fees: '' });
    expect(formatTotals(r.totals)).toEqual([
      'HK (HKD): 1 legs (0 open, 1 closed, 0 expired, 0 assigned, 0 rolled); realised P&L -300.00 HKD',
    ]);
    expect(formatTotals([])).toEqual([]);
  });
});

describe('canonical symbols', () => {
  it('HK digits are left-padded to 4 whatever the spelling', () => {
    for (const raw of ['700', '0700', '00700', '0700.HK', '0700.hk', 'HK.00700', ' 700 ']) {
      expect(canonicalSymbol('HK', raw), raw).toBe('0700');
    }
    expect(canonicalSymbol('HK', '9988')).toBe('9988');
    expect(canonicalSymbol('HK', '5')).toBe('0005');
    expect(canonicalSymbol('HK', '80737')).toBe('80737');
    expect(canonicalSymbol('HK', 'TENCENT')).toBeNull();
    expect(canonicalSymbol('HK', '0')).toBeNull();
  });

  it('US symbols are upper-cased', () => {
    expect(canonicalSymbol('US', 'aapl')).toBe('AAPL');
    expect(canonicalSymbol('US', 'brk.b')).toBe('BRK.B');
    expect(canonicalSymbol('US', '$$')).toBeNull();
  });

  it('legs carry the canonical form', () => {
    expect(only(parse({ ...HK_ROW, symbol: '00700' })).symbol).toBe('0700');
    expect(only(parse({ symbol: 'aapl' })).symbol).toBe('AAPL');
    expect(only(parse({ ...HK_ROW, market: 'hk' })).market).toBe('HK');
  });
});
