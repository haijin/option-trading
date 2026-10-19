import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays } from '../../src/core/dates';
import { hkDayOf } from '../../src/core/news';
import { createReplayFetch, writeReplayFixture } from '../../src/providers/http-replay';
import { hkexPrefixUrl, hkexSearchUrl } from '../../src/providers/news/hkex';
import { yahooRssUrl } from '../../src/providers/news/yahoo-rss';

/** 08:30 on Tue 13 Oct 2026 in Hong Kong: the fixtures' newest stories are from Mon 12 Oct. */
export const NEWS_NOW = new Date('2026-10-13T00:30:00Z');

const FIX = 'tests/fixtures/news';
const read = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const RSS = 'application/rss+xml';

export interface NewsReplay {
  fetch: typeof fetch;
  dir: string;
  cleanup(): void;
}

/** Replayable HTTP for every news feed the fixtures cover (NKE, 0700.HK with its HKEXnews titles, the market feeds). */
export function newsReplay(now: Date = NEWS_NOW): NewsReplay {
  const dir = mkdtempSync(join(tmpdir(), 'ot-news-'));
  const rss = (url: string, file: string): void => writeReplayFixture(dir, { url, body: read(file), contentType: RSS });
  rss(yahooRssUrl('NKE'), 'yahoo-nke.rss.xml');
  rss(yahooRssUrl('0700.HK'), 'yahoo-0700hk.rss.xml');
  rss(yahooRssUrl('^GSPC'), 'yahoo-gspc.rss.xml');
  rss(yahooRssUrl('^IXIC'), 'yahoo-ixic.rss.xml');
  rss(yahooRssUrl('^HSI'), 'yahoo-hsi.rss.xml');
  rss('https://www.cnbc.com/id/20910258/device/rss/rss.html', 'cnbc-markets.rss.xml');
  writeReplayFixture(dir, {
    url: hkexPrefixUrl('00700'),
    body: read('hkex-prefix-00700.txt'),
    contentType: 'text/javascript',
  });
  const to = hkDayOf(now);
  writeReplayFixture(dir, {
    url: hkexSearchUrl(7609, addDays(to, -14), to),
    body: read('hkex-search-7609.json'),
    contentType: 'application/json',
  });
  return { fetch: createReplayFetch(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
