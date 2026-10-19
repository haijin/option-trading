/**
 * Everything the server derives from a validated document: deterministic Markdown (export, the AI prompt, Research
 * previews), plain text (search), a word count and the stock names mentioned. Pure functions of the document.
 */
import type { JournalDerived, JournalDocJson, JournalMentionRef, JournalNodeJson } from './types';

/** `$NKE`, `$BRK.B`, `$0700.HK`: a name after a dollar sign. A sentence-ending full stop is not part of it. */
const BARE_MENTION = /(?<![A-Za-z0-9$])\$(\d{4,5}\.HK|[A-Z][A-Z0-9]{0,8}(?:\.[A-Z]{1,2})?)(?![A-Za-z0-9])/g;

/** `0700` -> `0700.HK`, `NKE` -> `NKE`: how a mention is written in the text. */
export const mentionLabel = (m: JournalMentionRef): string => (m.market === 'HK' ? `${m.symbol}.HK` : m.symbol);

/** HK codes are four digits, zero-padded: `700`, `00700` and `0700` are the same name. */
const canonHk = (digits: string): string => digits.replace(/^0+(?=\d)/, '').padStart(4, '0');

/** The reverse of `mentionLabel` for text typed by a person (`0700.HK`, `700.HK`, `nke`); null when it is not a name. */
export function parseMention(raw: string): JournalMentionRef | null {
  const s = raw.trim().replace(/^\$/, '').toUpperCase();
  const hk = /^(\d{1,5})\.HK$/.exec(s);
  if (hk) return { market: 'HK', symbol: canonHk(hk[1] as string) };
  if (/^[A-Z][A-Z0-9]{0,8}(?:\.[A-Z]{1,2})?$/.test(s) && !/\.HK$/.test(s)) return { market: 'US', symbol: s };
  return null;
}

/** The name a `stockMention` mark points at, with the HK code in canonical form. */
function markRef(attrs: Record<string, unknown> | undefined): JournalMentionRef {
  const symbol = String(attrs?.symbol ?? '');
  return attrs?.market === 'HK' ? { market: 'HK', symbol: canonHk(symbol) } : { market: 'US', symbol };
}

const sameMention = (a: JournalMentionRef, b: JournalMentionRef): boolean =>
  a.market === b.market && a.symbol === b.symbol;

function addMention(list: JournalMentionRef[], ref: JournalMentionRef): void {
  if (!list.some((x) => sameMention(x, ref))) list.push(ref);
}

/** Every `$SYMBOL` in a Markdown text (marks are written that way by `renderMarkdown`), in order, without duplicates. */
export function mentionsOfMarkdown(markdown: string): JournalMentionRef[] {
  const out: JournalMentionRef[] = [];
  for (const m of markdown.matchAll(BARE_MENTION)) {
    const ref = parseMention(m[1] as string);
    if (ref) addMention(out, ref);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ inline text
const MD_ESCAPE = /([\\`*_~[\]<>|])/g;
const MD_UNESCAPE = /\\([\\`*_~[\]<>|])/g;
/** Emphasis markers that are formatting, not an escaped literal (`\*`). */
const EMPHASIS = /(?<!\\)[*_~]/g;

function inlineMarkdown(node: JournalNodeJson): string {
  if (node.type === 'hardBreak') return '  \n';
  if (node.type !== 'text') return '';
  const text = node.text ?? '';
  const marks = node.marks ?? [];
  const mention = marks.find((m) => m.type === 'stockMention');
  let out = mention ? `$${mentionLabel(markRef(mention.attrs))}` : text.replace(MD_ESCAPE, '\\$1');
  if (marks.some((m) => m.type === 'strike')) out = `~~${out}~~`;
  if (marks.some((m) => m.type === 'italic')) out = `*${out}*`;
  if (marks.some((m) => m.type === 'bold')) out = `**${out}**`;
  return out;
}

const inlineOf = (n: JournalNodeJson): string => (n.content ?? []).map(inlineMarkdown).join('');

/** A paragraph that would read as a heading, list or quote when parsed back gets its first character escaped. */
function guardLineStart(line: string): string {
  return /^(#{1,6}\s|[-+*]\s|>|\d+[.)]\s)/.test(line) ? `\\${line}` : line;
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
/** A table cell on one line. Text from the document is already escaped (`|` included); raw app strings go through `rawCell`. */
const cell = (s: string): string => oneLine(s);
const rawCell = (s: string): string => s.replace(MD_ESCAPE, '\\$1');

function tableMarkdown(columns: string[], aligns: ('l' | 'r')[], rows: string[][]): string {
  const n = Math.max(columns.length, ...rows.map((r) => r.length), 1);
  const pad = (r: string[]): string[] => Array.from({ length: n }, (_, i) => cell(r[i] ?? ''));
  const head = pad(columns);
  const sep = Array.from({ length: n }, (_, i) => (aligns[i] === 'r' ? '---:' : '---'));
  return [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...rows.map((r) => `| ${pad(r).join(' | ')} |`)].join(
    '\n',
  );
}

function tableNodeMarkdown(table: JournalNodeJson): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((c) => (c.content ?? []).map(inlineOf).join('<br>')),
  );
  const first = table.content?.[0];
  const headerRow = first?.content?.length ? first.content.every((c) => c.type === 'tableHeader') : false;
  if (rows.length === 0) return '';
  if (headerRow) return tableMarkdown(rows[0] as string[], [], rows.slice(1));
  return tableMarkdown(
    Array.from({ length: (rows[0] ?? []).length }, () => ''),
    [],
    rows,
  );
}

// ------------------------------------------------------------------------------------------------ blocks
function listMarkdown(list: JournalNodeJson, indent: string): string {
  const lines: string[] = [];
  let n = Number(list.attrs?.start ?? 1);
  for (const item of list.content ?? []) {
    let marker = '- ';
    if (list.type === 'orderedList') marker = `${n++}. `;
    else if (list.type === 'taskList') marker = item.attrs?.checked ? '- [x] ' : '- [ ] ';
    const pad = ' '.repeat(marker.length);
    const [first, ...rest] = item.content ?? [];
    lines.push(`${indent}${marker}${first ? guardLineStart(inlineOf(first)) : ''}`);
    for (const child of rest) {
      if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList')
        lines.push(listMarkdown(child, indent + pad));
      else if (child.type === 'paragraph') lines.push(`${indent}${pad}${inlineOf(child)}`);
      else lines.push(blockMarkdown(child).replace(/^/gm, indent + pad));
    }
  }
  return lines.join('\n');
}

function blockMarkdown(n: JournalNodeJson): string {
  switch (n.type) {
    case 'paragraph':
      return guardLineStart(inlineOf(n));
    case 'heading':
      return `## ${inlineOf(n)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listMarkdown(n, '');
    case 'blockquote':
      return (n.content ?? [])
        .map(blockMarkdown)
        .filter((s) => s !== '')
        .join('\n\n')
        .replace(/^/gm, '> ');
    case 'table':
      return tableNodeMarkdown(n);
    case 'figure': {
      const caption = oneLine(String(n.attrs?.caption ?? '')).replace(/[[\]]/g, '');
      return `![${caption}](asset:${String(n.attrs?.assetId ?? '')})`;
    }
    case 'snapshot': {
      const a = n.attrs ?? {};
      const table = tableMarkdown(
        ((a.columns as string[]) ?? []).map(rawCell),
        (a.align as ('l' | 'r')[]) ?? [],
        ((a.rows as string[][]) ?? []).map((r) => r.map(rawCell)),
      );
      const title = oneLine(rawCell(String(a.title ?? '')));
      return `<!-- snapshot:${String(a.kind)}:${String(a.asOf)} -->\n${title ? `**${title}**\n\n` : ''}${table}`;
    }
    default:
      return '';
  }
}

/** Deterministic Markdown for a document: the same document always renders to the same bytes. */
export function renderMarkdown(doc: JournalDocJson): string {
  return (doc.content ?? [])
    .map(blockMarkdown)
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}

// ------------------------------------------------------------------------------------------------ plain text, words, mentions
interface Walked {
  plain: string[];
  prose: string[];
  mentions: JournalMentionRef[];
  assetIds: string[];
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading']);
const ITEM_BLOCKS = new Set(['listItem', 'taskItem', 'tableRow']);

function walk(n: JournalNodeJson, out: Walked, inCell: boolean): void {
  if (n.type === 'text') {
    const text = n.text ?? '';
    out.plain.push(text);
    out.prose.push(text);
    const mark = n.marks?.find((m) => m.type === 'stockMention');
    if (mark) {
      addMention(out.mentions, markRef(mark.attrs));
    } else {
      for (const m of text.matchAll(BARE_MENTION)) {
        const ref = parseMention(m[1] as string);
        if (ref) addMention(out.mentions, ref);
      }
    }
    return;
  }
  if (n.type === 'hardBreak') {
    out.plain.push('\n');
    out.prose.push(' ');
    return;
  }
  if (n.type === 'figure') {
    const caption = String(n.attrs?.caption ?? '');
    if (caption) {
      out.plain.push(`${caption}\n`);
      out.prose.push(`${caption}\n`);
    }
    const id = String(n.attrs?.assetId ?? '');
    if (id && !out.assetIds.includes(id)) out.assetIds.push(id);
    return;
  }
  if (n.type === 'snapshot') {
    // App data: searchable, but not words the author wrote.
    const a = n.attrs ?? {};
    const cells = [String(a.title ?? ''), ...((a.columns as string[]) ?? []), ...((a.rows as string[][]) ?? []).flat()];
    out.plain.push(`${cells.join(' ')}\n`);
    return;
  }
  const cellBox = n.type === 'tableCell' || n.type === 'tableHeader';
  for (const child of n.content ?? []) walk(child, out, inCell || cellBox);
  // A paragraph inside a table cell ends with a space, not a line break, so a row stays one line of text.
  const lineEnd = inCell ? ' ' : '\n';
  if (TEXT_BLOCKS.has(n.type)) {
    out.plain.push(lineEnd);
    out.prose.push(lineEnd);
  } else if (ITEM_BLOCKS.has(n.type)) {
    out.plain.push('\n');
    out.prose.push('\n');
  }
}

let segmenter: Intl.Segmenter | null = null;

/** Words in a text: runs of letters or digits, and every CJK character on its own (so Chinese entries count too). */
export function countWords(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  let n = 0;
  for (const seg of segmenter.segment(text)) if (seg.isWordLike) n++;
  return n;
}

const tidy = (parts: string[]): string =>
  parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

/** Markdown, search text, word count (prose only, not app snapshots), mentions and figure ids of a document. */
export function deriveFromDoc(doc: JournalDocJson): JournalDerived {
  const out: Walked = { plain: [], prose: [], mentions: [], assetIds: [] };
  for (const block of doc.content ?? []) walk(block, out, false);
  const prose = tidy(out.prose);
  return {
    markdown: renderMarkdown(doc),
    plain: tidy(out.plain),
    wordCount: countWords(prose),
    mentions: out.mentions,
    assetIds: out.assetIds,
  };
}

// ------------------------------------------------------------------------------------------------ list helpers
/** The first lines of prose in a Markdown entry: no headings, tables, comments or checklist boxes. */
export function excerptOf(markdown: string, max = 180): string {
  const picked: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('<!--') || line.startsWith('!['))
      continue;
    picked.push(
      line
        .replace(/^>\s*/, '')
        .replace(/^[-+*]\s+(\[[ x]\]\s+)?/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(EMPHASIS, ''),
    );
    if (picked.join(' ').length >= max) break;
  }
  const text = picked.join(' ').replace(MD_UNESCAPE, '$1').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const LESSON_LINE = /^(?:>\s*)*Lessons?:\s*(.+)$/i;

/** Paragraphs that start with "Lesson:" (also inside a callout), taken from the Markdown of an entry. */
export function extractLessons(markdown: string): string[] {
  const lessons: string[] = [];
  for (const raw of markdown.split('\n')) {
    const m = LESSON_LINE.exec(raw.trim());
    if (m?.[1]) lessons.push(m[1].replace(EMPHASIS, '').replace(MD_UNESCAPE, '$1').trim());
  }
  return lessons;
}

export interface LessonItem {
  /** The lesson as plain text: no Markdown marks, `$NKE` written as `NKE`. */
  text: string;
  mentions: JournalMentionRef[];
  /** `entry`: a paragraph the author wrote that starts with "Lesson:". `ai`: a bullet of an accepted "Lessons & actions" section. */
  source: 'entry' | 'ai';
}

/** The heading the AI's "Lessons & actions" mode appends. */
const AI_LESSONS_HEADING = /^##\s+Lessons?\s*(?:&|and)\s*actions\b/i;

const plainLine = (line: string): string =>
  line.replace(BARE_MENTION, '$1').replace(EMPHASIS, '').replace(MD_UNESCAPE, '$1').trim();

/**
 * Lessons in an entry, in the order they appear: every "Lesson:" paragraph (also inside a callout), and every bullet under
 * an accepted "## Lessons & actions (AI draft)" heading (its checklist items are to-dos, not lessons).
 */
export function lessonsOf(markdown: string): LessonItem[] {
  const items: LessonItem[] = [];
  let inAiSection = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) inAiSection = AI_LESSONS_HEADING.test(line);
    const m = LESSON_LINE.exec(line);
    if (m?.[1]) {
      items.push({ mentions: mentionsOfMarkdown(m[1]), text: plainLine(m[1]), source: 'entry' });
      continue;
    }
    if (!inAiSection) continue;
    const bullet = /^[-*+]\s+(?!\[[ xX]\])(.+)$/.exec(line);
    if (bullet?.[1]) items.push({ mentions: mentionsOfMarkdown(bullet[1]), text: plainLine(bullet[1]), source: 'ai' });
  }
  return items;
}

/**
 * The line of an entry that mentions a stock, as plain text, for a "Your notes" card: the first prose line (not a table,
 * heading or comment) that names it, clipped.
 */
export function snippetFor(markdown: string, label: string, max = 200): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = new RegExp(`(?<![A-Za-z0-9$])\\$${escaped}(?![A-Za-z0-9])`);
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!name.test(line) || line.startsWith('|') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const text = plainLine(line.replace(/^>\s*/, '').replace(/^(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ''))
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return '';
}
