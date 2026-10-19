/**
 * Strict validation of a journal document sent by a client (or produced from a model's output).
 * Unknown node types, marks and attributes are rejected, never silently dropped: a document that passes is exactly in
 * the schema, and the canonical JSON it returns is what gets stored. No HTML is ever accepted.
 */
import { JOURNAL_LIMITS, journalSchema } from './schema';
import type { JournalDocJson, JournalMarkJson, JournalNodeJson } from './types';

export interface DocIssue {
  /** Where, e.g. `content[2].content[0].attrs.level`. */
  path: string;
  message: string;
}

export type ValidateResult = { ok: true; doc: JournalDocJson; assetIds: string[] } | { ok: false; issues: DocIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HK_SYMBOL = /^\d{4,5}$/;
const US_SYMBOL = /^[A-Z][A-Z0-9]{0,8}(?:\.[A-Z]{1,2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+Z?)?$/;

const NODE_KEYS = new Set(['type', 'attrs', 'content', 'marks', 'text']);
const MARK_KEYS = new Set(['type', 'attrs']);

type AttrCheck = (value: unknown) => string | null;
interface NodeRule {
  /** Attributes the node may carry; anything else is an error. Absent attributes are fine (the schema's defaults apply). */
  attrs: Record<string, AttrCheck>;
  /** True when the node may have a `content` array. */
  content: boolean;
}

const isInt = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** No NUL and no lone surrogate: Postgres refuses both in text and jsonb, which would fail every save with a 500. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const isStorableText = (s: string): boolean => !s.includes(String.fromCharCode(0)) && !LONE_SURROGATE.test(s);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && isStorableText(v);

const level2: AttrCheck = (v) => (v === 2 ? null : 'headings are level 2 only');
const colspan: AttrCheck = (v) => (isInt(v, 1, 10) ? null : 'must be a whole number from 1 to 10');
const align: AttrCheck = (v) =>
  v === null || v === 'left' || v === 'center' || v === 'right' ? null : 'must be left, center, right or null';
const colwidth: AttrCheck = (v) =>
  v === null || (Array.isArray(v) && v.length <= 10 && v.every((x) => isInt(x, 1, 2000)))
    ? null
    : 'must be null or a list of widths';

const stringRows: AttrCheck = (v) => {
  if (!Array.isArray(v) || v.length > JOURNAL_LIMITS.snapshotRows) return `at most ${JOURNAL_LIMITS.snapshotRows} rows`;
  for (const row of v) {
    if (!Array.isArray(row) || row.length > JOURNAL_LIMITS.snapshotColumns) return 'every row is a list of cells';
    if (!row.every((c) => isStr(c, JOURNAL_LIMITS.snapshotCellChars))) return 'every cell is a short string';
  }
  return null;
};

const RULES: Record<string, NodeRule> = {
  doc: { attrs: {}, content: true },
  paragraph: { attrs: {}, content: true },
  text: { attrs: {}, content: false },
  heading: { attrs: { level: level2 }, content: true },
  bulletList: { attrs: {}, content: true },
  orderedList: {
    attrs: {
      start: (v) => (isInt(v, 1, 99_999) ? null : 'must be a whole number from 1'),
      type: (v) => (v === null || v === '1' ? null : 'must be null or "1"'),
    },
    content: true,
  },
  listItem: { attrs: {}, content: true },
  taskList: { attrs: {}, content: true },
  taskItem: { attrs: { checked: (v) => (typeof v === 'boolean' ? null : 'must be true or false') }, content: true },
  blockquote: { attrs: {}, content: true },
  table: { attrs: {}, content: true },
  tableRow: { attrs: {}, content: true },
  tableHeader: { attrs: { colspan, rowspan: colspan, colwidth, align }, content: true },
  tableCell: { attrs: { colspan, rowspan: colspan, colwidth, align }, content: true },
  figure: {
    attrs: {
      assetId: (v) => (typeof v === 'string' && UUID.test(v) ? null : 'must be an asset id'),
      caption: (v) =>
        v === null || isStr(v, JOURNAL_LIMITS.captionChars)
          ? null
          : `at most ${JOURNAL_LIMITS.captionChars} characters`,
    },
    content: false,
  },
  snapshot: {
    attrs: {
      kind: (v) => (v === 'positions' || v === 'scan' ? null : 'must be positions or scan'),
      asOf: (v) => (typeof v === 'string' && ISO_DATE.test(v) ? null : 'must be a date'),
      title: (v) => (isStr(v, 120) ? null : 'at most 120 characters'),
      columns: (v) =>
        Array.isArray(v) && v.length <= JOURNAL_LIMITS.snapshotColumns && v.every((c) => isStr(c, 40))
          ? null
          : 'a short list of column names',
      align: (v) =>
        Array.isArray(v) && v.length <= JOURNAL_LIMITS.snapshotColumns && v.every((c) => c === 'l' || c === 'r')
          ? null
          : 'a list of l or r',
      rows: stringRows,
    },
    content: false,
  },
  hardBreak: { attrs: {}, content: false },
};

const MARK_RULES: Record<string, Record<string, AttrCheck>> = {
  bold: {},
  italic: {},
  strike: {},
  stockMention: {
    market: (v) => (v === 'US' || v === 'HK' ? null : 'must be US or HK'),
    symbol: (v) =>
      typeof v === 'string' && (HK_SYMBOL.test(v) || US_SYMBOL.test(v)) ? null : 'must be a stock symbol',
  },
};

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Walk {
  readonly issues: DocIssue[] = [];
  readonly assetIds: string[] = [];
  nodes = 0;

  add(path: string, message: string): void {
    if (this.issues.length < 20) this.issues.push({ path, message });
  }

  attrs(path: string, given: unknown, rules: Record<string, AttrCheck>, owner: string): void {
    if (given === undefined) return;
    if (!isPlain(given)) {
      this.add(`${path}.attrs`, 'attrs must be an object');
      return;
    }
    for (const [key, value] of Object.entries(given)) {
      // Own keys only: `constructor`, `valueOf` and `__proto__` are not attributes.
      const check = Object.hasOwn(rules, key) ? rules[key] : undefined;
      if (!check) {
        this.add(`${path}.attrs.${key}`, `${owner} has no attribute "${key}"`);
        continue;
      }
      const problem = check(value);
      if (problem) this.add(`${path}.attrs.${key}`, problem);
    }
  }

  marks(path: string, marks: unknown): void {
    if (!Array.isArray(marks)) {
      this.add(`${path}.marks`, 'marks must be a list');
      return;
    }
    const seen = new Set<string>();
    for (const [i, m] of (marks as unknown[]).entries()) {
      const p = `${path}.marks[${i}]`;
      if (!isPlain(m)) {
        this.add(p, 'a mark is an object');
        continue;
      }
      for (const k of Object.keys(m)) if (!MARK_KEYS.has(k)) this.add(`${p}.${k}`, `a mark has no property "${k}"`);
      const type = m.type;
      if (typeof type !== 'string' || !Object.hasOwn(MARK_RULES, type)) {
        this.add(`${p}.type`, `mark "${String(type)}" is not allowed`);
        continue;
      }
      if (seen.has(type)) this.add(p, `mark "${type}" is repeated`);
      seen.add(type);
      this.attrs(p, m.attrs, MARK_RULES[type] as Record<string, AttrCheck>, `mark ${type}`);
    }
  }

  node(path: string, n: unknown, depth: number, parent: string | null): void {
    if (++this.nodes > JOURNAL_LIMITS.maxNodes) {
      this.add(path, 'the document has too many nodes');
      return;
    }
    if (depth > JOURNAL_LIMITS.maxDepth) {
      this.add(path, 'the document is nested too deeply');
      return;
    }
    if (!isPlain(n)) {
      this.add(path, 'a node is an object');
      return;
    }
    for (const k of Object.keys(n)) if (!NODE_KEYS.has(k)) this.add(`${path}.${k}`, `a node has no property "${k}"`);
    const type = n.type;
    if (typeof type !== 'string' || !Object.hasOwn(RULES, type)) {
      this.add(`${path}.type`, `node "${String(type)}" is not allowed`);
      return;
    }
    if (type === 'doc' && parent !== null) {
      this.add(path, 'a doc cannot be nested');
      return;
    }
    const rule = RULES[type] as NodeRule;
    this.attrs(path, n.attrs, rule.attrs, `node ${type}`);

    if (type === 'text') {
      if (typeof n.text !== 'string' || n.text === '') this.add(`${path}.text`, 'a text node has non-empty text');
      else if (!isStorableText(n.text)) this.add(`${path}.text`, 'the text has a character that cannot be stored');
      if (n.content !== undefined) this.add(`${path}.content`, 'a text node has no content');
      if (n.marks !== undefined) this.marks(path, n.marks);
      return;
    }
    if (n.text !== undefined) this.add(`${path}.text`, `node "${type}" has no text`);
    // Marks belong to text only: a mark on a table cell, a paragraph or a figure is never valid.
    if (n.marks !== undefined) this.add(`${path}.marks`, `node "${type}" cannot carry marks`);

    if (type === 'figure') {
      const id = (n.attrs as Record<string, unknown> | undefined)?.assetId;
      if (typeof id === 'string' && UUID.test(id) && !this.assetIds.includes(id.toLowerCase()))
        this.assetIds.push(id.toLowerCase());
    }
    if (n.content === undefined) return;
    if (!rule.content) {
      this.add(`${path}.content`, `node "${type}" has no content`);
      return;
    }
    if (!Array.isArray(n.content)) {
      this.add(`${path}.content`, 'content must be a list');
      return;
    }
    for (const [i, child] of (n.content as unknown[]).entries())
      this.node(`${path}.content[${i}]`, child, depth + 1, type);
  }
}

/** Validates and canonicalises a document. Never throws. */
export function validateJournalDoc(input: unknown): ValidateResult {
  try {
    return validate(input);
  } catch (err) {
    return { ok: false, issues: [{ path: '', message: `the document cannot be read: ${(err as Error).message}` }] };
  }
}

function validate(input: unknown): ValidateResult {
  const w = new Walk();
  if (!isPlain(input) || input.type !== 'doc')
    return { ok: false, issues: [{ path: '', message: 'the document must be a doc node' }] };
  if (JSON.stringify(input).length > JOURNAL_LIMITS.docBytes)
    return { ok: false, issues: [{ path: '', message: `the document is over ${JOURNAL_LIMITS.docBytes / 1024} KB` }] };
  w.node('', input, 0, null);
  if (w.issues.length > 0) return { ok: false, issues: w.issues };

  // Structure: the content expressions of the schema (a list item holds a paragraph first, a table has rows, ...).
  try {
    const node = journalSchema().nodeFromJSON(input);
    node.check();
    const canonical = node.toJSON() as JournalDocJson;
    return { ok: true, doc: normalise(canonical), assetIds: w.assetIds };
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `the document structure is not valid: ${(err as Error).message}` }],
    };
  }
}

/**
 * ProseMirror omits empty `content` and `marks`; make absent attrs explicit so the stored JSON is stable. Headings are
 * always level 2 (the TipTap default is 1 when the attribute is missing) and image ids are lower-case, the way the
 * database and the "is this image still used" check write them.
 */
function normalise(n: JournalNodeJson): JournalDocJson {
  const walk = (x: JournalNodeJson): JournalNodeJson => {
    const out: JournalNodeJson = { type: x.type };
    let attrs = x.attrs;
    if (x.type === 'heading') attrs = { ...attrs, level: 2 };
    if (x.type === 'figure' && typeof attrs?.assetId === 'string')
      attrs = { ...attrs, assetId: attrs.assetId.toLowerCase() };
    if (attrs && Object.keys(attrs).length > 0) out.attrs = attrs;
    if (x.content) out.content = x.content.map(walk);
    if (x.marks)
      out.marks = x.marks.map((m): JournalMarkJson => (m.attrs ? { type: m.type, attrs: m.attrs } : { type: m.type }));
    if (x.text !== undefined) out.text = x.text;
    return out;
  };
  return walk(n) as JournalDocJson;
}
