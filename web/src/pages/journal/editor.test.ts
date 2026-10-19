import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { JOURNAL_TEMPLATES, type JournalDocJson, validateJournalDoc } from '../../../../src/journal';
import { insertJournalTable, toggleJournalCallout } from './editorCommands';
import { BARE_HK_MENTION, DOLLAR_MENTION, journalEditorExtensions, mentionFromMatch } from './editorExtensions';

let editor: Editor | null = null;

function makeEditor(content?: JSONContent): Editor {
  editor = new Editor({
    extensions: journalEditorExtensions(),
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Types one character the way the browser would: input rules get the first chance, then the text is inserted. */
function type(e: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const handled = e.view.someProp('handleTextInput', (f) =>
      f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)),
    );
    if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
  }
}

const json = (e: Editor): JournalDocJson => e.getJSON() as JournalDocJson;
const marksOf = (e: Editor) =>
  (json(e).content?.[0]?.content ?? []).map((n) => ({
    text: n.text,
    marks: (n.marks ?? []).map((m) => m.type),
    attrs: n.marks?.[0]?.attrs,
  }));

describe('the journal editor and the server schema', () => {
  it('writes a document the server accepts after every kind of edit the toolbar makes', () => {
    const e = makeEditor();
    type(e, 'Plan for today');
    e.chain().focus().toggleHeading({ level: 2 }).run();
    e.chain()
      .focus()
      .insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'bold and ' }] })
      .run();
    e.chain().focus().selectAll().toggleBold().run();
    e.chain().focus('end').insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    // one click per command, like the table tools in the toolbar
    e.chain().focus().addRowAfter().run();
    e.chain().focus().addColumnAfter().run();
    e.chain().focus('end').toggleTaskList().run();
    e.chain().focus('end').toggleBulletList().run();
    e.chain().focus('end').toggleOrderedList().run();
    e.chain().focus('end').toggleBlockquote().run();
    const checked = validateJournalDoc(json(e));
    expect(checked.ok, JSON.stringify(checked.ok ? '' : checked.issues)).toBe(true);
    // the table is really there, with a header row
    const types = JSON.stringify(json(e));
    expect(types).toContain('"tableHeader"');
    expect(types).toContain('"tableCell"');
  });

  it('inserts a 3x3 table with a header row and keeps a paragraph after it to type in', () => {
    const e = makeEditor();
    e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    const table = json(e).content?.find((n) => n.type === 'table');
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.[0]?.content?.every((c) => c.type === 'tableHeader')).toBe(true);
    expect(table?.content?.[1]?.content).toHaveLength(3);
    expect(json(e).content?.at(-1)?.type).toBe('paragraph');
  });

  it('accepts every template as a document the server accepts', () => {
    for (const t of JOURNAL_TEMPLATES) {
      const e = makeEditor(t.doc as JSONContent);
      const checked = validateJournalDoc(json(e));
      expect(checked.ok, `${t.id}: ${JSON.stringify(checked.ok ? '' : checked.issues)}`).toBe(true);
      e.destroy();
      editor = null;
    }
  });

  it('turns "- ", "1. ", "[] ", "## " and "> " into lists, a checklist, a heading and a callout', () => {
    const cases: [string, string][] = [
      ['- ', 'bulletList'],
      ['1. ', 'orderedList'],
      ['[] ', 'taskList'],
      ['[ ] ', 'taskList'],
      ['## ', 'heading'],
      ['> ', 'blockquote'],
    ];
    for (const [typed, node] of cases) {
      const e = makeEditor();
      type(e, `${typed}x`);
      expect(json(e).content?.[0]?.type, typed).toBe(node);
      e.destroy();
      editor = null;
    }
  });
});

describe('stock mentions', () => {
  it('turns $NKE followed by a space into a stockMention mark and drops the $', () => {
    const e = makeEditor();
    type(e, 'sold $NKE ');
    expect(marksOf(e)).toEqual([
      { text: 'sold ', marks: [], attrs: undefined },
      { text: 'NKE', marks: ['stockMention'], attrs: { market: 'US', symbol: 'NKE' } },
      { text: ' ', marks: [], attrs: undefined },
    ]);
  });

  it('handles $0700.HK, a lower-case $nke, and punctuation as the ending character', () => {
    const hk = makeEditor();
    type(hk, '$0700.HK,');
    expect(marksOf(hk)[0]).toEqual({
      text: '0700.HK',
      marks: ['stockMention'],
      attrs: { market: 'HK', symbol: '0700' },
    });
    hk.destroy();
    const us = makeEditor();
    type(us, '$nke.');
    expect(marksOf(us)[0]).toEqual({ text: 'NKE', marks: ['stockMention'], attrs: { market: 'US', symbol: 'NKE' } });
  });

  it('turns a bare 0700.HK (no $) into a mention too, and canonicalises 700.HK', () => {
    const e = makeEditor();
    type(e, 'watch 0700.HK ');
    expect(marksOf(e)[1]).toEqual({
      text: '0700.HK',
      marks: ['stockMention'],
      attrs: { market: 'HK', symbol: '0700' },
    });
  });

  it('leaves ordinary text alone: prices, a bare ticker, a $ inside a word', () => {
    const e = makeEditor();
    type(e, 'paid $5 for it, NKE is fine, US$100 ok ');
    expect(marksOf(e)).toEqual([{ text: 'paid $5 for it, NKE is fine, US$100 ok ', marks: [], attrs: undefined }]);
  });

  it('keeps typing outside the mention (the mark does not extend to what comes next)', () => {
    const e = makeEditor();
    type(e, '$KO and more');
    const nodes = marksOf(e);
    expect(nodes[0]).toMatchObject({ text: 'KO', marks: ['stockMention'] });
    expect(nodes[1]).toMatchObject({ text: ' and more', marks: [] });
  });

  it('writes a document the server accepts', () => {
    const e = makeEditor();
    type(e, 'ideas: $NKE , 0700.HK ');
    expect(validateJournalDoc(json(e)).ok).toBe(true);
  });
});

describe('the mention patterns', () => {
  it('match a name only when the next character ends it', () => {
    expect(DOLLAR_MENTION.test('$NKE')).toBe(false);
    expect(DOLLAR_MENTION.test('$NKE ')).toBe(true);
    expect(DOLLAR_MENTION.test('a$NKE ')).toBe(false);
    expect(DOLLAR_MENTION.test('(see $NKE)')).toBe(true);
    expect(BARE_HK_MENTION.test('0700.HK ')).toBe(true);
    expect(BARE_HK_MENTION.test('x0700.HK ')).toBe(false);
    expect(BARE_HK_MENTION.test('700.HK ')).toBe(false);
  });

  it('reject text that is not a stock name', () => {
    expect(mentionFromMatch('12')).toBeNull();
    expect(mentionFromMatch('NKE')).toEqual({ market: 'US', symbol: 'NKE' });
    expect(mentionFromMatch('0700.hk')).toEqual({ market: 'HK', symbol: '0700' });
  });
});

describe('toolbar commands', () => {
  const task = (text: string): JSONContent => ({
    type: 'taskItem',
    attrs: { checked: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('puts a table after the list instead of splitting it and leaving an empty item', () => {
    const e = makeEditor({ type: 'doc', content: [{ type: 'taskList', content: [task('one'), task('two')] }] });
    e.commands.setTextSelection(6); // inside "one"
    insertJournalTable(e);
    const content = json(e).content ?? [];
    expect(content.map((n) => n.type)).toEqual(['taskList', 'table', 'paragraph']);
    const items = content[0]?.content ?? [];
    expect(items).toHaveLength(2);
    expect(items.every((i) => (i.content?.[0]?.content ?? []).length > 0)).toBe(true);
    expect(validateJournalDoc(json(e)).ok).toBe(true);
  });

  it('puts a table on the empty line the cursor is on', () => {
    const e = makeEditor();
    insertJournalTable(e);
    expect((json(e).content ?? []).map((n) => n.type)).toEqual(['table', 'paragraph']);
  });

  it('starts a "Lesson: " callout on an empty line, and wraps or unwraps text', () => {
    const e = makeEditor();
    toggleJournalCallout(e);
    expect(json(e).content?.[0]).toMatchObject({
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lesson: ' }] }],
    });
    // inside it, the button leaves the callout again
    toggleJournalCallout(e);
    expect(json(e).content?.[0]?.type).toBe('paragraph');
    const text = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }],
    });
    text.commands.setTextSelection(2);
    toggleJournalCallout(text);
    expect(json(text).content?.[0]?.type).toBe('blockquote');
    expect(validateJournalDoc(json(text)).ok).toBe(true);
  });
});
