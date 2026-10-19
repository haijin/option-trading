/**
 * Journal images: upload, serve and delete. The server never stores what the client sent: it checks the first bytes,
 * decodes, applies the camera's rotation, strips every piece of metadata (location included), caps the long edge and
 * writes a re-encoded copy plus a small WebP thumbnail under `<data>/journal/<user>/<yyyy>/`. File names are built from
 * ids, never from the client's name. Every read and delete is checked against the signed-in user.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import sharp from 'sharp';
import {
  deleteJournalAssetIfUnused,
  findJournalAssetBySha,
  getJournalAsset,
  insertJournalAsset,
  touchJournalAsset,
} from '../../db/journal';
import {
  ASSET_LIMITS,
  assetRelPath,
  MIME_OF,
  type StoredFormat,
  sniffImage,
  storedFormatOf,
  thumbRelPath,
} from '../../journal';
import type { JournalAssetView } from '../api-types';
import type { ServerDeps } from '../deps';
import { ApiError, badRequest, conflict, notFound } from '../errors';

const unsupported = (message: string): ApiError => new ApiError(415, 'unsupported_image', message);

export interface AssetFile {
  data: Buffer;
  mime: string;
  /** Strong validator for caching: the hash of what was uploaded. */
  etag: string;
}

export class JournalAssetService {
  constructor(private readonly deps: ServerDeps) {}

  private root(): string {
    return resolve(this.deps.dataDir);
  }

  /** The absolute path of a stored file; refuses anything that would leave the data root. */
  private full(rel: string): string {
    const p = resolve(this.root(), rel);
    if (!p.startsWith(this.root() + sep)) throw badRequest('bad_path', 'invalid asset path');
    return p;
  }

  private view(row: { id: string; width: number | null; height: number | null }): JournalAssetView {
    return { id: row.id, url: `/api/journal/assets/${row.id}`, width: row.width ?? 0, height: row.height ?? 0 };
  }

  async upload(userId: string, bytes: Buffer): Promise<JournalAssetView> {
    if (bytes.length === 0) throw badRequest('empty_file', 'The upload is empty.');
    if (bytes.length > ASSET_LIMITS.maxBytes)
      throw new ApiError(413, 'file_too_large', `Images are limited to ${ASSET_LIMITS.maxBytes / 1024 / 1024} MB.`);
    const kind = sniffImage(bytes);
    if (!kind) throw unsupported('Only PNG, JPEG, WebP, GIF or HEIC images are accepted.');
    const db = this.deps.db;

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const known = await findJournalAssetBySha(db, userId, sha256);
    if (known) {
      // The same image again: it is new again, so the daily cleanup does not remove it before this upload is saved.
      await touchJournalAsset(db, known.id, this.deps.now());
      return this.view(known);
    }

    const format: StoredFormat = storedFormatOf(kind);
    let stored: { data: Buffer; width: number; height: number };
    let thumb: Buffer;
    try {
      const animated = format === 'gif';
      let pipeline = sharp(bytes, {
        failOn: 'error',
        limitInputPixels: ASSET_LIMITS.maxInputPixels,
        animated,
      });
      // The camera's rotation is applied to the pixels; metadata (EXIF, GPS, XMP, ICC) is dropped by default.
      if (!animated) pipeline = pipeline.rotate();
      pipeline = pipeline.resize({
        width: ASSET_LIMITS.maxEdge,
        height: ASSET_LIMITS.maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
      if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
      else if (format === 'png') pipeline = pipeline.png();
      else if (format === 'webp') pipeline = pipeline.webp({ quality: 85 });
      else pipeline = pipeline.gif();
      const out = await pipeline.toBuffer({ resolveWithObject: true });
      stored = { data: out.data, width: out.info.width, height: out.info.pageHeight ?? out.info.height };
      thumb = await sharp(out.data, { failOn: 'error' })
        .resize({
          width: ASSET_LIMITS.thumbEdge,
          height: ASSET_LIMITS.thumbEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 75 })
        .toBuffer();
    } catch (err) {
      const heic = kind === 'heic';
      throw unsupported(
        heic
          ? 'This server cannot read HEIC photos. Choose Most Compatible in Settings > Camera > Formats, or pick a JPEG.'
          : `That file could not be read as an image (${(err as Error).message.split('\n')[0]}).`,
      );
    }

    const id = randomUUID();
    const now = this.deps.now();
    const rel = assetRelPath(userId, now.getUTCFullYear(), id, format);
    const file = this.full(rel);
    const thumbFile = this.full(thumbRelPath(rel));
    await mkdir(dirname(file), { recursive: true });
    await this.writeAtomic(file, stored.data);
    await this.writeAtomic(thumbFile, thumb);
    try {
      const row = await insertJournalAsset(db, {
        id,
        userId,
        mime: MIME_OF[format],
        bytes: stored.data.length,
        width: stored.width,
        height: stored.height,
        sha256,
        path: rel,
        createdAt: now,
      });
      return this.view(row);
    } catch (err) {
      await rm(file, { force: true });
      await rm(thumbFile, { force: true });
      // The same image uploaded twice at once: the other request won, answer with its row.
      const again = await findJournalAssetBySha(db, userId, sha256);
      if (again) return this.view(again);
      throw err;
    }
  }

  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }

  async read(userId: string, id: string, thumb: boolean): Promise<AssetFile> {
    const row = await getJournalAsset(this.deps.db, userId, id);
    if (!row) throw notFound('there is no such image', 'asset_not_found');
    if (thumb) {
      try {
        const data = await readFile(this.full(thumbRelPath(row.path)));
        return { data, mime: 'image/webp', etag: `"${row.sha256}-t"` };
      } catch {
        // no thumbnail on disk: serve the image itself
      }
    }
    try {
      return { data: await readFile(this.full(row.path)), mime: row.mime, etag: `"${row.sha256}"` };
    } catch {
      throw notFound('the image file is missing on disk', 'asset_not_found');
    }
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    // One transaction: lock the row, look again whether anything shows it, then delete (see deleteJournalAssetIfUnused).
    const row = await deleteJournalAssetIfUnused(this.deps.db, userId, id);
    if (row === null) throw notFound('there is no such image', 'asset_not_found');
    if (row === 'in_use')
      throw conflict('asset_in_use', 'An entry still uses this image. Remove it from the entry first.');
    await rm(this.full(row.path), { force: true });
    await rm(this.full(thumbRelPath(row.path)), { force: true });
    return { ok: true };
  }
}
