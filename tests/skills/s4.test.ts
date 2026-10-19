import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params';
import type { CalibrationRow } from '../../src/core/types';
import { bsGreeks, bsPrice, probItm } from '../../src/indicators';
import type { SkillResult } from '../../src/skills/contract';
import { optionSelect, targetExpiries } from '../../src/skills/s4-option-select';
import { bsChain, ctxFor, END, makeHistory, walkCloses } from '../helpers/history';

const prior = (skillId: string, payload: unknown): SkillResult => ({
  skillId,
  version: '1.0.0',
  score: null,
  verdict: 'PASS',
  reasons: [],
  payload,
  dataQuality: { tier: 'real', missing: [] },
});
const priors = (
  o: { deltaCap?: number; support?: number | null; iv30?: number | null; rvRecent?: number | null } = {},
) =>
  new Map<string, SkillResult>([
    ['market.regime', prior('market.regime', { regime: 'bull_calm', deployCapPct: 0.5, deltaCap: o.deltaCap ?? 0.3 })],
    ['technical.timing', prior('technical.timing', { support: o.support === undefined ? 96 : o.support, close: 100 })],
    [
      'volatility.edge',
      prior('volatility.edge', { iv30: o.iv30 === undefined ? 0.3 : o.iv30, rvRecent: o.rvRecent ?? null }),
    ],
  ]);

/** A stock sitting at 100 so chain strikes are easy to reason about. */
const flat100 = () =>
  walkCloses({ n: 400, start: 100, drift: 0, vol: 0.0001, seed: 1 }).map((c) => 100 + (c - 100) * 0.01);
const US_EXP = ['2026-11-13', '2026-11-20']; // 35 and 42 days; 2026-11-20 is the monthly
const hist = (over: Parameters<typeof makeHistory>[0] = {}) => makeHistory({ closes: flat100(), ...over });

const run = (
  h: ReturnType<typeof hist>,
  o: Parameters<typeof priors>[0] = {},
  params = defaultParams(),
  extra: Partial<Parameters<typeof ctxFor>[2]> = {},
) => optionSelect.run(ctxFor(h, END, { params, priors: priors(o), ...extra }));

describe('expiry rules', () => {
  it('HK: the spot month if its DTE >= 20, else the next month; one monthly only', () => {
    expect(targetExpiries('HK', '2026-10-09', 20, 45)).toEqual(['2026-10-29']); // 20 DTE
    expect(targetExpiries('HK', '2026-10-05', 20, 45)).toEqual(['2026-10-29']);
    expect(targetExpiries('HK', '2026-10-30', 20, 45)).toEqual(['2026-11-27']); // spot month already expired
    expect(targetExpiries('HK', '2026-12-10', 20, 45)).toEqual(['2026-12-30']);
    expect(targetExpiries('HK', '2026-12-31', 20, 45)).toEqual(['2027-01-28']);
  });
  it('HK: when the spot month has < 20 DTE and the next monthly is beyond 45 days there is no valid expiry that day', () => {
    expect(targetExpiries('HK', '2026-10-12', 20, 45)).toEqual([]); // Oct 29 is 17 days out, Nov 27 is 46
  });
  it('US: Friday expiries inside the window', () => {
    expect(targetExpiries('US', '2026-10-09', 30, 45)).toEqual(['2026-11-13', '2026-11-20']);
  });
});

describe('S4 option.select on a real chain', () => {
  const chain = () => bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, spreadPct: 0.04 });

  it('picks the highest annualised ROC among contracts that satisfy every constraint, preferring the monthly', async () => {
    const r = await run(hist({ chain: chain() }));
    expect(r.verdict).toBe('PASS');
    const c = r.payload.chosen;
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.expiry).toBe('2026-11-20'); // both expiries qualify: the monthly wins
    expect(c.delta).toBeGreaterThanOrEqual(0.15);
    expect(c.delta).toBeLessThanOrEqual(0.3);
    expect(c.strike).toBeLessThanOrEqual(96); // support
    expect(c.spreadPct).toBeLessThanOrEqual(0.1);
    expect(c.oi).toBeGreaterThanOrEqual(100);
    expect(c.annRoc).toBeGreaterThanOrEqual(0.12);
    expect(r.payload.tier).toBe('real');
    expect(r.payload.source).toBe('yahoo');
    expect(r.dataQuality).toEqual({ tier: 'real', missing: [] });
  });

  it('economics follow docs/01 E: notional collateral, bid credit, annualised ROC, breakeven, cushion, US margin proxy', async () => {
    const r = await run(hist({ chain: chain() }));
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.collateral).toBe(c.strike * 100);
    expect(c.credit).toBeCloseTo((c.bid as number) * 100, 3);
    expect(c.fillPrice).toBe(c.bid);
    expect(c.roc).toBeCloseTo(c.credit / c.collateral, 4);
    expect(c.annRoc).toBeCloseTo(c.roc * (365 / c.dte), 9);
    expect(c.breakeven).toBeCloseTo(c.strike - (c.bid as number), 6);
    const spot = r.payload.spot as number;
    expect(c.cushionPct).toBeCloseTo((spot - c.breakeven) / spot, 9);
    const margin = Math.max(0.2 * spot - Math.max(0, spot - c.strike), 0.1 * c.strike) * 100 + c.credit;
    expect(c.marginEstimate).toBeCloseTo(margin, 1);
    expect(c.rocOnMargin).toBeCloseTo(c.credit / margin, 3);
    expect(c.collateralBaseCcy).toBeCloseTo(c.collateral * 7.8, 2); // HKD base, USDHKD 7.8
    expect(c.probItm).toBe(c.delta);
    expect(c.probTouch).toBeCloseTo(Math.min(1, 2 * c.delta), 9);
    expect(c.bsProbItm).toBeGreaterThan(0);
    expect(c.expectedValue).not.toBeNull();
  });

  it('stores the runner-up: the next lower strike on the same expiry', async () => {
    const r = await run(hist({ chain: chain() }));
    const { chosen, alternative } = r.payload;
    expect(alternative?.expiry).toBe(chosen?.expiry);
    expect(alternative?.strike as number).toBeLessThan(chosen?.strike as number);
  });

  it('computes greeks when the quote has none and says so (greeks:computed); uses the quote delta when present', async () => {
    const r = await run(hist({ chain: chain() }));
    expect(r.payload.chosen?.greeksSource).toBe('computed');
    expect(r.reasons.find((x) => x.rule === 'option.greeks')?.value).toBe('greeks:computed');
    const withDelta = chain();
    for (const q of withDelta.quotes) q.delta = bsGreeks('P', 100, q.strike, 35 / 365, 0.04, 0.4).delta;
    const r2 = await run(hist({ chain: withDelta }));
    expect(r2.payload.chosen?.greeksSource).toBe('quote');
  });

  it('IV is implied from the mid when the chain carries none (CSV paste), greeks still computed', async () => {
    const r = await run(hist({ chain: bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, withIv: false }) }));
    expect(r.verdict).toBe('PASS');
    expect(r.payload.chosen?.iv).toBeCloseTo(0.4, 2);
    expect(r.payload.chosen?.greeksSource).toBe('computed');
  });

  it('the regime delta cap tightens the band', async () => {
    const r = await run(hist({ chain: chain() }), { deltaCap: 0.2 });
    expect(r.payload.deltaMaxEffective).toBe(0.2);
    expect(r.payload.chosen?.delta).toBeLessThanOrEqual(0.2);
    const blocked = await run(hist({ chain: chain() }), { deltaCap: 0.1 });
    expect(blocked.verdict).toBe('FAIL');
    expect(blocked.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('delta.regimeCap');
  });

  it('fillAssumption mid_minus_tick fills above the bid', async () => {
    const p = defaultParams();
    p['option.select'].fillAssumption = 'mid_minus_tick';
    const r = await run(hist({ chain: chain() }), {}, p);
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.fillPrice).toBeGreaterThan(c.bid as number);
    expect(c.fillPrice).toBeLessThan(c.mid);
  });
});

describe('S4: every FAIL names its binding constraint', () => {
  const failRule = async (
    chain: ReturnType<typeof bsChain>,
    o: Parameters<typeof priors>[0] = {},
    params = defaultParams(),
  ) => {
    const r = await run(hist({ chain }), o, params);
    expect(r.verdict).toBe('FAIL');
    return { rule: r.reasons.find((x) => x.level === 'FAIL')?.rule, r };
  };

  it('delta.band: nothing inside the band', async () => {
    const strikes = [60, 65, 70, 75, 80]; // all far OTM (|delta| < 0.15)
    const { rule } = await failRule(bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, strikes }));
    expect(rule).toBe('delta.band');
  });

  it('support: strikes in the band are all above support', async () => {
    const { rule, r } = await failRule(bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP }), { support: 80 });
    expect(rule).toBe('support');
    expect(r.payload.binding).toBe('support');
    expect(r.payload.rejected.some((x) => x.reason.startsWith('support'))).toBe(true);
  });

  it('liquidity.bid: no put has a bid', async () => {
    const c = bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP });
    for (const q of c.quotes) q.bid = 0;
    expect((await failRule(c)).rule).toBe('liquidity.bid');
  });

  it('liquidity.spread: bid/ask too wide (10% US limit)', async () => {
    expect((await failRule(bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, spreadPct: 0.6 }))).rule).toBe(
      'liquidity.spread',
    );
  });

  it('liquidity.oi: open interest below 100 contracts (US)', async () => {
    expect((await failRule(bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, oi: 20 }))).rule).toBe('liquidity.oi');
  });

  it('roc.annualized: premium too thin for the 12% US minimum', async () => {
    expect(
      (
        await failRule(
          bsChain({ spot: 100, sigma: 0.08, expiries: US_EXP, strikes: [96, 96.5, 97, 97.5, 98, 98.5, 99, 99.5, 100] }),
          { support: 100 },
        )
      ).rule,
    ).toBe('roc.annualized');
  });

  it('the binding constraint is the stage that emptied the survivor set, not merely the one that rejected most', async () => {
    // delta + support leave strikes, then every one has a 60% spread: binding = liquidity.spread, not delta or support
    const { rule } = await failRule(bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, spreadPct: 0.6 }), {
      support: 96,
    });
    expect(rule).toBe('liquidity.spread');
  });

  it('relaxSupport rescues a support failure and downgrades the verdict to a rule WARN', async () => {
    const p = defaultParams();
    p['option.select'].relaxSupport = true;
    const r = await run(hist({ chain: bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP }) }), { support: 80 }, p);
    expect(r.verdict).toBe('WARN');
    expect(r.payload.relaxedSupport).toBe(true);
    expect(r.payload.chosen?.strike as number).toBeGreaterThan(80);
    expect(r.reasons.find((x) => x.rule === 'option.relaxedSupport')).toMatchObject({ level: 'WARN', kind: 'rule' });
  });
});

describe('S4: HK', () => {
  const hk = (over: Parameters<typeof makeHistory>[0] = {}) =>
    makeHistory({
      instrument: { market: 'HK', symbol: '0700', currency: 'HKD', multiplier: 500 },
      closes: flat100(),
      ...over,
    });

  it('real CSV chain on the HK monthly: multiplier = board lot, margin = 25% of notional, lower HK thresholds', async () => {
    const chain = bsChain({
      spot: 100,
      sigma: 0.3,
      expiries: ['2026-10-29'],
      multiplier: 500,
      source: 'csv',
      oi: 80,
      spreadPct: 0.12,
    });
    const r = await optionSelect.run(ctxFor(hk({ chain }), END, { priors: priors() }));
    expect(r.verdict).toBe('PASS');
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.expiry).toBe('2026-10-29');
    expect(c.dte).toBe(20);
    expect(c.collateral).toBe(c.strike * 500);
    expect(c.marginEstimate).toBeCloseTo(0.25 * c.collateral, 1);
    expect(c.collateralBaseCcy).toBeCloseTo(c.collateral, 6); // HKD in HKD base
    expect(r.payload.source).toBe('csv');
  });

  it('no chain: synthetic strikes priced from IV30 with a skew bump and the 15% + 5% HK haircut', async () => {
    const r = await optionSelect.run(ctxFor(hk(), END, { priors: priors({ iv30: 0.35, support: 95 }) }));
    expect(r.verdict).toBe('PASS');
    expect(r.payload.tier).toBe('synthetic');
    expect(r.payload.source).toBe('synthetic');
    expect(r.dataQuality.tier).toBe('synthetic');
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.contractId).toBe('synthetic');
    expect(c.bid).toBeNull();
    expect(c.greeksSource).toBe('model');
    expect(c.iv).toBeGreaterThan(0.35); // skew bump on an OTM put
    const model = bsPrice('P', r.payload.spot as number, c.strike, c.dte / 365, 0.035, c.iv as number);
    expect(c.fillPrice).toBeCloseTo(model * (1 - 0.15 - 0.05), 4);
    expect(r.reasons.find((x) => x.rule === 'option.synthetic')).toMatchObject({ level: 'WARN', kind: 'data' });
  });

  it('chain-calibrated real/synthetic ratio per delta bucket replaces the default haircut once >= 10 samples exist', async () => {
    const rows: CalibrationRow[] = Array.from({ length: 12 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      bucket: '10-20',
      ratio: 0.7,
      ivRvRatio: null,
      source: 'csv',
    }));
    const rows2: CalibrationRow[] = rows.map((r) => ({ ...r, bucket: '20-30' }));
    const r = await optionSelect.run(
      ctxFor(hk({ calibration: [...rows, ...rows2] }), END, { priors: priors({ iv30: 0.35, support: 95 }) }),
    );
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    const model = bsPrice('P', r.payload.spot as number, c.strike, c.dte / 365, 0.035, c.iv as number);
    expect(c.fillPrice).toBeCloseTo(model * 0.7, 4);
    expect(r.reasons.find((x) => x.rule === 'option.synthetic')?.note).toContain('calibrated');
  });

  it('a pasted chain older than chainMaxAgeDays counts as absent: synthetic pricing and the paste block take over', async () => {
    const old = bsChain({
      spot: 100,
      snapshotDate: '2026-10-02',
      sigma: 0.3,
      expiries: ['2026-10-29'],
      multiplier: 500,
      source: 'csv',
    });
    const r = await optionSelect.run(ctxFor(hk({ chain: old }), END, { priors: priors({ support: 95 }) }));
    expect(r.payload.tier).toBe('synthetic');
    const fresh = bsChain({
      spot: 100,
      snapshotDate: '2026-10-07',
      sigma: 0.3,
      expiries: ['2026-10-29'],
      multiplier: 500,
      source: 'csv',
    });
    const r2 = await optionSelect.run(ctxFor(hk({ chain: fresh }), END, { priors: priors({ support: 95 }) }));
    expect(r2.payload.tier).toBe('real'); // 2 days old passes
  });

  it('a chain without the target expiry falls back to synthetic and says why', async () => {
    const wrong = bsChain({ spot: 100, sigma: 0.3, expiries: ['2026-11-27'], multiplier: 500, source: 'csv' });
    const r = await optionSelect.run(ctxFor(hk({ chain: wrong }), END, { priors: priors({ support: 95 }) }));
    expect(r.payload.tier).toBe('synthetic');
    expect(r.reasons.find((x) => x.rule === 'option.synthetic')?.note).toContain('chain has no 2026-10-29');
  });

  it('a day with no HK expiry inside the dte window FAILs with dte.window (window narrowed to 20-45 days)', async () => {
    // Default HK dteMax is 180 days since params v2, so 2026-10-12 has Nov 27 (46 days) in range. Narrow it to the
    // old window to exercise the rule: Oct 29 is 17 days out, Nov 27 is 46.
    const p = defaultParams();
    p['option.select'].dteMax = { US: 45, HK: 45 };
    const r = await optionSelect.run(ctxFor(hk({ end: '2026-10-12' }), '2026-10-12', { params: p, priors: priors() }));
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('dte.window');
  });

  it('with the default 180-day HK window, 2026-10-12 picks the November expiry instead of failing', async () => {
    const r = await optionSelect.run(ctxFor(hk({ end: '2026-10-12' }), '2026-10-12', { priors: priors() }));
    expect(r.reasons.find((x) => x.rule === 'dte.window')).toBeUndefined();
    expect(r.reasons.find((x) => x.rule === 'option.dte')?.note).toBe('2026-11-27');
  });

  it('allowSynthetic=false with no chain FAILs option.noChain; no IV30 FAILs option.noSynthetic', async () => {
    const p = defaultParams();
    p['option.select'].allowSynthetic = false;
    const a = await optionSelect.run(ctxFor(hk(), END, { params: p, priors: priors() }));
    expect(a.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('option.noChain');
    const b = await optionSelect.run(ctxFor(hk(), END, { priors: priors({ iv30: null }) }));
    expect(b.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('option.noSynthetic');
  });
});

describe('S4: FX', () => {
  it('missing FX to the base currency leaves collateralBaseCcy null and raises a data warning (sizing is blocked downstream)', async () => {
    const chain = bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP });
    const r = await run(hist({ chain, fx: {} }));
    expect(r.payload.chosen?.collateralBaseCcy).toBeNull();
    expect(r.dataQuality.missing).toContain('fx');
    expect(r.reasons.find((x) => x.rule === 'fx.missing')).toMatchObject({ kind: 'data' });
  });
});

describe('S4: expiries must not reach the next earnings date (docs/01 A5, per candidate expiry)', () => {
  const chain = () => bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP });
  const withEarnings = (nextEarnings: string | null, allow = false) => {
    const p = priors();
    p.set('fundamental.gate', prior('fundamental.gate', { nextEarnings, earningsInWindow: nextEarnings !== null }));
    const params = defaultParams();
    params['fundamental.gate'].allowEarningsInWindow = allow;
    return run(hist({ chain: chain() }), {}, params, { priors: p });
  };

  it('earnings between the two candidate expiries: only the earlier expiry is used', async () => {
    const r = await withEarnings('2026-11-17'); // after 2026-11-13, before 2026-11-20
    expect(r.verdict).toBe('PASS');
    expect(r.payload.chosen?.expiry).toBe('2026-11-13');
    expect(r.reasons.some((x) => x.rule === 'option.earningsExpiries')).toBe(true);
  });

  it('earnings before every candidate expiry: FAIL names events.earningsBeforeExpiry', async () => {
    const r = await withEarnings('2026-11-10');
    expect(r.verdict).toBe('FAIL');
    expect(r.payload.binding).toBe('events.earningsBeforeExpiry');
    expect(r.reasons.find((x) => x.level === 'FAIL')?.rule).toBe('events.earningsBeforeExpiry');
  });

  it('an expiry ON the earnings date is not allowed (results may land before the open)', async () => {
    const r = await withEarnings('2026-11-13');
    expect(r.payload.binding).toBe('events.earningsBeforeExpiry');
  });

  it('allowEarningsInWindow leaves the expiries unrestricted (S5 requires the IV rank, S6 halves the size)', async () => {
    const r = await withEarnings('2026-11-10', true);
    expect(r.verdict).toBe('PASS');
    expect(r.payload.chosen?.expiry).toBe('2026-11-20');
  });

  it('no earnings date or earnings outside the window: nothing is restricted', async () => {
    expect((await withEarnings(null)).payload.chosen?.expiry).toBe('2026-11-20');
    const outside = priors();
    outside.set('fundamental.gate', prior('fundamental.gate', { nextEarnings: '2026-12-20', earningsInWindow: false }));
    const r = await run(hist({ chain: chain() }), {}, defaultParams(), { priors: outside });
    expect(r.payload.chosen?.expiry).toBe('2026-11-20');
  });
});

describe('S4: loss probability at the breakeven under both vols (trade-skills T1)', () => {
  const chain = () => bsChain({ spot: 100, sigma: 0.4, expiries: US_EXP, spreadPct: 0.04 });

  it('publishes P(S_T < breakeven) at the IV sold and at the recent realised vol from S3, as two INFO rows', async () => {
    const r = await run(hist({ chain: chain() }), { rvRecent: 0.2 });
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.iv).toBeCloseTo(0.4, 6);
    const t = c.dte / 365;
    expect(c.lossProbIv).toBeCloseTo(probItm('P', r.payload.spot as number, c.breakeven, t, 0.04, c.iv as number), 10);
    expect(c.lossProbRv).toBeCloseTo(probItm('P', r.payload.spot as number, c.breakeven, t, 0.04, 0.2), 10);
    expect(c.lossProbRv as number).toBeLessThan(c.lossProbIv as number); // calmer realised: less likely to breach
    const iv = r.reasons.find((x) => x.rule === 'option.lossProbIv');
    const rv = r.reasons.find((x) => x.rule === 'option.lossProbRv');
    expect(iv).toMatchObject({
      level: 'INFO',
      passed: true,
      value: Math.round((c.lossProbIv as number) * 1000) / 1000,
    });
    expect(rv).toMatchObject({
      level: 'INFO',
      passed: true,
      value: Math.round((c.lossProbRv as number) * 1000) / 1000,
    });
    expect(rv?.note).toMatch(/pricing more risk than the stock has shown/);
    expect(r.verdict).toBe('PASS');
  });

  it('without a realised-vol window from S3 the implied-vol probability stands alone and the realised row says n/a', async () => {
    const r = await run(hist({ chain: chain() }), { rvRecent: null });
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.lossProbIv).not.toBeNull();
    expect(c.lossProbRv).toBeNull();
    expect(r.reasons.find((x) => x.rule === 'option.lossProbRv')).toMatchObject({ level: 'INFO', value: 'n/a' });
  });

  it('a wilder realised vol than implied flips the wording', async () => {
    const r = await run(hist({ chain: chain() }), { rvRecent: 0.8 });
    const c = r.payload.chosen as NonNullable<typeof r.payload.chosen>;
    expect(c.lossProbRv as number).toBeGreaterThan(c.lossProbIv as number);
    expect(r.reasons.find((x) => x.rule === 'option.lossProbRv')?.note).toMatch(/less risk than the stock has shown/);
  });
});
