import type { PresetView, SkillId, SkillInfoView } from '../api-types';

/** The seven stock-level skills the user chose from the Invest-agent repository (the other eleven are theme, industry, portfolio or publishing tools). */
export interface SkillDef extends Omit<SkillInfoView, 'available' | 'unavailableReason'> {
  /** Prompt file name under `<root>/skills/`; null for the local screen. */
  file: string | null;
}

export const SKILLS: SkillDef[] = [
  {
    id: 'quality-screen',
    zhName: '去劣筛选',
    enName: 'Quality screen',
    effort: 'local',
    local: true,
    file: null,
    does: 'Seven hard filters (10-year ROE, 5-year free cash flow, interest cover, gross margin, cash conversion, net margin, dilution) and three exemptions. Rules out clearly non-first-rate companies. Computed from your stored numbers, no AI.',
    steps: ['Read the stored statements', 'Check the 7 filters and the exemptions'],
  },
  {
    id: 'investment-checklist',
    zhName: '巴菲特买入前Checklist',
    enName: 'Buffett checklist',
    effort: 'medium',
    local: false,
    file: 'investment-checklist.md',
    does: 'Six gates (circle of competence, good business, moat, management, price, discipline), the five-sentence mirror test and eight instant vetoes.',
    steps: [
      'Grade AI-research bias (A / B / C)',
      'Collect profitability, valuation, growth, health, moat evidence, management, last 6 months',
      'Gate 1: circle of competence',
      'Gate 2: good business',
      'Gate 3: moat',
      'Gate 4: management',
      'Gate 5: price (three scenarios)',
      'Gate 6: discipline',
      'Mirror test and 8 quick vetoes',
      'Write the report',
    ],
  },
  {
    id: 'investment-research',
    zhName: '四大师综合研究',
    enName: 'Four-masters research',
    effort: 'heavy',
    local: false,
    file: 'investment-research.md',
    does: 'Business essence, moat, inversion (how it fails), management, long-run trend, valuation with margin of safety, then a decision memo. Opens with an AI-bias grade and ends with a data audit.',
    steps: [
      'Grade AI-research bias',
      'Collect data and cross-check key figures against two sources',
      'Business essence',
      'Moat',
      'Inversion: ways it can fail',
      'Management',
      'Long-run industry trend',
      'Valuation: reverse DCF and three scenarios',
      'Decision memo',
      'Data audit',
    ],
  },
  {
    id: 'earnings-review',
    zhName: '财报精读',
    enName: 'Earnings deep-read',
    effort: 'medium',
    local: false,
    file: 'earnings-review.md',
    does: 'Primary filings only: key figures extracted and cross-checked, management discussion, footnotes and hidden items, comparison with history.',
    steps: [
      'Grade data availability',
      'Fetch primary filings',
      'Extract and verify key figures',
      'Read the management discussion',
      'Footnotes and hidden items',
      'Compare with history',
      'Write the report',
      'Data audit',
    ],
  },
  {
    id: 'management-deep-dive',
    zhName: '管理层纵深',
    enName: 'Management deep dive',
    effort: 'medium',
    local: false,
    file: 'management-deep-dive.md',
    does: 'CEO competence, integrity record, capital allocation, governance, outside-in checks and what happens if the CEO leaves. "Buying a stock is buying the people."',
    steps: [
      'Identify key people',
      'CEO competence',
      'Integrity record',
      'Capital allocation',
      'Governance',
      'Outside-in checks',
      'If the CEO leaves',
      'Write the report',
    ],
  },
  {
    id: 'news-pulse',
    zhName: '新闻脉搏',
    enName: 'News pulse',
    effort: 'light',
    local: false,
    file: 'news-pulse.md',
    does: 'Four scouts (company events, regulation, peers, sentiment): what happened, the real cause of a price move, and whether the thesis needs a re-review.',
    steps: [
      'Confirm scope and trigger',
      'Grade information availability',
      'Scout: events, regulation, peers, sentiment',
      'Attribute the price move',
      'Thesis re-review trigger',
      'Write the report',
    ],
  },
  {
    id: 'thesis-tracker',
    zhName: '论文追踪',
    enName: 'Thesis tracker',
    effort: 'light',
    local: false,
    file: 'thesis-tracker.md',
    does: 'Writes the 200-word thesis, assumptions, red lines and valuation anchor, then checks them later. For a put seller this is the reason you would accept assignment.',
    steps: [
      'Collect data',
      'Core thesis in 200 words',
      'Assumptions list',
      'Red lines',
      'Valuation anchor',
      'Write the thesis',
    ],
  },
];

export const SKILL_IDS: SkillId[] = SKILLS.map((s) => s.id);

export const PRESETS: PresetView[] = [
  {
    id: 'assign',
    name: 'Would I accept assignment?',
    description: 'Put-seller pre-trade check',
    skillIds: ['quality-screen', 'investment-checklist', 'thesis-tracker', 'news-pulse'],
  },
  { id: 'numbers', name: 'Just the numbers', description: 'Instant, local, no AI', skillIds: ['quality-screen'] },
  {
    id: 'full',
    name: 'Full deep dive',
    description: 'Filings, people, long-form memo',
    skillIds: ['quality-screen', 'investment-research', 'earnings-review', 'management-deep-dive', 'thesis-tracker'],
  },
  {
    id: 'leader',
    name: 'Leader check',
    description: 'Numbers, news, and the reason to hold it if the entry fails',
    skillIds: ['quality-screen', 'news-pulse', 'thesis-tracker'],
  },
];

export const skillDef = (id: string): SkillDef | undefined => SKILLS.find((s) => s.id === id);
