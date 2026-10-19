import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  cardDate,
  localDay,
  localTime,
  longDate,
  monthGrid,
  monthOf,
  monthTitle,
  weekdayIndex,
  weekOf,
} from './dates';

describe('journal dates', () => {
  it('numbers weekdays Monday first', () => {
    expect(weekdayIndex('2026-10-12')).toBe(0); // Monday
    expect(weekdayIndex('2026-10-13')).toBe(1);
    expect(weekdayIndex('2026-10-18')).toBe(6); // Sunday
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('adds months across a year end', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-10', 15)).toBe('2028-01');
    expect(monthOf('2026-10-13')).toBe('2026-10');
  });

  it('writes the labels the cards and header use', () => {
    expect(longDate('2026-10-13')).toBe('Tue 13 Oct 2026');
    expect(cardDate('2026-10-10')).toBe('Sat 10 Oct');
    expect(monthTitle('2026-10')).toBe('October 2026');
  });

  it('builds the week of a day, Monday first, with the weekend flagged', () => {
    const week = weekOf('2026-10-13');
    expect(week.map((d) => d.date)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(week.map((d) => d.dow)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(week.map((d) => d.weekend)).toEqual([false, false, false, false, false, true, true]);
    // a Sunday belongs to the week that started the Monday before it
    expect(weekOf('2026-10-18')[0]?.date).toBe('2026-10-12');
    // a week can straddle two months
    expect(weekOf('2026-10-29').map((d) => d.day)).toEqual([26, 27, 28, 29, 30, 31, 1]);
  });

  it('pads a month grid to whole Monday-first weeks (October 2026 starts on a Thursday)', () => {
    const cells = monthGrid('2026-10');
    expect(cells).toHaveLength(35);
    expect(cells.slice(0, 3).map((c) => [c.date, c.pad])).toEqual([
      ['2026-09-28', true],
      ['2026-09-29', true],
      ['2026-09-30', true],
    ]);
    expect(cells[3]).toEqual({ date: '2026-10-01', day: 1, pad: false });
    expect(cells[33]).toEqual({ date: '2026-10-31', day: 31, pad: false });
    expect(cells[34]).toEqual({ date: '2026-11-01', day: 1, pad: true });
    expect(cells.filter((c) => !c.pad)).toHaveLength(31);
  });

  it('needs no padding when a month fills whole weeks, and handles leap February', () => {
    // February 2027 starts on a Monday and has 28 days: exactly four weeks
    const feb = monthGrid('2027-02');
    expect(feb).toHaveLength(28);
    expect(feb.every((c) => !c.pad)).toBe(true);
    // February 2028 has 29 days and starts on a Tuesday
    const leap = monthGrid('2028-02');
    expect(leap.filter((c) => !c.pad)).toHaveLength(29);
    expect(leap).toHaveLength(35);
    expect(leap[0]?.date).toBe('2028-01-31');
  });

  it('uses the local calendar day and clock time', () => {
    const at = new Date(2026, 9, 13, 16, 42, 5);
    expect(localDay(at)).toBe('2026-10-13');
    expect(localTime(at.getTime())).toBe('16:42');
    expect(localDay(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });
});
