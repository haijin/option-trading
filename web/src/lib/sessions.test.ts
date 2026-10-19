import { describe, expect, it } from 'vitest';
import { durationText, newYorkOnDaylightTime, sessionBlocks, sessionState } from './sessions';

/** A Hong Kong wall-clock instant. */
const hkt = (iso: string): Date => new Date(`${iso}+08:00`);

describe('sessions', () => {
  it('knows when New York is on daylight time', () => {
    expect(newYorkOnDaylightTime(hkt('2026-10-17T08:40'))).toBe(true);
    expect(newYorkOnDaylightTime(hkt('2026-11-02T08:40'))).toBe(false);
    expect(newYorkOnDaylightTime(hkt('2026-03-09T08:40'))).toBe(true);
    expect(newYorkOnDaylightTime(hkt('2026-03-08T08:40'))).toBe(false);
  });

  it('draws the US session at 21:30 in summer and 22:30 in winter, split across midnight', () => {
    const summer = sessionBlocks(hkt('2026-10-17T08:40'));
    expect(summer.map((b) => [b.market, b.start, b.end])).toEqual([
      ['US', 0, 240],
      ['HK', 570, 720],
      ['HK', 780, 960],
      ['US', 1290, 1440],
    ]);
    const winter = sessionBlocks(hkt('2026-11-20T08:40'));
    expect(winter[0]?.end).toBe(300);
    expect(winter[3]?.start).toBe(1350);
  });

  it('writes the headline for each part of a weekday', () => {
    const friday = sessionState(hkt('2026-10-16T08:40'));
    expect(friday.dateTitle).toBe('Friday 16 October');
    expect(friday.clock).toBe('08:40');
    expect(friday.open).toBe(null);
    expect(friday.headline).toBe('HK opens in 50 min');
    expect(friday.sub).toBe('US closed, reopens 21:30');

    expect(sessionState(hkt('2026-10-16T02:15')).headline).toBe('US trading, closes 04:00');
    expect(sessionState(hkt('2026-10-16T02:15')).sub).toBe('HK opens in 7 h 15 min');
    expect(sessionState(hkt('2026-10-16T10:00')).headline).toBe('HK trading, lunch at 12:00');
    expect(sessionState(hkt('2026-10-16T12:30')).headline).toBe('HK lunch, reopens 13:00');
    expect(sessionState(hkt('2026-10-16T15:00')).open).toBe('HK');
    expect(sessionState(hkt('2026-10-16T18:30')).headline).toBe('US opens in 3 h');
    expect(sessionState(hkt('2026-10-16T18:30')).sub).toBe('HK closed until Monday 09:30');
    expect(sessionState(hkt('2026-10-15T18:30')).sub).toBe('HK closed, reopens 09:30');
    expect(sessionState(hkt('2026-10-16T22:00')).headline).toBe('US trading, closes 04:00');
  });

  it('handles the weekend: Saturday morning still has the US session, then everything is closed', () => {
    const satMorning = sessionState(hkt('2026-10-17T03:00'));
    expect(satMorning.open).toBe('US');
    expect(satMorning.sub).toBe('HK closed until Monday 09:30');
    const satNoon = sessionState(hkt('2026-10-17T12:00'));
    expect(satNoon.headline).toBe('Markets closed until Monday 09:30');
    expect(satNoon.sub).toBe('US session ended this morning');
    const sunday = sessionState(hkt('2026-10-18T12:00'));
    expect(sunday.headline).toBe('Markets closed until Monday 09:30');
    expect(sunday.sub).toBe('US reopens Monday 21:30');
    // Monday 02:00: no US session ran on Sunday night.
    expect(sessionState(hkt('2026-10-19T02:00')).headline).toBe('HK opens in 7 h 30 min');
  });

  it('formats durations', () => {
    expect(durationText(0)).toBe('now');
    expect(durationText(50)).toBe('50 min');
    expect(durationText(120)).toBe('2 h');
    expect(durationText(190)).toBe('3 h 10 min');
  });
});
