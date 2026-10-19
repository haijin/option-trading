/** The four starting points offered by "Apply a template". Plain ProseMirror JSON in the journal schema. */
import type { JournalDocJson, JournalNodeJson, JournalTemplateId } from './types';

const text = (t: string): JournalNodeJson => ({ type: 'text', text: t });
const p = (t = ''): JournalNodeJson => (t ? { type: 'paragraph', content: [text(t)] } : { type: 'paragraph' });
const h2 = (t: string): JournalNodeJson => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
const bullets = (...items: string[]): JournalNodeJson => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
});
const todos = (...items: string[]): JournalNodeJson => ({
  type: 'taskList',
  content: items.map((t) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(t)] })),
});
const callout = (t: string): JournalNodeJson => ({ type: 'blockquote', content: [p(t)] });
const doc = (...content: JournalNodeJson[]): JournalDocJson => ({ type: 'doc', content });

export interface JournalTemplate {
  id: Exclude<JournalTemplateId, 'free'>;
  label: string;
  blurb: string;
  doc: JournalDocJson;
}

export const JOURNAL_TEMPLATES: readonly JournalTemplate[] = [
  {
    id: 'morning',
    label: 'Morning plan',
    blurb:
      "Overnight moves, today's scan picks with your yes/no and why, orders you intend to place, what would make you stop.",
    doc: doc(
      h2('Overnight'),
      p(),
      h2('Scan picks: yes / no and why'),
      bullets(''),
      h2('Orders I intend to place'),
      bullets(''),
      h2('What would make me stop'),
      p(),
    ),
  },
  {
    id: 'evening',
    label: 'Evening review',
    blurb: "What happened, what you did and did not do, open positions snapshot, one lesson, tomorrow's checklist.",
    doc: doc(
      h2('What happened'),
      p(),
      h2('What I did, what I skipped'),
      p(),
      h2('Lesson'),
      callout('Lesson: '),
      h2('Tomorrow'),
      todos(''),
    ),
  },
  {
    id: 'trade',
    label: 'Trade note',
    blurb: 'One trade: thesis, strike and expiry reasoning, exit plan, what the scan said, how you feel about it.',
    doc: doc(
      h2('Thesis'),
      p(),
      h2('Strike and expiry'),
      p(),
      h2('Exit plan'),
      bullets('Take profit at', 'Roll at', 'Stop at'),
      h2('What the scan said'),
      p(),
    ),
  },
  {
    id: 'weekly',
    label: 'Weekly review',
    blurb: "Sunday: P&L by name, rule breaches, journal lessons re-read, next week's watch items.",
    doc: doc(
      h2('P&L by name'),
      p(),
      h2('Rule breaches'),
      bullets(''),
      h2('Lessons re-read'),
      p(),
      h2('Next week'),
      todos(''),
    ),
  },
];

export const templateById = (id: string): JournalTemplate | undefined => JOURNAL_TEMPLATES.find((t) => t.id === id);

/** True when the document has nothing in it but empty paragraphs (a template then fills it instead of appending). */
export function isEmptyDoc(d: JournalDocJson): boolean {
  const empty = (n: JournalNodeJson): boolean => n.type === 'paragraph' && !(n.content && n.content.length > 0);
  return (d.content ?? []).every(empty);
}

/** The document after applying a template: it replaces an empty entry and is appended below anything else. */
export function applyTemplate(current: JournalDocJson, id: Exclude<JournalTemplateId, 'free'>): JournalDocJson {
  const t = templateById(id);
  if (!t) return current;
  if (isEmptyDoc(current)) return structuredClone(t.doc);
  return { type: 'doc', content: [...(current.content ?? []), ...structuredClone(t.doc.content ?? [])] };
}
