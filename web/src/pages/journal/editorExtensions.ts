/**
 * The extensions of the journal editor. Everything that defines the document (nodes, marks, attributes) comes from
 * `journalSchemaExtensions()`, the same list the server validates with. This file only adds behaviour that has no
 * schema of its own: undo history, the placeholder, cursors, a trailing paragraph, and the typing rules that turn
 * `$NKE ` and `0700.HK ` into a stock mention. Figure and Snapshot node views are added here in stages J2 and J4.
 */
import { type AnyExtension, Extension, InputRule } from '@tiptap/core';
import { Dropcursor, Gapcursor, Placeholder, TrailingNode, UndoRedo } from '@tiptap/extensions';
import { type JournalMentionRef, journalSchemaExtensions, mentionLabel, parseMention } from '../../../../src/journal';
import { figureExtension } from './FigureView';
import type { UploadManager } from './uploads';

/** The schema's extensions with the figure given its node view (the schema itself is untouched). */
export function withFigureView<T extends { name: string }>(
  extensions: T[],
  uploads: UploadManager | null,
): AnyExtension[] {
  return extensions.map((ext) => (ext.name === 'figure' ? figureExtension(uploads) : (ext as unknown as AnyExtension)));
}

export const EDITOR_PLACEHOLDER = 'What happened today, what you did, what you will do tomorrow…';

/** What may stand in front of a name for it to count as a word of its own. */
const LEAD = String.raw`(^|[\s(\[,;:!?"'])`;
/** What ends a name: the space or punctuation the person types next. */
const END = String.raw`([\s.,;:!?)\]])`;

/** `$NKE ` or `$0700.HK ` (the `$` is typed by hand or with the toolbar button). */
export const DOLLAR_MENTION = new RegExp(`${LEAD}\\$(\\d{4,5}\\.[Hh][Kk]|[A-Za-z][A-Za-z0-9]{0,9})${END}$`);
/** A bare `0700.HK ` with no `$`. US tickers need the `$` (a bare word could be anything). */
export const BARE_HK_MENTION = new RegExp(`${LEAD}(\\d{4,5}\\.[Hh][Kk])${END}$`);

/** The stock a regex match names, or null when the text is not a name (`$12`, `99999.HK` stays text too). */
export function mentionFromMatch(name: string): JournalMentionRef | null {
  const ref = parseMention(name);
  if (!ref) return null;
  if (ref.market === 'HK' && !/^\d{4,5}$/.test(ref.symbol)) return null;
  return ref;
}

function mentionRule(find: RegExp, hasDollar: boolean): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const markType = state.schema.marks.stockMention;
      if (!markType) return null;
      const lead = match[1] ?? '';
      const name = match[2] ?? '';
      const ref = mentionFromMatch(name);
      if (!ref) return null;
      // The text before the cursor is `<lead>[$]<name><typed char>`: the replaced part is `[$]<name>`.
      const from = range.from + lead.length;
      const to = from + (hasDollar ? 1 : 0) + name.length;
      const existing = state.doc.rangeHasMark(from, to, markType);
      if (existing) return null;
      state.tr.replaceWith(from, to, state.schema.text(mentionLabel(ref), [markType.create(ref)]));
      state.tr.removeStoredMark(markType);
      return undefined;
    },
  });
}

/** Typing `$NKE` or `0700.HK` followed by a space or punctuation makes the name a `stockMention` mark. */
export const StockMentionRules = Extension.create({
  name: 'stockMentionRules',
  addInputRules() {
    return [mentionRule(DOLLAR_MENTION, true), mentionRule(BARE_HK_MENTION, false)];
  },
});

export interface EditorExtensionOptions {
  /** The uploads in flight, for the image node view. */
  uploads?: UploadManager | null;
}

export function journalEditorExtensions(options: EditorExtensionOptions = {}) {
  return [
    ...withFigureView(journalSchemaExtensions(), options.uploads ?? null),
    UndoRedo,
    Placeholder.configure({
      placeholder: ({ editor }) => (editor.isEmpty ? EDITOR_PLACEHOLDER : ''),
      showOnlyCurrent: false,
    }),
    Dropcursor,
    Gapcursor,
    TrailingNode,
    StockMentionRules,
  ];
}
