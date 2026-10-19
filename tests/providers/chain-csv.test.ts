import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ChainCsvOptions, chainToSnapshot, formatViolations, parseChainCsv } from '../../src/providers/csv/chain';
import { readCsv } from '../../src/providers/csv/read';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/chains/${name}`, import.meta.url), 'utf8');

const HK: ChainCsvOptions = { market: 'HK', symbol: '0700', spot: 420, date: '2026-10-09', multiplier: 100 };
const US: ChainCsvOptions = { market: 'US', symbol: 'AAPL', spot: 336, date: '2026-10-09', multiplier: 100 };

const HDR = 'expiry,strike,right,bid,ask,last,volume,oi';
/** Header on physical line 1, first data row on line 2. */
const csv = (...rows: string[]): string => [HDR, ...rows].join('\n');
const codes = (vs: { code: string }[]): string[] => vs.map((v) => v.code);

describe('fixtures', () => {
  it('us-valid.csv is accepted with no violations', () => {
    const r = parseChainCsv(fixture('us-valid.csv'), US);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rows.length).toBe(77);
    expect(r.rows.some((x) => x.iv === null && x.delta === null)).toBe(true);
    expect(r.rows.every((x) => (x.right === 'P' ? (x.delta ?? -1) <= 0 : (x.delta ?? 1) >= 0))).toBe(true);
  });

  it('hk-valid.csv is accepted: only monthly HK expiries, no warnings', () => {
    const r = parseChainCsv(fixture('hk-valid.csv'), HK);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect([...new Set(r.rows.map((x) => x.expiry))]).toEqual(['2026-10-29', '2026-11-27', '2026-12-30']);
  });

  it('hk-crossed.csv is rejected with chain.crossed on its physical line', () => {
    const r = parseChainCsv(fixture('hk-crossed.csv'), HK);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.code).toBe('chain.crossed');
    expect(r.errors[0]?.line).toBe(12);
    expect(r.errors[0]?.message).toBe('line 12: chain.crossed bid 5.06 > ask 4.86');
  });

  it('hk-illiquid.csv is accepted with chain.illiquid warnings that say which condition', () => {
    const r = parseChainCsv(fixture('hk-illiquid.csv'), HK);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(14);
    expect(r.warnings.map((w) => [w.line, w.code])).toEqual([
      [3, 'chain.illiquid'],
      [6, 'chain.illiquid'],
      [9, 'chain.illiquid'],
      [12, 'chain.illiquid'],
    ]);
    expect(r.warnings[0]?.message).toMatch(/^line 3: chain\.illiquid bid is 0\b/);
    expect(r.warnings[1]?.message).toMatch(/^line 6: chain\.illiquid open interest is 0\b/);
    expect(r.warnings[2]?.message).toMatch(/^line 9: chain\.illiquid bid is 0 and open interest is 0\b/);
  });
});

describe('rule: chain.crossed', () => {
  it('rejects bid > ask and reports the physical line', () => {
    const r = parseChainCsv(
      csv('2026-10-29,420,P,12.00,12.20,12.1,5,100', '2026-10-29,400,P,1.20,1.10,1.15,5,100'),
      HK,
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.crossed' });
    expect(r.errors[0]?.message).toBe('line 3: chain.crossed bid 1.20 > ask 1.10');
  });

  it('accepts a locked market (bid = ask)', () => {
    const r = parseChainCsv(csv('2026-10-29,420,P,12.00,12.00,12,5,100'), HK);
    expect(r.ok).toBe(true);
  });
});

describe('rule: chain.duplicate', () => {
  it('rejects the second occurrence of (expiry, strike, right) and mentions the first line', () => {
    const r = parseChainCsv(
      csv(
        '2026-10-29,420,P,12.00,12.20,12.1,5,100',
        '2026-10-29,400,P,5.00,5.20,5.1,5,100',
        '2026-10-29,420.0,P,12.10,12.30,12.2,5,100',
      ),
      HK,
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 4, code: 'chain.duplicate' });
    expect(r.errors[0]?.message).toMatch(/^line 4: chain\.duplicate .*line 2/);
  });

  it('treats put and call at the same strike as different contracts', () => {
    const r = parseChainCsv(
      csv('2026-10-29,420,P,12.00,12.20,12.1,5,100', '2026-10-29,420,C,13.00,13.20,13.1,5,100'),
      HK,
    );
    expect(r.ok).toBe(true);
  });

  it('reports every later occurrence', () => {
    const row = '2026-10-29,420,P,12.00,12.20,12.1,5,100';
    const r = parseChainCsv(csv(row, row, row), HK);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(codes(r.errors)).toEqual(['chain.duplicate', 'chain.duplicate']);
  });
});

describe('rule: chain.badExpiry', () => {
  it('HK rejects a weekly / non-monthly expiry', () => {
    const r = parseChainCsv(csv('2026-10-16,420,P,12.00,12.20,12.1,5,100'), HK);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'chain.badExpiry' });
    expect(r.errors[0]?.message).toContain('2026-10-29');
  });

  it('HK accepts the business day before the last business day of the month', () => {
    expect(parseChainCsv(csv('2026-10-29,420,P,12.00,12.20,12.1,5,100'), HK).ok).toBe(true);
    expect(parseChainCsv(csv('2026-10-30,420,P,12.00,12.20,12.1,5,100'), HK).ok).toBe(false);
  });

  it('US accepts Fridays and the Thursday before a Friday holiday, rejects other days', () => {
    const asOf = { ...US, date: '2026-06-30' };
    expect(parseChainCsv(csv('2026-07-02,336,P,5.00,5.20,5.1,5,100'), asOf).ok).toBe(true);
    const wed = parseChainCsv(csv('2026-07-08,336,P,5.00,5.20,5.1,5,100'), asOf);
    expect(wed.ok).toBe(false);
    expect(wed.errors[0]).toMatchObject({ line: 2, code: 'chain.badExpiry' });
    const holidayFriday = parseChainCsv(csv('2026-07-03,336,P,5.00,5.20,5.1,5,100'), asOf);
    expect(holidayFriday.errors[0]).toMatchObject({ line: 2, code: 'chain.badExpiry' });
  });

  it('rejects an expiry before the snapshot date even when it is a valid expiry day', () => {
    const r = parseChainCsv(csv('2026-10-02,336,P,5.00,5.20,5.1,5,100'), US);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'chain.badExpiry' });
    expect(r.errors[0]?.message).toContain('before the snapshot date 2026-10-09');
  });

  it('reports a date outside the calendar tables as badExpiry instead of throwing', () => {
    const r = parseChainCsv(csv('2031-10-31,336,P,5.00,5.20,5.1,5,100'), US);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'chain.badExpiry' });
    expect(r.errors[0]?.message).toContain('calendar tables');
  });
});

describe('rule: chain.strikeRange', () => {
  it('accepts the 40% and 160% bounds inclusively', () => {
    const r = parseChainCsv(csv('2026-11-27,168,P,0.50,0.60,0.5,5,100', '2026-11-27,672,C,0.50,0.60,0.5,5,100'), HK);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a strike below 40% of spot', () => {
    const r = parseChainCsv(csv('2026-11-27,167.9,P,0.50,0.60,0.5,5,100'), HK);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'chain.strikeRange' });
    expect(r.ok).toBe(false);
  });

  it('rejects a strike above 160% of spot', () => {
    const r = parseChainCsv(csv('2026-11-27,420,P,5.00,5.20,5.1,5,100', '2026-11-27,672.1,C,0.50,0.60,0.5,5,100'), HK);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.strikeRange' });
  });
});

describe('rule: chain.badNumber', () => {
  const bad = (row: string, opts = HK) => parseChainCsv(csv('2026-10-29,420,P,12.00,12.20,12.1,5,100', row), opts);

  it('rejects a negative bid', () => {
    const r = bad('2026-10-29,400,P,-1,5.20,5.1,5,100');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(r.errors[0]?.message).toContain('bid');
  });

  it('rejects a non-numeric ask and a blank required price', () => {
    const r = bad('2026-10-29,400,P,5.00,abc,5.1,5,100');
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(r.errors[0]?.message).toContain('ask');
    const blank = bad('2026-10-29,400,P,,5.2,5.1,5,100');
    expect(blank.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(blank.errors[0]?.message).toContain('bid is required');
  });

  it('rejects negative or non-numeric volume and oi', () => {
    const vol = bad('2026-10-29,400,P,5.00,5.20,5.1,-5,100');
    expect(vol.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(vol.errors[0]?.message).toContain('volume');
    const oi = bad('2026-10-29,400,P,5.00,5.20,5.1,5,many');
    expect(oi.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(oi.errors[0]?.message).toContain('oi');
    const last = bad('2026-10-29,400,P,5.00,5.20,x,5,100');
    expect(last.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
  });

  it('rejects a non-positive or non-numeric strike', () => {
    expect(bad('2026-10-29,0,P,5.00,5.20,5.1,5,100').errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(bad('2026-10-29,-400,P,5.00,5.20,5.1,5,100').errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(bad('2026-10-29,four hundred,P,5.00,5.20,5.1,5,100').errors[0]).toMatchObject({
      line: 3,
      code: 'chain.badNumber',
    });
  });

  it('rejects thousands separators', () => {
    const r = bad('2026-10-29,400,P,"1,234.50","1,240.00",5.1,5,100');
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(r.errors[0]?.message).toContain('thousands separators');
  });

  it('rejects bad date text', () => {
    const r = bad('29/10/2026,400,P,5.00,5.20,5.1,5,100');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.badNumber' });
    expect(r.errors[0]?.message).toContain('expiry');
  });

  it('rejects iv outside (0, 5] after unit normalisation, mentioning units', () => {
    const header = `${HDR},iv`;
    for (const iv of ['0', '600%', '-0.3', '501', 'abc']) {
      const r = parseChainCsv([header, `2026-10-29,420,P,12.00,12.20,12.1,5,100,${iv}`].join('\n'), HK);
      expect(r.ok, iv).toBe(false);
      expect(r.errors[0], iv).toMatchObject({ line: 2, code: 'chain.badNumber' });
      expect(r.errors[0]?.message, iv).toContain('units');
    }
  });

  it('rejects delta outside [-1, 1]', () => {
    const header = `${HDR},delta`;
    const r = parseChainCsv([header, '2026-10-29,420,P,12.00,12.20,12.1,5,100,-25'].join('\n'), HK);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'chain.badNumber' });
    expect(r.errors[0]?.message).toContain('delta');
    const ok = parseChainCsv([header, '2026-10-29,420,P,12.00,12.20,12.1,5,100,-1'].join('\n'), HK);
    expect(ok.ok).toBe(true);
  });

  it('rejects an unknown option right with chain.badRight', () => {
    const r = bad('2026-10-29,400,X,5.00,5.20,5.1,5,100');
    expect(r.errors[0]).toMatchObject({ line: 3, code: 'chain.badRight' });
  });
});

describe('rule: chain.illiquid (warning, row kept)', () => {
  it('bid = 0 warns and keeps the row', () => {
    const r = parseChainCsv(csv('2026-10-29,300,P,0,0.05,0.05,0,100'), HK);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ line: 2, code: 'chain.illiquid' });
    expect(r.warnings[0]?.message).toContain('bid is 0');
    expect(r.warnings[0]?.message).not.toContain('open interest');
  });

  it('oi = 0 warns and keeps the row', () => {
    const r = parseChainCsv(csv('2026-10-29,420,P,12.00,12.20,12.1,5,0'), HK);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ line: 2, code: 'chain.illiquid' });
    expect(r.warnings[0]?.message).toContain('open interest is 0');
  });

  it('bid = 0 and oi = 0 gives one warning naming both', () => {
    const r = parseChainCsv(csv('2026-10-29,300,P,0,0.05,,,0'), HK);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.message).toContain('bid is 0 and open interest is 0');
  });

  it('a blank oi is unknown, not zero: no warning', () => {
    const r = parseChainCsv(csv('2026-10-29,420,P,12.00,12.20,12.1,5,'), HK);
    expect(r.warnings).toEqual([]);
    expect(r.rows[0]?.openInterest).toBeNull();
  });

  it('warnings never reject, even next to an error elsewhere they stay warnings', () => {
    const r = parseChainCsv(csv('2026-10-29,300,P,0,0.05,0.05,0,0', '2026-10-29,420,P,13,12,12,0,5'), HK);
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toEqual(['chain.crossed']);
    expect(codes(r.warnings)).toEqual(['chain.illiquid']);
  });
});

describe('missing iv / delta', () => {
  it('no iv or delta columns: rows kept with null iv and delta, no violations', () => {
    const r = parseChainCsv(csv('2026-10-29,420,P,12.00,12.20,12.1,5,100'), HK);
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ iv: null, delta: null });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('blank and "-" cells in optional columns are null', () => {
    const r = parseChainCsv(`${HDR},iv,delta\n2026-10-29,420,P,12.00,12.20,-,-,,-,`, HK);
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ last: null, volume: null, openInterest: null, iv: null, delta: null });
  });
});

describe('file-level errors', () => {
  it('chain.header when a required column is missing', () => {
    const r = parseChainCsv('expiry,strike,right,bid,ask,last,volume\n2026-10-29,420,P,1,2,1,1', HK);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 0, code: 'chain.header' });
    expect(r.errors[0]?.message).toContain('oi');
  });

  it('chain.empty for a header-only file and for an empty file', () => {
    const headerOnly = parseChainCsv(`${HDR}\n`, HK);
    expect(headerOnly.ok).toBe(false);
    expect(headerOnly.errors[0]).toMatchObject({ line: 0, code: 'chain.empty' });
    const empty = parseChainCsv('', HK);
    expect(empty.errors[0]).toMatchObject({ line: 0, code: 'chain.empty' });
    const commentsOnly = parseChainCsv('# nothing here\n\n', HK);
    expect(commentsOnly.errors[0]).toMatchObject({ line: 0, code: 'chain.empty' });
  });

  it('chain.options for a non-positive spot, an invalid date or a bad multiplier', () => {
    const body = csv('2026-10-29,420,P,12.00,12.20,12.1,5,100');
    for (const bad of [{ spot: 0 }, { spot: -1 }, { date: '2026-13-01' }, { date: 'today' }, { multiplier: 0 }]) {
      const r = parseChainCsv(body, { ...HK, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.errors[0], JSON.stringify(bad)).toMatchObject({ line: 0, code: 'chain.options' });
    }
  });

  it('chain.unknownColumn is a warning at the header line and the column is ignored', () => {
    const r = parseChainCsv(`# comment\n${HDR},gamma\n2026-10-29,420,P,12.00,12.20,12.1,5,100,0.01`, HK);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ line: 2, code: 'chain.unknownColumn' });
    expect(r.rows).toHaveLength(1);
  });
});

describe('collecting every violation in one pass', () => {
  it('reports all errors and warnings, ordered by line, and rejects the file', () => {
    const r = parseChainCsv(
      csv(
        '2026-10-29,420,P,12.00,12.20,12.1,5,100', // 2 ok
        '2026-10-29,400,P,5.20,5.00,5.1,5,100', // 3 crossed
        '2026-10-29,420,P,12.00,12.20,12.1,5,100', // 4 duplicate of line 2
        '2026-10-16,380,P,3.00,3.20,3.1,5,100', // 5 badExpiry
        '2026-11-27,100,P,0.10,0.20,0.1,5,100', // 6 strikeRange
        '2026-11-27,380,P,abc,3.20,3.1,5,100', // 7 badNumber
        '2026-11-27,390,P,0,0.2,0.1,5,100', // 8 illiquid warning
        '2026-10-16,50,P,9.00,8.00,1,5,100', // 9 badExpiry + strikeRange + crossed
      ),
      HK,
    );
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'chain.crossed'],
      [4, 'chain.duplicate'],
      [5, 'chain.badExpiry'],
      [6, 'chain.strikeRange'],
      [7, 'chain.badNumber'],
      [9, 'chain.badExpiry'],
      [9, 'chain.strikeRange'],
      [9, 'chain.crossed'],
    ]);
    expect(r.warnings.map((w) => [w.line, w.code])).toEqual([[8, 'chain.illiquid']]);
    for (const e of r.errors) expect(e.message).toMatch(new RegExp(`^line ${e.line}: ${e.code.replace('.', '\\.')} `));
  });

  it('formatViolations returns the messages, file-level first then by line', () => {
    const r = parseChainCsv(csv('2026-10-29,400,P,5.20,5.00,5.1,5,100', '2026-10-16,380,P,3.00,3.20,3.1,5,100'), HK);
    const lines = formatViolations([...r.errors].reverse());
    expect(lines).toEqual(r.errors.map((e) => e.message));
    expect(lines[0]).toMatch(/^line 2: chain\.crossed bid 5\.20 > ask 5\.00$/);
    expect(
      formatViolations([
        { line: 5, code: 'x.b', message: 'line 5: x.b' },
        { line: 0, code: 'x.a', message: 'file: x.a' },
      ]),
    ).toEqual(['file: x.a', 'line 5: x.b']);
  });
});

describe('header, units and sign handling', () => {
  const withCols = (cols: string, ...rows: string[]) => parseChainCsv([`${HDR},${cols}`, ...rows].join('\n'), HK);

  it('reads iv written as a fraction, as 32.5% or as a bare 32.5 (above 3 means percent)', () => {
    const r = withCols(
      'iv',
      '2026-10-29,420,P,12.00,12.20,12.1,5,100,0.325',
      '2026-10-29,400,P,5.00,5.20,5.1,5,100,32.5%',
      '2026-10-29,380,P,3.00,3.20,3.1,5,100,32.5',
      '2026-10-29,360,P,2.00,2.20,2.1,5,100,28.7',
      '2026-10-29,440,C,5.00,5.20,5.1,5,100,3',
      '2026-10-29,460,C,2.00,2.20,2.1,5,100,3.5',
      '2026-10-29,480,C,1.00,1.20,1.1,5,100,0.5%',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.iv)).toEqual([0.325, 0.325, 0.325, 0.287, 3, 0.035, 0.005]);
  });

  it('puts store delta negative and calls positive whatever sign was typed', () => {
    const r = withCols(
      'delta',
      '2026-10-29,420,P,12.00,12.20,12.1,5,100,0.25',
      '2026-10-29,400,P,5.00,5.20,5.1,5,100,-0.25',
      '2026-10-29,440,C,5.00,5.20,5.1,5,100,-0.3',
      '2026-10-29,460,C,2.00,2.20,2.1,5,100,0.3',
      '2026-10-29,300,P,0.50,0.60,0.5,5,100,0',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.delta)).toEqual([-0.25, -0.25, 0.3, 0.3, 0]);
    expect(Object.is(r.rows[4]?.delta, 0)).toBe(true);
  });

  it('column order is free, names are case-insensitive, right accepts P/C/PUT/CALL in any case', () => {
    const text = [
      'OI,Volume,Last,Ask,Bid,Right,Strike,Expiry',
      '100,5,12.1,12.20,12.00,put,420,2026-10-29',
      '100,5,13.1,13.20,13.00,CALL,420,2026-10-29',
      '100,5,5.1,5.20,5.00,c,440,2026-10-29',
      '100,5,5.1,5.20,5.00,Put,400,2026-10-29',
    ].join('\n');
    const r = parseChainCsv(text, HK);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.right)).toEqual(['P', 'C', 'C', 'P']);
    expect(r.rows[0]).toMatchObject({
      expiry: '2026-10-29',
      strike: 420,
      bid: 12,
      ask: 12.2,
      last: 12.1,
      volume: 5,
      openInterest: 100,
    });
  });

  it('accepts quoted cells and trims spaces', () => {
    const r = parseChainCsv(csv('"2026-10-29", 420 ,"P", 12.00 ,12.20,12.1,5,100 '), HK);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ expiry: '2026-10-29', strike: 420, right: 'P', bid: 12 });
  });
});

describe('BOM, CRLF and physical line numbers', () => {
  it('parses a BOM + CRLF file; comments and blank lines still count towards line numbers', () => {
    const text = `﻿# AAPL spot 336 "quoted" it's a comment\r\n${HDR}\r\n\r\n2026-10-30,336,P,5.00,5.20,5.1,5,100\r\n# mid-file comment\r\n2026-10-30,330,P,4.00,3.90,4.1,5,100\r\n`;
    const r = parseChainCsv(text, US);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 6, code: 'chain.crossed' });
  });

  it('a clean BOM + CRLF file parses fully', () => {
    const r = parseChainCsv(
      `﻿${HDR}\r\n2026-10-30,336,P,5.00,5.20,5.1,5,100\r\n2026-10-30,336,C,6.00,6.20,6.1,5,100\r\n`,
      US,
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.line)).toEqual([2, 3]);
  });

  it('readCsv counts physical lines across quoted multi-line cells', () => {
    const r = readCsv('a,b\n"x\ny",1\n\n3,4\n');
    expect(r.rows.map((x) => x.line)).toEqual([2, 5]);
    expect(r.rows[0]?.cells).toEqual({ a: 'x\ny', b: '1' });
  });

  it('readCsv reports an unterminated quote and surplus cells', () => {
    expect(readCsv('a,b\n"x,1\n').errors[0]).toMatchObject({ line: 2, code: 'csv.unterminatedQuote' });
    expect(readCsv('a,b\n1,2,3\n').errors[0]).toMatchObject({ line: 2, code: 'csv.columnCount' });
    expect(readCsv('a,A\n1,2\n').errors[0]).toMatchObject({ line: 1, code: 'csv.duplicateColumn' });
  });
});

describe('chainToSnapshot', () => {
  it('builds a real-tier csv snapshot with the option multiplier and file order', () => {
    const r = parseChainCsv(
      `${HDR},iv,delta\n2026-10-29,420,P,12.00,12.20,12.1,5,100,32.5%,0.45\n2026-10-29,440,C,5.00,5.20,,,,,`,
      HK,
    );
    const snap = chainToSnapshot(r.rows, { ...HK, multiplier: 400 });
    expect(snap).toEqual({
      snapshotDate: '2026-10-09',
      underlyingPrice: 420,
      source: 'csv',
      tier: 'real',
      quotes: [
        {
          expiry: '2026-10-29',
          strike: 420,
          right: 'P',
          bid: 12,
          ask: 12.2,
          last: 12.1,
          volume: 5,
          openInterest: 100,
          iv: 0.325,
          delta: -0.45,
          gamma: null,
          theta: null,
          vega: null,
          multiplier: 400,
        },
        {
          expiry: '2026-10-29',
          strike: 440,
          right: 'C',
          bid: 5,
          ask: 5.2,
          last: null,
          volume: null,
          openInterest: null,
          iv: null,
          delta: null,
          gamma: null,
          theta: null,
          vega: null,
          multiplier: 400,
        },
      ],
    });
  });

  it('works end to end on a fixture file', () => {
    const r = parseChainCsv(fixture('hk-valid.csv'), HK);
    const snap = chainToSnapshot(r.rows, HK);
    expect(snap.quotes).toHaveLength(r.rows.length);
    expect(snap.quotes.every((q) => q.multiplier === 100)).toBe(true);
  });
});
