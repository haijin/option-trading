import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalAssets, journalEntries } from '../../src/db/schema';
import { cleanJournal } from '../../src/jobs/journal-cleanup';
import { startApp, type TestApp } from '../helpers/app';
import { addUser, entryInput, figureDoc, journalClient, paragraphDoc, type TestUser } from '../helpers/journal';
import { createTestDb, type TestDb } from '../helpers/test-db';

const T0 = new Date('2026-10-13T08:00:00Z');

const png = (width = 400, height = 300, background = '#2a7') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#a52' } })
    .jpeg()
    .toBuffer();

describe('journal images', () => {
  let db: TestDb;
  let tmp: string;
  let data: string;
  let t: TestApp;
  let opts: { tmp: string; auth: object; now: Date; dataDir: string };
  let alice: TestUser;
  let bob: TestUser;
  let a: ReturnType<typeof journalClient>;
  let b: ReturnType<typeof journalClient>;
  let anon: ReturnType<typeof journalClient>;

  beforeAll(async () => {
    db = await createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'ot-assets-'));
    data = join(tmp, 'data');
    mkdirSync(data);
    opts = { tmp, auth: {}, now: T0, dataDir: data };
    t = await startApp(db, opts);
    alice = await addUser(db, 'alice', T0);
    bob = await addUser(db, 'bob', T0);
    a = journalClient(t, alice.cookie);
    b = journalClient(t, bob.cookie);
    anon = journalClient(t);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const upload = async (c: typeof a, bytes: Buffer, name = 'chart.png') => {
    const r = await c.upload(bytes, name);
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    return r.json as { id: string; url: string; width: number; height: number };
  };
  const fileOf = (userId: string, id: string, ext = 'png') =>
    join(data, 'journal', userId, String(T0.getUTCFullYear()), `${id}.${ext}`);

  describe('the login gate', () => {
    it('answers 401 to every image route without a session, encoded paths included', async () => {
      const bytes = await png(20, 20);
      expect((await anon.upload(bytes)).status).toBe(401);
      expect((await anon.upload(bytes, 'x.png', { url: '/%61pi/journal/assets' })).status).toBe(401);
      expect((await anon.get('/api/journal/assets/0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11')).status).toBe(401);
      expect((await anon.get('/%61pi/journal/assets/0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11')).status).toBe(401);
      expect((await anon.del('/api/journal/assets/0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11')).status).toBe(401);
      expect((await anon.del('/%61pi/journal/assets/0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11')).status).toBe(401);
    });

    it('lets multipart through on the upload route only, and stops a foreign origin', async () => {
      const bytes = await png(20, 20);
      const other = await a.upload(bytes, 'x.png', { url: '/api/scan/run' });
      expect(other.status).toBe(415);
      const foreign = await a.upload(bytes, 'x.png', { headers: { origin: 'https://evil.example' } });
      expect(foreign.status).toBe(403);
      const json = await a.post('/api/journal/assets', { file: 'x' });
      expect(json.status).toBe(400);
      expect(json.json.error.code).toBe('multipart_required');
    });
  });

  describe('upload', () => {
    it('stores a PNG re-encoded under the data root, with a thumbnail, and answers with its address', async () => {
      const asset = await upload(a, await png(400, 300), 'My Screenshot (1).png');
      expect(asset).toMatchObject({ width: 400, height: 300 });
      expect(asset.url).toBe(`/api/journal/assets/${asset.id}`);
      expect(existsSync(fileOf(alice.id, asset.id))).toBe(true);
      expect(existsSync(fileOf(alice.id, asset.id, 'thumb.webp'))).toBe(true);
      const row = (await db.db.select().from(journalAssets).where(eq(journalAssets.id, asset.id)))[0];
      expect(row).toMatchObject({ userId: alice.id, mime: 'image/png', kind: 'image', entryId: null });
      expect(row?.path).toBe(`journal/${alice.id}/2026/${asset.id}.png`);
      expect(row?.path).not.toContain('Screenshot');
    });

    it('strips EXIF including location, applies the rotation, and caps the long edge at 2000 px', async () => {
      const source = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#a52' } })
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: { IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 3/1' } },
        })
        .toBuffer();
      const before = await sharp(source).metadata();
      expect(before.exif).toBeTruthy();
      expect(before.orientation).toBe(6);
      const asset = await upload(a, source, 'IMG_0001.jpg');
      // Rotated 90 degrees (the camera's orientation), then fitted inside 2000 x 2000.
      expect(asset.width).toBe(1000);
      expect(asset.height).toBe(2000);
      const served = await a.bytes(asset.url);
      expect(served.status).toBe(200);
      const meta = await sharp(served.body).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(meta.width).toBe(1000);
      expect(served.body.includes(Buffer.from('secret-owner'))).toBe(false);
    });

    it('writes a thumbnail of at most 320 px as WebP', async () => {
      const asset = await upload(a, await jpeg(1200, 800), 'wide.jpg');
      const thumb = await a.bytes(`${asset.url}?thumb=1`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers['content-type']).toBe('image/webp');
      const m = await sharp(thumb.body).metadata();
      expect(m.format).toBe('webp');
      expect(Math.max(m.width ?? 0, m.height ?? 0)).toBe(320);
    });

    it('accepts WebP and GIF, and keeps a small image at its size', async () => {
      const webp = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#000' } })
        .webp()
        .toBuffer();
      const gif = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#f00' } })
        .gif()
        .toBuffer();
      expect(await upload(a, webp, 'a.webp')).toMatchObject({ width: 50, height: 40 });
      expect(await upload(a, gif, 'a.gif')).toMatchObject({ width: 30, height: 30 });
    });

    it('rejects a program renamed .png, text, an empty file and a broken image', async () => {
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x90)]);
      const r = await a.upload(exe, 'chart.png');
      expect(r.status).toBe(415);
      expect(r.json.error.code).toBe('unsupported_image');
      expect(
        (await a.upload(Buffer.from('<svg onload=alert(1)></svg>'), 'x.png', { fileType: 'image/png' })).status,
      ).toBe(415);
      expect((await a.upload(Buffer.from('<?php system($_GET[0]); ?>'), 'x.jpg')).status).toBe(415);
      expect((await a.upload(Buffer.alloc(0), 'empty.png')).status).toBe(400);
      const broken = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 1),
      ]);
      const b2 = await a.upload(broken, 'broken.png');
      expect(b2.status).toBe(415);
      expect(b2.json.error.message).toContain('could not be read');
    });

    it('explains a HEIC photo this server cannot decode', async () => {
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64, 0)]);
      const r = await a.upload(heic, 'IMG_0001.HEIC', { fileType: 'image/heic' });
      expect(r.status).toBe(415);
      expect(r.json.error.message).toContain('Most Compatible');
    });

    it('refuses an image over 8 MB', async () => {
      const big = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(9 * 1024 * 1024, 7),
      ]);
      const r = await a.upload(big, 'huge.png');
      expect(r.status).toBe(413);
      expect(r.json.error.code).toBe('file_too_large');
    });

    it('refuses an image with an absurd pixel count before decoding it', async () => {
      // 10000 x 10000 = 100 megapixels of one colour compresses to a tiny PNG: a decompression bomb.
      const bomb = await sharp({ create: { width: 10000, height: 10000, channels: 3, background: '#000' } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      expect(bomb.length).toBeLessThan(8 * 1024 * 1024);
      const r = await a.upload(bomb, 'bomb.png');
      expect(r.status).toBe(415);
    });

    it('stores a screenshot sent twice once', async () => {
      const bytes = await png(123, 77, '#09c');
      const first = await upload(a, bytes);
      const second = await upload(a, bytes, 'again.png');
      expect(second.id).toBe(first.id);
      const rows = await db.db.select().from(journalAssets).where(eq(journalAssets.userId, alice.id));
      expect(rows.filter((r) => r.id === first.id)).toHaveLength(1);
      // Bob uploading the same bytes gets his own copy, not Alice's.
      const bobs = await upload(b, bytes);
      expect(bobs.id).not.toBe(first.id);
    });
  });

  describe('serving', () => {
    it('serves the image to its owner with safe headers and revalidation', async () => {
      const asset = await upload(a, await png(64, 64, '#123456'));
      const r = await a.bytes(asset.url);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-disposition']).toBe('inline');
      expect(r.headers['cache-control']).toBe('private, max-age=86400');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
      const etag = String(r.headers.etag);
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      const again = await a.bytes(asset.url, { 'if-none-match': etag });
      expect(again.status).toBe(304);
      expect((await sharp(r.body).metadata()).width).toBe(64);
    });

    it("never serves another user's image, its thumbnail, or lets them delete it (404, as if it did not exist)", async () => {
      const asset = await upload(a, await png(40, 40, '#abcdef'));
      expect((await b.bytes(asset.url)).status).toBe(404);
      expect((await b.bytes(`${asset.url}?thumb=1`)).status).toBe(404);
      expect((await b.del(asset.url)).status).toBe(404);
      expect((await a.bytes(asset.url)).status).toBe(200);
      expect((await a.get('/api/journal/assets/not-an-id')).status).toBe(404);
      expect((await a.get('/api/journal/assets/..%2F..%2Fpackage.json')).status).toBe(404);
    });

    it('keeps other API answers uncached', async () => {
      const r = await a.get('/api/journal/entries');
      expect(r.headers['cache-control']).toBe('no-store');
    });
  });

  describe('use in entries', () => {
    it('saves a figure, lists its thumbnail, links the image to the entry and exports an absolute address', async () => {
      const asset = await upload(a, await png(80, 60, '#fedcba'));
      const saved = await a.put(
        '/api/journal/entries/2026-10-20',
        entryInput(figureDoc(asset.id, 'Tencent held 600 [1D]')),
      );
      expect(saved.status).toBe(200);
      expect(saved.json.markdown).toBe(`Chart:\n\n![Tencent held 600 1D](asset:${asset.id})`);
      expect(saved.json.thumbnailAssetId).toBe(asset.id);
      const row = (await db.db.select().from(journalAssets).where(eq(journalAssets.id, asset.id)))[0];
      expect(row?.entryId).toBe(saved.json.id);
      const list = (await a.get('/api/journal/entries?from=2026-10-20&to=2026-10-20')).json.entries[0];
      expect(list.thumbnailAssetId).toBe(asset.id);
      const exported = await a.get('/api/journal/entries/2026-10-20/export.md');
      expect(exported.text).toContain(`![Tencent held 600 1D](http://127.0.0.1:4317/api/journal/assets/${asset.id})`);
      expect(exported.text).not.toContain('asset:');
    });

    it('rejects a figure that belongs to another user, or to nobody', async () => {
      const alices = await upload(a, await png(33, 33, '#331133'));
      const stolen = await b.put('/api/journal/entries/2026-10-21', entryInput(figureDoc(alices.id)));
      expect(stolen.status).toBe(400);
      expect(stolen.json.error.code).toBe('invalid_document');
      const nobody = await a.put(
        '/api/journal/entries/2026-10-21',
        entryInput(figureDoc('0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11')),
      );
      expect(nobody.status).toBe(400);
      expect((await b.get('/api/journal/entries/2026-10-21')).status).toBe(404);
    });

    it('rejects a figure carrying an address, a script handler or any other attribute', async () => {
      const asset = await upload(a, await png(34, 34, '#343434'));
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'figure',
            attrs: { assetId: asset.id, caption: null, src: 'https://evil.example/x.png', onerror: 'alert(1)' },
          },
        ],
      };
      const r = await a.put('/api/journal/entries/2026-10-22', { ...entryInput(paragraphDoc('x')), doc });
      expect(r.status).toBe(400);
      expect(r.json.error.details.map((d: { message: string }) => d.message).join(' ')).toContain('no attribute');
    });

    it('refuses to delete an image an entry shows, and deletes it with its files once nothing does', async () => {
      const asset = await upload(a, await png(35, 35, '#353535'));
      const saved = await a.put('/api/journal/entries/2026-10-23', entryInput(figureDoc(asset.id)));
      const inUse = await a.del(asset.url);
      expect(inUse.status).toBe(409);
      expect(inUse.json.error.code).toBe('asset_in_use');
      // Take the picture out within the ten minutes the newest revision follows typing: nothing shows it any more.
      await a.put(
        '/api/journal/entries/2026-10-23',
        entryInput(paragraphDoc('no picture now'), { revisionNo: saved.json.revisionNo }),
      );
      expect((await a.del(asset.url)).json).toEqual({ ok: true });
      expect((await a.bytes(asset.url)).status).toBe(404);
      expect(existsSync(fileOf(alice.id, asset.id))).toBe(false);
      expect(existsSync(fileOf(alice.id, asset.id, 'thumb.webp'))).toBe(false);
    });

    it('keeps an image while an older revision still shows it, and restoring that revision brings the picture back', async () => {
      const asset = await upload(a, await png(36, 36, '#363636'));
      const first = await a.put('/api/journal/entries/2026-10-24', entryInput(figureDoc(asset.id)));
      opts.now = new Date(T0.getTime() + 20 * 60_000);
      const second = await a.put(
        '/api/journal/entries/2026-10-24',
        entryInput(paragraphDoc('removed it'), { revisionNo: first.json.revisionNo }),
      );
      expect(second.status).toBe(200);
      expect((await a.del(asset.url)).status).toBe(409);
      const restored = await a.post('/api/journal/entries/2026-10-24/revisions/1/restore');
      expect(restored.status).toBe(200);
      expect(restored.json.markdown).toContain(asset.id);
      opts.now = T0;
    });

    it('refuses to restore a revision whose image is gone', async () => {
      const asset = await upload(a, await png(37, 37, '#373737'));
      const first = await a.put('/api/journal/entries/2026-10-25', entryInput(figureDoc(asset.id)));
      opts.now = new Date(T0.getTime() + 20 * 60_000);
      await a.put(
        '/api/journal/entries/2026-10-25',
        entryInput(paragraphDoc('removed it'), { revisionNo: first.json.revisionNo }),
      );
      // Simulate the cleanup having removed the image row.
      await db.db.delete(journalAssets).where(eq(journalAssets.id, asset.id));
      const r = await a.post('/api/journal/entries/2026-10-25/revisions/1/restore');
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('revision_unusable');
      opts.now = T0;
    });
  });

  describe('the daily cleanup', () => {
    it('removes only images nothing shows that are over a day old, and entries deleted over 30 days ago', async () => {
      const day = 24 * 3600 * 1000;
      const old = new Date(T0.getTime() - 3 * day);
      const mk = async (c: typeof a, color: string, createdAt: Date) => {
        const asset = await upload(c, await png(41, 41, color));
        await db.db.update(journalAssets).set({ createdAt }).where(eq(journalAssets.id, asset.id));
        return asset;
      };
      const orphan = await mk(a, '#400000', old);
      const used = await mk(a, '#004000', old);
      const fresh = await mk(a, '#000040', new Date(T0.getTime() - 2 * 3600 * 1000));
      const inRevision = await mk(a, '#404000', old);
      const goneWithEntry = await mk(a, '#400040', old);
      const bobsOrphan = await mk(b, '#004040', old);

      await a.put('/api/journal/entries/2026-10-26', entryInput(figureDoc(used.id)));
      const r1 = await a.put('/api/journal/entries/2026-10-27', entryInput(figureDoc(inRevision.id)));
      opts.now = new Date(T0.getTime() + 20 * 60_000);
      await a.put(
        '/api/journal/entries/2026-10-27',
        entryInput(paragraphDoc('picture removed'), { revisionNo: r1.json.revisionNo }),
      );
      opts.now = T0;
      await a.put('/api/journal/entries/2026-10-28', entryInput(figureDoc(goneWithEntry.id)));
      await a.del('/api/journal/entries/2026-10-28');
      await db.db
        .update(journalEntries)
        .set({ deletedAt: new Date(T0.getTime() - 31 * day) })
        .where(eq(journalEntries.entryDate, '2026-10-28'));

      const result = await cleanJournal(db.db, data, T0);
      expect(result.purgedEntries).toBe(1);
      expect(result.deletedAssets).toBeGreaterThanOrEqual(3);
      const left = new Set((await db.db.select({ id: journalAssets.id }).from(journalAssets)).map((x) => x.id));
      expect(left.has(orphan.id)).toBe(false);
      expect(left.has(bobsOrphan.id)).toBe(false);
      expect(left.has(goneWithEntry.id)).toBe(false);
      expect(left.has(used.id)).toBe(true);
      expect(left.has(fresh.id)).toBe(true);
      expect(left.has(inRevision.id)).toBe(true);
      expect(existsSync(fileOf(alice.id, orphan.id))).toBe(false);
      expect(existsSync(fileOf(alice.id, orphan.id, 'thumb.webp'))).toBe(false);
      expect(existsSync(fileOf(alice.id, used.id))).toBe(true);
      expect(existsSync(fileOf(alice.id, inRevision.id))).toBe(true);
      // Running it again changes nothing.
      expect(await cleanJournal(db.db, data, T0)).toEqual({ purgedEntries: 0, deletedAssets: 0 });
    });
  });

  it('keeps every image row tied to a real user', async () => {
    const n = await db.db.execute<{ n: number }>(
      sql`select count(*)::int as n from journal_assets a where not exists (select 1 from app_users u where u.id = a.user_id)`,
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});
