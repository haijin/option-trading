/**
 * The AI rewrite of a journal entry, as pure functions (docs/designs/daily-journal.md, "AI rewrite pipeline"):
 * cut the blocks the model must never touch out of the document, build the prompt, check what comes back, parse it into
 * the journal schema and put the blocks back. No model call, clock, file or database in here; the service runs the model.
 *
 * Nothing the model writes is trusted. It is Markdown that has to pass every check below and the document schema before it
 * is even offered to the author, and it never changes the entry until the author accepts it.
 */
import MarkdownIt from 'markdown-it';
import { countWords, mentionLabel, parseMention, renderMarkdown } from './derive';
import type { JournalDocJson, JournalMarkJson, JournalMentionRef, JournalNodeJson } from './types';
import { validateJournalDoc } from './validate';

// ------------------------------------------------------------------------------------------------ modes
export const JOURNAL_AI_MODES = [
  'polish',
  'tighten',
  'structure',
  'lessons',
  'translate_zh',
  'translate_en',
  'custom',
] as const;
export type JournalAiMode = (typeof JOURNAL_AI_MODES)[number];

export const MODE_LABEL: Record<JournalAiMode, string> = {
  polish: 'Polish',
  tighten: 'Tighten',
  structure: 'Structure',
  lessons: 'Lessons & actions',
  translate_zh: '中文',
  translate_en: 'English',
  custom: 'Custom',
};

const MODE_RULES: Record<JournalAiMode, string> = {
  polish:
    "Fix spelling, grammar and flow. Keep the author's own words, view and order as far as possible. Do not make it noticeably shorter or longer.",
  tighten:
    'Cut the length by about half. Remove repetition and filler. Keep every decision and the reason for it. You may drop a detail; you may never change one.',
  structure:
    'Add "##" headings (Market, Positions, Decisions, Lessons, Tomorrow, as they fit) and group the author\'s sentences under them, using bullets where the author lists things. You may move a placeholder under a heading but never change it.',
  lessons:
    'Return the entry EXACTLY as given, unchanged, then append a section that starts with the line "## Lessons & actions (AI draft)". The section is at most 300 words: two to four bullets with lessons drawn only from what the author wrote, then the next steps the author planned or implied as a checklist of "- [ ] " items.',
  translate_zh:
    'Translate the entry into Simplified Chinese. Keep tickers, numbers, currency symbols, dates and placeholders exactly as written.',
  translate_en:
    'Translate the entry into English. Keep tickers, numbers, currency symbols, dates and placeholders exactly as written.',
  custom: "Follow the author's instruction below, within the rules that apply to every mode.",
};

// ------------------------------------------------------------------------------------------------ locked blocks
export type LockedKind = 'FIG' | 'TBL' | 'SNAP' | 'TODO';

export interface LockedBlock {
  /** `FIG:1`, `TBL:2`: the placeholder is `[[FIG:1]]`. */
  id: string;
  kind: LockedKind;
  node: JournalNodeJson;
}

const KIND_OF: Record<string, LockedKind> = { figure: 'FIG', table: 'TBL', snapshot: 'SNAP', taskList: 'TODO' };
const PLACEHOLDER = /\[\[((?:FIG|TBL|SNAP|TODO):\d+)\]\]/g;
const LOCK_LABEL: Record<LockedKind, string> = { FIG: 'image', TBL: 'table', SNAP: 'snapshot', TODO: 'checklist' };

export interface CutResult {
  /** The entry as Markdown with every locked block replaced by its `[[KIND:n]]` line: what the model sees. */
  markdown: string;
  locked: LockedBlock[];
  /** Words of prose the model will work on (placeholders excluded). */
  words: number;
  /** "image, snapshot, checklist": for the progress line. */
  summary: string;
}

/** Cuts images, tables, snapshots and checklists out of the document and replaces each with a placeholder paragraph. */
export function cutLockedBlocks(doc: JournalDocJson): CutResult {
  const counters: Record<LockedKind, number> = { FIG: 0, TBL: 0, SNAP: 0, TODO: 0 };
  const locked: LockedBlock[] = [];
  const walk = (n: JournalNodeJson): JournalNodeJson => {
    const kind = KIND_OF[n.type];
    if (kind) {
      counters[kind] += 1;
      const id = `${kind}:${counters[kind]}`;
      locked.push({ id, kind, node: n });
      // Letters, digits, `@` and `:` pass through the Markdown writer untouched; the brackets are put on afterwards.
      return { type: 'paragraph', content: [{ type: 'text', text: `@@${id}@@` }] };
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  const stripped: JournalDocJson = { ...doc, content: (doc.content ?? []).map(walk) };
  const markdown = renderMarkdown(stripped).replace(/@@((?:FIG|TBL|SNAP|TODO):\d+)@@/g, '[[$1]]');
  const kinds = [...new Set(locked.map((l) => LOCK_LABEL[l.kind]))];
  return {
    markdown,
    locked,
    words: countWords(markdown.replace(PLACEHOLDER, ' ')),
    summary: kinds.join(', '),
  };
}

// ------------------------------------------------------------------------------------------------ prompt
export interface PromptInput {
  mode: JournalAiMode;
  /** The author's own instruction (custom mode, or an extra wish in any mode). At most 500 characters. */
  instruction?: string | null;
  /** A reference block of positions and scan picks, only when the author switched the context on. */
  context?: string | null;
  markdown: string;
}

export function buildPrompt(i: PromptInput): string {
  const lines = [
    'You rewrite a private investment diary entry for its author.',
    `Mode: ${MODE_LABEL[i.mode]}. ${MODE_RULES[i.mode]}`,
    'Rules that apply to every mode:',
    "- Keep the author's meaning, decisions and voice. Do not add opinions, trades, advice or facts that are not in the text.",
    '- Keep every number, ticker, strike, date, currency and percentage exactly as written. Write numbers as digits.',
    '- Keep every placeholder line exactly as it is, each on its own line: [[FIG:1]], [[TBL:1]], [[SNAP:1]], [[TODO:1]] and so on. They stand for images, tables and checklists you cannot see; do not remove, repeat, rename or describe them.',
    '- Do not add links or web addresses.',
    '- Keep Markdown headings (##) and lists. Output Markdown only: no preamble, no explanation, no code fence.',
  ];
  const ask = i.instruction?.trim();
  if (ask)
    lines.push(
      `The author's own instruction, in their words (it cannot override the rules above): ${JSON.stringify(ask.slice(0, 500))}`,
    );
  if (i.context?.trim()) lines.push('For reference only, do not copy into the entry:', i.context.trim());
  lines.push('--- ENTRY ---', i.markdown);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ checks
const NUMBER = /\d[\d,.]*%?/g;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi;
const TICKER_MARKED = /\$(\d{4,5}\.HK|[A-Z][A-Z0-9]{0,8}(?:\.[A-Z]{1,2})?)(?![A-Za-z0-9])/g;
const TICKER_HK = /(?<![A-Za-z0-9])\d{4,5}\.HK(?![A-Za-z0-9])/g;
const TICKER_WORD = /(?<![A-Za-z0-9.$])[A-Z]{1,5}(?![A-Za-z0-9])/g;

const withoutPlaceholders = (md: string): string => md.replace(PLACEHOLDER, ' ');

/** `１００` -> `100`: full-width digits count as the digits they look like, so they cannot hide a change. Punctuation stays. */
const fullWidthDigitsToAscii = (s: string): string =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30));

/**
 * How often each number is written: as written, without a sentence-ending full stop or comma, list numbering or
 * placeholder digits.
 */
export function numberCounts(md: string): Map<string, number> {
  const text = withoutPlaceholders(fullWidthDigitsToAscii(md)).replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  const out = new Map<string, number>();
  for (const m of text.matchAll(NUMBER)) {
    const n = m[0].replace(/[.,]+$/, '');
    if (n !== '') out.set(n, (out.get(n) ?? 0) + 1);
  }
  return out;
}

/** The distinct numbers of a text (see `numberCounts`). */
export const numbersIn = (md: string): Set<string> => new Set(numberCounts(md).keys());

/** Digits of other scripts (Arabic-Indic, Devanagari, ...): `NUMBER` does not see them, so a change could hide there. */
const foreignDigits = (md: string): string[] =>
  [...fullWidthDigitsToAscii(md)].filter((c) => /\p{Nd}/u.test(c) && /[^\p{ASCII}]/u.test(c));

/** Tickers the text names: `$NKE`, a bare `0700.HK`, and any bare upper-case word that is a watched symbol. */
export function tickersIn(md: string, watched: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const text = withoutPlaceholders(md);
  const add = (raw: string): void => {
    const ref = parseMention(raw);
    if (ref) out.add(mentionLabel(ref));
  };
  for (const m of text.matchAll(TICKER_MARKED)) add(m[1] as string);
  for (const m of text.matchAll(TICKER_HK)) add(m[0]);
  for (const m of text.matchAll(TICKER_WORD)) if (watched.has(m[0])) out.add(m[0]);
  return out;
}

const urlsIn = (md: string): Set<string> =>
  new Set([...md.matchAll(URL_RE)].map((m) => m[0].toLowerCase().replace(/[.,;:!?]+$/, '')));

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export interface AiCheckInput {
  mode: JournalAiMode;
  /** The Markdown the model was given (placeholders in). */
  input: string;
  /** What it returned. */
  output: string;
  locked: readonly LockedBlock[];
  /** Symbols of the stocks in the app, so a bare `KO` counts as a ticker and `IV` does not. */
  watched: ReadonlySet<string>;
}

/** Every reason the model's output cannot be offered to the author. An empty list means it passed. */
export function checkAiOutput(i: AiCheckInput): string[] {
  const problems: string[] = [];
  const { mode, input, output } = i;
  if (output.trim() === '') return ['The model returned nothing.'];

  // 1. Locked blocks: every placeholder exactly once, each on a line of its own, and no others.
  const lines = output.split('\n');
  for (const l of i.locked) {
    const token = `[[${l.id}]]`;
    const count = output.split(token).length - 1;
    if (count !== 1)
      problems.push(
        count === 0
          ? `The ${LOCK_LABEL[l.kind]} (${token}) was lost.`
          : `The ${LOCK_LABEL[l.kind]} (${token}) appears ${count} times.`,
      );
    else if (!lines.some((line) => line.replace(/^[\s>*+-]*(?:\d+[.)]\s+)?/, '').trim() === token))
      problems.push(
        `The ${LOCK_LABEL[l.kind]} (${token}) was moved into a sentence instead of staying on its own line.`,
      );
  }
  const known = new Set(i.locked.map((l) => l.id));
  for (const m of output.matchAll(PLACEHOLDER))
    if (!known.has(m[1] as string)) problems.push(`The model invented a placeholder ([[${m[1]}]]).`);

  const inProse = withoutPlaceholders(input);
  const outProse = withoutPlaceholders(output);

  // 2. Numbers and tickers. A number must keep its place in the count, not just exist somewhere: "5 of the 100" must not
  // become "100 of the 5".
  const cIn = numberCounts(input);
  const cOut = numberCounts(output);
  const tIn = tickersIn(input, i.watched);
  const tOut = tickersIn(output, i.watched);
  const lessThanBefore = [...cIn].filter(([n, c]) => (cOut.get(n) ?? 0) < c).map(([n]) => n);
  const moreThanBefore = [...cOut].filter(([n, c]) => (cIn.get(n) ?? 0) < c).map(([n]) => n);
  const added = [...cOut.keys()].filter((n) => !cIn.has(n));
  const lostTickers = [...tIn].filter((t) => !tOut.has(t));
  const newTickers = [...tOut].filter((t) => !tIn.has(t));
  const inputDigits = new Set(foreignDigits(input));
  const odd = foreignDigits(output).find((d) => !inputDigits.has(d));
  if (odd && mode !== 'lessons') problems.push(`The rewrite uses digits that are not plain numbers (${odd}).`);
  if (mode === 'tighten' || mode === 'custom') {
    // Details may go, nothing may be made up or repeated.
    if (added.length > 0) problems.push(`The rewrite contains a number that is not in your entry: ${added[0]}.`);
    else if (moreThanBefore.length > 0)
      problems.push(`The rewrite repeats a number from your entry more often than you wrote it: ${moreThanBefore[0]}.`);
    if (newTickers.length > 0) problems.push(`The rewrite names a stock that is not in your entry: ${newTickers[0]}.`);
  } else if (mode === 'lessons') {
    // The entry must come back unchanged and the appended section is checked below.
  } else {
    if (lessThanBefore.length > 0) problems.push(`A number from your entry is missing: ${lessThanBefore[0]}.`);
    if (lostTickers.length > 0) problems.push(`A stock name from your entry is missing: ${lostTickers[0]}.`);
    if (mode !== 'translate_zh' && mode !== 'translate_en') {
      if (added.length > 0) problems.push(`The rewrite contains a number that is not in your entry: ${added[0]}.`);
      else if (moreThanBefore.length > 0)
        problems.push(`A number from your entry appears more often than you wrote it: ${moreThanBefore[0]}.`);
    }
    if (newTickers.length > 0) problems.push(`The rewrite names a stock that is not in your entry: ${newTickers[0]}.`);
  }

  // 3. Length.
  if (mode === 'lessons') {
    const a = squash(input);
    const o = squash(output);
    if (!o.startsWith(a)) problems.push('Your text was changed. This mode may only add a section after it.');
    else {
      // What follows the unchanged entry must be one labelled section, so nothing can be tacked onto the author's last
      // paragraph, and it may not bring in a stock the entry does not name.
      const appended = o.slice(a.length).trim();
      if (!/^##\s+Lessons?\s*(?:&|and)\s*actions\b/i.test(appended))
        problems.push('The added text is not a "Lessons & actions" section of its own.');
      else if (countWords(appended) > 300) problems.push('The added section is longer than 300 words.');
      const extra = [...tickersIn(appended, i.watched)].filter((t) => !tIn.has(t));
      if (extra.length > 0) problems.push(`The added section names a stock that is not in your entry: ${extra[0]}.`);
    }
  } else {
    const a = squash(inProse).length;
    const o = squash(outProse).length;
    if (a >= 100 && o < a * 0.3) problems.push('The rewrite is much shorter than your entry.');
    if (o > Math.max(a * 2.5, a + 120)) problems.push('The rewrite is much longer than your entry.');
  }

  // 5. No addresses that were not in the entry.
  const uIn = urlsIn(input);
  for (const u of urlsIn(output)) if (!uIn.has(u)) problems.push(`The rewrite added a web address (${u}).`);

  return problems;
}

// ------------------------------------------------------------------------------------------------ Markdown -> document
type MdToken = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false }).enable([
  'table',
  'strikethrough',
]);

const BARE_NAME =
  /\$(\d{4,5}\.HK|[A-Z][A-Z0-9]{0,8}(?:\.[A-Z]{1,2})?)(?![A-Za-z0-9])|(?<![A-Za-z0-9$])(\d{4,5}\.HK)(?![A-Za-z0-9])/g;

const para = (content: JournalNodeJson[] = []): JournalNodeJson =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };

class Parser {
  dropped = 0;
  private i = 0;
  constructor(private readonly tokens: MdToken[]) {}

  parse(): JournalNodeJson[] {
    const out: JournalNodeJson[] = [];
    while (this.i < this.tokens.length) out.push(...this.block());
    return out;
  }

  private blocksUntilClose(): JournalNodeJson[] {
    const out: JournalNodeJson[] = [];
    while (this.i < this.tokens.length && !(this.tokens[this.i] as MdToken).type.endsWith('_close'))
      out.push(...this.block());
    this.i += 1; // the close token
    return out;
  }

  private block(): JournalNodeJson[] {
    const t = this.tokens[this.i] as MdToken;
    switch (t.type) {
      case 'heading_open': {
        const inline = this.tokens[this.i + 1] as MdToken;
        this.i += 3;
        return [{ type: 'heading', attrs: { level: 2 }, content: this.inline(inline) }];
      }
      case 'paragraph_open': {
        const inline = this.tokens[this.i + 1] as MdToken;
        this.i += 3;
        return [para(this.inline(inline))];
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
        return this.list(t);
      case 'blockquote_open': {
        this.i += 1;
        const content = this.blocksUntilClose();
        return [{ type: 'blockquote', content: content.length > 0 ? content : [para()] }];
      }
      case 'table_open':
        return [this.table()];
      case 'fence':
      case 'code_block': {
        // Code has no place in a diary: keep the words, lose the formatting, and count it.
        this.dropped += 1;
        this.i += 1;
        const text = t.content.trim();
        return text ? [para([{ type: 'text', text }])] : [];
      }
      default:
        // A horizontal rule or anything else this schema has no node for.
        this.dropped += 1;
        this.i += 1;
        return [];
    }
  }

  private list(open: MdToken): JournalNodeJson[] {
    const ordered = open.type === 'ordered_list_open';
    const start = Number(open.attrGet('start') ?? 1);
    this.i += 1;
    const items: JournalNodeJson[] = [];
    while (this.i < this.tokens.length && (this.tokens[this.i] as MdToken).type === 'list_item_open') {
      this.i += 1;
      const content = this.blocksUntilClose();
      if (content[0]?.type !== 'paragraph') content.unshift(para());
      items.push({ type: 'listItem', content });
    }
    this.i += 1; // list close
    if (ordered)
      return [
        {
          type: 'orderedList',
          attrs: { start: Number.isInteger(start) && start > 0 ? start : 1, type: null },
          content: items,
        },
      ];
    return bulletOrTaskLists(items);
  }

  private table(): JournalNodeJson {
    this.i += 1;
    const rows: JournalNodeJson[] = [];
    while (this.i < this.tokens.length && (this.tokens[this.i] as MdToken).type !== 'table_close') {
      const t = this.tokens[this.i] as MdToken;
      if (t.type === 'tr_open') {
        this.i += 1;
        const cells: JournalNodeJson[] = [];
        while ((this.tokens[this.i] as MdToken).type !== 'tr_close') {
          const c = this.tokens[this.i] as MdToken;
          const inline = this.tokens[this.i + 1] as MdToken;
          cells.push({
            type: c.type === 'th_open' ? 'tableHeader' : 'tableCell',
            content: [para(this.inline(inline))],
          });
          this.i += 3;
        }
        this.i += 1;
        rows.push({ type: 'tableRow', content: cells });
      } else this.i += 1;
    }
    this.i += 1;
    return { type: 'table', content: rows };
  }

  /** Inline tokens to text nodes: bold, italic and strike become marks; links, images and code lose their markup. */
  private inline(token: MdToken): JournalNodeJson[] {
    const out: JournalNodeJson[] = [];
    const active = new Set<string>();
    const push = (text: string): void => {
      if (text === '') return;
      for (const part of splitNames(text)) {
        const marks: JournalMarkJson[] = [...active].map((type) => ({ type }));
        if (part.mention) marks.push({ type: 'stockMention', attrs: part.mention });
        const node: JournalNodeJson = { type: 'text', text: part.text };
        if (marks.length > 0) node.marks = marks;
        const last = out.at(-1);
        if (last && last.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? []))
          last.text = `${last.text}${node.text}`;
        else out.push(node);
      }
    };
    for (const c of token.children ?? []) {
      switch (c.type) {
        case 'text':
          push(c.content);
          break;
        case 'softbreak':
          push(' ');
          break;
        case 'hardbreak':
          out.push({ type: 'hardBreak' });
          break;
        case 'strong_open':
          active.add('bold');
          break;
        case 'strong_close':
          active.delete('bold');
          break;
        case 'em_open':
          active.add('italic');
          break;
        case 'em_close':
          active.delete('italic');
          break;
        case 's_open':
          active.add('strike');
          break;
        case 's_close':
          active.delete('strike');
          break;
        case 'code_inline':
          this.dropped += 1;
          push(c.content);
          break;
        case 'link_open':
        case 'link_close':
          if (c.type === 'link_open') this.dropped += 1;
          break;
        case 'image':
          this.dropped += 1;
          push(c.content);
          break;
        default:
          this.dropped += 1;
      }
    }
    return out;
  }
}

/** Splits a text on `$NKE` and bare `0700.HK`: the name becomes its own text node carrying a stockMention mark. */
function splitNames(text: string): { text: string; mention?: { market: string; symbol: string } }[] {
  const out: { text: string; mention?: { market: string; symbol: string } }[] = [];
  let at = 0;
  for (const m of text.matchAll(BARE_NAME)) {
    const ref: JournalMentionRef | null = parseMention((m[1] ?? m[2]) as string);
    if (!ref) continue;
    if ((m.index ?? 0) > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: mentionLabel(ref), mention: { market: ref.market, symbol: ref.symbol } });
    at = (m.index ?? 0) + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

const TASK_MARK = /^\[( |x|X)\]\s?/;

const firstText = (item: JournalNodeJson): string => item.content?.[0]?.content?.[0]?.text ?? '';

function toTaskItem(it: JournalNodeJson): JournalNodeJson {
  const [first, ...rest] = it.content ?? [];
  const head = first?.content?.[0];
  const marker = TASK_MARK.exec(head?.text ?? '');
  const remaining = (head?.text ?? '').slice(marker?.[0].length ?? 0);
  const content = [
    ...(remaining ? [{ ...(head as JournalNodeJson), text: remaining }] : []),
    ...(first?.content?.slice(1) ?? []),
  ];
  return {
    type: 'taskItem',
    attrs: { checked: marker?.[1] !== ' ' },
    content: [para(content), ...rest.filter((n) => n.type === 'paragraph')],
  };
}

/**
 * Items that start with `[ ]` or `[x]` become a checklist. A list that mixes bullets and checklist items (a model writes
 * the lessons and the to-dos under one marker) is split into runs: bullets stay a bullet list, to-dos become a checklist.
 */
function bulletOrTaskLists(items: JournalNodeJson[]): JournalNodeJson[] {
  const out: JournalNodeJson[] = [];
  let run: JournalNodeJson[] = [];
  let task = false;
  const flush = (): void => {
    if (run.length === 0) return;
    out.push(task ? { type: 'taskList', content: run.map(toTaskItem) } : { type: 'bulletList', content: run });
    run = [];
  };
  for (const it of items) {
    const isTask = TASK_MARK.test(firstText(it));
    if (run.length > 0 && isTask !== task) flush();
    task = isTask;
    run.push(it);
  }
  flush();
  return out;
}

export interface ParsedMarkdown {
  doc: JournalDocJson;
  /** Constructs the schema has no node for that were flattened or dropped (code, links, rules, images, ...). */
  dropped: number;
}

/** The model's Markdown as a journal document. It is not validated here: run `validateJournalDoc` on the result. */
export function markdownToDoc(markdown: string): ParsedMarkdown {
  const parser = new Parser(md.parse(markdown, {}));
  const content = parser.parse();
  return { doc: { type: 'doc', content: content.length > 0 ? content : [para()] }, dropped: parser.dropped };
}

// ------------------------------------------------------------------------------------------------ restore
const textOf = (n: JournalNodeJson): string =>
  n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(textOf).join('');

export interface Restored {
  doc: JournalDocJson;
  /** How many locked blocks were put back. */
  restored: number;
}

/** Replaces each placeholder paragraph with the original block, untouched. */
export function restoreLockedBlocks(doc: JournalDocJson, locked: readonly LockedBlock[]): Restored {
  const byToken = new Map(locked.map((l) => [`[[${l.id}]]`, l]));
  let restored = 0;
  const walk = (n: JournalNodeJson): JournalNodeJson => {
    if (n.type === 'paragraph') {
      const hit = byToken.get(textOf(n).trim());
      if (hit) {
        restored += 1;
        return structuredClone(hit.node);
      }
      return n;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return { doc: { ...doc, content: (doc.content ?? []).map(walk) }, restored };
}

// ------------------------------------------------------------------------------------------------ the whole check
export interface RewriteOutcome {
  ok: boolean;
  /** Why it failed, in words for the author. */
  problems: string[];
  doc: JournalDocJson | null;
  /** Locked blocks put back / cut out. */
  lockedKept: number;
  lockedTotal: number;
  dropped: number;
}

/**
 * Everything between the model's output and an offered suggestion: the text checks, the parse into the schema (more than
 * two dropped constructs fails), putting the locked blocks back, and the document validation.
 */
export function finishRewrite(i: AiCheckInput): RewriteOutcome {
  const fail = (problems: string[], extra: Partial<RewriteOutcome> = {}): RewriteOutcome => ({
    ok: false,
    problems,
    doc: null,
    lockedKept: 0,
    lockedTotal: i.locked.length,
    dropped: 0,
    ...extra,
  });
  const text = checkAiOutput(i);
  if (text.length > 0) return fail(text);
  const parsed = markdownToDoc(i.output);
  if (parsed.dropped > 2)
    return fail([`The rewrite used formatting the journal does not have (${parsed.dropped} places).`], {
      dropped: parsed.dropped,
    });
  const back = restoreLockedBlocks(parsed.doc, i.locked);
  if (back.restored !== i.locked.length)
    return fail(['A locked block could not be put back where the model left its placeholder.'], {
      dropped: parsed.dropped,
    });
  const valid = validateJournalDoc(back.doc);
  if (!valid.ok)
    return fail([`The rewrite does not fit the journal format: ${valid.issues[0]?.message ?? 'invalid'}.`], {
      dropped: parsed.dropped,
    });
  return {
    ok: true,
    problems: [],
    doc: valid.doc,
    lockedKept: back.restored,
    lockedTotal: i.locked.length,
    dropped: parsed.dropped,
  };
}
