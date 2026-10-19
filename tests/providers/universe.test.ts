import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { INDEX_MARKET, type IndexCode, type UniverseMember } from '../../src/db/universe';
import { parseBoardLotsCsv } from '../../src/providers/seed-files';
import { fetchUniverse } from '../../src/providers/universe';
import { parseHkexSecurities } from '../../src/providers/universe/hkex';
import {
  fetchHsci,
  fetchHsiIndex,
  HSCI_HISTORY_URL,
  hsiConstituentsUrl,
  parseHsiConstituents,
  replayHsciChanges,
} from '../../src/providers/universe/hsi';
import { formatUniverseSeed, parseUniverseSeed } from '../../src/providers/universe/seed';
import {
  fetchWikipediaIndex,
  parseConstituentTable,
  parseWikiApiResponse,
  parseWikiTables,
  wikiApiUrl,
  wikiPlain,
} from '../../src/providers/universe/wikipedia';
import { readXlsx } from '../../src/providers/universe/xlsx';
import { ProviderError } from '../../src/providers/yahoo/client';
import { UNIVERSE_FIXTURE_COUNTS, UNIVERSE_FIXTURES, universeReplay } from '../helpers/universe-replay';
import { buildXlsx } from '../helpers/xlsx-writer';

const replays: { cleanup(): void }[] = [];
const newReplay = (override?: Parameters<typeof universeReplay>[0]) => {
  const r = universeReplay(override);
  replays.push(r);
  return r;
};
afterAll(() => {
  for (const r of replays) r.cleanup();
});

const fixture = (name: string): Buffer => readFileSync(`${UNIVERSE_FIXTURES}/${name}`);
const byIndex = (members: UniverseMember[], code: IndexCode): UniverseMember[] =>
  members.filter((m) => m.indexCode === code);

describe('wikitext tables', () => {
  it('reads cells split by || and !!, strips the attribute prefix and keeps pipes inside links and templates', () => {
    const [t] = parseWikiTables(
      [
        '{| class="wikitable sortable" id="constituents"',
        '|-',
        '! style="x" | [[Ticker symbol|Symbol]] !! [[Public company|Security]]',
        '|-',
        '| style="border-color:inherit;" | {{NyseSymbol|AA}} || style="y" | [[Alcoa|Alcoa Corp]] || a | b',
        '|-',
        '|| {{NasdaqSymbol|AAL}}',
        '|| [[American Airlines Group]]',
        '|}',
      ].join('\n'),
    );
    expect(t?.attrs).toContain('constituents');
    expect(t?.rows.map((r) => r.header)).toEqual([true, false, false]);
    expect(t?.rows[0]?.cells.map(wikiPlain)).toEqual(['Symbol', 'Security']);
    expect(t?.rows[1]?.cells.map(wikiPlain)).toEqual(['AA', 'Alcoa Corp', 'b']);
    expect(t?.rows[2]?.cells.map(wikiPlain)).toEqual(['AAL', 'American Airlines Group']);
  });

  it('plain text drops refs, comments, templates other than ticker templates, links and markup', () => {
    expect(wikiPlain("[[3M]]<ref name=a>cite</ref><!-- note --> '''Co''' &amp; Sons&nbsp;(Class A)")).toBe(
      '3M Co & Sons (Class A)',
    );
    expect(wikiPlain('{{NyseSymbol|BRK.B}} <!-- DO NOT CHANGE THIS TICKER TO BRK-B -->')).toBe('BRK.B');
    expect(wikiPlain('{{BZX link|CBOE}}')).toBe('CBOE');
    expect(wikiPlain('{{Nasdaq|AAPL}}')).toBe('AAPL');
    expect(wikiPlain('{{cite web|url=http://x}} text')).toBe('text');
    expect(wikiPlain('[https://www.sec.gov/x reports]')).toBe('reports');
  });

  it('finds the symbol, name and sector columns by header text, whatever their order, and maps ICB industries to GICS names', () => {
    const rows = parseConstituentTable(
      [
        '{| class="wikitable"',
        '! Company !! ICB Industry !! Ticker',
        '|-',
        '| [[Arm Holdings]] || Technology || ARM',
        '|-',
        '| [[Berkshire Hathaway]] || Financials || BRK-B',
        '|-',
        '| not a ticker || Utilities || has space',
        '|-',
        '| [[Arm Holdings]] || Technology || ARM',
        '|}',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { symbol: 'ARM', name: 'Arm Holdings', sector: 'Information Technology' },
      { symbol: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financials' },
    ]);
  });

  it('an API error or a page without a constituent table is a ProviderError, not an empty list', () => {
    expect(() => parseWikiApiResponse('{"error":{"code":"missingtitle"}}', 'X')).toThrow(ProviderError);
    expect(() => parseWikiApiResponse('not json', 'X')).toThrow(ProviderError);
    expect(() =>
      parseWikiApiResponse(JSON.stringify({ parse: { wikitext: '{| class="wikitable"\n! A\n|-\n| 1\n|}' } }), 'X'),
    ).toThrow(/no constituent table/);
  });
});

describe('US constituents from the recorded Wikipedia pages', () => {
  const ranges = { SPX: [495, 510], NDX: [95, 105], MID: [395, 405] } as const;

  for (const code of ['SPX', 'NDX', 'MID'] as const) {
    it(`${code}: count in range, canonical symbols, no duplicates, names and sectors present`, async () => {
      const { members, via } = await fetchWikipediaIndex(newReplay().fetch, code);
      expect(via).toMatch(/^wikipedia:/);
      expect(members.length).toBeGreaterThanOrEqual(ranges[code][0]);
      expect(members.length).toBeLessThanOrEqual(ranges[code][1]);
      expect(members).toHaveLength(UNIVERSE_FIXTURE_COUNTS[code]);
      expect(new Set(members.map((m) => m.symbol)).size).toBe(members.length);
      for (const m of members) {
        expect(m.market).toBe('US');
        expect(m.indexCode).toBe(code);
        expect(m.symbol, m.symbol).toMatch(/^[A-Z][A-Z0-9]*(\.[A-Z])?$/);
        expect(m.name.length).toBeGreaterThan(0);
      }
      expect(members.filter((m) => m.sector).length).toBeGreaterThanOrEqual(members.length - 2);
    });
  }

  it('class shares keep a dot in the symbol and carry the provider spelling', async () => {
    const { members } = await fetchWikipediaIndex(newReplay().fetch, 'SPX');
    expect(members.find((m) => m.symbol === 'BRK.B')).toMatchObject({ name: 'Berkshire Hathaway', yahoo: 'BRK-B' });
    expect(members.find((m) => m.symbol === 'BF.B')?.yahoo).toBe('BF-B');
    expect(members.find((m) => m.symbol === 'AAPL')?.yahoo).toBeUndefined();
  });

  it('the Nasdaq-100 industries come out under GICS-style sector names', async () => {
    const { members } = await fetchWikipediaIndex(newReplay().fetch, 'NDX');
    const sectors = new Set(members.map((m) => m.sector));
    expect(sectors).toContain('Information Technology');
    expect(sectors).not.toContain('Technology');
    expect(sectors).not.toContain('Telecommunications');
  });

  it('a page whose count is out of range is rejected instead of shrinking the index', async () => {
    const r = newReplay((url) =>
      url === wikiApiUrl('List_of_S&P_400_companies')
        ? new Response(
            JSON.stringify({
              parse: { wikitext: `{| class="wikitable"\n! Symbol !! Security\n|-\n| ${'A'} || [[Alpha]]\n|}` },
            }),
          )
        : null,
    );
    await expect(fetchWikipediaIndex(r.fetch, 'MID')).rejects.toThrow(/expected 380-420/);
  });
});

describe('Hang Seng constituent lists', () => {
  it('HSI, HSCEI and HSTECH parse with four-digit symbols, names and the declared count', async () => {
    const r = newReplay();
    for (const code of ['HSI', 'HSCEI', 'HSTECH'] as const) {
      const { members, via, warnings } = await fetchHsiIndex(r.fetch, code);
      expect(members).toHaveLength(UNIVERSE_FIXTURE_COUNTS[code]);
      expect(via).toMatch(/hsi\.com\.hk/);
      expect(warnings).toEqual([]);
      expect(new Set(members.map((m) => m.symbol)).size).toBe(members.length);
      for (const m of members) {
        expect(m.symbol, m.symbol).toMatch(/^\d{4}$/);
        expect(m.market).toBe('HK');
        expect(m.name.length).toBeGreaterThan(0);
      }
    }
    const hstech = (await fetchHsiIndex(r.fetch, 'HSTECH')).members.map((m) => m.symbol);
    expect(hstech).toContain('0700');
    expect(hstech).toContain('9988');
  });

  it('HSI sub-index lists are flattened and de-duplicated (the site repeats every name in the parent list)', () => {
    const { rows, declared } = parseHsiConstituents(fixture('hsi.json').toString('utf8'), 'HSI');
    expect(declared).toBe(rows.length);
    expect(rows.find((r) => r.symbol === '0001')?.name).toBe('CKH HOLDINGS');
  });

  it('a response without a list (a logon-only series) is a format error', () => {
    const body = JSON.stringify({ data: { numOfConsList: [{ count: 581 }], viewConsDetail: null } });
    expect(() => parseHsiConstituents(body, 'HSCI')).toThrow(/no constituent list/);
  });

  it('warns when the list and the declared count disagree', async () => {
    const json = JSON.parse(fixture('hstech.json').toString('utf8'));
    json.data.numOfConsList[0].count = 31;
    const r = newReplay((url) => (url === hsiConstituentsUrl('hstech') ? new Response(JSON.stringify(json)) : null));
    const res = await fetchHsiIndex(r.fetch, 'HSTECH');
    expect(res.members).toHaveLength(30);
    expect(res.warnings[0]).toMatch(/declares 31/);
  });
});

describe('Hang Seng Composite from the public change log', () => {
  const sheets = readXlsx(fixture('hist-hsci.xlsx'));

  it('replays the HSCI sheet by name (not the industry sheets) up to the as-of date', () => {
    expect(sheets.length).toBeGreaterThan(1);
    const now = replayHsciChanges(sheets, '2026-10-13');
    expect(now.lastChange).toBe('2026-09-15');
    expect(now.declared).toBe(581);
    expect(now.members.size).toBe(473);
    expect(now.members.has('0625')).toBe(true); // SHEIN, added 2026-09-15
    // an as-of before the last review ignores it
    const before = replayHsciChanges(sheets, '2026-09-10');
    expect(before.lastChange).toBe('2026-09-07');
    expect(before.declared).toBe(580);
    expect(before.members.has('0625')).toBe(false);
    // Hang Seng Bank left the composite (and the HSI) in January 2026
    expect(now.members.has('0011')).toBe(false);
  });

  it('applies deletions before additions on one date, so a reused stock code ends up in', () => {
    const header = [
      'Effective Date',
      'No. of Constituents',
      'Change',
      'Count',
      'Stock Code',
      'Listing Place',
      'Stock Name',
    ];
    const rows = [
      ['Constituent Changes'],
      header,
      ['2026-01-05', '1.0', 'Add', '+1', '1234', 'Hong Kong', 'NEW CO'],
      ['2026-01-05', '1.0', 'Delete', '-1', '1234', 'Hong Kong', 'OLD CO'],
      ['2025-01-05', '1.0', 'Add', '+1', '1234', 'Hong Kong', 'OLD CO'],
      ['2025-01-05', '1.0', 'Add', '+1', '5', 'Hong Kong', 'HSBC'],
    ];
    const wb = readXlsx(buildXlsx([{ name: 'HSCI', rows }]));
    expect([...replayHsciChanges(wb, '2026-02-01').members]).toEqual([
      ['0005', 'HSBC'],
      ['1234', 'NEW CO'],
    ]);
  });

  it('adds the HSI/HSCEI/HSTECH members the log does not mention and reports exactly what is still missing', async () => {
    const r = newReplay();
    const known = new Map<string, string>();
    for (const code of ['HSI', 'HSCEI', 'HSTECH'] as const)
      for (const m of (await fetchHsiIndex(r.fetch, code)).members) known.set(m.symbol, m.name);
    const hsci = await fetchHsci(r.fetch, { asOf: '2026-10-13', known });
    expect(hsci.members).toHaveLength(UNIVERSE_FIXTURE_COUNTS.HSCI);
    expect(new Set(hsci.members.map((m) => m.symbol)).size).toBe(hsci.members.length);
    for (const code of known.keys()) expect(hsci.members.some((m) => m.symbol === code)).toBe(true);
    expect(hsci.warnings).toHaveLength(1);
    expect(hsci.warnings[0]).toMatch(/519 of the 581 constituents/);
    expect(hsci.warnings[0]).toMatch(/62 unchanged-since-2008 members are missing/);
  });

  it('a log that replays to a nonsense count is rejected', async () => {
    const tiny = buildXlsx([
      {
        name: 'HSCI',
        rows: [
          ['Effective Date', 'No. of Constituents', 'Change', 'Count', 'Stock Code'],
          ['2026-01-05', '1.0', 'Add', '+1', '1'],
        ],
      },
    ]);
    const r = newReplay((url) => (url === HSCI_HISTORY_URL ? new Response(tiny) : null));
    await expect(fetchHsci(r.fetch, { asOf: '2026-10-13', known: new Map() })).rejects.toThrow(/expected 400-700/);
  });
});

describe('HKEX stock board lots', () => {
  const securities = parseHkexSecurities(fixture('hkex-securities.xlsx'));

  it('reads the stock board lot (shares per trading lot) and the exchange name by canonical symbol', () => {
    expect(securities.get('0700')).toMatchObject({ lot: 100, name: 'TENCENT' });
    expect(securities.get('0005')?.lot).toBe(400);
    expect(securities.get('0001')?.lot).toBe(500);
    expect(securities.get('0003')?.lot).toBe(1000); // "1,000" in the sheet
    expect(securities.get('9988')?.lot).toBe(100);
  });

  it('is not the option contract size: Alibaba, Xiaomi and SMIC differ from data/hk-board-lots.csv', () => {
    const contract = parseBoardLotsCsv(readFileSync('data/hk-board-lots.csv', 'utf8'));
    expect(contract.get('9988')).toBe(500);
    expect(securities.get('9988')?.lot).toBe(100);
    const differ = ['0700', '0005', '9988', '1810', '0981', '3690'].filter(
      (s) => securities.get(s)?.lot !== contract.get(s),
    );
    expect(differ).toEqual(expect.arrayContaining(['9988', '3690']));
    expect(differ).not.toContain('0700');
    expect(differ).not.toContain('0005');
  });

  it('rows that are not securities with a lot (headers, footnotes, blank lots) are skipped', () => {
    expect(securities.has('Stock Code')).toBe(false);
    for (const s of securities.values()) expect(s.lot).toBeGreaterThan(0);
    expect(securities.size).toBeGreaterThan(500);
  });

  it('a workbook without the header row is a format error', () => {
    const wb = buildXlsx([{ name: 'S', rows: [['hello']] }], 'prefixed');
    expect(() => parseHkexSecurities(wb)).toThrow(/Stock Code/);
  });
});

describe('fetchUniverse', () => {
  it('returns every index of both markets with the stock lot on each HK member', async () => {
    const r = newReplay();
    const res = await fetchUniverse(r.fetch, { asOf: '2026-10-13' });
    expect(res.sources.map((s) => [s.indexCode, s.ok, s.count])).toEqual([
      ['SPX', true, 503],
      ['NDX', true, 101],
      ['MID', true, 400],
      ['HSI', true, 95],
      ['HSCEI', true, 50],
      ['HSTECH', true, 30],
      ['HSCI', true, 519],
    ]);
    for (const code of Object.keys(UNIVERSE_FIXTURE_COUNTS) as IndexCode[]) {
      const rows = byIndex(res.members, code);
      expect(new Set(rows.map((m) => m.symbol)).size, code).toBe(rows.length);
      for (const m of rows) expect(m.market).toBe(INDEX_MARKET[code]);
    }
    const hk = res.members.filter((m) => m.market === 'HK');
    expect(res.lots).toMatchObject({ ok: true, found: 517, assumed: 2 });
    const noLot = [...new Set(hk.filter((m) => !m.stockLot).map((m) => m.symbol))].sort();
    expect(noLot).toEqual(['2910', '2911']);
    expect(hk.find((m) => m.symbol === '0700')).toMatchObject({ stockLot: 100, name: 'TENCENT' });
    expect(new Set(res.members.map((m) => `${m.market}:${m.symbol}`)).size).toBeGreaterThan(1400);
    expect(res.members.filter((m) => m.market === 'US').every((m) => m.stockLot === undefined)).toBe(true);
  });

  it('one failing source is reported and the others still return', async () => {
    const r = newReplay((url) =>
      url === wikiApiUrl('List_of_NASDAQ-100_companies') || url === wikiApiUrl('Nasdaq-100')
        ? new Response('oops', { status: 500 })
        : null,
    );
    const res = await fetchUniverse(r.fetch, { asOf: '2026-10-13', markets: ['US'] });
    const ndx = res.sources.find((s) => s.indexCode === 'NDX');
    expect(ndx).toMatchObject({ ok: false, count: 0 });
    expect(ndx?.error).toMatch(/HTTP 500|expected|wikipedia/);
    expect(res.sources.filter((s) => s.ok).map((s) => s.indexCode)).toEqual(['SPX', 'MID']);
    expect(byIndex(res.members, 'NDX')).toEqual([]);
    expect(res.sources).toHaveLength(3); // HK was not requested
  });

  it('without the HKEX workbook the HK lists still come back, with the failure in `lots`', async () => {
    const r = newReplay((url) => (url.includes('ListOfSecurities') ? new Response('', { status: 503 }) : null));
    const res = await fetchUniverse(r.fetch, { asOf: '2026-10-13', markets: ['HK'] });
    expect(res.lots.ok).toBe(false);
    expect(res.lots.error).toMatch(/503/);
    expect(res.lots.assumed).toBe(519);
    expect(res.members.every((m) => m.stockLot === undefined)).toBe(true);
    expect(res.sources.every((s) => s.ok)).toBe(true);
  });

  it('a network that is down fails every source softly', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await fetchUniverse(down, { asOf: '2026-10-13' });
    expect(res.members).toEqual([]);
    expect(res.sources.every((s) => !s.ok && /fetch failed/.test(s.error ?? ''))).toBe(true);
  });
});

describe('seed CSV', () => {
  const members: UniverseMember[] = [
    {
      market: 'US',
      symbol: 'BRK.B',
      name: 'Berkshire Hathaway',
      sector: 'Financials',
      indexCode: 'SPX',
      yahoo: 'BRK-B',
    },
    { market: 'US', symbol: 'TPR', name: 'Tapestry, Inc. "Coach"', sector: null, indexCode: 'MID' },
    { market: 'HK', symbol: '0700', name: 'TENCENT', sector: null, indexCode: 'HSI', stockLot: 100 },
    { market: 'HK', symbol: '2910', name: 'ZHIDA TECH', sector: null, indexCode: 'HSCI' },
  ];

  it('round-trips quoting, class-share spellings and the HK lot', () => {
    const text = formatUniverseSeed(members, 'a comment\nsecond line');
    expect(text.startsWith('# a comment\n# second line\nindex_code,symbol,name,sector,yahoo,stock_lot\n')).toBe(true);
    expect(parseUniverseSeed(text)).toEqual([members[0], members[1], members[2], members[3]]);
  });

  it('skips comments, the header, unknown index codes, invalid symbols and repeated rows', () => {
    const text = [
      '# comment',
      'index_code,symbol,name,sector,yahoo,stock_lot',
      'SPX,AAPL,Apple,Information Technology,,',
      'SPX,AAPL,Apple again,,,',
      'XYZ,FOO,Foo,,,',
      'SPX,not a symbol,Bad,,,',
      'HSI,700,Tencent,,,100',
      'HSI,abc,Bad HK,,,100',
      '',
    ].join('\r\n');
    expect(parseUniverseSeed(text).map((m) => `${m.indexCode}:${m.symbol}:${m.stockLot ?? '-'}`)).toEqual([
      'SPX:AAPL:-',
      'HSI:0700:100',
    ]);
  });

  it('the committed seeds parse to sane counts per index and carry HK stock lots', () => {
    const us = parseUniverseSeed(readFileSync('data/universe-us.csv', 'utf8'));
    const hk = parseUniverseSeed(readFileSync('data/universe-hk.csv', 'utf8'));
    const count = (rows: UniverseMember[], code: IndexCode): number => byIndex(rows, code).length;
    expect(count(us, 'SPX')).toBeGreaterThanOrEqual(495);
    expect(count(us, 'SPX')).toBeLessThanOrEqual(510);
    expect(count(us, 'NDX')).toBeGreaterThanOrEqual(95);
    expect(count(us, 'MID')).toBeGreaterThanOrEqual(395);
    expect(count(us, 'HSI')).toBe(0);
    expect(count(hk, 'HSI')).toBeGreaterThanOrEqual(60);
    expect(count(hk, 'HSCEI')).toBeGreaterThanOrEqual(40);
    expect(count(hk, 'HSTECH')).toBeGreaterThanOrEqual(25);
    expect(count(hk, 'HSCI')).toBeGreaterThanOrEqual(400);
    expect(count(hk, 'SPX')).toBe(0);
    expect(hk.filter((m) => m.stockLot).length).toBeGreaterThan(hk.length - 10);
    expect(us.every((m) => m.stockLot === undefined)).toBe(true);
    expect(us.find((m) => m.symbol === 'BRK.B')?.yahoo).toBe('BRK-B');
  });
});

describe('xlsx reader', () => {
  it('reads Excel-style (shared strings) and prefixed (inline str) workbooks, sparse cells and entities', () => {
    const rows = [['a', '', 'c'], ['', 'b & <c>'], ['x'.repeat(5)]];
    for (const style of ['shared', 'prefixed'] as const) {
      const sheets = readXlsx(
        buildXlsx(
          [
            { name: 'S & T', rows },
            { name: 'Two', rows: [['2']] },
          ],
          style,
        ),
      );
      expect(sheets.map((s) => s.name)).toEqual(['S & T', 'Two']);
      expect(sheets[0]?.rows).toEqual([['a', '', 'c'], ['', 'b & <c>'], ['xxxxx']]);
      expect(sheets[1]?.rows).toEqual([['2']]);
    }
  });

  it('rejects data that is not a zip or not a workbook', () => {
    expect(() => readXlsx(Buffer.from('plainly not a zip archive at all'))).toThrow(/not a zip/);
    expect(() => readXlsx(buildXlsx([]).subarray(0, 10))).toThrow();
  });
});
