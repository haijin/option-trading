/**
 * Regenerates data/universe-us.csv and data/universe-hk.csv from the live sources (the fallback when a source changes
 * shape, and the way a fresh database gets a universe offline). With `--fixtures` it also records the trimmed responses
 * the universe tests replay into tests/fixtures/universe/ (network needed; CI never runs this).
 *
 *   pnpm tsx scripts/gen-universe-seed.ts [--fixtures]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toISO } from '../src/core/dates';
import type { IndexCode, UniverseMember } from '../src/db/universe';
import { fetchUniverse } from '../src/providers/universe';
import { HKEX_SECURITIES_URL } from '../src/providers/universe/hkex';
import { HSCI_HISTORY_URL, hsiConstituentsUrl } from '../src/providers/universe/hsi';
import { formatUniverseSeed, SEED_FILES } from '../src/providers/universe/seed';
import { WIKI_PAGES, wikiApiUrl } from '../src/providers/universe/wikipedia';
import { readXlsx } from '../src/providers/universe/xlsx';
import { buildXlsx } from '../tests/helpers/xlsx-writer';

const DATA_DIR = 'data';
const FIXTURE_DIR = join('tests', 'fixtures', 'universe');

async function main(): Promise<void> {
  const today = toISO(new Date());
  const captured = new Map<string, Buffer>();
  const recording: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (res.ok) captured.set(url, Buffer.from(await res.clone().arrayBuffer()));
    return res;
  };
  const r = await fetchUniverse(recording, { asOf: today });
  for (const s of r.sources)
    console.log(
      `${s.indexCode.padEnd(7)} ${s.ok ? `${String(s.count).padStart(4)} via ${s.via}` : `FAILED ${s.error}`}`,
      ...s.warnings,
    );
  console.log(`HK lots: ${r.lots.found} found, ${r.lots.assumed} assumed${r.lots.error ? `, ${r.lots.error}` : ''}`);
  const failed = r.sources.filter((s) => !s.ok);
  if (failed.length > 0) throw new Error(`not writing seeds: ${failed.map((s) => s.indexCode).join(', ')} failed`);

  const US_INDEXES: IndexCode[] = ['SPX', 'NDX', 'MID'];
  const header = (market: 'US' | 'HK'): string => {
    const own = r.sources.filter((s) => (US_INDEXES.includes(s.indexCode) ? 'US' : 'HK') === market);
    const lines = [
      `Universe seed (${market}), generated ${today} by scripts/gen-universe-seed.ts. Index members: ${own.map((s) => `${s.indexCode} ${s.count}`).join(', ')}.`,
    ];
    if (market === 'HK') {
      lines.push(
        'stock_lot is the HKEX stock board lot (shares per trading lot), NOT the option contract size in data/hk-board-lots.csv.',
      );
      for (const w of own.flatMap((s) => s.warnings)) lines.push(w);
    } else
      lines.push(
        'Source: Wikipedia constituent tables; sector is GICS (S&P) or the Nasdaq-100 ICB industry mapped to GICS names.',
      );
    return lines.join('\n');
  };
  mkdirSync(DATA_DIR, { recursive: true });
  for (const market of ['US', 'HK'] as const) {
    const rows: UniverseMember[] = r.members.filter((m) => m.market === market);
    writeFileSync(join(DATA_DIR, SEED_FILES[market]), formatUniverseSeed(rows, header(market)));
    console.log(`wrote ${join(DATA_DIR, SEED_FILES[market])}: ${rows.length} rows`);
  }

  if (!process.argv.includes('--fixtures')) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const get = (url: string): Buffer => {
    const b = captured.get(url);
    if (!b) throw new Error(`no captured response for ${url}`);
    return b;
  };
  // Wikipedia: keep only the constituent table of the wikitext, inside the API response shape.
  const wiki: [string, string, string][] = [
    ['wiki-spx.json', WIKI_PAGES.SPX[0] as string, 'S&P 500'],
    ['wiki-ndx.json', WIKI_PAGES.NDX[0] as string, 'Nasdaq-100'],
    ['wiki-mid.json', WIKI_PAGES.MID[0] as string, 'S&P 400'],
  ];
  for (const [file, page, label] of wiki) {
    const json = JSON.parse(get(wikiApiUrl(page)).toString('utf8')) as {
      parse: { title: string; pageid: number; wikitext: string };
    };
    const text = json.parse.wikitext;
    const start = text.indexOf('id="constituents"');
    const open = text.lastIndexOf('{|', start);
    const close = text.indexOf('\n|}', start) + 3;
    if (start < 0 || open < 0 || close < 3) throw new Error(`${label}: constituent table not found`);
    const body = { parse: { title: json.parse.title, pageid: json.parse.pageid, wikitext: text.slice(open, close) } };
    writeFileSync(join(FIXTURE_DIR, file), JSON.stringify(body));
  }
  for (const [file, series] of [
    ['hsi.json', 'hsi'],
    ['hscei.json', 'hscei'],
    ['hstech.json', 'hstech'],
  ] as const)
    writeFileSync(join(FIXTURE_DIR, file), get(hsiConstituentsUrl(series)));

  // Composite change log: the HSCI sheet plus one industry sheet cut short (proves the sheet is picked by name).
  const sheets = readXlsx(get(HSCI_HISTORY_URL));
  const hsci = sheets.find((s) => s.name === 'HSCI');
  const other = sheets.find((s) => s.name !== 'HSCI');
  if (!hsci || !other) throw new Error('unexpected workbook layout for hist_hsci.xlsx');
  writeFileSync(
    join(FIXTURE_DIR, 'hist-hsci.xlsx'),
    buildXlsx([{ name: other.name, rows: other.rows.slice(0, 12) }, hsci], 'shared'),
  );

  // HKEX list: header rows plus the rows of every universe name, some other equities and a few non-equity rows.
  const hkex = readXlsx(get(HKEX_SECURITIES_URL))[0];
  if (!hkex) throw new Error('unexpected workbook layout for ListOfSecurities.xlsx');
  const headerAt = hkex.rows.findIndex((row) => (row[0] ?? '').trim() === 'Stock Code');
  const universe = new Set(
    r.members.filter((m) => m.market === 'HK').map((m) => String(Number(m.symbol)).padStart(5, '0')),
  );
  const keep = hkex.rows
    .slice(headerAt + 1)
    .filter((row, i) => universe.has(row[0] ?? '') || (!/^\d{5}$/.test(row[0] ?? '') ? false : i % 40 === 0));
  const nonEquity = hkex.rows
    .slice(headerAt + 1)
    .filter((row) => !/^\d{5}$/.test(row[0] ?? '') && row[0])
    .slice(0, 5);
  writeFileSync(
    join(FIXTURE_DIR, 'hkex-securities.xlsx'),
    buildXlsx([{ name: hkex.name, rows: [...hkex.rows.slice(0, headerAt + 1), ...keep, ...nonEquity] }], 'prefixed'),
  );
  console.log(`wrote fixtures in ${FIXTURE_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
