/**
 * The "Changes" tab: a word diff of what the model was given against what it returned (docs/prototypes/daily-journal.html,
 * `wordDiff`). Pure. The locked blocks (`[[FIG:1]]` lines: images, tables, snapshots, checklists) are the same on both sides
 * by construction, so they are left out of the diff and mentioned in a note instead.
 */

export type DiffKind = 'same' | 'ins' | 'del';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/** Above this many words on either side the diff is not computed (a quadratic table) and before and after are shown whole. */
export const DIFF_WORD_LIMIT = 3000;

interface Token {
  /** The word, without the whitespace after it. */
  word: string;
  /** The whitespace that followed it, newlines included. */
  space: string;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /(\S+)(\s*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push({ word: m[1] as string, space: m[2] as string });
  return out;
}

function push(parts: DiffPart[], kind: DiffKind, text: string): void {
  if (text === '') return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/**
 * Words kept, words removed (`del`) and words added (`ins`), in reading order. Spacing and line breaks come from the side
 * the word is on. A replaced stretch reads as the removed words, then the added ones.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start]?.word === b[start]?.word) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1]?.word === b[endB - 1]?.word) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  // L[i][j]: length of the longest common run of a[start+i..] and b[start+j..]
  const width = m + 1;
  const L = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * width + j] =
        a[start + i]?.word === b[start + j]?.word
          ? (L[(i + 1) * width + j + 1] as number) + 1
          : Math.max(L[(i + 1) * width + j] as number, L[i * width + j + 1] as number);
    }
  }
  const parts: DiffPart[] = [];
  for (let k = 0; k < start; k++) push(parts, 'same', `${(b[k] as Token).word}${(b[k] as Token).space}`);
  let i = 0;
  let j = 0;
  let removed = '';
  let added = '';
  const flush = () => {
    push(parts, 'del', removed);
    push(parts, 'ins', added);
    removed = '';
    added = '';
  };
  while (i < n && j < m) {
    const x = a[start + i] as Token;
    const y = b[start + j] as Token;
    if (x.word === y.word) {
      flush();
      push(parts, 'same', `${y.word}${y.space}`);
      i++;
      j++;
    } else if ((L[(i + 1) * width + j] as number) >= (L[i * width + j + 1] as number)) {
      removed += `${x.word}${x.space}`;
      i++;
    } else {
      added += `${y.word}${y.space}`;
      j++;
    }
  }
  while (i < n) {
    removed += `${(a[start + i] as Token).word}${(a[start + i] as Token).space}`;
    i++;
  }
  while (j < m) {
    added += `${(b[start + j] as Token).word}${(b[start + j] as Token).space}`;
    j++;
  }
  flush();
  for (let k = endB; k < b.length; k++) push(parts, 'same', `${(b[k] as Token).word}${(b[k] as Token).space}`);
  return parts;
}

// ------------------------------------------------------------------------------------------------ locked blocks
const PLACEHOLDER_LINE = /^[ \t]*\[\[(FIG|TBL|SNAP|TODO):\d+\]\][ \t]*$/;
const LOCK_NAME: Record<string, string> = { FIG: 'image', SNAP: 'snapshot', TBL: 'table', TODO: 'checklist' };
const LOCK_ORDER = ['FIG', 'SNAP', 'TBL', 'TODO'] as const;

/** The markdown without its placeholder lines, and which kinds of locked block there were. */
export function withoutPlaceholders(markdown: string): { text: string; kinds: string[] } {
  const kinds = new Set<string>();
  const kept: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = PLACEHOLDER_LINE.exec(line);
    if (m) kinds.add(m[1] as string);
    else kept.push(line);
  }
  return {
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    kinds: LOCK_ORDER.filter((k) => kinds.has(k)),
  };
}

/** "Image, snapshot and checklist: kept as written (locked)." (null when nothing was locked). */
export function lockedNote(kinds: readonly string[]): string | null {
  const names = kinds.map((k) => LOCK_NAME[k] ?? k.toLowerCase());
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}: kept as written (locked).`;
}

/**
 * The markdown the model works in, as the author wrote it: no heading hashes, emphasis marks or escapes, and names as typed
 * (`$NKE` is NKE). The diff is of words, and these marks would only show up as noise.
 */
export function plainMarkdown(markdown: string): string {
  return markdown
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/\*\*|~~/g, '')
    .replace(/(^|[\s(])\*(?=\S)|(?<=[^\s\\])\*(?=[\s).,;:!?]|$)/g, '$1')
    .replace(/\\([\\`*_~[\]<>|$])/g, '$1')
    .replace(/\$(?=(?:\d{4,5}\.HK|[A-Z][A-Z0-9.]{0,9})\b)/g, '');
}

export type ChangesView =
  | { kind: 'diff'; parts: DiffPart[]; changed: boolean; note: string | null }
  | { kind: 'whole'; before: string; after: string; note: string | null };

const countWords = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** What the Changes tab shows for a run: the word diff, or before and after whole when the entry is too long to diff. */
export function changesView(inputMarkdown: string, outputMarkdown: string): ChangesView {
  const before = withoutPlaceholders(plainMarkdown(inputMarkdown));
  const after = withoutPlaceholders(plainMarkdown(outputMarkdown));
  const note = lockedNote(before.kinds.length >= after.kinds.length ? before.kinds : after.kinds);
  if (countWords(before.text) > DIFF_WORD_LIMIT || countWords(after.text) > DIFF_WORD_LIMIT)
    return { kind: 'whole', before: before.text, after: after.text, note };
  const parts = wordDiff(before.text, after.text);
  return { kind: 'diff', parts, changed: parts.some((p) => p.kind !== 'same'), note };
}
