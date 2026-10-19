/**
 * The Daily Journal document schema: one definition for the server (validation, derived text) and the editor.
 * Pure: no DOM, no database, no clock. The stored source of truth is ProseMirror JSON in exactly this schema.
 *
 * Allowed nodes: doc, paragraph, text, heading (level 2 only), bulletList, orderedList, listItem, taskList, taskItem,
 * blockquote, table, tableRow, tableHeader, tableCell, figure, snapshot, hardBreak.
 * Allowed marks: bold, italic, strike, stockMention (market, symbol).
 * Anything else is rejected by `validateJournalDoc` (validate.ts); this file only describes what is allowed.
 */
import { getSchema, Mark, mergeAttributes, Node } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import Italic from '@tiptap/extension-italic';
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Strike from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Text from '@tiptap/extension-text';

export const JOURNAL_LIMITS = {
  /** Serialized document, bytes. */
  docBytes: 512 * 1024,
  titleChars: 200,
  tags: 20,
  tagChars: 40,
  instructionChars: 500,
  captionChars: 300,
  /** Deepest allowed nesting of nodes (doc = depth 0). Lists in lists in a table cell stay well under it. */
  maxDepth: 24,
  maxNodes: 20_000,
  snapshotColumns: 12,
  snapshotRows: 100,
  snapshotCellChars: 80,
} as const;

export const JOURNAL_NODE_NAMES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'figure',
  'snapshot',
  'hardBreak',
] as const;
export type JournalNodeName = (typeof JOURNAL_NODE_NAMES)[number];

export const JOURNAL_MARK_NAMES = ['bold', 'italic', 'strike', 'stockMention'] as const;
export type JournalMarkName = (typeof JOURNAL_MARK_NAMES)[number];

/** A stock name inside the text: `$NKE`, `0700.HK`. `symbol` is the canonical symbol (HK: four or five digits). */
export const StockMention = Mark.create({
  name: 'stockMention',
  inclusive: false,
  excludes: 'stockMention',
  addAttributes() {
    return {
      market: {
        default: 'US',
        parseHTML: (el) => el.getAttribute('data-market') ?? 'US',
        renderHTML: (attrs) => ({ 'data-market': attrs.market }),
      },
      symbol: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-symbol') ?? '',
        renderHTML: (attrs) => ({ 'data-symbol': attrs.symbol }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-stock]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'tk', 'data-stock': '' }, HTMLAttributes), 0];
  },
});

/**
 * An uploaded image with a caption. `assetId` is the only image attribute and must name a journal asset of the same
 * user (checked by the server); there is no `src`, so nothing in the document can point at another origin.
 */
export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      assetId: { default: null, parseHTML: (el) => el.getAttribute('data-asset-id') },
      caption: { default: null, parseHTML: (el) => el.querySelector('figcaption')?.textContent ?? null },
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-asset-id]' }];
  },
  renderHTML({ node }) {
    const id = String(node.attrs.assetId ?? '');
    const caption = node.attrs.caption ? String(node.attrs.caption) : '';
    return [
      'figure',
      { 'data-asset-id': id },
      ['img', { src: `/api/journal/assets/${id}`, alt: caption }],
      ...(caption ? [['figcaption', {}, caption]] : []),
    ];
  },
});

/**
 * A frozen copy of app data (open positions, today's scan picks) as a table. It stores the rows it showed that day on
 * purpose: the entry says what the user saw, and re-rendering from live tables would rewrite history. Read-only.
 */
export const Snapshot = Node.create({
  name: 'snapshot',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: 'positions', parseHTML: (el) => el.getAttribute('data-kind') ?? 'positions' },
      asOf: { default: '', parseHTML: (el) => el.getAttribute('data-as-of') ?? '' },
      title: { default: '', parseHTML: (el) => el.getAttribute('data-title') ?? '' },
      columns: { default: [], parseHTML: () => [] },
      align: { default: [], parseHTML: () => [] },
      rows: { default: [], parseHTML: () => [] },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-snapshot]' }];
  },
  renderHTML({ node }) {
    const rows = Array.isArray(node.attrs.rows) ? (node.attrs.rows as string[][]) : [];
    const columns = Array.isArray(node.attrs.columns) ? (node.attrs.columns as string[]) : [];
    return [
      'div',
      { 'data-snapshot': '', 'data-kind': String(node.attrs.kind), class: 'snap' },
      ['div', { class: 'cap' }, `${String(node.attrs.title)} · ${String(node.attrs.asOf)}`],
      [
        'table',
        {},
        ['thead', {}, ['tr', {}, ...columns.map((c) => ['th', {}, c])]],
        ['tbody', {}, ...rows.map((r) => ['tr', {}, ...r.map((c) => ['td', {}, c])])],
      ],
    ];
  },
});

/** Table cells hold paragraphs only (no nested tables, lists or quotes): the editor is phone-first. */
const JournalTableCell = TableCell.extend({ content: 'paragraph+' });
const JournalTableHeader = TableHeader.extend({ content: 'paragraph+' });

/** Every schema-defining extension. The editor adds its own UI-only ones (history, placeholder) on top of these. */
export function journalSchemaExtensions() {
  return [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [2] }),
    Blockquote,
    HardBreak,
    BulletList,
    OrderedList,
    ListItem,
    TaskList,
    TaskItem,
    Table,
    TableRow,
    JournalTableHeader,
    JournalTableCell,
    Figure,
    Snapshot,
    Bold,
    Italic,
    Strike,
    StockMention,
  ];
}

let cached: ReturnType<typeof getSchema> | null = null;

/** The ProseMirror schema built from the extensions above (built once per process). */
export function journalSchema() {
  if (!cached) cached = getSchema(journalSchemaExtensions());
  return cached;
}

/** A document with one empty paragraph: what a new entry starts as. */
export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
