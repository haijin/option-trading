/**
 * Test-side .xlsx writer for the universe fixtures: a minimal zip (deflate) plus a workbook with the given sheets. Two
 * encodings are produced so the reader is exercised against both shapes it meets:
 *   - `shared`: Excel's own layout (`<c t="s">` cells pointing into sharedStrings.xml, unprefixed tags)
 *   - `prefixed`: the HKEX list's layout (`x:`-prefixed tags, `t="str"` cells with the text inline)
 */
import { deflateRawSync } from 'node:zlib';

// zlib.crc32 only exists from Node 22.2; the repo's floor is 22.0.
const CRC_TABLE = Array.from({ length: 256 }, (_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function columnLetters(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

export interface SheetData {
  name: string;
  rows: string[][];
}

export function buildXlsx(sheets: SheetData[], style: 'shared' | 'prefixed' = 'shared'): Buffer {
  const p = style === 'prefixed' ? 'x:' : '';
  const ns = style === 'prefixed' ? ' xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' : '';
  const nsMain = style === 'prefixed' ? ns : ' xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const files: { name: string; data: Buffer }[] = [];
  const sheetXml = (rows: string[][]): string => {
    const body = rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            if (v === '') return '';
            const ref = `${columnLetters(ci)}${ri + 1}`;
            if (style === 'prefixed') return `<x:c r="${ref}" t="str"><x:v>${esc(v)}</x:v></x:c>`;
            let idx = stringIndex.get(v);
            if (idx === undefined) {
              idx = strings.length;
              strings.push(v);
              stringIndex.set(v, idx);
            }
            return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
          })
          .join('');
        return `<${p}row r="${ri + 1}">${cells}</${p}row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}worksheet${nsMain}><${p}sheetData>${body}</${p}sheetData></${p}worksheet>`;
  };
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows), 'utf8') });
  });
  const wbSheets = sheets
    .map((s, i) => `<${p}sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  files.unshift({
    name: 'xl/workbook.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}workbook${nsMain} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><${p}sheets>${wbSheets}</${p}sheets></${p}workbook>`,
      'utf8',
    ),
  });
  const rels = sheets
    .map(
      (_s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('');
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      'utf8',
    ),
  });
  if (style === 'shared')
    files.push({
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
        'utf8',
      ),
    });
  return zip(files);
}
