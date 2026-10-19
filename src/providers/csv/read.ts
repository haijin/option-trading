/** Tolerant CSV reader shared by the chain and journal importers. Pure: text in, rows out. */

/** One problem found in an import file. `line` is the 1-based physical line (0 = file-level). */
export interface Violation {
  line: number;
  code: string;
  /** Full human-readable text, e.g. `line 7: chain.crossed bid 1.20 > ask 1.10` (file-level: `file: ...`). */
  message: string;
}

export interface CsvRow {
  /** 1-based physical line the record starts on. */
  line: number;
  /** Header name (lower-cased, trimmed) to trimmed cell text. Missing trailing cells read as ''. */
  cells: Record<string, string>;
}

export interface CsvReadResult {
  /** Lower-cased, trimmed header names in file order (unnamed columns dropped). */
  header: string[];
  /** Physical line of the header, 0 when the file has no header. */
  headerLine: number;
  rows: CsvRow[];
  errors: Violation[];
}

export function violation(line: number, code: string, detail: string): Violation {
  return { line, code, message: `${line > 0 ? `line ${line}` : 'file'}: ${code} ${detail}` };
}

/** Violations sorted by physical line (file-level first), stable within a line. */
export function sortViolations(vs: readonly Violation[]): Violation[] {
  return vs
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.line - b.v.line || a.i - b.i)
    .map(({ v }) => v);
}

/** Violation messages ordered by line (file-level first), ready to print one per line. */
export function formatViolations(vs: readonly Violation[]): string[] {
  return sortViolations(vs).map((v) => v.message);
}

interface RawRecord {
  line: number;
  cells: string[];
}

/**
 * Split text into physical records. Handles a UTF-8 BOM, CRLF / LF / lone CR, double-quoted cells (with `""` escapes
 * and embedded newlines) and `#` comment lines. Every record carries the physical line it starts on.
 */
function splitRecords(text: string, errors: Violation[]): RawRecord[] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const n = src.length;
  const records: RawRecord[] = [];
  let pos = 0;
  let line = 1;

  while (pos < n) {
    // Comment line: first non-blank character is '#'. Skipped before tokenising so stray quotes inside it are harmless.
    let p = pos;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (src[p] === '#') {
      while (pos < n && src[pos] !== '\n') pos++;
      pos++;
      line++;
      continue;
    }

    const startLine = line;
    const cells: string[] = [];
    let cell = '';
    let inQuotes = false;
    let quoteLine = line;
    for (;;) {
      if (pos >= n) {
        if (inQuotes) {
          errors.push(violation(quoteLine, 'csv.unterminatedQuote', 'a quoted cell is never closed'));
        }
        cells.push(cell);
        break;
      }
      const ch = src[pos] as string;
      if (inQuotes) {
        if (ch === '"') {
          if (src[pos + 1] === '"') {
            cell += '"';
            pos += 2;
          } else {
            inQuotes = false;
            pos++;
          }
        } else {
          if (ch === '\n') line++;
          cell += ch;
          pos++;
        }
        continue;
      }
      if (ch === '"' && cell.trim() === '') {
        inQuotes = true;
        quoteLine = line;
        cell = '';
        pos++;
      } else if (ch === ',') {
        cells.push(cell);
        cell = '';
        pos++;
      } else if (ch === '\n') {
        cells.push(cell);
        pos++;
        line++;
        break;
      } else {
        cell += ch;
        pos++;
      }
    }
    records.push({ line: startLine, cells: cells.map((c) => c.trim()) });
  }
  return records;
}

/**
 * Read CSV text into header + rows. Blank lines (including lines of only commas) and `#` comment lines are skipped
 * but still counted, so every `line` is the physical 1-based line number in the file.
 */
export function readCsv(text: string): CsvReadResult {
  const errors: Violation[] = [];
  const records = splitRecords(text, errors).filter((r) => r.cells.some((c) => c !== ''));
  const head = records[0];
  if (!head) return { header: [], headerLine: 0, rows: [], errors };

  const names = head.cells.map((c) => c.toLowerCase());
  const seen = new Set<string>();
  for (const name of names) {
    if (name === '') continue;
    if (seen.has(name))
      errors.push(violation(head.line, 'csv.duplicateColumn', `column "${name}" appears more than once`));
    seen.add(name);
  }

  const rows: CsvRow[] = [];
  for (const rec of records.slice(1)) {
    const cells: Record<string, string> = {};
    names.forEach((name, i) => {
      if (name !== '' && !(name in cells)) cells[name] = rec.cells[i] ?? '';
    });
    const stray = rec.cells.findIndex((c, i) => c !== '' && (i >= names.length || names[i] === ''));
    if (stray >= 0) {
      errors.push(
        violation(
          rec.line,
          'csv.columnCount',
          `has a value in column ${stray + 1} but the header only names ${names.filter((x) => x !== '').length} columns`,
        ),
      );
    }
    rows.push({ line: rec.line, cells });
  }
  return { header: names.filter((x) => x !== ''), headerLine: head.line, rows, errors };
}
