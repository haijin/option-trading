import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hkDayStart, newsHash } from '../../src/core/news';
import {
  aiSpendSince,
  briefDaysBetween,
  countUnclassified,
  earliestBriefDay,
  earliestNewsDay,
  insertNewsItems,
  lastNewsFetchAt,
  listBriefsForDay,
  listNewsItems,
  listUnclassified,
  markRejected,
  type NewNewsItem,
  newsImpactsByDay,
  saveBrief,
  searchNewsItems,
  setClassification,
} from '../../src/db/news';
import { seedInstrument } from '../helpers/seed';
import { createTestDb, type TestDb } from '../helpers/test-db';

let db: TestDb;
let nke: number;
let tcent: number;

const story = (instrumentId: number | null, url: string, title: string, publishedAt: string): NewNewsItem => ({
  instrumentId,
  source: 'Yahoo Finance',
  url,
  title,
  snippet: null,
  publishedAt: new Date(publishedAt),
  fetchedAt: new Date('2026-10-13T00:30:00Z'),
  hash: newsHash(url),
});

beforeAll(async () => {
  db = await createTestDb();
  nke = (await seedInstrument(db.db, 'US', 'NKE', { name: 'NIKE' })).id;
  tcent = (await seedInstrument(db.db, 'HK', '0700', { name: 'Tencent' })).id;
});
afterAll(async () => {
  await db.drop();
});

describe('storing stories', () => {
  it('keeps one row per name and url; the same story on two names is two rows; a market-wide story dedupes too', async () => {
    const url = 'https://example.com/a-1';
    const n1 = await insertNewsItems(db.db, [
      story(nke, url, 'A story', '2026-10-12T10:00:00Z'),
      story(tcent, url, 'A story', '2026-10-12T10:00:00Z'),
      story(null, url, 'A story', '2026-10-12T10:00:00Z'),
    ]);
    expect(n1).toBe(3);
    const n2 = await insertNewsItems(db.db, [
      story(nke, `${url}?utm_source=x#top`, 'A story', '2026-10-12T10:00:00Z'),
      story(null, url, 'A story', '2026-10-12T10:00:00Z'),
    ]);
    expect(n2).toBe(0); // the hash is of the canonical url, so tracking parameters do not make a new story
  });

  it('never prunes: there is no delete path and old rows stay readable', async () => {
    await insertNewsItems(db.db, [story(nke, 'https://example.com/old-1', 'An old story', '2025-01-02T03:00:00Z')]);
    expect(await earliestNewsDay(db.db)).toBe('2025-01-02');
  });
});

describe('the day and window query uses Hong Kong day boundaries', () => {
  beforeAll(async () => {
    await insertNewsItems(db.db, [
      // 23:59 HKT on 9 Oct, 00:00 HKT on 10 Oct, 23:59 HKT on 10 Oct, 00:00 HKT on 11 Oct
      story(nke, 'https://example.com/b-1', 'Late 9 Oct', '2026-10-09T15:59:00Z'),
      story(nke, 'https://example.com/b-2', 'Early 10 Oct', '2026-10-09T16:00:00Z'),
      story(nke, 'https://example.com/b-3', 'Late 10 Oct', '2026-10-10T15:59:00Z'),
      story(nke, 'https://example.com/b-4', 'Early 11 Oct', '2026-10-10T16:00:00Z'),
    ]);
  });

  it('one HK day holds exactly the stories between its two midnights', async () => {
    const rows = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-10'),
      to: hkDayStart('2026-10-11'),
      instrumentIds: [nke],
    });
    expect(rows.map((r) => r.title)).toEqual(['Late 10 Oct', 'Early 10 Oct']);
  });

  it('a wider window includes the days before it, newest first', async () => {
    const rows = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-09'),
      to: hkDayStart('2026-10-12'),
      instrumentIds: [nke],
    });
    expect(rows.map((r) => r.title)).toEqual(['Early 11 Oct', 'Late 10 Oct', 'Early 10 Oct', 'Late 9 Oct']);
  });

  it('leaves out names that are not asked for and market-wide stories', async () => {
    const rows = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-12'),
      to: hkDayStart('2026-10-13'),
      instrumentIds: [tcent],
    });
    expect(rows.map((r) => r.symbol)).toEqual(['0700']);
    expect(await listNewsItems(db.db, { from: new Date(0), to: new Date(), instrumentIds: [] })).toEqual([]);
  });
});

describe('calendar dots', () => {
  it('collects the impact words per Hong Kong day, with "none" for stories not classified yet', async () => {
    const rows = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-10'),
      to: hkDayStart('2026-10-11'),
      instrumentIds: [nke],
    });
    const [late] = rows;
    const at = new Date('2026-10-13T01:00:00Z');
    await setClassification(db.db, (late as (typeof rows)[0]).id, {
      impact: 'blocks',
      summary: 'Blocks it.',
      rules: [{ key: 'e', text: 'Earnings inside the window' }],
      standing: { kind: 'sell', label: 'Sell', detail: '', strike: 65, expiry: '2026-11-14', dte: 32, otmPct: 10 },
      confidence: 70,
      knownAt: at,
      model: 'fake',
      costUsd: 0.01,
    });
    const days = await newsImpactsByDay(db.db, {
      from: hkDayStart('2026-10-01'),
      to: hkDayStart('2026-11-01'),
      instrumentIds: [nke],
    });
    expect([...(days.get('2026-10-10') ?? [])].sort()).toEqual(['blocks', 'none']);
    expect([...(days.get('2026-10-09') ?? [])]).toEqual(['none']);
    expect([...(days.get('2026-10-12') ?? [])]).toEqual(['none']);
    expect(days.get('2026-10-13')).toBeUndefined();
  });

  it('hide-neutral drops a day that only had Neutral stories', async () => {
    const [row] = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-11'),
      to: hkDayStart('2026-10-12'),
      instrumentIds: [nke],
    });
    await setClassification(db.db, (row as NonNullable<typeof row>).id, {
      impact: 'neutral',
      summary: 'Nothing.',
      rules: [],
      standing: { kind: 'wait', label: 'Wait', detail: '', strike: null, expiry: null, dte: null, otmPct: null },
      confidence: 50,
      knownAt: new Date('2026-10-13T01:00:00Z'),
      model: 'fake',
      costUsd: 0.01,
    });
    const range = { from: hkDayStart('2026-10-11'), to: hkDayStart('2026-10-12'), instrumentIds: [nke] };
    expect([...((await newsImpactsByDay(db.db, range)).get('2026-10-11') ?? [])]).toEqual(['neutral']);
    expect((await newsImpactsByDay(db.db, { ...range, hideNeutral: true })).size).toBe(0);
  });
});

describe('search', () => {
  it('matches the headline, symbol, name and source across all days, newest first, case-insensitively', async () => {
    expect((await searchNewsItems(db.db, { q: 'early 10', instrumentIds: [nke, tcent] })).map((r) => r.title)).toEqual([
      'Early 10 Oct',
    ]);
    expect(
      (await searchNewsItems(db.db, { q: '0700', instrumentIds: [nke, tcent] })).every((r) => r.symbol === '0700'),
    ).toBe(true);
    expect((await searchNewsItems(db.db, { q: 'nike', instrumentIds: [nke, tcent] })).length).toBeGreaterThan(3);
    expect((await searchNewsItems(db.db, { q: 'yahoo', instrumentIds: [tcent] })).length).toBeGreaterThan(0);
  });

  it('treats % and _ as plain characters and respects the name scope', async () => {
    expect(await searchNewsItems(db.db, { q: '%', instrumentIds: [nke] })).toEqual([]);
    expect(await searchNewsItems(db.db, { q: 'early 10', instrumentIds: [tcent] })).toEqual([]);
    expect(await searchNewsItems(db.db, { q: '  ', instrumentIds: [nke] })).toEqual([]);
  });
});

describe('classification bookkeeping', () => {
  it('offers only stories nobody has judged, the priority names first, and stops offering a rejected one', async () => {
    const todo = await listUnclassified(db.db, {
      priorityIds: [tcent],
      since: new Date('2026-10-01T00:00:00Z'),
      limit: 50,
    });
    expect(todo.length).toBeGreaterThan(0);
    expect(todo[0]?.instrumentId).toBe(tcent);
    const first = todo[0] as NonNullable<(typeof todo)[0]>;
    await markRejected(db.db, first.id, { knownAt: new Date('2026-10-13T02:00:00Z'), model: 'fake', costUsd: 0.02 });
    const again = await listUnclassified(db.db, {
      priorityIds: [tcent],
      since: new Date('2026-10-01T00:00:00Z'),
      limit: 50,
    });
    expect(again.map((c) => c.id)).not.toContain(first.id);
    expect(await countUnclassified(db.db, new Date('2026-10-01T00:00:00Z'))).toBe(again.length);
  });

  it('adds up what the model calls cost since a time, stories and briefs together', async () => {
    await saveBrief(db.db, {
      day: '2026-10-13',
      asOf: new Date('2026-10-13T03:00:00Z'),
      session: 'manual',
      lead: 'Lead',
      bullets: [],
      forPuts: 'x',
      tape: [],
      citations: [],
      model: 'fake',
      costUsd: 0.03,
    });
    const spent = await aiSpendSince(db.db, new Date('2026-10-13T00:00:00Z'));
    expect(spent).toBeCloseTo(0.01 + 0.01 + 0.02 + 0.03, 4);
    expect(await aiSpendSince(db.db, new Date('2026-10-14T00:00:00Z'))).toBe(0);
  });

  it('knows when the last story was fetched', async () => {
    expect((await lastNewsFetchAt(db.db))?.toISOString()).toBe('2026-10-13T00:30:00.000Z');
  });
});

describe('briefs', () => {
  const brief = (session: 'hk_open' | 'us_open' | 'manual', lead: string, asOf: string, day = '2026-10-12') => ({
    day,
    asOf: new Date(asOf),
    session,
    lead,
    bullets: [{ tag: 'US' as const, text: 'Banks report' }],
    forPuts: 'Sell the dip',
    tape: [{ key: 'vix', label: 'VIX', value: '17.2', changePct: null, asOf: '2026-10-09' }],
    citations: [],
    model: 'fake',
    costUsd: 0.01,
  });

  it('a scheduled session replaces the brief already stored for that day; manual ones accumulate', async () => {
    await saveBrief(db.db, brief('hk_open', 'first', '2026-10-11T23:30:00Z'));
    await saveBrief(db.db, brief('hk_open', 'second', '2026-10-11T23:45:00Z'));
    await saveBrief(db.db, brief('us_open', 'us', '2026-10-12T13:00:00Z'));
    await saveBrief(db.db, brief('manual', 'm1', '2026-10-12T05:00:00Z'));
    await saveBrief(db.db, brief('manual', 'm2', '2026-10-12T06:00:00Z'));
    const day = await listBriefsForDay(db.db, '2026-10-12');
    expect(day.map((b) => b.lead)).toEqual(['second', 'm1', 'm2', 'us']);
    expect(day[0]?.tape[0]?.value).toBe('17.2');
  });

  it('lists the days that have a brief and the first one', async () => {
    expect([...(await briefDaysBetween(db.db, '2026-10-01', '2026-10-31'))].sort()).toEqual([
      '2026-10-12',
      '2026-10-13',
    ]);
    expect(await earliestBriefDay(db.db)).toBe('2026-10-12');
  });
});

describe('constraints', () => {
  it('refuses an unknown impact word and a summary over 240 characters', async () => {
    const [row] = await listNewsItems(db.db, {
      from: hkDayStart('2026-10-12'),
      to: hkDayStart('2026-10-13'),
      instrumentIds: [nke],
    });
    const id = (row as NonNullable<typeof row>).id;
    const base = {
      rules: [],
      standing: {
        kind: 'wait' as const,
        label: 'Wait',
        detail: '',
        strike: null,
        expiry: null,
        dte: null,
        otmPct: null,
      },
      confidence: 50,
      knownAt: new Date(),
      model: 'fake',
      costUsd: 0,
    };
    await expect(setClassification(db.db, id, { ...base, impact: 'bullish' as never, summary: 'x' })).rejects.toThrow();
    await expect(
      setClassification(db.db, id, { ...base, impact: 'neutral', summary: 'x'.repeat(241) }),
    ).rejects.toThrow();
  });
});
