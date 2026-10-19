/**
 * Mock of the journal's image endpoints: `POST /api/journal/assets` (multipart, field `file`) and
 * `GET /api/journal/assets/:id[?thumb=1]`. The mock keeps the uploaded bytes in memory and serves them back with the type
 * the first bytes say (the real server re-encodes; the mock does not need to). The same bytes uploaded twice answer the same
 * id, like the real one. Two generated charts are seeded so the sample entries have pictures.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ASSET_LIMITS, isAssetId, MIME_OF, sniffImage, storedFormatOf } from '../../src/journal';
import type { JournalAssetView } from '../../src/server/api-types';
import type { RawReply } from './routes';
import { HttpError } from './util';

interface Asset {
  id: string;
  mime: string;
  bytes: Buffer;
  width: number;
  height: number;
}

const assets = new Map<string, Asset>();
const byHash = new Map<string, string>();

/** What `server.ts` hands to a route for a multipart request: the raw body and its Content-Type (with the boundary). */
export interface MultipartBody {
  multipart: true;
  contentType: string;
  bytes: Buffer;
}

export const isMultipartBody = (x: unknown): x is MultipartBody =>
  typeof x === 'object' && x !== null && (x as { multipart?: unknown }).multipart === true;

// ------------------------------------------------------------------------------------------------ seeds
function chartSvg(color: string, label: string): Buffer {
  const path =
    'M0 48 L20 62 L40 70 L60 66 L80 78 L100 74 L120 82 L140 72 L160 60 L180 64 L200 50 L220 54 L240 44 L260 48 L280 40 L300 42 L320 38';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="640" height="240"><rect width="320" height="120" fill="#ffffff"/><g stroke="#e3e7ea" stroke-width="1"><path d="M0 30H320M0 60H320M0 90H320"/></g><path d="${path} V120 H0Z" fill="${color}" opacity=".14"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/><text x="6" y="14" font-size="10" fill="#667781" font-family="monospace">${label}</text></svg>`,
  );
}

export const SEED_ASSET_CHART = '00000000-0000-4000-8000-00000000a001';
export const SEED_ASSET_CHART_DOWN = '00000000-0000-4000-8000-00000000a002';

function seed(): void {
  assets.set(SEED_ASSET_CHART, {
    id: SEED_ASSET_CHART,
    mime: 'image/svg+xml',
    bytes: chartSvg('#128c7e', '0700.HK · 1D · 16:05'),
    width: 640,
    height: 240,
  });
  assets.set(SEED_ASSET_CHART_DOWN, {
    id: SEED_ASSET_CHART_DOWN,
    mime: 'image/svg+xml',
    bytes: chartSvg('#c5221f', 'MSFT · 1D · 08:10'),
    width: 640,
    height: 240,
  });
}
seed();

// ------------------------------------------------------------------------------------------------ parsing
/** The bytes of the part named `file` in a multipart body, or null. Enough of RFC 7578 for a browser's FormData. */
export function filePartOf(body: MultipartBody): Buffer | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(body.contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  let from = body.bytes.indexOf(delimiter);
  while (from >= 0) {
    const headStart = from + delimiter.length;
    const headEnd = body.bytes.indexOf(Buffer.from('\r\n\r\n'), headStart);
    if (headEnd < 0) return null;
    const head = body.bytes.subarray(headStart, headEnd).toString('latin1');
    const next = body.bytes.indexOf(Buffer.from(`\r\n--${boundary}`), headEnd + 4);
    if (/name="file"/i.test(head) && next >= 0) return body.bytes.subarray(headEnd + 4, next);
    from = next < 0 ? -1 : next + 2;
  }
  return null;
}

/** Width and height from the header of a PNG, GIF, JPEG or WebP; a default when the file is something else. */
export function dimensionsOf(b: Buffer): { width: number; height: number } {
  try {
    if (b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG')
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF')
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 12, 16) === 'VP8X')
      return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1] as number;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    // fall through to the default
  }
  return { width: 800, height: 600 };
}

// ------------------------------------------------------------------------------------------------ endpoints
export function uploadAsset(body: unknown): JournalAssetView {
  if (!isMultipartBody(body)) throw new HttpError(400, 'multipart_required', 'Send the image as multipart/form-data.');
  const bytes = filePartOf(body);
  if (!bytes) throw new HttpError(400, 'no_file', 'There is no image in the upload.');
  if (bytes.length === 0) throw new HttpError(400, 'empty_file', 'The upload is empty.');
  if (bytes.length > ASSET_LIMITS.maxBytes)
    throw new HttpError(413, 'file_too_large', `Images are limited to ${ASSET_LIMITS.maxBytes / 1024 / 1024} MB.`);
  const kind = sniffImage(bytes);
  if (!kind) throw new HttpError(415, 'unsupported_image', 'Only PNG, JPEG, WebP, GIF or HEIC images are accepted.');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const known = byHash.get(sha);
  const existing = known ? assets.get(known) : undefined;
  if (existing)
    return {
      id: existing.id,
      url: `/api/journal/assets/${existing.id}`,
      width: existing.width,
      height: existing.height,
    };
  const { width, height } = dimensionsOf(bytes);
  const asset: Asset = { id: randomUUID(), mime: MIME_OF[storedFormatOf(kind)], bytes, width, height };
  assets.set(asset.id, asset);
  byHash.set(sha, asset.id);
  return { id: asset.id, url: `/api/journal/assets/${asset.id}`, width, height };
}

/** The image bytes (the thumbnail is the same file: the browser scales it). */
export function readAsset(id: string): RawReply {
  const asset = isAssetId(id) ? assets.get(id.toLowerCase()) : undefined;
  if (!asset) throw new HttpError(404, 'asset_not_found', 'There is no such image.');
  return {
    raw: true,
    contentType: asset.mime,
    body: asset.bytes,
    headers: { 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=60' },
  };
}

/** Test hook: how many images the mock holds. */
export const assetCount = (): number => assets.size;
