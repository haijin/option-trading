import type { WatchAction, WatchBoardRow, WatchBoardView, WatchEntryView, WatchStatus } from '../../api/types';

export const AS_OF = '2026-10-09';

const ACTIONS: Record<WatchAction['kind'], WatchAction> = {
  sell_put: { kind: 'sell_put', label: 'Sell put', reason: '24.9% a year, 6.2% cushion' },
  wait: { kind: 'wait', label: 'Wait', reason: 'Not near support yet' },
  avoid: { kind: 'avoid', label: 'Avoid', reason: 'Free cash flow yield is below the floor' },
  hold: { kind: 'hold', label: 'Hold', reason: 'Open put: manage it on Positions; no new idea on this name' },
  needs_data: { kind: 'needs_data', label: 'Needs data', reason: 'No prices yet: run an ingest and it is scored' },
};

export const action = (kind: WatchAction['kind'], reason?: string): WatchAction => ({
  ...ACTIONS[kind],
  ...(reason ? { reason } : {}),
});

export function boardRow(over: Partial<WatchBoardRow> = {}): WatchBoardRow {
  return {
    symbol: 'NVDA',
    market: 'US',
    name: 'NVIDIA',
    sector: 'Technology',
    currency: 'USD',
    conviction: 4,
    hasOpenPut: false,
    price: 120.5,
    lastBar: AS_OF,
    changePct: 1.25,
    closes: [100, 104, 103, 110, 115, 120.5],
    trend: 'up',
    supportDistPct: 4.2,
    rsi14: 55,
    ivRank: 42,
    roePct: 31.2,
    fcfYieldPct: 4.5,
    pe: 28.1,
    value: { base: 150, priceRatio: 0.8, costRatio: null, stars: 3 },
    screen: 'PASS',
    nextEarnings: { date: '2026-11-20', confirmed: true, source: 'yahoo' },
    earningsInDays: 42,
    rank: 1,
    composite: 78,
    put: {
      strike: 110,
      expiry: '2026-11-13',
      dte: 35,
      delta: 0.2,
      premium: 2.4,
      annRocPct: 24.9,
      cushionPct: 6.2,
      warns: 0,
    },
    action: action('sell_put'),
    highlights: [{ tone: 'good', text: 'Top US idea' }],
    ...over,
  };
}

/** A small book: one idea, two waits (one with results soon), an avoid, an open put and a name with no data yet. */
export function sampleRows(): WatchBoardRow[] {
  return [
    boardRow(),
    boardRow({
      symbol: '0700',
      market: 'HK',
      name: 'Tencent',
      currency: 'HKD',
      price: 424.8,
      changePct: -2.1,
      trend: 'down',
      ivRank: 71,
      roePct: 19.9,
      fcfYieldPct: 5.7,
      pe: 15,
      value: { base: 650, priceRatio: 0.65, costRatio: null, stars: 4 },
      rank: 1,
      composite: 70,
      put: {
        strike: 400,
        expiry: '2026-11-27',
        dte: 49,
        delta: 0.18,
        premium: 9.5,
        annRocPct: 17.2,
        cushionPct: 7.9,
        warns: 1,
      },
      action: action('sell_put', '17.2% a year, 7.9% cushion, 1 warning'),
      highlights: [
        { tone: 'good', text: 'Top HK idea' },
        { tone: 'good', text: '35% below IV' },
      ],
      nextEarnings: { date: '2026-11-18', confirmed: false, source: 'yahoo' },
      earningsInDays: 40,
    }),
    boardRow({
      symbol: 'JPM',
      name: 'JPMorgan Chase',
      conviction: null,
      price: 333,
      changePct: 0.47,
      trend: 'side',
      ivRank: 7,
      roePct: 15.2,
      fcfYieldPct: null,
      pe: 16.6,
      value: { base: 278, priceRatio: 1.2, costRatio: null, stars: 2 },
      screen: 'EXCLUDED',
      nextEarnings: { date: '2026-10-13', confirmed: true, source: 'yahoo' },
      earningsInDays: 4,
      rank: null,
      composite: null,
      put: null,
      action: action('wait', 'Results due 2026-10-13: wait until after them'),
      highlights: [
        { tone: 'warn', text: 'Results in 4 days' },
        { tone: 'warn', text: '20% above IV' },
      ],
    }),
    boardRow({
      symbol: 'XOM',
      name: 'Exxon Mobil',
      conviction: 2,
      price: 168.94,
      changePct: 0.26,
      ivRank: 26,
      roePct: 7.5,
      fcfYieldPct: -2,
      pe: null,
      value: { base: 80, priceRatio: 2.1, costRatio: null, stars: 1 },
      nextEarnings: null,
      earningsInDays: null,
      rank: null,
      composite: null,
      put: null,
      action: action('avoid'),
      highlights: [],
    }),
    boardRow({
      symbol: 'KO',
      name: 'Coca-Cola',
      conviction: null,
      hasOpenPut: true,
      price: 71.2,
      changePct: 0,
      rank: null,
      composite: null,
      put: null,
      action: action('hold'),
      highlights: [{ tone: 'info', text: 'Open put' }],
    }),
    boardRow({
      symbol: 'AAPL',
      name: 'Apple',
      conviction: null,
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
      screen: null,
      nextEarnings: null,
      earningsInDays: null,
      rank: null,
      composite: null,
      put: null,
      action: action('needs_data'),
      highlights: [],
    }),
  ];
}

export const boardView = (
  rows: WatchBoardRow[] = sampleRows(),
  over: Partial<WatchBoardView> = {},
): WatchBoardView => ({
  asOf: AS_OF,
  generatedAt: `${AS_OF}T10:00:00.000Z`,
  rows,
  scored: true,
  ...over,
});

const STATUS: Record<WatchAction['kind'], WatchStatus> = {
  sell_put: { kind: 'idea', label: 'idea today', detail: null },
  wait: { kind: 'rejected', label: 'not recommended', detail: null },
  avoid: { kind: 'rejected', label: 'not recommended', detail: null },
  hold: { kind: 'open_put', label: 'open put: no new ideas', detail: null },
  needs_data: {
    kind: 'pending_first_ingest',
    label: 'waiting for first ingest',
    detail: 'run ingest to fetch its prices and filings',
  },
};

export function entryFor(row: WatchBoardRow, over: Partial<WatchEntryView> = {}): WatchEntryView {
  return {
    symbol: row.symbol,
    market: row.market,
    name: row.name,
    sector: row.sector,
    currency: row.currency,
    boardLot: row.market === 'HK' ? 100 : 100,
    solvencyModel: 'altman',
    solvencyInferred: false,
    reportingFrequency: 'quarterly',
    conviction: row.conviction,
    notes: null,
    maxCollateralPct: null,
    active: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    hasOpenPut: row.hasOpenPut,
    nextEarnings: row.nextEarnings,
    status: STATUS[row.action.kind],
    ...over,
  };
}

export function pausedEntry(symbol: string, over: Partial<WatchEntryView> = {}): WatchEntryView {
  return entryFor(boardRow({ symbol, name: `${symbol} Inc`, action: action('wait') }), {
    active: false,
    status: { kind: 'paused', label: 'not watching', detail: 'history is kept; resume any time' },
    ...over,
  });
}
