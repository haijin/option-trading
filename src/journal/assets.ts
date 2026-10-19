/**
 * Rules for journal images that need no disk, database or image library: which bytes are an image, where a stored file
 * lives, and the limits. Pure, so the server and the editor can share them.
 */

export const ASSET_LIMITS = {
  /** Upload cap, bytes. */
  maxBytes: 8 * 1024 * 1024,
  /** Longest edge of the stored image, pixels. */
  maxEdge: 2000,
  /** Longest edge of the list thumbnail, pixels. */
  thumbEdge: 320,
  /** Refuse to decode anything with more pixels than this (a decompression bomb). */
  maxInputPixels: 64_000_000,
} as const;

export type SniffedImage = 'png' | 'jpeg' | 'webp' | 'gif' | 'heic';

/** Stored formats: what an upload becomes after it is re-encoded. HEIC (an iPhone photo) becomes JPEG. */
export type StoredFormat = 'png' | 'jpeg' | 'webp' | 'gif';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));

/**
 * The image kind the first bytes say it is, or null. The file name and the declared type are never looked at: a program
 * renamed `chart.png` starts with `MZ`, not with a PNG signature.
 */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    ascii(b, 1, 4) === 'PNG' &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(b, 8, 12))) return 'heic';
  return null;
}

export const storedFormatOf = (k: SniffedImage): StoredFormat => (k === 'heic' ? 'jpeg' : k);

export const MIME_OF: Record<StoredFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const EXT_OF: Record<StoredFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAssetId = (s: string): boolean => UUID.test(s);

/** `journal/<user>/<yyyy>/<id>.<ext>` under the data root. The name is built from ids, never from the client's file name. */
export function assetRelPath(userId: string, year: number, assetId: string, format: StoredFormat): string {
  if (!UUID.test(userId) || !UUID.test(assetId)) throw new Error('asset paths are built from ids only');
  return `journal/${userId.toLowerCase()}/${String(year).padStart(4, '0')}/${assetId.toLowerCase()}.${EXT_OF[format]}`;
}

/** The thumbnail sits next to the image and is always WebP. */
export const thumbRelPath = (imageRelPath: string): string => imageRelPath.replace(/\.[a-z0-9]+$/i, '.thumb.webp');
