import { describe, expect, it } from 'vitest';
import type { NewsStandingView } from '../api/types';
import {
  addDays,
  daySub,
  diffDays,
  fmtDay,
  fmtDayMonth,
  fmtDayYear,
  highlightParts,
  hkTime,
  monthGrid,
  monthLabel,
  safeHref,
  sameStanding,
  shiftMonth,
  whenLabel,
  windowPhrase,
  windowPrefix,
} from './news';

describe('date helpers', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-09', '2026-10-13')).toBe(4);
    expect(diffDays('2026-10-13', '2026-10-09')).toBe(-4);
  });

  it('prints days the way the page does', () => {
    expect(fmtDay('2026-10-12')).toBe('Mon 12 Oct');
    expect(fmtDayYear('2026-10-13')).toBe('Tue 13 Oct 2026');
    expect(fmtDayMonth('2026-11-04')).toBe('4 Nov');
    expect(daySub('2026-10-13', '2026-10-13')).toBe('Tue 13 Oct 2026');
    expect(daySub('2026-10-12', '2026-10-13')).toBe('2026 · yesterday');
    expect(daySub('2026-10-09', '2026-10-13')).toBe('2026 · 4 days ago');
  });

  it('shifts months across a year end and labels them', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-10', -13)).toBe('2025-09');
    expect(monthLabel('2026-10')).toBe('Oct 2026');
  });
});

describe('monthGrid', () => {
  it('offsets the 1st by its weekday (Sunday first) and marks today, the selected day and the future', () => {
    // 1 Oct 2026 is a Thursday: four blank cells before it
    const { lead, cells } = monthGrid('2026-10', '2026-10-13', '2026-10-09');
    expect(lead).toBe(4);
    expect(cells).toHaveLength(31);
    expect(cells[0]).toMatchObject({ n: 1, day: '2026-10-01', future: false });
    expect(cells.find((c) => c.selected)?.day).toBe('2026-10-09');
    expect(cells.find((c) => c.today)?.day).toBe('2026-10-13');
    expect(cells.filter((c) => c.future)).toHaveLength(31 - 13);
  });

  it('knows a leap February', () => {
    expect(monthGrid('2028-02', '2028-03-01', '2028-02-01').cells).toHaveLength(29);
    expect(monthGrid('2026-02', '2026-03-01', '2026-02-01').cells).toHaveLength(28);
  });
});

describe('story times and labels', () => {
  it("prints Hong Kong time whatever the viewer's zone", () => {
    expect(hkTime('2026-10-12T21:10:00Z')).toBe('05:10'); // 05:10 next day in HKT
    expect(hkTime('2026-10-12T16:00:00Z')).toBe('00:00');
  });

  it('labels a story relative to the selected day', () => {
    const item = { day: '2026-10-13', publishedAt: '2026-10-12T21:10:00Z' };
    expect(whenLabel(item, '2026-10-13', '2026-10-13')).toBe('Today 05:10');
    expect(whenLabel(item, '2026-10-13', '2026-10-20')).toBe('05:10');
    expect(whenLabel({ day: '2026-10-12', publishedAt: '2026-10-12T10:40:00Z' }, '2026-10-13', '2026-10-13')).toBe(
      'Mon 12 Oct 18:40',
    );
  });

  it('words the window the way the result line needs', () => {
    expect(windowPrefix('2026-10-13', '2026-10-13')).toBe('Last');
    expect(windowPrefix('2026-10-12', '2026-10-13')).toBe('Up to Mon 12 Oct, last');
    expect(windowPhrase(1, '2026-10-13', '2026-10-13')).toBe('in the last 24h');
    expect(windowPhrase(1, '2026-10-12', '2026-10-13')).toBe('on Mon 12 Oct');
    expect(windowPhrase(3, '2026-10-13', '2026-10-13')).toBe('in the 3 days to today');
    expect(windowPhrase(3, '2026-10-12', '2026-10-13')).toBe('in the 3 days to Mon 12 Oct');
  });
});

describe('highlightParts', () => {
  it('splits on case-insensitive matches without touching the text', () => {
    expect(highlightParts('Tencent extends its share Buyback; buyback again', 'buyback')).toEqual([
      { text: 'Tencent extends its share ', hit: false },
      { text: 'Buyback', hit: true },
      { text: '; ', hit: false },
      { text: 'buyback', hit: true },
      { text: ' again', hit: false },
    ]);
  });

  it('treats regex characters and markup as plain text', () => {
    expect(highlightParts('a.b (c) <b>x</b>', '(c)')).toEqual([
      { text: 'a.b ', hit: false },
      { text: '(c)', hit: true },
      { text: ' <b>x</b>', hit: false },
    ]);
    expect(highlightParts('plain', '')).toEqual([{ text: 'plain', hit: false }]);
    expect(highlightParts('plain', 'zzz')).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('small helpers', () => {
  it('compares standings by what they print', () => {
    const now: NewsStandingView = {
      kind: 'sell',
      label: 'Sell',
      detail: '14 Nov · 65 put',
      strike: 65,
      expiry: '2026-11-14',
      dte: 32,
      otmPct: 9,
    };
    expect(sameStanding({ ...now, strike: 66 }, now)).toBe(true);
    expect(sameStanding({ ...now, detail: '29 Oct · 150 put' }, now)).toBe(false);
    expect(sameStanding(null, now)).toBe(false);
  });

  it('links only http and https', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,x')).toBeUndefined();
  });
});
