import { describe, expect, it } from 'vitest';
import type { IdeaView, KpiRowView, WatchEntryView, WatchStatus } from '../../src/server/api-types';
import {
  type BoardRowInput,
  buildBoardRow,
  compareBoardRows,
  type HighlightInput,
  highlightsFor,
  recommend,
} from '../../src/server/watch-board';

const AS_OF = '2026-10-12';

const status = (kind: WatchStatus['kind'], label = kind): WatchStatus => ({ kind, label, detail: null });

function entry(over: Partial<WatchEntryView> = {}): WatchEntryView {
  return {
    symbol: 'NVDA',
    market: 'US',
    name: 'NVIDIA',
    sector: 'Technology',
    currency: 'USD',
    boardLot: 100,
    solvencyModel: 'altman',
    solvencyInferred: false,
    reportingFrequency: 'quarterly',
    conviction: 4,
    notes: null,
    maxCollateralPct: null,
    active: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    hasOpenPut: false,
    nextEarnings: null,
    status: status('idea'),
    ...over,
  };
}

function idea(over: Partial<IdeaView> = {}): IdeaView {
  return {
    symbol: 'NVDA',
    market: 'US',
    name: 'NVIDIA',
    sector: 'Technology',
    currency: 'USD',
    rank: 1,
    composite: 78,
    confidence: 0.8,
    tier: 'real',
    staleTagged: false,
    spot: 120,
    support: 112,
    supportSource: 'swing low',
    trend: 'up',
    contract: {
      expiry: '2026-11-13',
      dte: 32,
      strike: 110,
      delta: 0.2,
      premium: 2.4,
      multiplier: 100,
      credit: 240,
      collateral: 11000,
      collateralBase: 11000,
      annRocPct: 24.86,
      rocPct: 2.18,
      cushionPct: 6.24,
      breakeven: 107.6,
      probItm: 0.2,
      expectedValue: 12,
      bid: 2.3,
      ask: 2.5,
      iv: 0.4,
      priceSource: 'yahoo',
      tier: 'real',
    },
    sizing: null,
    ruleWarns: [],
    narrative: null,
    reasons: [],
    skills: [],
    nextEarnings: null,
    value: null,
    ...over,
  };
}

const kpis = (rows: Record<string, number | null>): KpiRowView[] =>
  Object.entries(rows).map(([key, value]) => ({
    group: 'Profitability',
    key,
    label: key,
    value,
    unit: '%',
    text: null,
    status: 'info',
    rule: '',
    trend: null,
    window: null,
  }));

function input(over: Partial<BoardRowInput> = {}): BoardRowInput {
  return {
    entry: entry(),
    asOf: AS_OF,
    closes: [
      { day: '2026-10-08', close: 100 },
      { day: '2026-10-09', close: 102 },
      { day: '2026-10-12', close: 104.04 },
    ],
    technical: { support: 100, trendState: 'up', rsi14: 55.46 },
    ivRank: 42.34,
    kpis: kpis({ roe5: 31.2, fcf_yield: 4.5, pe: 28.1 }),
    value: { base: 150, priceRatio: 0.69, costRatio: null, stars: 4 },
    screen: 'PASS',
    idea: idea(),
    binding: null,
    staleLastBar: null,
    ...over,
  };
}

describe('recommend', () => {
  it('an idea is "Sell put" with its yield, cushion and warning count in one sentence', () => {
    const a = recommend({
      statusKind: 'idea',
      idea: { contract: { annRocPct: 24.86, cushionPct: 6.24 }, ruleWarns: ['a', 'b'] },
      binding: null,
      staleLastBar: null,
      earningsDate: null,
    });
    expect(a).toEqual({ kind: 'sell_put', label: 'Sell put', reason: '24.9% a year, 6.2% cushion, 2 warnings' });
    const one = recommend({
      statusKind: 'idea',
      idea: { contract: { annRocPct: 12, cushionPct: 5 }, ruleWarns: ['a'] },
      binding: null,
      staleLastBar: null,
      earningsDate: null,
    });
    expect(one.reason).toBe('12% a year, 5% cushion, 1 warning');
  });

  it('a failed quality rule is "Avoid", worded plainly', () => {
    const avoid = recommend({
      statusKind: 'rejected',
      idea: null,
      binding: { skillId: 'fundamental.gate', rule: 'quality.fcfYield', detail: 'whatever the scan wrote' },
      staleLastBar: null,
      earningsDate: null,
    });
    expect(avoid).toEqual({ kind: 'avoid', label: 'Avoid', reason: 'Free cash flow yield is below the floor' });
  });

  it('an earnings block is "Wait" and names the results date', () => {
    for (const rule of ['events.earningsBeforeExpiry', 'events.earningsWindow', 'events.earningsNeedsIvr']) {
      const a = recommend({
        statusKind: 'rejected',
        idea: null,
        binding: {
          skillId: 'option.select',
          rule,
          detail: 'Confirmed (yahoo); every candidate expiry spans the results',
        },
        staleLastBar: null,
        earningsDate: '2026-10-20',
      });
      expect(a).toEqual({ kind: 'wait', label: 'Wait', reason: 'Results due 2026-10-20: wait until after them' });
    }
    const unknown = recommend({
      statusKind: 'rejected',
      idea: null,
      binding: { skillId: 'fundamental.gate', rule: 'events.somethingNew', detail: 'x' },
      staleLastBar: null,
      earningsDate: null,
    });
    expect(unknown).toMatchObject({ kind: 'wait', reason: 'Results are close: wait until after them' });
  });

  it('timing, volatility, option and sizing rules are "Wait"; missing prices or statements need data', () => {
    const wait = (rule: string, skillId: string, detail = 'raw note') =>
      recommend({
        statusKind: 'rejected',
        idea: null,
        binding: { skillId, rule, detail },
        staleLastBar: null,
        earningsDate: null,
      });
    expect(wait('vol.noEdge', 'volatility.edge')).toMatchObject({
      kind: 'wait',
      reason: 'Premium is thin: IV is neither high nor above realised volatility',
    });
    expect(wait('option.annRoc', 'option.select').reason).toBe('The best put pays too little a year');
    expect(wait('technical.supportDistance', 'technical.timing').reason).toBe('Not near support yet');
    expect(wait('size.perNameCap', 'size.position').kind).toBe('wait');
    expect(wait('vol.ivFloorRamp', 'volatility.edge')).toEqual({
      kind: 'wait',
      label: 'Wait',
      reason: 'IV is at its floor with results 30 to 60 days out: premium ramps into them, wait',
    });
    expect(wait('size.dailyLossHalt', 'size.position')).toMatchObject({
      kind: 'wait',
      reason: 'The drawdown governor has halted new puts for today',
    });
    expect(wait('option.noChain', 'option.select').kind).toBe('needs_data');
    expect(wait('fundamentals.insufficientData', 'fundamental.gate').kind).toBe('needs_data');
  });

  it('a rule it has no words for shows the note the scan wrote, tidied; a gate failure still avoids', () => {
    const raw = recommend({
      statusKind: 'rejected',
      idea: null,
      binding: { skillId: 'technical.timing', rule: 'technical.somethingNew', detail: 'volume dried up.' },
      staleLastBar: null,
      earningsDate: null,
    });
    expect(raw).toEqual({ kind: 'wait', label: 'Wait', reason: 'Volume dried up' });
    const gate = recommend({
      statusKind: 'rejected',
      idea: null,
      binding: { skillId: 'fundamental.gate', rule: 'quality.somethingNew', detail: 'new test failed' },
      staleLastBar: null,
      earningsDate: null,
    });
    expect(gate).toMatchObject({ kind: 'avoid', reason: 'New test failed' });
  });

  it('falls back to the rule name when the detail is empty, and to a generic line with no binding', () => {
    expect(
      recommend({
        statusKind: 'rejected',
        idea: null,
        binding: { skillId: 'technical.timing', rule: 'technical.somethingNew', detail: '' },
        staleLastBar: null,
        earningsDate: null,
      }).reason,
    ).toBe('technical.somethingNew');
    expect(
      recommend({ statusKind: 'rejected', idea: null, binding: null, staleLastBar: null, earningsDate: null }).reason,
    ).toBe('Not recommended today');
  });

  it('open puts hold; missing or old data needs data and says what to do', () => {
    const base = { idea: null, binding: null, staleLastBar: null, earningsDate: null };
    expect(recommend({ ...base, statusKind: 'open_put' }).kind).toBe('hold');
    expect(recommend({ ...base, statusKind: 'pending_first_ingest' })).toMatchObject({
      kind: 'needs_data',
      reason: expect.stringContaining('run an ingest'),
    });
    expect(recommend({ ...base, statusKind: 'stale', staleLastBar: '2026-10-01' }).reason).toBe(
      'Prices stop at 2026-10-01: run an ingest',
    );
    expect(recommend({ ...base, statusKind: 'unscored' }).reason).toContain('equity');
    expect(recommend({ ...base, statusKind: 'no_data' }).kind).toBe('needs_data');
  });
});

describe('highlightsFor', () => {
  const none: HighlightInput = {
    market: 'US',
    actionKind: 'wait',
    rank: null,
    trend: null,
    supportDistPct: null,
    rsi14: null,
    ivRank: null,
    priceRatio: null,
    screen: null,
    earningsInDays: null,
    hasOpenPut: false,
    changePct: null,
  };

  it('says nothing when nothing stands out', () => {
    expect(highlightsFor(none)).toEqual([]);
  });

  it('flags results within 14 days first, with the right wording', () => {
    expect(highlightsFor({ ...none, earningsInDays: 0 })[0]).toEqual({ tone: 'warn', text: 'Results today' });
    expect(highlightsFor({ ...none, earningsInDays: 1 })[0]?.text).toBe('Results tomorrow');
    expect(highlightsFor({ ...none, earningsInDays: 9 })[0]?.text).toBe('Results in 9 days');
    expect(highlightsFor({ ...none, earningsInDays: 15 })).toEqual([]);
  });

  it('marks the top idea, support, value, IV and RSI, in that order, capped at three', () => {
    const h = highlightsFor({
      ...none,
      actionKind: 'sell_put',
      rank: 1,
      supportDistPct: 1.8,
      priceRatio: 0.7,
      ivRank: 75,
      rsi14: 25,
      earningsInDays: 5,
    });
    expect(h.map((x) => x.text)).toEqual(['Results in 5 days', 'Top US idea', 'Near support (+1.8%)']);
  });

  it('covers the cautionary cases', () => {
    const texts = (over: Partial<HighlightInput>) => highlightsFor({ ...none, ...over }).map((x) => x.text);
    expect(texts({ supportDistPct: -2.34 })).toEqual(['Below support (-2.3%)']);
    expect(texts({ priceRatio: 1.35 })).toEqual(['35% above IV']);
    expect(texts({ ivRank: 12 })).toEqual(['IV rank 12: thin premium']);
    expect(texts({ rsi14: 74.4 })).toEqual(['Overbought, RSI 74']);
    expect(texts({ trend: 'down' })).toEqual(['Downtrend']);
    expect(texts({ screen: 'EXCLUDED' })).toEqual(['Fails the quality screen']);
    expect(texts({ changePct: -5.26 })).toEqual(['-5.3% today']);
    expect(texts({ changePct: 3.9 })).toEqual([]);
    expect(texts({ hasOpenPut: true })).toEqual(['Open put']);
  });

  it('does not call a non-idea the top idea', () => {
    expect(highlightsFor({ ...none, actionKind: 'wait', rank: 1 })).toEqual([]);
  });
});

describe('buildBoardRow', () => {
  it('carries the price, the daily change, the KPIs and the put of an idea', () => {
    const row = buildBoardRow(input());
    expect(row).toMatchObject({
      symbol: 'NVDA',
      price: 104.04,
      lastBar: '2026-10-12',
      changePct: 2,
      closes: [100, 102, 104.04],
      trend: 'up',
      supportDistPct: 4,
      rsi14: 55.5,
      ivRank: 42.3,
      roePct: 31.2,
      fcfYieldPct: 4.5,
      pe: 28.1,
      rank: 1,
      composite: 78,
      screen: 'PASS',
    });
    expect(row.put).toMatchObject({
      strike: 110,
      expiry: '2026-11-13',
      dte: 32,
      delta: 0.2,
      annRocPct: 24.9,
      cushionPct: 6.2,
    });
    expect(row.action.kind).toBe('sell_put');
    expect(row.highlights.map((h) => h.text)).toContain('Top US idea');
  });

  it('leaves every number null when its input is missing: nothing is invented', () => {
    const row = buildBoardRow(
      input({
        entry: entry({ status: status('pending_first_ingest') }),
        closes: [],
        technical: null,
        ivRank: null,
        kpis: null,
        value: null,
        screen: null,
        idea: null,
      }),
    );
    expect(row).toMatchObject({
      price: null,
      lastBar: null,
      changePct: null,
      closes: [],
      trend: null,
      supportDistPct: null,
      rsi14: null,
      ivRank: null,
      roePct: null,
      fcfYieldPct: null,
      pe: null,
      value: null,
      rank: null,
      put: null,
    });
    expect(row.action.kind).toBe('needs_data');
  });

  it('a loss-making name has a null P/E, not zero (the KPI row has no value)', () => {
    const row = buildBoardRow(input({ kpis: kpis({ roe5: 5, fcf_yield: null, pe: null }) }));
    expect(row.pe).toBeNull();
    expect(row.fcfYieldPct).toBeNull();
    expect(row.roePct).toBe(5);
  });

  it('hides float32 noise in prices and closes', () => {
    const row = buildBoardRow(
      input({
        closes: [
          { day: '2026-10-09', close: 424.7000122 },
          { day: '2026-10-12', close: 424.799988 },
        ],
      }),
    );
    expect(row.price).toBe(424.8);
    expect(row.closes).toEqual([424.7, 424.8]);
  });

  it('shows no free-cash-flow yield for a bank or insurer, where it means nothing', () => {
    const bank = buildBoardRow(
      input({ entry: entry({ solvencyModel: 'financial' }), kpis: kpis({ roe5: 12, fcf_yield: 81, pe: 6 }) }),
    );
    expect(bank.fcfYieldPct).toBeNull();
    expect(bank.roePct).toBe(12);
    expect(bank.pe).toBe(6);
    expect(buildBoardRow(input()).fcfYieldPct).toBe(4.5);
  });

  it('the idea only counts when the watch status says it is one', () => {
    const row = buildBoardRow(input({ entry: entry({ status: status('open_put') }) }));
    expect(row.put).toBeNull();
    expect(row.rank).toBeNull();
    expect(row.action.kind).toBe('hold');
  });

  it('counts days to results from the as-of date, and ignores a date already past', () => {
    const soon = buildBoardRow(
      input({ entry: entry({ nextEarnings: { date: '2026-10-19', confirmed: true, source: 'yahoo' } }) }),
    );
    expect(soon.earningsInDays).toBe(7);
    expect(soon.highlights[0]?.text).toBe('Results in 7 days');
    const past = buildBoardRow(
      input({ entry: entry({ nextEarnings: { date: '2026-10-01', confirmed: true, source: 'yahoo' } }) }),
    );
    expect(past.earningsInDays).toBeNull();
  });

  it('keeps the last 60 closes for the sparkline', () => {
    const closes = Array.from({ length: 90 }, (_, i) => ({
      day: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      close: 100 + i,
    }));
    const row = buildBoardRow(input({ closes }));
    expect(row.closes).toHaveLength(60);
    expect(row.closes[59]).toBe(189);
  });
});

describe('ordering', () => {
  const mk = (symbol: string, market: 'US' | 'HK', kind: WatchStatus['kind'], rank: number | null) =>
    buildBoardRow(
      input({
        entry: entry({ symbol, market, status: status(kind) }),
        idea: rank === null ? null : idea({ rank }),
        binding: kind === 'rejected' ? { skillId: 'option.select', rule: 'option.annRoc', detail: 'x' } : null,
      }),
    );

  it('puts sell ideas first by rank, then wait, avoid, hold, needs data', () => {
    const rows = [
      mk('ZZZ', 'US', 'pending_first_ingest', null),
      mk('B', 'US', 'idea', 2),
      mk('C', 'HK', 'rejected', null),
      mk('A', 'US', 'idea', 1),
      mk('D', 'US', 'open_put', null),
    ];
    expect(rows.sort(compareBoardRows).map((r) => r.symbol)).toEqual(['A', 'B', 'C', 'D', 'ZZZ']);
  });
});
