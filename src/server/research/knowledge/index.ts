/**
 * The sell-put knowledge bundle behind the Ask chat (docs/designs/trade-skills-integration.md, stage T2): ten pitfalls
 * adapted from himself65/trade-skills (MIT, see LICENSE.md) and two Hong Kong notes of our own. A situation map attaches
 * only the files a question is about, so the prompt stays small and the answer stays grounded. Pure apart from reading the
 * markdown files next to this module, which are cached after the first read.
 */
import { readFileSync } from 'node:fs';

export type PitfallId = 4 | 7 | 13 | 19 | 21 | 24 | 30 | 31 | 36 | 37;

export const PITFALL_FILES: Record<PitfallId, string> = {
  4: '04-flip-on-invalidation.md',
  7: '07-iv-crush-favours-short.md',
  13: '13-take-profit-discipline.md',
  19: '19-direction-vs-vega.md',
  21: '21-event-iv-vs-demand-iv.md',
  24: '24-capped-upside-vs-conviction.md',
  30: '30-stop-distance-sets-size.md',
  31: '31-daily-loss-limit.md',
  36: '36-forward-aligned-vrp.md',
  37: '37-iv-floor-with-catalyst.md',
};

export const HK_NOTE_FILES = ['contract-multiplier.md', 'expiry-rule.md'] as const;

/** At most this many pitfalls go into one prompt (the first matches win, in situation order). */
export const MAX_PITFALLS = 6;

export type AskTargetKind = 'idea' | 'position';

export interface Situation {
  name: string;
  /** Lower-case. ASCII keywords match on word boundaries; CJK keywords match anywhere. */
  keywords: readonly string[];
  pitfalls: readonly PitfallId[];
}

/** Keyword -> pitfalls, from the analysis.md idea in the source repository, reduced to what a put seller asks. */
export const SITUATIONS: readonly Situation[] = [
  {
    name: 'sell',
    keywords: [
      'sell',
      'selling',
      'sold',
      'short put',
      'sell put',
      'sell a put',
      'write',
      'premium',
      'credit',
      'iv high',
      'iv is high',
      'high iv',
      'iv rank',
      'ivr',
      'vrp',
      'edge',
      'worth selling',
      '收租',
      '卖put',
      '卖 put',
      '卖出',
      '沽',
      '权利金',
      '隐含波动率高',
      '隐波高',
      'iv高',
      'iv 高',
      'iv很高',
      '值得卖',
    ],
    pitfalls: [36, 19, 7, 21],
  },
  {
    name: 'results',
    keywords: [
      'result',
      'results',
      'earnings',
      'print',
      'report date',
      'results date',
      'catalyst',
      'event',
      '业绩',
      '财报',
      '季报',
      '年报',
      '中报',
      '公布',
    ],
    pitfalls: [7, 21, 37],
  },
  {
    name: 'size',
    keywords: [
      'size',
      'sizing',
      'how many',
      'how much',
      'contracts',
      'lots',
      'drawdown',
      'risk',
      'leverage',
      'margin',
      'notional',
      'exposure',
      'too big',
      '仓位',
      '手数',
      '几张',
      '几手',
      '多少张',
      '回撤',
      '杠杆',
      '风险',
      '保证金',
      '名义',
    ],
    pitfalls: [30, 31],
  },
  {
    name: 'manage',
    keywords: [
      'roll',
      'rolling',
      'close',
      'closing',
      'take profit',
      'buy back',
      'buyback',
      'exit',
      '50%',
      'stop',
      'assign',
      'assigned',
      'assignment',
      'expire',
      'expiry',
      'hold',
      '平仓',
      '止盈',
      '止损',
      '展期',
      '移仓',
      '回购',
      '买回',
      '接货',
      '行权',
      '到期',
      '持有',
    ],
    pitfalls: [13, 4],
  },
  {
    name: 'wait',
    keywords: [
      'wait',
      'low iv',
      'iv low',
      'iv is low',
      'cheap',
      'floor',
      'percentile',
      'ramp',
      'too early',
      '再等',
      '等等',
      'iv低',
      'iv 低',
      'iv很低',
      '隐波低',
      '便宜',
      '百分位',
    ],
    pitfalls: [37, 19, 36],
  },
  {
    name: 'conviction',
    keywords: [
      'bullish',
      'conviction',
      'upside',
      'rally',
      'going up',
      'go up',
      'own the shares',
      'buy the stock',
      'spread',
      '看多',
      '看涨',
      '上涨',
      '大涨',
      '买股票',
      '正股',
    ],
    pitfalls: [24, 19],
  },
];

/** What a question with no matching keyword gets: the sell-put core for an idea, position management for an open put. */
export const DEFAULT_PITFALLS: Record<AskTargetKind, readonly PitfallId[]> = {
  idea: [36, 19],
  position: [13, 4],
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAscii = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);

function hasKeyword(text: string, keyword: string): boolean {
  if (!isAscii(keyword)) return text.includes(keyword);
  return new RegExp(`(?:^|[^a-z0-9%])${escapeRe(keyword)}(?=$|[^a-z0-9])`).test(text);
}

/** The situations a question touches, in map order. */
export function matchSituations(question: string): Situation[] {
  const text = question.toLowerCase().replace(/\s+/g, ' ').trim();
  return SITUATIONS.filter((s) => s.keywords.some((k) => hasKeyword(text, k)));
}

/** Pitfalls to attach for a question: the matched situations' lists in order, deduplicated, capped; a default when none match. */
export function matchPitfalls(question: string, kind: AskTargetKind): PitfallId[] {
  const out: PitfallId[] = [];
  for (const s of matchSituations(question)) for (const p of s.pitfalls) if (!out.includes(p)) out.push(p);
  if (out.length === 0) out.push(...DEFAULT_PITFALLS[kind]);
  return out.slice(0, MAX_PITFALLS);
}

// ------------------------------------------------------------------------------------------------ files
export interface KnowledgeDoc {
  /** "36" for a pitfall, "hk-multiplier" for a note. */
  id: string;
  title: string;
  /** The markdown after the frontmatter. */
  body: string;
}

const cache = new Map<string, KnowledgeDoc>();

function readDoc(rel: string, fallbackId: string): KnowledgeDoc {
  const hit = cache.get(rel);
  if (hit) return hit;
  const raw = readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const front = m ? (m[1] as string) : '';
  const body = (m ? (m[2] as string) : raw).trim();
  const id = /^id:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? fallbackId;
  const title = /^title:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? fallbackId;
  const doc = { id, title, body };
  cache.set(rel, doc);
  return doc;
}

export const pitfallDoc = (id: PitfallId): KnowledgeDoc => readDoc(`./pitfalls/${PITFALL_FILES[id]}`, String(id));
export const hkNotes = (): KnowledgeDoc[] => HK_NOTE_FILES.map((f) => readDoc(`./hk/${f}`, f));
export const rulesText = (): string => readDoc('./rules.md', 'rules').body;
export const ALL_PITFALL_IDS = Object.keys(PITFALL_FILES).map(Number) as PitfallId[];
