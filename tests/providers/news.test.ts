import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalUrl } from '../../src/core/news';
import { collectNews, MARKET_FEEDS } from '../../src/providers/news';
import { hkexSearchUrl, parseHkexAnnouncements, parseHkexDate, parseHkexStockId } from '../../src/providers/news/hkex';
import { decodeEntities, parseRss, plainText } from '../../src/providers/news/rss';
import { NEWS_NOW, newsReplay } from '../helpers/news-replay';

const fx = (name: string): string => readFileSync(`tests/fixtures/news/${name}`, 'utf8');
const replay = newsReplay();
afterAll(() => replay.cleanup());

describe('RSS parsing', () => {
  const items = parseRss(fx('yahoo-nke.rss.xml'));

  it('reads every item in order and skips the channel header', () => {
    expect(items.map((i) => i.title)).toEqual([
      "NIKE's Sample Digital Plan: Competitive Edge or Cost Burden?",
      'Sample Bank, Example Foods and Nike are part of the Acme Research Earnings Preview',
      'Nike & Converse: buyback pace slows',
      'Nike & Converse: buyback pace slows',
      'Undated Nike item',
    ]);
    expect(items[0]?.pubDate?.toISOString()).toBe('2026-10-12T14:52:00.000Z');
  });

  it('strips markup and decodes entities inside CDATA descriptions', () => {
    expect(items[2]?.description).toBe('Nike & Converse: buyback pace slows as inventories fall.');
  });

  it('leaves the date empty when the feed has none', () => {
    expect(items[4]?.pubDate).toBeNull();
  });

  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(decodeEntities('S&amp;P &#8217;26 &#x2f; &unknown;')).toBe('S&P ’26 / &unknown;');
    expect(plainText('<p>Fish &amp;amp; chips</p>  now')).toBe('Fish & chips now');
  });

  it('drops an item that has no title or no link', () => {
    expect(parseRss('<rss><channel><item><title>x</title></item><item><link>y</link></item></channel></rss>')).toEqual(
      [],
    );
  });
});

describe('HKEXnews', () => {
  it('reads the stock id out of the JSONP prefix lookup', () => {
    expect(parseHkexStockId(fx('hkex-prefix-00700.txt'), '00700')).toBe(7609);
    expect(parseHkexStockId(fx('hkex-prefix-00700.txt'), '00005')).toBeNull();
    expect(parseHkexStockId('not jsonp', '00700')).toBeNull();
  });

  it('reads Hong Kong dates', () => {
    expect(parseHkexDate('12/10/2026 17:50')?.toISOString()).toBe('2026-10-12T09:50:00.000Z');
    expect(parseHkexDate('12-10-2026')).toBeNull();
  });

  it('turns title-search rows into stories; a row without a readable date is dropped', () => {
    const rows = parseHkexAnnouncements(fx('hkex-search-7609.json'), { market: 'HK', symbol: '0700' });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source: 'HKEXnews',
      url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1012/2026101200659.pdf',
      title: 'Next Day Disclosure Return - Changes in issued shares and share buybacks',
      snippet: 'Next Day Disclosure Returns - [Others / Share Buyback]',
      target: { market: 'HK', symbol: '0700' },
    });
    expect(rows[0]?.publishedAt.toISOString()).toBe('2026-10-12T09:50:00.000Z');
    // A generic title is kept as the headline and the category line says what the filing is.
    expect(rows[2]?.title).toBe('Next Day Disclosure Return');
    expect(rows[2]?.snippet).toBe('Next Day Disclosure Returns - [Share Buyback]');
  });

  it('survives a body that is not the expected JSON', () => {
    expect(parseHkexAnnouncements('<html>blocked</html>', null)).toEqual([]);
    expect(parseHkexAnnouncements('{"result":"not json"}', null)).toEqual([]);
  });

  it('builds the search url from the stock id and a date range', () => {
    const u = new URL(hkexSearchUrl(7609, '2026-09-29', '2026-10-13'));
    expect(u.searchParams.get('stockId')).toBe('7609');
    expect(u.searchParams.get('fromDate')).toBe('20260929');
    expect(u.searchParams.get('toDate')).toBe('20261013');
  });
});

describe('collectNews over replayed HTTP', () => {
  const names = [
    { market: 'US' as const, symbol: 'NKE' },
    { market: 'HK' as const, symbol: '0700' },
  ];

  it('fetches per-name headlines, HKEXnews titles and the market feeds, none of them failing', async () => {
    const res = await collectNews({ fetch: replay.fetch, now: NEWS_NOW, names });
    expect(res.errors).toEqual([]);
    expect(res.feeds).toBe(1 + 2 + MARKET_FEEDS.length);
    const bySource = (s: string) => res.items.filter((i) => i.source === s);
    expect(bySource('HKEXnews')).toHaveLength(3);
    expect(bySource('CNBC')).toHaveLength(2);
    expect(res.items.filter((i) => i.target?.symbol === 'NKE')).toHaveLength(5);
    expect(res.items.filter((i) => i.target?.symbol === '0700' && i.source === 'Yahoo Finance')).toHaveLength(2);
    expect(res.items.filter((i) => i.target === null && i.source === 'Yahoo Finance')).toHaveLength(4);
  });

  it('dates an undated story when it was first seen, and never in the future', async () => {
    const res = await collectNews({
      fetch: replay.fetch,
      now: NEWS_NOW,
      names: [names[0] as (typeof names)[0]],
      marketFeeds: false,
    });
    const undated = res.items.find((i) => i.title === 'Undated Nike item');
    expect(undated?.publishedAt).toEqual(NEWS_NOW);
    expect(res.items.every((i) => i.publishedAt.getTime() <= NEWS_NOW.getTime())).toBe(true);
  });

  it('a feed that fails is reported and the others still deliver', async () => {
    const res = await collectNews({
      fetch: replay.fetch,
      now: NEWS_NOW,
      names: [...names, { market: 'US', symbol: 'ZZZZ' }],
      marketFeeds: false,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('US:ZZZZ');
    expect(res.items.length).toBeGreaterThan(5);
  });

  it('an HTTP error status is a failed feed, not an exception', async () => {
    const failing = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    const res = await collectNews({
      fetch: failing,
      now: NEWS_NOW,
      names: [names[0] as (typeof names)[0]],
      marketFeeds: false,
    });
    expect(res.items).toEqual([]);
    expect(res.errors[0]).toContain('HTTP 429');
  });

  it('the same story under a tracking parameter has one canonical url', async () => {
    const res = await collectNews({
      fetch: replay.fetch,
      now: NEWS_NOW,
      names: [names[0] as (typeof names)[0]],
      marketFeeds: false,
    });
    const buyback = res.items.filter((i) => i.title === 'Nike & Converse: buyback pace slows');
    expect(buyback).toHaveLength(2);
    expect(new Set(buyback.map((i) => canonicalUrl(i.url))).size).toBe(1);
  });
});
