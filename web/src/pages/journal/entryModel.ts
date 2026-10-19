/**
 * The editable shape of one journal entry on the client, and the small pure rules around it: tags, blank entries, the
 * body of a save, applying a template. No React, no network.
 */
import {
  applyTemplate,
  EMPTY_DOC,
  isEmptyDoc,
  JOURNAL_LIMITS,
  type JournalDocJson,
  type JournalMarketView,
  type JournalTemplateId,
  normaliseTag,
  renderMarkdown,
} from '../../../../src/journal';
import type { JournalEntryInput, JournalEntryView } from '../../api/types';

/** Everything a person edits in an entry. */
export interface Draft {
  title: string;
  tags: string[];
  marketView: JournalMarketView;
  template: JournalTemplateId | null;
  doc: JournalDocJson;
}

export type SaveSource = 'user' | 'template';

export const blankDoc = (): JournalDocJson => structuredClone(EMPTY_DOC) as unknown as JournalDocJson;

export const blankDraft = (): Draft => ({
  title: '',
  tags: [],
  marketView: 'neutral',
  template: null,
  doc: blankDoc(),
});

export function draftFromEntry(entry: JournalEntryView): Draft {
  return {
    title: entry.title ?? '',
    tags: [...entry.tags],
    marketView: entry.marketView,
    template: entry.template,
    doc: entry.doc,
  };
}

/** Nothing typed: no title, no tags, a neutral view and only empty paragraphs. Such an entry is never sent to the server. */
export function isBlankDraft(d: Draft): boolean {
  return d.title.trim() === '' && d.tags.length === 0 && d.marketView === 'neutral' && isEmptyDoc(d.doc);
}

/**
 * `#roll-rule, #HK  breach` -> `['roll-rule', 'hk', 'breach']`: split on spaces and commas, drop the `#`, lower-case,
 * drop duplicates and anything over the server's limits.
 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const tag = normaliseTag(raw.trim().replace(/^#+/, '').slice(0, JOURNAL_LIMITS.tagChars));
    if (tag !== null && !out.includes(tag)) out.push(tag);
    if (out.length >= JOURNAL_LIMITS.tags) break;
  }
  return out;
}

/** `['roll-rule', 'hk']` -> `#roll-rule #hk` (how the tags box shows them). */
export const formatTags = (tags: readonly string[]): string => tags.map((t) => `#${t}`).join(' ');

/** The body of a save. The server derives markdown, search text, word count and mentions itself. */
export function toInput(draft: Draft, revisionNo: number | null, source: SaveSource): JournalEntryInput {
  const input: JournalEntryInput = {
    title: draft.title.trim() === '' ? null : draft.title.trim().slice(0, JOURNAL_LIMITS.titleChars),
    template: draft.template,
    marketView: draft.marketView,
    tags: draft.tags,
    doc: draft.doc,
    revisionNo,
  };
  if (source === 'template') input.source = 'template';
  return input;
}

export type TemplateId = Exclude<JournalTemplateId, 'free'>;

/**
 * What applying a template does: an empty entry is filled with it, anything else gets it appended below. The entry's
 * template label becomes the new one when the entry was empty or had none.
 */
export function applyTemplateToDraft(draft: Draft, id: TemplateId): { draft: Draft; appended: boolean } {
  const appended = !isEmptyDoc(draft.doc);
  return {
    appended,
    draft: {
      ...draft,
      doc: applyTemplate(draft.doc, id),
      template: !appended || draft.template === null ? id : draft.template,
    },
  };
}

/** True when what is typed here is what the server already holds (so a copy kept on the phone adds nothing). */
export function sameAsServer(draft: Draft, server: JournalEntryView): boolean {
  return (
    draft.title.trim() === (server.title ?? '').trim() &&
    draft.marketView === server.marketView &&
    draft.tags.join(' ') === server.tags.join(' ') &&
    renderMarkdown(draft.doc) === server.markdown
  );
}

export const TEMPLATE_LABEL: Record<JournalTemplateId, string> = {
  morning: 'Morning plan',
  evening: 'Evening review',
  trade: 'Trade note',
  weekly: 'Weekly review',
  free: 'Free write',
};
