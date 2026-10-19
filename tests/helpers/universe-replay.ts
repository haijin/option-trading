import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplayFetch, writeReplayFixture } from '../../src/providers/http-replay';
import { HKEX_SECURITIES_URL } from '../../src/providers/universe/hkex';
import { HSCI_HISTORY_URL, hsiConstituentsUrl } from '../../src/providers/universe/hsi';
import { WIKI_PAGES, wikiApiUrl } from '../../src/providers/universe/wikipedia';

export const UNIVERSE_FIXTURES = 'tests/fixtures/universe';

const text = (name: string): string => readFileSync(join(UNIVERSE_FIXTURES, name), 'utf8');

/** What the recorded sources contain (recorded 2026-10-13 by scripts/gen-universe-seed.ts --fixtures). */
export const UNIVERSE_FIXTURE_COUNTS = {
  SPX: 503,
  NDX: 101,
  MID: 400,
  HSI: 95,
  HSCEI: 50,
  HSTECH: 30,
  HSCI: 519,
} as const;

export interface UniverseReplay {
  fetch: typeof fetch;
  /** Every URL requested through `fetch`, in order. */
  calls: string[];
  dir: string;
  cleanup(): void;
}

/**
 * Replayable HTTP for every constituent source: the three Wikipedia pages, the three Hang Seng constituent lists, the
 * Composite change log and the HKEX securities workbook. Like `createReplayFetch`, a request with no recorded response
 * throws and never reaches the network. `override` answers a URL first (to make one source fail or change).
 */
export function universeReplay(override: (url: string) => Response | null = () => null): UniverseReplay {
  const dir = mkdtempSync(join(tmpdir(), 'ot-universe-'));
  const json = (url: string, file: string): void =>
    writeReplayFixture(dir, { url, body: text(file), contentType: 'application/json' });
  json(wikiApiUrl(WIKI_PAGES.SPX[0] as string), 'wiki-spx.json');
  json(wikiApiUrl(WIKI_PAGES.NDX[0] as string), 'wiki-ndx.json');
  json(wikiApiUrl(WIKI_PAGES.MID[0] as string), 'wiki-mid.json');
  json(hsiConstituentsUrl('hsi'), 'hsi.json');
  json(hsiConstituentsUrl('hscei'), 'hscei.json');
  json(hsiConstituentsUrl('hstech'), 'hstech.json');
  const binary = new Map([
    [HSCI_HISTORY_URL, 'hist-hsci.xlsx'],
    [HKEX_SECURITIES_URL, 'hkex-securities.xlsx'],
  ]);
  const base = createReplayFetch(dir);
  const calls: string[] = [];
  const replay: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    const forced = override(url);
    if (forced) return forced;
    const file = binary.get(url);
    if (file) return new Response(readFileSync(join(UNIVERSE_FIXTURES, file)), { status: 200 });
    return base(input, init);
  };
  return { fetch: replay, calls, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
