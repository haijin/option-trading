/**
 * A deliberately small .xlsx reader (no dependency): a zip central-directory walk, raw-deflate through node:zlib, the
 * shared-strings table and the cell grid of each sheet. It reads values only (no styles, no formulas; dates stay the raw
 * cell text), which is all the exchange and index-provider list files need.
 *
 * The input is untrusted data: sizes are capped and nothing in the archive is ever written to disk or executed.
 */
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('not a zip archive (no end-of-central-directory record)');
}

function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (e.size > MAX_ENTRY_BYTES) throw new Error(`zip entry ${e.name} is too large (${e.size} bytes)`);
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('corrupt zip local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
}

/** The XML parts (and relationship files) of a zip, by archive path. Other entries are ignored. */
export function unzipText(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of listEntries(buf))
    if (/\.(xml|rels)$/i.test(e.name)) out.set(e.name, readEntry(buf, e).toString('utf8'));
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g.startsWith('#x')) return String.fromCodePoint(Number.parseInt(g.slice(2), 16));
    if (g.startsWith('#')) return String.fromCodePoint(Number.parseInt(g.slice(1), 10));
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Optional XML namespace prefix: Excel writes `<c>`, other writers (the HKEX list) write `<x:c>`. */
const NS = '(?:[A-Za-z0-9_-]+:)?';

/** Matches `<name attrs/>` or `<name attrs>body</name>` (with or without a namespace prefix); groups: attrs, body. */
function element(name: string): RegExp {
  return new RegExp(String.raw`<${NS}${name}\b([^>]*?)(?:/>|>([\s\S]*?)</${NS}${name}>)`, 'g');
}

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(String.raw`(?:^|\s)(?:[A-Za-z0-9_-]+:)?${name}="([^"]*)"`).exec(attrs)?.[1];

/** Column letters to a zero-based index ("A" 0, "AA" 26). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** Concatenated text of every `<t>` run inside an element body (rich-text strings have several). */
function textRuns(body: string): string {
  let out = '';
  for (const t of body.matchAll(element('t'))) out += xmlText((t[2] as string | undefined) ?? '');
  return out;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(element('si'))].map((si) => textRuns((si[2] as string | undefined) ?? ''));
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

/** Every worksheet of the workbook as a grid of cell texts (missing cells are empty strings). */
export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = unzipText(buf);
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw new Error('not an xlsx workbook (no xl/workbook.xml)');
  const target = new Map<string, string>();
  for (const r of (files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(r[1] as string, 'Id');
    const t = attr(r[1] as string, 'Target');
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`);
  }
  const strings = sharedStrings(files.get('xl/sharedStrings.xml'));
  const sheets: XlsxSheet[] = [];
  for (const s of workbook.matchAll(element('sheet'))) {
    const attrs = s[1] as string;
    const xml = files.get(target.get(attr(attrs, 'id') ?? '') ?? '');
    if (xml === undefined) continue;
    const rows: string[][] = [];
    for (const row of xml.matchAll(element('row'))) {
      const cells: string[] = [];
      for (const c of ((row[2] as string | undefined) ?? '').matchAll(element('c'))) {
        const cattrs = c[1] as string;
        const body = (c[2] as string | undefined) ?? '';
        const type = attr(cattrs, 't') ?? 'n';
        const v = new RegExp(String.raw`<${NS}v>([\s\S]*?)</${NS}v>`).exec(body)?.[1];
        const value =
          type === 's' ? (strings[Number(v)] ?? '') : type === 'inlineStr' ? textRuns(body) : xmlText(v ?? '');
        const ref = attr(cattrs, 'r');
        const idx = ref ? columnIndex(ref) : cells.length;
        while (cells.length < idx) cells.push('');
        cells[idx] = value;
      }
      rows.push(cells);
    }
    sheets.push({ name: xmlText(attr(attrs, 'name') ?? ''), rows });
  }
  return sheets;
}
