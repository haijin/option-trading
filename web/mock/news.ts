/**
 * Mock of the News page endpoints (src/server/api-types.ts, news section) with the sample data of
 * docs/prototypes/latest-news.html. "Today" is the prototype's sample day (Tue 13 Oct 2026, Hong Kong), not the real clock,
 * so the page always shows the same picture. Two extra stories are left unclassified to show the "New" state.
 */
import type {
  Market,
  NewsBriefDayView,
  NewsBriefView,
  NewsDaysView,
  NewsGroupView,
  NewsImpact,
  NewsItemView,
  NewsRefreshView,
  NewsRuleKey,
  NewsScope,
  NewsSearchView,
  NewsSessionId,
  NewsStandingKind,
  NewsStandingView,
  NewsStatusView,
  NewsView,
} from '../../src/server/api-types';
import { invalid } from './util';

export const NEWS_TODAY = '2026-10-13';
const NOW_MS = Date.parse('2026-10-13T07:45:00+08:00');
const FETCHED_AT = '2026-10-13T07:40:00+08:00';

type SampleScope = 'shortlist' | 'positions' | 'watched';
interface SampleName {
  name: string;
  scope: SampleScope;
  cls: NewsStandingKind;
  px: number;
  chg: number;
  stand: string;
  m: string;
}

const NAMES: Record<string, SampleName> = {
  NKE: {
    name: 'NIKE',
    scope: 'shortlist',
    cls: 'sell',
    px: 72.4,
    chg: 1.8,
    stand: 'Sell',
    m: '14 Nov · 65 put · 19.4%/yr',
  },
  META: {
    name: 'Meta Platforms',
    scope: 'shortlist',
    cls: 'sell',
    px: 718,
    chg: -1.1,
    stand: 'Sell, half size',
    m: '21 Nov · 640 put · 14.8%/yr',
  },
  '0700.HK': {
    name: 'Tencent',
    scope: 'shortlist',
    cls: 'sell',
    px: 612.5,
    chg: 1.6,
    stand: 'Sell',
    m: '29 Oct · 560 put · 16.2%/yr',
  },
  '9988.HK': {
    name: 'Alibaba',
    scope: 'shortlist',
    cls: 'wait',
    px: 171.9,
    chg: 4.9,
    stand: 'Wait (was Sell)',
    m: 'pullback toward 150',
  },
  PDD: {
    name: 'PDD Holdings',
    scope: 'shortlist',
    cls: 'sell',
    px: 121.3,
    chg: -0.6,
    stand: 'Sell',
    m: '14 Nov · 105 put · 17.1%/yr',
  },
  BX: {
    name: 'Blackstone',
    scope: 'shortlist',
    cls: 'sell',
    px: 158.2,
    chg: 0.4,
    stand: 'Sell',
    m: '14 Nov · 145 put · 13.2%/yr',
  },
  '1211.HK': {
    name: 'BYD',
    scope: 'positions',
    cls: 'open',
    px: 97.1,
    chg: -4.2,
    stand: 'Open put at risk',
    m: '29 Oct · 95 put · 2.2% OTM · 12 days',
  },
  JD: {
    name: 'JD.com',
    scope: 'positions',
    cls: 'open',
    px: 33.1,
    chg: 0.7,
    stand: 'Open put',
    m: '17 Oct · 31 put · 6.3% OTM · 4 days',
  },
  MSFT: {
    name: 'Microsoft',
    scope: 'positions',
    cls: 'open',
    px: 512.6,
    chg: -0.4,
    stand: 'Close or roll Monday',
    m: '31 Oct · 480 put · 6.4% OTM · 21 days',
  },
  TSLA: {
    name: 'Tesla',
    scope: 'watched',
    cls: 'wait',
    px: 429.8,
    chg: -2.3,
    stand: 'Wait until after earnings',
    m: '22 Oct',
  },
  COIN: {
    name: 'Coinbase',
    scope: 'watched',
    cls: 'avoid',
    px: 338.1,
    chg: -7.1,
    stand: 'Avoid',
    m: 'solvency screen fails',
  },
  '3690.HK': {
    name: 'Meituan',
    scope: 'watched',
    cls: 'wait',
    px: 118.4,
    chg: 2.3,
    stand: 'Wait for a close above 122',
    m: '',
  },
  NVDA: {
    name: 'NVIDIA',
    scope: 'watched',
    cls: 'wait',
    px: 183.2,
    chg: 0.9,
    stand: 'Wait: best put pays 7.9%',
    m: '',
  },
  AAPL: { name: 'Apple', scope: 'watched', cls: 'wait', px: 245.3, chg: 0.2, stand: 'Wait: premium too thin', m: '' },
  BIDU: {
    name: 'Baidu',
    scope: 'watched',
    cls: 'wait',
    px: 128.4,
    chg: 2.1,
    stand: 'Wait for a close above 132',
    m: '',
  },
  SE: { name: 'Sea', scope: 'watched', cls: 'wait', px: 168.7, chg: -1.4, stand: 'Wait for the trend to turn', m: '' },
  LULU: {
    name: 'lululemon',
    scope: 'watched',
    cls: 'wait',
    px: 171.5,
    chg: -0.8,
    stand: 'Wait: no support below',
    m: '',
  },
  SNOW: {
    name: 'Snowflake',
    scope: 'watched',
    cls: 'wait',
    px: 231.2,
    chg: 1.1,
    stand: 'Wait: no strike pays 10%',
    m: '',
  },
  PLTR: {
    name: 'Palantir',
    scope: 'watched',
    cls: 'avoid',
    px: 181.4,
    chg: 3.2,
    stand: 'Avoid',
    m: '3.1x intrinsic value',
  },
  '2318.HK': {
    name: 'Ping An',
    scope: 'watched',
    cls: 'wait',
    px: 52.3,
    chg: 0.6,
    stand: 'Wait: premium too thin',
    m: '',
  },
};

/** [sym, day, HKT time, impact, source, standing then, headline, summary, rules, citation [host, title]] */
type Row = [
  string,
  string,
  string,
  NewsImpact | null,
  string,
  string | null,
  string,
  string,
  [NewsRuleKey, string][],
  [string, string],
];
const ROWS: Row[] = [
  [
    'NKE',
    '2026-10-13',
    '05:10',
    'supports',
    'Company IR',
    null,
    'Nike reaffirms holiday-quarter guidance at its investor update; new North America head named.',
    'Supports the 14 Nov 65 put: guidance intact and no earnings inside the window (next ~18 Dec).',
    [
      ['e', 'Next earnings ~18 Dec, outside every 30 to 45 day expiry'],
      ['t', 'Still above the 50-day at 68; nothing changes the timing score (72)'],
    ],
    ['nike.com/investors', 'Investor update, 12 Oct'],
  ],
  [
    'NKE',
    '2026-10-01',
    '20:05',
    'supports',
    'Earnings',
    'Wait, gate WARN',
    'Nike Q1: revenue +1%, gross margin 42.2%, inventories down 2%.',
    'Supports: gate back to PASS on the FCF margin; price gapped above the 50-day. Became a Sell idea on 6 Oct.',
    [
      ['f', 'Quality gate WARN to PASS: FCF margin back above 8%, net cash'],
      ['t', 'Gapped above the 50-day and held it'],
    ],
    ['nike.com/investors', 'Q1 FY27 results'],
  ],
  [
    'NKE',
    '2026-10-13',
    '07:20',
    null,
    'Yahoo Finance',
    null,
    "NIKE's Digital Transformation: Competitive Edge or Cost Burden?",
    '',
    [],
    ['finance.yahoo.com', 'Headline, 13 Oct'],
  ],
  [
    'META',
    '2026-10-13',
    '03:30',
    'caution',
    'Company IR',
    null,
    'Meta sets Q3 results for Wed 29 Oct after the close.',
    'Caution: the date is now confirmed inside the 21 Nov window. The scanner already halves size; the 7 Nov expiry would avoid it but pays 9.1%.',
    [
      ['e', 'Confirmed event replaces the Yahoo estimate (was 28 Oct)'],
      ['p', 'Size rule: earnings in window = half size, unchanged'],
    ],
    ['investor.atmeta.com', 'Results date notice'],
  ],
  [
    'META',
    '2026-10-11',
    '18:40',
    'neutral',
    'Yahoo Finance',
    null,
    "EU opens a second DMA review of Meta's ad-free subscription tier.",
    'Neutral for a 10% out-of-the-money put: a fine would be under 1% of revenue; no rule touched.',
    [['f', 'Quality gate PASS; no change to FCF margin or net cash']],
    ['finance.yahoo.com', 'Headline, 11 Oct'],
  ],
  [
    '0700.HK',
    '2026-10-13',
    '07:02',
    'supports',
    'HKEXnews',
    null,
    'Tencent repurchased 1.5m shares for HK$0.92bn on 12 Oct; buyback total this year passes HK$70bn.',
    'Supports the 29 Oct 560 put: the daily buyback keeps a bid under the 50-day at 585.',
    [
      ['t', 'Price 4.7% above the 50-day, timing score 68'],
      ['f', 'Net cash, 4-star value, gate PASS'],
    ],
    ['hkexnews.hk', 'Next day disclosure return, 13 Oct'],
  ],
  [
    '0700.HK',
    '2026-10-10',
    '09:15',
    'caution',
    'Model (events scout)',
    null,
    "Q3 results expected Thu 12 Nov, per last year's pattern and the IR calendar.",
    'Caution: 12 Nov is outside the 29 Oct expiry but inside the Nov one. Added as an unconfirmed event; confirm it on the Data page or wait for the HKEXnews notice.',
    [['e', 'corporate_events row, source ai, confirmed false, WARN only until confirmed']],
    ['tencent.com/ir', 'Financial calendar'],
  ],
  [
    '0700.HK',
    '2026-10-06',
    '07:05',
    'neutral',
    'HKEXnews',
    null,
    'Tencent: monthly return on share capital movements for September.',
    'Neutral: routine filing; share count down 0.4% in the month.',
    [['f', 'No rule touched']],
    ['hkexnews.hk', 'Monthly return, 6 Oct'],
  ],
  [
    '9988.HK',
    '2026-10-13',
    '06:20',
    'caution',
    'Yahoo Finance',
    null,
    'Alibaba lifts cloud capex plan after the Qwen3 launch; shares +5% Monday, best day since June.',
    'Caution: now 14% above the 50-day, so timing wants a pullback toward 150 before selling the 29 Oct put. Same story moved it from Sell to Wait on Today.',
    [
      ['t', 'Timing score 41, extended; the 150 strike is 13% below spot'],
      ['f', 'Gate PASS, 4-star value, assignment at 150 would be welcome'],
    ],
    ['finance.yahoo.com', 'Headline, 12 Oct'],
  ],
  [
    '9988.HK',
    '2026-10-09',
    '10:30',
    'supports',
    'Company IR',
    'Sell · 29 Oct · 150 put',
    'Alibaba launches Qwen3-Max and opens its model to Hong Kong enterprise customers.',
    'Supports the 29 Oct 150 put: product cadence intact, price 6% above the 50-day.',
    [
      ['t', 'Timing score 64 that day'],
      ['f', 'Gate PASS'],
    ],
    ['alibabagroup.com', 'Press release, 9 Oct'],
  ],
  [
    'PDD',
    '2026-10-06',
    '21:10',
    'neutral',
    'Yahoo Finance',
    null,
    'PDD expands Temu local-seller programme to six more European markets.',
    'Neutral: no rule touched; the 105 strike sits under the 116 to 124 range either way.',
    [['t', 'Range-bound, timing score 58']],
    ['finance.yahoo.com', 'Headline, 6 Oct'],
  ],
  [
    'BX',
    '2026-10-12',
    '22:00',
    'neutral',
    'Company IR',
    null,
    'Blackstone to report Q3 on Thu 16 Oct before the open.',
    "Neutral: results fall before the 14 Nov window opens, so the scanner waits for Thursday's print and re-prices the put on Friday.",
    [['e', 'Earnings 16 Oct, 3 days away; idea is tagged "after earnings"']],
    ['blackstone.com/ir', 'Results date notice'],
  ],
  [
    '1211.HK',
    '2026-10-13',
    '06:48',
    'blocks',
    'HKEXnews',
    null,
    'BYD September NEV sales 396k, down 8% y/y, the first annual decline in five years; overseas sales +120%.',
    'Blocks: spot fell to 2.2% above your 95 strike. Assignment-risk alert sent 07:12; the model reads it as cyclical, thesis break: no. Stop rule (2x credit) is HK$0.40 away.',
    [
      ['p', 'Open 29 Oct 95 put, credit 2.10, mark 3.80 (1.8x)'],
      ['f', 'Quality gate PASS, 4-star value at 95; you said you would own it here'],
      ['t', 'Closed below the 100-day; next support 92'],
    ],
    ['hkexnews.hk', 'Voluntary announcement, 13 Oct'],
  ],
  [
    '1211.HK',
    '2026-10-11',
    '16:20',
    'caution',
    'Reuters (headline)',
    null,
    'EU to review definitive tariffs on China-built EVs after the price-undertaking talks stall.',
    'Caution: no rule touched today, but it is the second negative headline in three days on the same name.',
    [['e', 'No dated event; watch for a Commission decision date']],
    ['reuters.com', 'Headline, 11 Oct'],
  ],
  [
    '1211.HK',
    '2026-10-02',
    '08:30',
    'caution',
    'Yahoo Finance',
    'Open put · 29 Oct · 95 put · 7.8% OTM',
    'BYD cuts prices on twelve models in China by up to 12% ahead of Golden Week.',
    'Caution: margin pressure, but 7.8% out of the money with 27 days left; hold.',
    [
      ['p', 'Mark 1.9, 0.9x credit'],
      ['f', 'Operating margin trend WARN'],
    ],
    ['finance.yahoo.com', 'Headline, 2 Oct'],
  ],
  [
    'JD',
    '2026-10-12',
    '14:05',
    'caution',
    'Yahoo Finance',
    null,
    'Broker cuts JD.com margin forecast on food-delivery subsidies; keeps Buy.',
    'Caution: 4 days to expiry and 6.3% out of the money, so hold. A close under 31.5 would trigger the close rule.',
    [
      ['p', 'Hold to expiry stands; alert threshold 31.5'],
      ['f', 'Operating margin trend WARN if the Q3 print confirms it'],
    ],
    ['finance.yahoo.com', 'Headline, 12 Oct'],
  ],
  [
    'JD',
    '2026-09-30',
    '09:40',
    'neutral',
    'Company IR',
    'Open put · 17 Oct · 31 put · 8.1% OTM',
    'JD.com to report Q3 results in mid-November; date to be announced.',
    'Neutral: outside the 17 Oct expiry.',
    [['e', 'No dated event yet']],
    ['ir.jd.com', 'IR notice, 30 Sep'],
  ],
  [
    'MSFT',
    '2026-10-11',
    '20:10',
    'supports',
    'Company IR',
    null,
    'Microsoft adds Azure capacity in Malaysia and Japan; reiterates FY capex guidance.',
    "Supports holding the 480 put into Monday's 21-day close-or-roll; 71% of the credit is already captured.",
    [
      ['p', '21-day rule fires Monday regardless of news'],
      ['e', 'Earnings 29 Oct, after this expiry'],
    ],
    ['microsoft.com/investor', 'Press release, 11 Oct'],
  ],
  [
    'MSFT',
    '2026-10-08',
    '22:30',
    'neutral',
    'Yahoo Finance',
    'Open put · 31 Oct · 480 put · 5.9% OTM',
    'Microsoft and OpenAI finalise the restructured partnership terms.',
    'Neutral: no rule touched; the 480 strike is unchanged in risk.',
    [['f', 'Gate PASS']],
    ['finance.yahoo.com', 'Headline, 8 Oct'],
  ],
  [
    'TSLA',
    '2026-10-13',
    '02:15',
    'blocks',
    'Company IR',
    null,
    'Tesla confirms Q3 earnings call for Wed 22 Oct.',
    'Blocks new puts until 23 Oct: earnings sit inside every 30 to 45 day expiry.',
    [
      ['e', 'Earnings inside the window'],
      ['f', 'Price 3.8x intrinsic value (1 star)'],
    ],
    ['ir.tesla.com', 'Results date notice'],
  ],
  [
    'TSLA',
    '2026-10-02',
    '21:00',
    'blocks',
    'Event',
    'Wait',
    'Q3 deliveries beat; earnings call expected 22 Oct.',
    'Blocks new puts until after earnings: the date sits inside every 30 to 45 day expiry.',
    [
      ['e', 'Earnings inside the window'],
      ['f', 'Price 3.8x intrinsic value (1 star)'],
    ],
    ['ir.tesla.com', 'Deliveries release, 2 Oct'],
  ],
  [
    'COIN',
    '2026-10-12',
    '23:00',
    'blocks',
    'Signal',
    null,
    'COIN -7.1%, closed below the 50- and 100-day on the crypto sell-off.',
    'Blocks: trend flipped down and the quality gate already fails.',
    [
      ['t', 'Support at 320 is 5% away'],
      ['f', 'Solvency model below threshold'],
    ],
    ['scanner.local', 'Daily mark, 12 Oct'],
  ],
  [
    '3690.HK',
    '2026-10-13',
    '06:30',
    'neutral',
    'HKEXnews',
    null,
    'Meituan: monthly buyback disclosure, 2.1m shares.',
    'Neutral: routine disclosure; the name is still below the 200-day.',
    [['t', 'Downtrend; timing score 33']],
    ['hkexnews.hk', 'Next day disclosure return'],
  ],
  [
    '3690.HK',
    '2026-10-07',
    '11:20',
    'caution',
    'Reuters (headline)',
    null,
    'Meituan says food-delivery subsidies will continue through Q4; margin outlook cut.',
    'Caution: operating margin trend WARN deepens; stays Wait.',
    [
      ['f', 'Operating margin trend WARN'],
      ['t', 'Below the 200-day'],
    ],
    ['reuters.com', 'Headline, 7 Oct'],
  ],
  [
    'NVDA',
    '2026-10-07',
    '22:45',
    'neutral',
    'Yahoo Finance',
    null,
    'NVIDIA extends Blackwell supply agreement with a second foundry.',
    'Neutral: IV rank 18 is the reason this name waits, and the story does not move it.',
    [['t', 'Premium too thin at any strike in the band']],
    ['finance.yahoo.com', 'Headline, 7 Oct'],
  ],
  [
    'NVDA',
    '2026-10-13',
    '07:10',
    null,
    'Yahoo Finance',
    null,
    'Chip stocks mixed ahead of bank earnings as Treasury yields hold near highs.',
    '',
    [],
    ['finance.yahoo.com', 'Headline, 13 Oct'],
  ],
];

const marketOf = (sym: string): Market => (sym.endsWith('.HK') ? 'HK' : 'US');
const canonical = (sym: string): string => sym.replace(/\.HK$/, '');
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function standingThen(then: string): NewsStandingView {
  const at = then.indexOf(' · ');
  const label = at >= 0 ? then.slice(0, at) : (then.split(', ')[0] ?? then);
  const detail = at >= 0 ? then.slice(at + 3) : then.slice(label.length).replace(/^, /, '');
  const kind: NewsStandingKind = label.startsWith('Sell') ? 'sell' : label.startsWith('Open') ? 'open' : 'wait';
  return { kind, label, detail, strike: null, expiry: null, dte: null, otmPct: null };
}

const ITEMS: (NewsItemView & { sym: string })[] = ROWS.map((r, i) => {
  const [sym, day, time, impact, source, then, title, summary, rules, cite] = r;
  return {
    sym,
    id: i + 1,
    source,
    url: cite[0].includes('.')
      ? `https://${cite[0]}/${slug(title).slice(0, 40)}`
      : `https://example.com/${slug(title)}`,
    title,
    snippet: cite[1],
    publishedAt: new Date(`${day}T${time}:00+08:00`).toISOString(),
    day,
    impact,
    summary: impact ? summary.replace(/^(Supports|Caution|Blocks|Neutral)(:| for)?\s*/, '') : null,
    rules: impact ? rules.map(([key, text]) => ({ key, text })) : [],
    standingThen: impact && then ? standingThen(then) : null,
    judgedAt: impact ? new Date(`${day}T${time}:00+08:00`).toISOString() : null,
    confidence: impact ? 70 : null,
    model: impact ? 'claude-haiku-5-5' : null,
  };
});

// ------------------------------------------------------------------------------------------------ briefs
type Tape = [string, string, ('up' | 'dn')?];
type Brief = {
  sess: 'HK open' | 'US open';
  time: string;
  lead: string;
  tape: Tape[];
  pts: ['US' | 'HK·CN' | 'Macro' | 'Dates', string][];
  forput: string;
  srcs: [string, string, string][];
};
const BRIEFS: Record<string, Brief[]> = {
  '2026-10-13': [
    {
      sess: 'HK open',
      time: '07:40',
      lead: "Quiet US close ahead of Wednesday's CPI. HK set to open higher after stronger China export data; HK option premiums are the richer side this week.",
      tape: [
        ['S&P 500', '-0.3%', 'dn'],
        ['Nasdaq', '-0.5%', 'dn'],
        ['HSI fut', '+0.9%', 'up'],
        ['VIX', '17.2'],
        ['VHSI', '21.8'],
        ['UST 10y', '4.08%'],
        ['USDHKD', '7.78'],
        ['USDCNH', '7.09'],
      ],
      pts: [
        [
          'US',
          'Banks start Q3 reporting today (JPM, WFC, C); guidance on credit costs sets the tone for financials. Tech drifted lower on light volume.',
        ],
        [
          'HK·CN',
          "September exports +6.1% y/y, well above forecasts; Hang Seng futures point to a firm open. Tech names led Monday's rebound.",
        ],
        [
          'Macro',
          'US CPI Wed 20:30 HKT; a hot print would push the 10-year back above 4.2% and lift index volatility into expiry week.',
        ],
        [
          'Dates',
          'META and MSFT report 29 Oct; TSLA 22 Oct; Tencent 12 Nov (unconfirmed). HK October expiry is Thu 29 Oct.',
        ],
      ],
      forput:
        'US IV rank is mid-range (38), HK is rich (61). HK premiums pay better this week; for US names prefer expiries past the 15 Oct CPI and outside each earnings date.',
      srcs: [
        ['07:31', 'HKEX', 'Hang Seng Index futures pre-open indication'],
        ['07:05', 'Yahoo Finance', 'US stocks edge lower ahead of inflation data'],
        ['06:40', 'Reuters (headline)', 'China September exports beat forecasts'],
        ['06:10', 'CBOE', 'VIX close 17.2'],
        ['05:55', 'Company IR', 'Q3 reporting dates for JPM, WFC, C'],
      ],
    },
  ],
  '2026-10-12': [
    {
      sess: 'HK open',
      time: '07:35',
      lead: 'Risk-on Monday: HK tech bid after the Qwen3 news, US futures flat. Crypto weak over the weekend.',
      tape: [
        ['S&P fut', '+0.1%', 'up'],
        ['HSI fut', '+1.2%', 'up'],
        ['VIX', '16.4'],
        ['VHSI', '20.9'],
        ['UST 10y', '4.05%'],
      ],
      pts: [
        ['HK·CN', 'Alibaba and Tencent lead the pre-open after the weekend AI product news; HSI futures +1.2%.'],
        ['US', 'Flat futures; bank earnings start Tuesday.'],
        ['Macro', "CPI Wednesday is the week's event; no Fed speakers Monday."],
        ['Dates', 'JD 31 put expires Friday 17 Oct; BX reports Thu 16 Oct.'],
      ],
      forput:
        'HK IV rank 58 and rising: good day to sell HK puts on names that are not extended. Keep US sizes normal until CPI.',
      srcs: [
        ['07:20', 'HKEX', 'Pre-open indication'],
        ['07:00', 'Yahoo Finance', 'Weekend crypto sell-off'],
        ['06:30', 'Company IR', 'BX results date'],
      ],
    },
    {
      sess: 'US open',
      time: '21:05',
      lead: 'HK closed +1.4% with tech up 2.3%; Alibaba +5%. COIN -7% pre-market on the crypto sell-off; US cash open quiet.',
      tape: [
        ['HSI', '+1.4%', 'up'],
        ['HSTECH', '+2.3%', 'up'],
        ['S&P fut', '-0.2%', 'dn'],
        ['VIX', '16.9'],
        ['VHSI', '21.4'],
        ['UST 10y', '4.06%'],
      ],
      pts: [
        ['HK·CN', 'Alibaba +5%, now 14% above the 50-day: Today moved it from Sell to Wait. Tencent +1.8%, BYD -1.1%.'],
        ['US', 'COIN -7% pre-market; crypto names gap down. Megacaps flat.'],
        ['Macro', '10-year steady at 4.06% ahead of CPI.'],
        ['Dates', 'TSLA earnings date due this week; META date due this week.'],
      ],
      forput:
        'No new US puts today on crypto-linked names (COIN already Avoid). Alibaba 150 put waits for a pullback; Tencent 560 put is still the best HK idea.',
      srcs: [
        ['20:50', 'HKEX', 'Close'],
        ['20:30', 'Yahoo Finance', 'Pre-market movers'],
        ['20:10', 'CBOE', 'VIX'],
      ],
    },
  ],
  '2026-10-09': [
    {
      sess: 'HK open',
      time: '07:38',
      lead: 'Soft US close on Thursday (-0.6%) after a hawkish Fed speech; HK to open lower. Alibaba IR event after the close.',
      tape: [
        ['S&P 500', '-0.6%', 'dn'],
        ['HSI fut', '-0.7%', 'dn'],
        ['VIX', '18.1'],
        ['VHSI', '22.6'],
        ['UST 10y', '4.15%'],
      ],
      pts: [
        ['US', 'Fed\'s Waller flags "no rush" to cut; 10-year +7bp. Tech led the decline.'],
        ['HK·CN', 'Futures -0.7%; Alibaba hosts a cloud event today.'],
        ['Macro', 'Jobs report tonight 20:30 HKT.'],
        ['Dates', 'MSFT 480 put at 21 days on Mon 13 Oct.'],
      ],
      forput:
        'VIX 18 and VHSI 22.6: both sides pay. A down open in HK is the day to sell the Alibaba 150 and Tencent 560 puts if they hold the 50-day.',
      srcs: [
        ['07:25', 'HKEX', 'Pre-open indication'],
        ['06:55', 'Yahoo Finance', 'Fed speech recap'],
        ['06:20', 'CBOE', 'VIX'],
      ],
    },
  ],
};

const SESSION: Record<Brief['sess'], NewsSessionId> = { 'HK open': 'hk_open', 'US open': 'us_open' };

function briefViews(day: string): NewsBriefView[] {
  return (BRIEFS[day] ?? []).map((b, i) => {
    const at = (t: string): string => new Date(`${day}T${t}:00+08:00`).toISOString();
    return {
      id: Number(`${day.replace(/-/g, '')}${i}`),
      session: SESSION[b.sess],
      asOf: at(b.time),
      lead: b.lead,
      bullets: b.pts.map(([tag, text]) => ({ tag, text })),
      forPuts: b.forput,
      tape: b.tape.map(([label, value, tone]) => {
        const change = tone && value.endsWith('%') ? Number.parseFloat(value) : null;
        return {
          key: slug(label),
          label,
          value: change === null ? value : '',
          changePct: change,
          asOf: day,
        };
      }),
      sources: b.srcs.map(([t, source, title]) => ({
        url: `https://example.com/brief/${slug(`${source} ${title}`)}`,
        source,
        title,
        publishedAt: at(t),
      })),
      model: 'claude-haiku-5-5',
    };
  });
}

// ------------------------------------------------------------------------------------------------ helpers
const toMs = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const addDays = (d: string, n: number): string => new Date(toMs(d) + n * 86_400_000).toISOString().slice(0, 10);
const SEV: Record<string, number> = { blocks: 0, caution: 1, supports: 2, neutral: 3, none: 4 };

function scopeOf(q: URLSearchParams): NewsScope {
  const s = q.get('scope') ?? 'shortlist';
  if (s !== 'shortlist' && s !== 'positions' && s !== 'all')
    throw invalid('Query parameter "scope" must be shortlist, positions or all.');
  return s;
}
const inScope = (sym: string, scope: NewsScope): boolean => scope === 'all' || NAMES[sym]?.scope === scope;
const neutralOf = (q: URLSearchParams): boolean => (q.get('neutral') ?? '1') !== '0';

function standingOf(sym: string): NewsStandingView {
  const n = NAMES[sym] as SampleName;
  return { kind: n.cls, label: n.stand, detail: n.m, strike: null, expiry: null, dte: null, otmPct: null };
}

function groupsOf(
  items: (NewsItemView & { sym: string })[],
  syms: string[],
): { groups: NewsGroupView[]; quiet: NewsView['quiet']; total: number } {
  const groups: (NewsGroupView & { rank: number; newest: number })[] = [];
  const quiet: NewsView['quiet'] = [];
  let total = 0;
  for (const sym of syms) {
    const mine = items.filter((i) => i.sym === sym).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const n = NAMES[sym] as SampleName;
    if (mine.length === 0) {
      quiet.push({ market: marketOf(sym), symbol: canonical(sym) });
      continue;
    }
    total += mine.length;
    groups.push({
      market: marketOf(sym),
      symbol: canonical(sym),
      name: n.name,
      price: n.px,
      changePct: n.chg,
      standing: standingOf(sym),
      hasOpenPosition: n.scope === 'positions',
      items: mine.map(({ sym: _s, ...rest }) => rest),
      rank: Math.min(...mine.map((i) => SEV[i.impact ?? 'none'] as number)),
      newest: Date.parse(mine[0]?.publishedAt ?? ''),
    });
  }
  groups.sort((a, b) => a.rank - b.rank || b.newest - a.newest);
  return { groups: groups.map(({ rank: _r, newest: _n, ...g }) => g), quiet, total };
}

// ------------------------------------------------------------------------------------------------ refresh state
let refreshReads = 0;
let fetchedAt = FETCHED_AT;

function status(): NewsStatusView {
  const refreshing = refreshReads > 0;
  if (refreshing) {
    refreshReads--;
    if (refreshReads === 0) fetchedAt = '2026-10-13T07:52:00+08:00';
  }
  return {
    fetchedAt: new Date(fetchedAt).toISOString(),
    refreshing,
    lastFetch: {
      status: 'ok',
      finishedAt: new Date(fetchedAt).toISOString(),
      detail: '3 new of 41 stories from 28/28 feeds',
    },
    unclassified: ITEMS.filter((i) => i.impact === null).length,
    ai: { available: true, auto: true, model: 'claude-haiku-5-5', budgetUsd: 2, spentTodayUsd: 0.34 },
    earliestDay: '2026-09-30',
  };
}

// ------------------------------------------------------------------------------------------------ handlers
export function buildNews(q: URLSearchParams): NewsView {
  const scope = scopeOf(q);
  const daysRaw = q.get('days') ?? '3';
  if (!['1', '3', '7', '30'].includes(daysRaw)) throw invalid('Query parameter "days" must be 1, 3, 7 or 30.');
  const days = Number(daysRaw);
  const dateRaw = q.get('date');
  if (dateRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw))
    throw invalid('Query parameter "date" must be YYYY-MM-DD.');
  const date = dateRaw && dateRaw < NEWS_TODAY ? dateRaw : NEWS_TODAY;
  const rolling = date === NEWS_TODAY && days === 1;
  const from = rolling ? NOW_MS - 24 * 3_600_000 : Date.parse(`${addDays(date, -(days - 1))}T00:00:00+08:00`);
  const to = date === NEWS_TODAY ? NOW_MS + 1 : Date.parse(`${addDays(date, 1)}T00:00:00+08:00`);
  const showNeutral = neutralOf(q);
  const syms = Object.keys(NAMES).filter((s) => inScope(s, scope));
  const items = ITEMS.filter((i) => {
    const t = Date.parse(i.publishedAt);
    return inScope(i.sym, scope) && t >= from && t < to && (showNeutral || i.impact !== 'neutral');
  });
  const { groups, quiet, total } = groupsOf(items, syms);
  const count = (s: NewsScope): number => Object.keys(NAMES).filter((k) => inScope(k, s)).length;
  return {
    scope,
    date,
    today: NEWS_TODAY,
    days,
    rolling,
    hideNeutral: !showNeutral,
    counts: { shortlist: count('shortlist'), positions: count('positions'), all: count('all') },
    groups,
    quiet,
    total,
    status: status(),
  };
}

export function buildNewsDays(q: URLSearchParams): NewsDaysView {
  const month = q.get('month') ?? '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalid('Query parameter "month" must be YYYY-MM.');
  const scope = scopeOf(q);
  const showNeutral = neutralOf(q);
  const by = new Map<string, Set<NewsImpact | 'none'>>();
  for (const i of ITEMS) {
    if (!inScope(i.sym, scope) || i.day.slice(0, 7) !== month || (!showNeutral && i.impact === 'neutral')) continue;
    const set = by.get(i.day) ?? new Set();
    set.add(i.impact ?? 'none');
    by.set(i.day, set);
  }
  const briefDays = Object.keys(BRIEFS).filter((d) => d.slice(0, 7) === month);
  const keys = [...new Set([...by.keys(), ...briefDays])].filter((d) => d <= NEWS_TODAY).sort();
  return {
    month,
    scope,
    today: NEWS_TODAY,
    earliest: '2026-09-30',
    days: keys.map((day) => ({
      day,
      impacts: [...(by.get(day) ?? [])].sort((a, b) => (SEV[a] as number) - (SEV[b] as number)),
      brief: day in BRIEFS,
    })),
  };
}

export function searchNews(q: URLSearchParams): NewsSearchView {
  const text = (q.get('q') ?? '').trim();
  if (text === '') throw invalid('Query parameter "q" is required.');
  const scope = scopeOf(q);
  const needle = text.toLowerCase();
  const hit = ITEMS.filter(
    (i) =>
      inScope(i.sym, scope) &&
      `${i.title} ${i.sym} ${NAMES[i.sym]?.name ?? ''} ${i.source}`.toLowerCase().includes(needle),
  );
  const { groups, total } = groupsOf(
    hit,
    Object.keys(NAMES).filter((s) => inScope(s, scope)),
  );
  return { q: text, scope, total, groups };
}

export function newsBriefs(q: URLSearchParams): NewsBriefDayView {
  const date = q.get('date') ?? NEWS_TODAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('Query parameter "date" must be YYYY-MM-DD.');
  const briefs = briefViews(date);
  const first = Object.keys(BRIEFS).sort()[0] ?? null;
  let none: NewsBriefDayView['none'] = null;
  if (briefs.length === 0) {
    const dow = new Date(toMs(date)).getUTCDay();
    none =
      date > NEWS_TODAY
        ? 'not_yet'
        : first && date < first
          ? 'before_start'
          : dow === 0 || dow === 6
            ? 'weekend'
            : 'not_written';
  }
  return { date, briefs, none, firstBriefDay: first };
}

export function refreshNews(): NewsRefreshView {
  if (refreshReads > 0) return { queued: false, message: 'A refresh is already running.' };
  refreshReads = 3;
  return { queued: true, message: 'Refresh started.' };
}
