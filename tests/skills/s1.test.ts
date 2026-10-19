import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import { defaultParams } from '../../src/core/params';
import type { CorporateEvent, FundamentalStatement } from '../../src/core/types';
import { fundamentalGate, piotroski } from '../../src/skills/s1-fundamental-gate';
import { ctxFor, END, makeHistory, statement, walkCloses } from '../helpers/history';

/** n annual statements ending FY2025, improving every year (strong F-score, safe Z). */
function improving(n: number, over: (i: number) => Partial<FundamentalStatement> = () => ({})): FundamentalStatement[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k; // 0 = oldest
    return statement(`${2025 - (n - 1) + i}-12-31`, {
      revenue: 1500 * 1.08 ** i,
      grossProfit: 1500 * 1.08 ** i * (0.4 + 0.01 * i),
      ebit: 300 + 20 * i,
      ebitda: 350 + 20 * i,
      interestExpense: 10,
      netIncome: 100 + 15 * i,
      epsDiluted: 1 + 0.15 * i,
      sharesDiluted: 100 - i,
      totalAssets: 2000 * 1.04 ** i,
      currentAssets: 800 + 40 * i,
      currentLiabilities: 500,
      totalLiabilities: 900,
      longTermDebt: 320 - 15 * i,
      totalDebt: 360 - 15 * i,
      cash: 200 + 20 * i,
      retainedEarnings: 900 + 100 * i,
      totalEquity: 1100 + 100 * i,
      cfo: (100 + 15 * i) * 1.3,
      fcf: 150 + 15 * i,
      dividendsPaid: -(30 + 3 * i),
      ...over(i),
    });
  });
}

const sixYearPrices = () => walkCloses({ n: 1600, start: 20, drift: 0.0004, vol: 0.01, seed: 9 });
const run = (
  statements: FundamentalStatement[],
  opts: Parameters<typeof makeHistory>[0] = {},
  params = defaultParams(),
) => fundamentalGate.run(ctxFor(makeHistory({ closes: sixYearPrices(), statements, ...opts }), END, { params }));

const earnings = (date: string, over: Partial<CorporateEvent> = {}): CorporateEvent => ({
  type: 'earnings',
  date,
  confirmed: true,
  source: 'manual',
  knownAt: '2026-09-01T00:00:00.000Z',
  details: null,
  ...over,
});

describe('piotroski components', () => {
  it('a clearly improving company passes all 9; a clearly deteriorating one fails them', () => {
    const [a1, a0] = improving(2) as [FundamentalStatement, FundamentalStatement];
    expect(piotroski(a0, a1)).toEqual([true, true, true, true, true, true, true, true, true]);
    const bad0 = statement('2025-12-31', {
      netIncome: -50,
      cfo: -60,
      totalAssets: 2000,
      longTermDebt: 600,
      currentAssets: 600,
      currentLiabilities: 700,
      sharesDiluted: 130,
      grossProfit: 300,
      revenue: 900,
    });
    const good1 = statement('2024-12-31');
    expect(piotroski(bad0, good1)).toEqual([false, false, false, false, false, false, false, false, false]);
  });

  it('components with missing inputs are null, not false', () => {
    const a1 = statement('2024-12-31', { grossProfit: null });
    const a0 = statement('2025-12-31', { grossProfit: null, sharesDiluted: null });
    const c = piotroski(a0, a1);
    expect(c[6]).toBeNull();
    expect(c[7]).toBeNull();
    expect(c[0]).toBe(true);
  });
});

describe('S1 fundamental.gate: full-data company', () => {
  it('6 annual periods + 8 quarters + 5y of prices: every test runs, nothing skipped, sub-scores all exist', async () => {
    const quarters = Array.from({ length: 8 }, (_, i) =>
      statement(addDays('2024-09-30', i * 91), { periodType: 'quarterly', grossProfit: 400, revenue: 1000 }),
    );
    const r = await run([...improving(6), ...quarters], { events: [earnings('2026-12-20')] });
    expect(r.verdict).not.toBe('FAIL');
    expect(r.payload.skipped).toEqual([]);
    expect(r.payload.fScore).toBeGreaterThanOrEqual(6);
    expect(r.payload.zScore).toBeGreaterThan(2.99);
    expect(r.payload.roic5y).not.toBeNull();
    expect(r.payload.gmStdev).toBe(0);
    expect(r.payload.evEbitZ).not.toBeNull();
    expect(r.payload.peZ).not.toBeNull();
    expect(Object.values(r.payload.subScores).every((x) => x !== null)).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.dataQuality.tier).toBe('proxy'); // filing dates are estimated
    expect(r.reasons.some((x) => x.rule === 'fundamentals.estimatedFilingDate')).toBe(true);
    expect(r.payload.nextEarnings).toBe('2026-12-20');
  });

  it('revenue CAGR, EPS years, dividend cut and ROIC are computed from the statements', async () => {
    const r = await run(improving(6), { events: [earnings('2026-12-20')] });
    // revenue 1000*1.08^i: 3y CAGR is exactly 8%
    expect(r.payload.revCagr3y).toBeCloseTo(0.08, 6);
    expect(r.payload.epsPosYears).toBe(4);
    expect(r.payload.divCut).toBe(false);
    // ROIC_i = EBIT_i x 0.75 / (equity + debt - cash); median of the last five
    const rois = improving(6)
      .slice(-5)
      .map(
        (s) => ((s.ebit as number) * 0.75) / ((s.totalEquity as number) + (s.totalDebt as number) - (s.cash as number)),
      )
      .sort((a, b) => a - b);
    expect(r.payload.roic5y).toBeCloseTo(rois[2] as number, 9);
  });

  it('a dividend cut inside the last 3 years is flagged (rule warning); no dividends at all is not a cut', async () => {
    const cut = await run(
      improving(6, (i) => ({ dividendsPaid: i === 4 ? -10 : -40 })),
      { events: [earnings('2026-12-20')] },
    );
    expect(cut.payload.divCut).toBe(true);
    expect(cut.reasons.find((x) => x.rule === 'quality.dividendCut')).toMatchObject({ level: 'WARN', kind: 'rule' });
    const none = await run(
      improving(6, () => ({ dividendsPaid: 0 })),
      { events: [earnings('2026-12-20')] },
    );
    expect(none.payload.divCut).toBe(false);
  });
});

describe('S1: F-score rule', () => {
  it('F <= 3 FAILs and names the binding rule', async () => {
    const sick = improving(2).map((s, i) =>
      i === 1
        ? statement(s.periodEnd, {
            netIncome: -50,
            cfo: -20,
            longTermDebt: 700,
            currentAssets: 500,
            currentLiabilities: 700,
            sharesDiluted: 140,
            grossProfit: 300,
            revenue: 900,
            totalAssets: 2100,
          })
        : s,
    );
    const r = await run(sick, { events: [earnings('2026-12-20')] });
    expect(r.verdict).toBe('FAIL');
    expect(r.payload.fScore).toBeLessThanOrEqual(3);
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('fundamentals.fScore');
  });

  it('F in 4-5 is a rule WARN (score penalty), F >= 6 passes', async () => {
    // keep 5 of 9 components true
    const [a1, a0] = improving(2) as [FundamentalStatement, FundamentalStatement];
    const mid = { ...a0, cfo: 100, longTermDebt: 400, currentAssets: 700, sharesDiluted: 120 }; // CFO<NI, leverage up, current ratio down, issuance
    const r = await run([a1, mid as FundamentalStatement], { events: [earnings('2026-12-20')] });
    expect(r.payload.fScore).toBe(5);
    expect(r.reasons.find((x) => x.rule === 'fundamentals.fScore')).toMatchObject({ level: 'WARN', kind: 'rule' });
  });

  it('fewer than 2 annual statements: F-score skipped, never failed', async () => {
    const r = await run(improving(1), { events: [earnings('2026-12-20')] });
    expect(r.payload.fScore).toBeNull();
    expect(r.payload.skipped).toContain('fScore');
    expect(r.verdict).not.toBe('FAIL');
  });
});

describe('S1: sector-switched solvency', () => {
  const withInst = (solvencyModel: 'altman' | 'property' | 'financial' | 'reit') => ({ instrument: { solvencyModel } });

  it('altman: Z < 1.81 FAILs; 1.81-2.99 is a WARN; > 2.99 passes', async () => {
    const mk = (equityLike: Partial<FundamentalStatement>) => improving(3, () => equityLike);
    const distress = await run(
      mk({
        currentAssets: 300,
        currentLiabilities: 900,
        retainedEarnings: -400,
        ebit: 20,
        totalLiabilities: 1900,
        revenue: 700,
      }),
      { events: [earnings('2026-12-20')] },
    );
    expect(distress.reasons.find((x) => x.rule === 'solvency.altmanZ')).toMatchObject({ level: 'FAIL' });
    expect(distress.verdict).toBe('FAIL');
    const strong = await run(mk({}), { events: [earnings('2026-12-20')] });
    expect(strong.reasons.find((x) => x.rule === 'solvency.altmanZ')).toMatchObject({ level: 'PASS' });
  });

  it('property: net gearing 60/100% and interest cover 3x/1.5x thresholds', async () => {
    const mk = (debt: number, ebit: number, interest: number) =>
      improving(3, () => ({ totalDebt: debt, cash: 100, totalEquity: 1000, ebit, interestExpense: interest }));
    const ok = await run(mk(600, 300, 50), { ...withInst('property'), events: [earnings('2026-12-20')] }); // gearing 50%, cover 6x
    expect(ok.reasons.find((x) => x.rule === 'solvency.gearing')).toMatchObject({ level: 'PASS' });
    expect(ok.reasons.find((x) => x.rule === 'solvency.interestCover')).toMatchObject({ level: 'PASS' });
    const warn = await run(mk(1000, 300, 50), { ...withInst('property'), events: [earnings('2026-12-20')] }); // gearing 90%
    expect(warn.reasons.find((x) => x.rule === 'solvency.gearing')).toMatchObject({ level: 'WARN', kind: 'rule' });
    const bad = await run(mk(1300, 300, 50), { ...withInst('property'), events: [earnings('2026-12-20')] }); // gearing 120%
    expect(bad.reasons.find((x) => x.rule === 'solvency.gearing')).toMatchObject({ level: 'FAIL' });
    const cover = await run(mk(600, 60, 50), { ...withInst('property'), events: [earnings('2026-12-20')] }); // cover 1.2x
    expect(cover.reasons.find((x) => x.rule === 'solvency.interestCover')).toMatchObject({ level: 'FAIL' });
    expect(ok.reasons.some((x) => x.rule === 'solvency.altmanZ')).toBe(false); // Z is absent for property names
  });

  it('reit: gearing <= 45% passes, <= 50% warns, above fails', async () => {
    const mk = (debt: number) =>
      improving(3, () => ({ totalDebt: debt, cash: 0, totalEquity: 1000, ebit: 300, interestExpense: 50 }));
    const g = async (debt: number) =>
      (await run(mk(debt), { ...withInst('reit'), events: [earnings('2026-12-20')] })).reasons.find(
        (x) => x.rule === 'solvency.gearing',
      );
    expect((await g(440))?.level).toBe('PASS');
    expect((await g(480))?.level).toBe('WARN');
    expect((await g(550))?.level).toBe('FAIL');
  });

  it('financial (banks, insurers): solvency skipped with a data-level note, no Altman Z', async () => {
    const r = await run(improving(4), { ...withInst('financial'), events: [earnings('2026-12-20')] });
    expect(r.reasons.find((x) => x.rule === 'solvency.financialSkipped')).toMatchObject({
      level: 'WARN',
      kind: 'data',
    });
    expect(r.reasons.some((x) => x.rule === 'solvency.altmanZ')).toBe(false);
    expect(r.payload.zScore).toBeNull();
    expect(r.payload.skipped).toContain('solvency');
    expect(r.verdict).not.toBe('FAIL');
  });
});

describe('S1: T12 free-data coverage', () => {
  it('4 annual periods: ROIC5y, GM stability and the valuation z-scores are skipped (NA, not 50); F-score and solvency still score; weights renormalised', async () => {
    const r = await run(improving(4), { events: [earnings('2026-12-20')] });
    expect(r.payload.skipped).toEqual(expect.arrayContaining(['roic5y', 'gmStdev', 'evEbitZ', 'peZ']));
    expect(r.payload.fScore).not.toBeNull();
    expect(r.payload.zScore).not.toBeNull();
    expect(r.payload.subScores.valuation).toBeNull();
    expect(r.payload.subScores.strength).not.toBeNull();
    const partial = r.reasons.find((x) => x.rule === 'fundamentals.partialCoverage');
    expect(partial?.note).toContain('roic5y');
    // score == weighted mean over the existing sub-scores only (quality .4, strength .3)
    const q = r.payload.subScores.quality as number;
    const s = r.payload.subScores.strength as number;
    expect(r.score).toBeCloseTo((0.4 * q + 0.3 * s) / 0.7, 0);
  });

  it('more than half of the tests skipped: WARN with fundamentals.insufficientData shown first, never FAIL', async () => {
    const r = await run(improving(1), { events: [] });
    expect(r.verdict).toBe('WARN');
    expect(r.reasons[0]?.rule).toBe('fundamentals.insufficientData');
    expect(r.reasons.some((x) => x.level === 'FAIL')).toBe(false);
  });

  it('no statements at all: score null, WARN, nothing fails', async () => {
    const r = await run([], { events: [] });
    expect(r.score).toBeNull();
    expect(r.verdict).toBe('WARN');
    expect(r.dataQuality.tier).toBe('proxy');
  });

  it('statements reported after asOf are invisible (point-in-time)', async () => {
    const all = improving(6);
    const future = statement('2026-06-30', {
      revenue: 1,
      netIncome: -999,
      cfo: -999,
      totalAssets: 1,
      reportedAt: '2026-10-20T00:00:00.000Z',
    });
    const without = await run(all, { events: [earnings('2026-12-20')] });
    const withFuture = await run([...all, future], { events: [earnings('2026-12-20')] });
    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(without));
  });
});

describe('S1: currency of statements vs trading currency', () => {
  const hk = (fx: { CNYHKD?: number }) =>
    makeHistory({
      instrument: { market: 'HK', symbol: '0700', currency: 'HKD', multiplier: 100, reportingFrequency: 'semiannual' },
      closes: sixYearPrices(),
      statements: improving(4, () => ({ currency: 'CNY' as never })),
      events: [earnings('2026-12-20')],
      fx: fx.CNYHKD === undefined ? {} : { CNYHKD: [{ day: END, rate: fx.CNYHKD }] },
    });

  it('market cap is converted into the statement currency before mixing with statement lines', async () => {
    const lo = await fundamentalGate.run(ctxFor(hk({ CNYHKD: 1 })));
    const hi = await fundamentalGate.run(ctxFor(hk({ CNYHKD: 2 })));
    // a stronger CNY (more HKD per CNY) makes the same HKD market cap smaller in CNY, so Z falls
    expect(hi.payload.zScore as number).toBeLessThan(lo.payload.zScore as number);
    expect(lo.payload.statementCurrency).toBe('CNY');
  });

  it('no FX rate: market-cap tests are skipped with a note, not computed in mixed currencies', async () => {
    const r = await fundamentalGate.run(ctxFor(hk({})));
    expect(r.payload.zScore).toBeNull();
    expect(r.payload.skipped).toEqual(expect.arrayContaining(['solvency', 'fcfYield']));
    expect(r.reasons.find((x) => x.rule === 'solvency.altmanZ')?.note).toContain('CNY->HKD');
  });
});

describe('S1: event risk', () => {
  const base = () => improving(4);

  it('pending rights issue / spin-off / privatisation FAILs', async () => {
    for (const e of [
      { type: 'rights_issue' as const, details: null },
      { type: 'spin_off' as const, details: null },
      { type: 'other' as const, details: { kind: 'privatisation' } },
    ]) {
      const r = await run(base(), { events: [earnings('2026-12-20'), { ...earnings('2026-11-01'), ...e }] });
      expect(r.verdict).toBe('FAIL');
      expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('events.pendingCorporateAction');
    }
  });

  it('earnings inside the 45-day window FAIL; outside pass; the boundary day counts as inside', async () => {
    const inside = await run(base(), { events: [earnings(addDays(END, 30))] });
    expect(inside.verdict).toBe('FAIL');
    expect(inside.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('events.earningsWindow');
    expect(inside.payload.earningsInWindow).toBe(true);
    const edge = await run(base(), { events: [earnings(addDays(END, 45))] });
    expect(edge.payload.earningsInWindow).toBe(true);
    const outside = await run(base(), { events: [earnings(addDays(END, 46))] });
    expect(outside.reasons.find((x) => x.rule === 'events.earningsWindow')?.level).toBe('PASS');
    expect(outside.payload.earningsInWindow).toBe(false);
  });

  it('allowEarningsInWindow turns the FAIL into a rule WARN that records the IV-rank condition for S5/S6', async () => {
    const p = defaultParams();
    p['fundamental.gate'].allowEarningsInWindow = true;
    const r = await run(base(), { events: [earnings(addDays(END, 20))] }, p);
    expect(r.verdict).toBe('WARN');
    expect(r.payload.earningsInWindow).toBe(true);
    expect(r.reasons.find((x) => x.rule === 'events.earningsWindow')?.note).toContain('IV rank >= 60');
  });

  it('unknown earnings date is WARN (data), never a silent PASS; a past earnings date does not count as the next one', async () => {
    const none = await run(base(), { events: [] });
    expect(none.reasons.find((x) => x.rule === 'events.earningsUnknown')).toMatchObject({
      level: 'WARN',
      kind: 'data',
    });
    const past = await run(base(), { events: [earnings(addDays(END, -20))] });
    expect(past.payload.nextEarnings).toBeNull();
    expect(past.reasons.some((x) => x.rule === 'events.earningsUnknown')).toBe(true);
  });

  it('an event learned after asOf is invisible (known_at is point-in-time)', async () => {
    const late = earnings(addDays(END, 10), { knownAt: '2026-10-12T00:00:00.000Z' });
    const r = await run(base(), { events: [late] });
    expect(r.verdict).not.toBe('FAIL');
    expect(r.payload.nextEarnings).toBeNull();
  });
});

describe('S1: earnings are judged per candidate expiry (docs/01 A5)', () => {
  const base = () => improving(4);
  const gate = (days: number, market: 'US' | 'HK' = 'US') =>
    fundamentalGate.run(
      ctxFor(
        makeHistory({
          instrument:
            market === 'HK' ? { market: 'HK', symbol: '0700', currency: 'HKD', reportingFrequency: 'semiannual' } : {},
          closes: sixYearPrices(),
          statements: market === 'HK' ? base().map((s) => ({ ...s, currency: 'HKD' as const })) : base(),
          events: [earnings(addDays(END, days))],
        }),
      ),
    );

  it('earnings before the earliest allowed expiry (US 30 days) FAIL: every candidate would span them', async () => {
    for (const d of [5, 20, 30]) {
      const r = await gate(d);
      expect(r.verdict, `+${d}d`).toBe('FAIL');
      expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('events.earningsWindow');
    }
  });

  it('earnings between the earliest expiry and dteMax do not FAIL the gate: only earlier expiries qualify (S4 enforces)', async () => {
    for (const d of [31, 38, 45]) {
      const r = await gate(d);
      expect(r.verdict, `+${d}d`).not.toBe('FAIL');
      expect(r.payload.earningsInWindow).toBe(true);
      expect(r.reasons.find((x) => x.rule === 'events.earningsWindow')?.note).toContain(
        'only expiries before this date qualify',
      );
    }
  });

  it('HK uses its own earliest expiry (20 days)', async () => {
    expect((await gate(20, 'HK')).verdict).toBe('FAIL');
    expect((await gate(25, 'HK')).verdict).not.toBe('FAIL');
  });
});
