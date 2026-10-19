import { createElement, type ReactNode } from 'react';

/**
 * A small, SAFE markdown renderer for research reports (mostly Chinese, written by an AI).
 * It returns React elements only: text is never interpreted as HTML (React escapes it), links are limited to
 * http(s), and there is no dangerouslySetInnerHTML anywhere.
 *
 * Supported: headings, bold, italic, strikethrough, inline code, fenced code, bullet and numbered lists (nested),
 * tables, blockquotes, horizontal rules, links, paragraphs.
 */

type Align = 'left' | 'right' | 'center' | undefined;

interface ListItem {
  text: string;
  children: Block[];
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: string[]; align: Align[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const CJK_RE = /[　-鿿＀-￯]/;
const ESCAPABLE = '\\`*_{}[]()#+-.!|>~';

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  return head !== undefined && sep !== undefined && head.includes('|') && sep.includes('-') && TABLE_SEP_RE.test(sep);
}

/** Whether `line` starts a block that can interrupt a paragraph. */
function interruptsParagraph(lines: string[], i: number): boolean {
  const line = lines[i] as string;
  if (HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
  const list = LIST_RE.exec(line);
  if (list) {
    const marker = list[2] as string;
    return !/^\d/.test(marker) || /^1[.)]$/.test(marker);
  }
  return isTableStart(lines, i);
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseAlign(sepLine: string): Align[] {
  return splitRow(sepLine).map((cell): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return undefined;
  });
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_RE.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = (first[1] as string).length;
  const ordered = /^\d/.test(first[2] as string);
  const startNumber = ordered ? Number.parseInt(first[2] as string, 10) : 1;
  const items: { text: string[]; sub: string[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j] as string)) j++;
      const next = lines[j];
      const nextMatch = next === undefined ? null : LIST_RE.exec(next);
      if (!nextMatch || (nextMatch[1] as string).length < baseIndent) break;
      i = j;
      continue;
    }
    const match = LIST_RE.exec(line);
    const current = items[items.length - 1];
    if (match) {
      const indent = (match[1] as string).length;
      if (indent < baseIndent) break;
      if (indent < baseIndent + 2) {
        if (/^\d/.test(match[2] as string) !== ordered) break;
        items.push({ text: [match[3] as string], sub: [] });
      } else if (current) {
        current.sub.push(line);
      } else {
        break;
      }
      i++;
      continue;
    }
    if (!current) break;
    const indent = line.length - line.trimStart().length;
    if (indent > baseIndent) {
      if (current.sub.length > 0) current.sub.push(line);
      else current.text.push(line.trim());
    } else if (interruptsParagraph(lines, i)) {
      break;
    } else {
      current.text.push(line.trim());
    }
    i++;
  }
  const listItems: ListItem[] = items.map((item) => ({
    text: joinLines(item.text),
    children: item.sub.length > 0 ? parseBlocks(item.sub) : [],
  }));
  return [{ type: 'list', ordered, start: startNumber, items: listItems }, i];
}

/** Joins soft-wrapped lines: no space between two CJK characters, one space otherwise. */
function joinLines(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (out === '') {
      out = part;
      continue;
    }
    const prev = out[out.length - 1] as string;
    const next = part[0] as string;
    out += CJK_RE.test(prev) && CJK_RE.test(next) ? part : ` ${part}`;
  }
  return out;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // closing fence (or end of input: an unterminated fence runs to the end)
      blocks.push({ type: 'code', lang: fence[2] as string, text: body.join('\n') });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] as string).length, text: heading[2] as string });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i] as string);
        if (!q) break;
        inner.push(q[1] as string);
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = parseAlign(lines[i + 1] as string);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i] as string) && (lines[i] as string).includes('|')) {
        rows.push(splitRow(lines[i] as string));
        i++;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }
    if (LIST_RE.test(line)) {
      const [block, next] = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const text: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i] as string) && !interruptsParagraph(lines, i)) {
      text.push((lines[i] as string).trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: joinLines(text) });
  }
  return blocks;
}

/** Only absolute http(s) URLs become links. */
export function safeUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function findClosingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findSingleClose(text: string, marker: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] !== marker || text[j + 1] === marker || text[j - 1] === marker) continue;
    if (/\s/.test(text[j - 1] ?? ' ')) continue;
    if (marker === '_' && /\w/.test(text[j + 1] ?? '')) continue;
    return j;
  }
  return -1;
}

function parseInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  let counter = 0;
  const flush = () => {
    if (buffer) {
      nodes.push(buffer);
      buffer = '';
    }
  };
  const push = (tag: string, children: ReactNode, props: Record<string, unknown> = {}) => {
    flush();
    counter++;
    nodes.push(createElement(tag, { key: `${keyBase}.${counter}`, ...props }, children));
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '\\' && next !== undefined && ESCAPABLE.includes(next)) {
      buffer += next;
      i += 2;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        push('code', text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && next === ch && !/\s/.test(text[i + 2] ?? ' ')) {
      const close = text.indexOf(ch + ch, i + 2);
      if (close > i + 2 && (ch === '*' || !/\w/.test(text[i - 1] ?? ' '))) {
        push('strong', parseInline(text.slice(i + 2, close), `${keyBase}.${counter}`));
        i = close + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && next !== undefined && !/\s/.test(next) && next !== ch) {
      const intraword = ch === '_' && /\w/.test(text[i - 1] ?? ' ');
      const close = intraword ? -1 : findSingleClose(text, ch, i + 1);
      if (close > i + 1) {
        push('em', parseInline(text.slice(i + 1, close), `${keyBase}.${counter}`));
        i = close + 1;
        continue;
      }
    }
    if (ch === '~' && next === '~') {
      const close = text.indexOf('~~', i + 2);
      if (close > i + 2) {
        push('del', parseInline(text.slice(i + 2, close), `${keyBase}.${counter}`));
        i = close + 2;
        continue;
      }
    }
    if (ch === '[') {
      const closeBracket = findClosingBracket(text, i);
      if (closeBracket > i && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          const target =
            text
              .slice(closeBracket + 2, closeParen)
              .trim()
              .split(/\s+/)[0] ?? '';
          const label = parseInline(text.slice(i + 1, closeBracket), `${keyBase}.${counter}`);
          const href = safeUrl(target);
          if (href) {
            push('a', label, { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
          } else {
            flush();
            nodes.push(...label);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return nodes;
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, block.level + 2);
      return createElement(`h${level}`, { key, className: `md-h${block.level}` }, parseInline(block.text, key));
    }
    case 'code':
      return (
        <pre key={key} className="md-code">
          <code data-lang={block.lang || undefined}>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key}>{block.blocks.map((inner, index) => renderBlock(inner, `${key}.${index}`))}</blockquote>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static document structure, never reordered
        <li key={`${key}.${index}`}>
          {parseInline(item.text, `${key}.${index}`)}
          {item.children.map((child, childIndex) => renderBlock(child, `${key}.${index}.${childIndex}`))}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start !== 1 ? block.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="tbl md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static document structure, never reordered
                  <th key={`${key}.h${index}`} style={{ textAlign: block.align[index] }}>
                    {parseInline(cell, `${key}.h${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static document structure, never reordered
                <tr key={`${key}.r${rowIndex}`}>
                  {block.header.map((_, cellIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static document structure, never reordered
                    <td key={`${key}.r${rowIndex}.c${cellIndex}`} style={{ textAlign: block.align[cellIndex] }}>
                      {parseInline(row[cellIndex] ?? '', `${key}.r${rowIndex}.c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} />;
    case 'paragraph':
      return <p key={key}>{parseInline(block.text, key)}</p>;
  }
}

/** Renders markdown source to React elements. Safe for untrusted input. */
export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines).map((block, index) => renderBlock(block, `md${index}`));
}

export function Markdown({ source }: { source: string }) {
  return <div className="markdown">{renderMarkdown(source)}</div>;
}
