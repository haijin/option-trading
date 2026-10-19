import { describe, expect, it } from 'vitest';
import {
  asOfLine,
  bigMoney,
  filterCandidates,
  flagsOf,
  gain,
  hkDay,
  noPlanNote,
  outcomeText,
  price,
  putAngleText,
  runsLine,
  sessionText,
  sortCandidates,
  tightness,
  tradingViewUrl,
} from './leadersLib';
import { candidate, hkCandidate, leadersView, TODAY, watchCandidate } from './testFixtures';

const base = (contractionRatio: number | null, volDryUpRatio: number | null) => ({
  anchorDay: '2026-09-15',
  depthRatio: 0.1,
  lenDays: 12,
  contractionRatio,
  volDryUpRatio,
  atrRatio: 0.9,
});

describe('tradingViewUrl', () => {
  it('writes Hong Kong codes as HKEX:700 without the leading zeros', () => {
    expect(tradingViewUrl('HK', '0700')).toBe('https://www.tradingview.com/chart/?symbol=HKEX:700');
    expect(tradingViewUrl('HK', '0981')).toBe('https://www.tradingview.com/chart/?symbol=HKEX:981');
    expect(tradingViewUrl('HK', '1810')).toBe('https://www.tradingview.com/chart/?symbol=HKEX:1810');
  });

  it('uses the bare symbol for US names and escapes anything odd', () => {
    expect(tradingViewUrl('US', 'VRT')).toBe('https://www.tradingview.com/chart/?symbol=VRT');
    expect(tradingViewUrl('US', 'BRK.B')).toBe('https://www.tradingview.com/chart/?symbol=BRK.B');
    expect(tradingViewUrl('US', 'A&B=1')).toBe('https://www.tradingview.com/chart/?symbol=A%26B%3D1');
  });
});

describe('tightness', () => {
  it('adds the range contraction and the volume dry-up, and sorts unknown last', () => {
    expect(tightness({ base: base(0.62, 0.78) })).toBeCloseTo(1.4, 10);
    expect(tightness({ base: base(null, 0.78) })).toBe(Number.POSITIVE_INFINITY);
    expect(tightness({ base: null })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sortCandidates', () => {
  const a = candidate({ id: 1, rank: 1, symbol: 'A', score: 90, stopPct: 2.5, ret3mPct: 40, base: base(0.7, 0.8) });
  const b = candidate({ id: 2, rank: 2, symbol: 'B', score: 80, stopPct: 1.9, ret3mPct: 70, base: base(0.5, 0.6) });
  const c = watchCandidate({
    id: 3,
    rank: 3,
    symbol: 'C',
    score: 70,
    stopPct: null,
    ret3mPct: null,
    base: base(0.9, 1),
  });
  const names = (list: ReturnType<typeof sortCandidates>) => list.map((x) => x.symbol).join('');

  it('sorts by score, highest first', () => {
    expect(names(sortCandidates([c, a, b], 'score'))).toBe('ABC');
  });

  it('sorts by tightness, tightest first', () => {
    expect(names(sortCandidates([a, b, c], 'tight'))).toBe('BAC');
  });

  it('sorts by stop width, narrowest first, and a name with no stop last', () => {
    expect(names(sortCandidates([c, a, b], 'stop'))).toBe('BAC');
  });

  it('sorts by 3m gain, biggest first, and an unknown gain last', () => {
    expect(names(sortCandidates([c, a, b], 'r3'))).toBe('BAC');
  });

  it('puts a Setup before a Watch on a tie, then keeps the list rank, and does not touch its input', () => {
    const w = watchCandidate({ id: 9, rank: 1, symbol: 'W', score: 90 });
    const s = candidate({ id: 8, rank: 5, symbol: 'S', score: 90 });
    const input = [w, s];
    expect(names(sortCandidates(input, 'score'))).toBe('SW');
    expect(names(input)).toBe('WS');
    const x = candidate({ id: 7, rank: 2, symbol: 'X', score: 90 });
    const y = candidate({ id: 6, rank: 1, symbol: 'Y', score: 90 });
    expect(names(sortCandidates([x, y], 'score'))).toBe('YX');
  });
});

describe('filterCandidates', () => {
  const list = [candidate(), watchCandidate(), hkCandidate()];
  it('filters by market and by state, and All keeps everything', () => {
    expect(filterCandidates(list, 'all', 'all')).toHaveLength(3);
    expect(filterCandidates(list, 'US', 'all').map((c) => c.symbol)).toEqual(['VRT', 'PLTR']);
    expect(filterCandidates(list, 'HK', 'all').map((c) => c.symbol)).toEqual(['0700']);
    expect(filterCandidates(list, 'all', 'setup').map((c) => c.symbol)).toEqual(['VRT', '0700']);
    expect(filterCandidates(list, 'US', 'watch').map((c) => c.symbol)).toEqual(['PLTR']);
    expect(filterCandidates(list, 'HK', 'watch')).toEqual([]);
  });
});

describe('formatting', () => {
  it('prints prices with the currency prefix and a dash for nothing', () => {
    expect(price({ currency: 'USD' }, 168.4)).toBe('US$168.40');
    expect(price({ currency: 'HKD' }, 2.64)).toBe('HK$2.64');
    expect(price({ currency: 'USD' }, null)).toBe('-');
    expect(price({ currency: 'USD' }, 1285, 0)).toBe('US$1,285');
  });

  it('shortens dollar volume', () => {
    expect(bigMoney(1_420_000_000)).toBe('1.4b');
    expect(bigMoney(410_000_000)).toBe('410m');
    expect(bigMoney(950_000)).toBe('950k');
    expect(bigMoney(1_000_000)).toBe('1m');
    expect(bigMoney(640_000)).toBe('640k');
    expect(bigMoney(null)).toBe('-');
  });

  it('signs gains', () => {
    expect(gain(9)).toBe('+9.0%');
    expect(gain(-1.25)).toBe('-1.3%');
    expect(gain(null)).toBe('-');
  });

  it('converts an instant to its Hong Kong day', () => {
    expect(hkDay('2026-10-13T22:45:00.000Z')).toBe('2026-10-14');
    expect(hkDay('2026-10-13T10:45:00.000Z')).toBe('2026-10-13');
  });
});

describe('header and day lines', () => {
  it('names the session whose run is for the day shown', () => {
    const v = leadersView();
    expect(sessionText(v.runs, TODAY)).toBe('after US close');
    expect(sessionText({ US: null, HK: v.runs.HK }, TODAY)).toBe('after HK close');
    expect(sessionText({ US: null, HK: null }, TODAY)).toBeNull();
    expect(sessionText(v.runs, '2026-10-01')).toBeNull();
  });

  it('writes the as-of line with the run time in Hong Kong time', () => {
    expect(asOfLine(leadersView())).toBe('Tue 13 Oct · after US close · 06:45 HKT');
    expect(asOfLine(leadersView({ isArchive: true, asOf: '2026-10-12' }))).toBe('Archive · Mon 12 Oct');
    expect(asOfLine(leadersView({ asOf: null }))).toBe('No scan yet');
  });

  it('writes when each market ran, or says outcomes are stamped on an archived day', () => {
    expect(runsLine(leadersView())).toBe('Tue 13 Oct 2026 · HK run 18:45 · US run 06:45 HKT');
    expect(runsLine(leadersView({ isArchive: true, asOf: '2026-10-12' }))).toBe('2026 · outcomes stamped');
  });
});

describe('card text', () => {
  it('writes the put angle the way the prototype does', () => {
    expect(putAngleText({ expiry: '2026-11-21', strike: 160, delta: 0.21, rocPct: 1.6, belowStopPct: 1.1 })).toBe(
      'Put angle: 21 Nov 160P · delta .21 · 1.6% ROC · strike 1.1% under the stop',
    );
    expect(putAngleText({ expiry: '2026-10-29', strike: 590, delta: null, rocPct: 1.3, belowStopPct: null })).toBe(
      'Put angle: 29 Oct 590P · 1.3% ROC',
    );
  });

  it('explains a Watch that has no plan, with the stop width and the blackout when they apply', () => {
    expect(noPlanNote({ stopPct: null, earningsInDays: null })).toBe(
      'Watch names have no plan: the stop is set from the turn-up bar on the day it prints.',
    );
    expect(noPlanNote({ stopPct: 3.6, earningsInDays: null })).toContain('needed a 3.6% stop, above the 3% cap.');
    expect(noPlanNote({ stopPct: 2.3, earningsInDays: 5 })).toContain('needed a 2.3% stop.');
    expect(noPlanNote({ stopPct: 2.3, earningsInDays: 5 })).not.toContain('cap');
    expect(noPlanNote({ stopPct: 2.3, earningsInDays: 5 })).toContain('Earnings inside the 7-day blackout.');
    expect(noPlanNote({ stopPct: null, earningsInDays: 8 })).not.toContain('blackout');
  });

  it('adds On watchlist and Chain stored from the booleans and never shows them twice', () => {
    const flags = flagsOf({
      flags: [
        { level: 'warn', text: 'Earnings in 9 d' },
        { level: 'ok', text: 'On watchlist' },
      ],
      watched: true,
      hasChain: true,
    });
    expect(flags.map((f) => f.text)).toEqual(['Earnings in 9 d', 'On watchlist', 'Chain stored']);
    expect(flagsOf({ flags: [], watched: false, hasChain: false })).toEqual([]);
  });
});

describe('outcomeText', () => {
  const o = {
    fwd5Pct: 3.2,
    fwd10Pct: 6.1,
    fwd20Pct: null,
    hit3r: null,
    stopped: null,
    maxR: null,
    daysTo3r: null,
    asOf: '2026-10-13',
  };
  it('says a Setup reached 3R, with the days and the best R', () => {
    const t = outcomeText({ ...o, hit3r: true, stopped: false, daysTo3r: 7, maxR: 3.4 });
    expect(t).toEqual({
      later: 'After 5 d +3.2% · 10 d +6.1%',
      result: 'Reached 3R in 7 d · max 3.4R',
      kind: 'ok',
      counted: 'Counted to Tue 13 Oct',
    });
  });

  it('says stopped, still open, a Watch with no plan, and nothing yet', () => {
    expect(outcomeText({ ...o, hit3r: false, stopped: true, maxR: 0.6 })).toMatchObject({
      result: 'Stopped first · max 0.6R',
      kind: 'fail',
    });
    expect(outcomeText({ ...o, hit3r: false, stopped: false })).toMatchObject({ result: 'Still open', kind: 'blue' });
    expect(outcomeText(o)).toMatchObject({ result: 'Watch: no plan to track', kind: 'blue' });
    expect(outcomeText({ ...o, fwd5Pct: null, fwd10Pct: null, asOf: null })).toEqual({
      later: 'No bar after this day yet',
      result: 'Not counted yet',
      kind: 'blue',
      counted: null,
    });
  });
});
