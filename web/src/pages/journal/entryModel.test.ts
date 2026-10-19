import { describe, expect, it } from 'vitest';
import { JOURNAL_LIMITS, JOURNAL_TEMPLATES, type JournalDocJson, renderMarkdown } from '../../../../src/journal';
import type { JournalEntryView } from '../../api/types';
import {
  applyTemplateToDraft,
  blankDraft,
  type Draft,
  draftFromEntry,
  formatTags,
  isBlankDraft,
  parseTags,
  sameAsServer,
  toInput,
} from './entryModel';

const para = (text: string): JournalDocJson['content'] => [{ type: 'paragraph', content: [{ type: 'text', text }] }];
const docOf = (text: string): JournalDocJson => ({ type: 'doc', content: para(text) });

function entryOf(draft: Draft, patch: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'e1',
    date: '2026-10-13',
    title: draft.title || null,
    template: draft.template,
    marketView: draft.marketView,
    tags: draft.tags,
    status: 'draft',
    wordCount: 3,
    excerpt: '',
    mentions: [],
    thumbnailAssetId: null,
    aiPolished: false,
    updatedAt: '2026-10-13T08:00:00.000Z',
    doc: draft.doc,
    markdown: renderMarkdown(draft.doc),
    revisionNo: 4,
    createdAt: '2026-10-13T07:00:00.000Z',
    revisionCount: 2,
    lastAi: null,
    ...patch,
  };
}

describe('tags', () => {
  it('splits on spaces and commas, drops the hash, lower-cases and removes duplicates', () => {
    expect(parseTags('#roll-rule, #HK  breach #hk')).toEqual(['roll-rule', 'hk', 'breach']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags('# ## ,')).toEqual([]);
  });

  it('respects the server limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ');
    expect(parseTags(many)).toHaveLength(JOURNAL_LIMITS.tags);
    expect(parseTags('x'.repeat(100))[0]).toHaveLength(JOURNAL_LIMITS.tagChars);
  });

  it('writes tags the way the box shows them', () => {
    expect(formatTags(['roll-rule', 'hk'])).toBe('#roll-rule #hk');
    expect(formatTags([])).toBe('');
  });
});

describe('blank entries', () => {
  it('is blank only when nothing at all is typed', () => {
    expect(isBlankDraft(blankDraft())).toBe(true);
    expect(isBlankDraft({ ...blankDraft(), title: '  ' })).toBe(true);
    expect(isBlankDraft({ ...blankDraft(), title: 'x' })).toBe(false);
    expect(isBlankDraft({ ...blankDraft(), tags: ['hk'] })).toBe(false);
    expect(isBlankDraft({ ...blankDraft(), marketView: 'bearish' })).toBe(false);
    expect(isBlankDraft({ ...blankDraft(), doc: docOf('hello') })).toBe(false);
  });
});

describe('the body of a save', () => {
  it('sends the title trimmed (or null), the token and no derived fields', () => {
    const draft: Draft = { ...blankDraft(), title: '  Evening  ', doc: docOf('hi'), tags: ['hk'] };
    const input = toInput(draft, 3, 'user');
    expect(input).toEqual({
      title: 'Evening',
      template: null,
      marketView: 'neutral',
      tags: ['hk'],
      doc: draft.doc,
      revisionNo: 3,
    });
    expect('source' in input).toBe(false);
    expect(toInput({ ...draft, title: '   ' }, null, 'user').title).toBeNull();
    expect(toInput(draft, null, 'user').revisionNo).toBeNull();
  });

  it('marks a template save', () => {
    expect(toInput(blankDraft(), 1, 'template').source).toBe('template');
  });
});

describe('applying a template', () => {
  const evening = JOURNAL_TEMPLATES.find((t) => t.id === 'evening');

  it('fills an empty entry and takes the template as its label', () => {
    const { draft, appended } = applyTemplateToDraft(blankDraft(), 'evening');
    expect(appended).toBe(false);
    expect(draft.template).toBe('evening');
    expect(draft.doc).toEqual(evening?.doc);
    // the template's own document is not shared with the entry
    expect(draft.doc).not.toBe(evening?.doc);
  });

  it('appends to an entry that has text and keeps its existing label', () => {
    const start: Draft = { ...blankDraft(), doc: docOf('my notes'), template: 'morning' };
    const { draft, appended } = applyTemplateToDraft(start, 'evening');
    expect(appended).toBe(true);
    expect(draft.template).toBe('morning');
    expect(draft.doc.content?.[0]).toEqual(start.doc.content?.[0]);
    expect(draft.doc.content).toHaveLength(1 + (evening?.doc.content?.length ?? 0));
  });

  it('labels an unlabelled entry with the appended template', () => {
    const { draft } = applyTemplateToDraft({ ...blankDraft(), doc: docOf('notes') }, 'trade');
    expect(draft.template).toBe('trade');
  });
});

describe('comparing with the server', () => {
  it('is the same when title, view, tags and markdown agree, whatever the JSON spelling', () => {
    const draft: Draft = { ...blankDraft(), title: 'T', doc: docOf('same'), tags: ['a'], marketView: 'bullish' };
    const server = entryOf(draft);
    expect(sameAsServer(draft, server)).toBe(true);
    expect(sameAsServer({ ...draft, doc: docOf('different') }, server)).toBe(false);
    expect(sameAsServer({ ...draft, title: 'U' }, server)).toBe(false);
    expect(sameAsServer({ ...draft, tags: [] }, server)).toBe(false);
    expect(sameAsServer({ ...draft, marketView: 'bearish' }, server)).toBe(false);
    expect(sameAsServer(draftFromEntry(server), server)).toBe(true);
  });
});
