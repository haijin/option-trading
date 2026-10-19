import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JournalDocJson, journalSchemaExtensions, validateJournalDoc } from '../../../../src/journal';
import { ApiError } from '../../api/client';
import type { JournalAssetView } from '../../api/types';
import { toInput } from './entryModel';
import { makeLocalCopy } from './localCopy';
import {
  clipboardImageFiles,
  type DataLike,
  dropImageFiles,
  handleImageDrop,
  handleImagePaste,
  imageFilesOf,
  insertImageFiles,
  isImageFile,
  isPendingAssetId,
  pendingFigureIds,
  stripPendingFigures,
  swapFigureId,
  UploadManager,
} from './uploads';

const REAL = '11111111-1111-4111-8111-111111111111';
const REAL2 = '22222222-2222-4222-8222-222222222222';
const asset = (id: string): JournalAssetView => ({ id, url: `/api/journal/assets/${id}`, width: 800, height: 600 });

const para = (text: string): JSONContent =>
  text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] };
const fig = (assetId: string | null, caption: string | null = null): JSONContent => ({
  type: 'figure',
  attrs: { assetId, caption },
});
const docOf = (...content: JSONContent[]): JournalDocJson => ({ type: 'doc', content }) as JournalDocJson;

describe('stripPendingFigures', () => {
  it('leaves a document with only real images exactly as it is (the same object)', () => {
    const doc = docOf(para('a'), fig(REAL, 'chart'), para('b'));
    expect(stripPendingFigures(doc)).toBe(doc);
  });

  it('takes out figures that are uploading, failed or without an id, and keeps the rest in order', () => {
    const doc = docOf(para('a'), fig('pending-1-abc'), para('b'), fig(REAL), fig(null), fig('not-a-uuid'), para('c'));
    expect(stripPendingFigures(doc).content).toEqual([para('a'), para('b'), fig(REAL), para('c')]);
  });

  it('always leaves a block behind: a document that was only a pending figure becomes one empty paragraph', () => {
    const doc = docOf(fig('pending-1-abc'));
    expect(stripPendingFigures(doc).content).toEqual([{ type: 'paragraph' }]);
    expect(validateJournalDoc(stripPendingFigures(doc)).ok).toBe(true);
  });

  it('removes a callout or list item that held only the pending figure, but keeps one that has text', () => {
    const doc = docOf(
      { type: 'blockquote', content: [fig('pending-2-x')] },
      { type: 'blockquote', content: [para('keep me'), fig('pending-3-x')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('item'), fig('pending-4-x')] }] },
    );
    expect(stripPendingFigures(doc).content).toEqual([
      { type: 'blockquote', content: [para('keep me')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('item')] }] },
    ]);
  });

  it('is what the save and the copy on the phone are made from: no pending id ever reaches either', () => {
    const doc = docOf(para('text'), fig('pending-1-abc'), fig(REAL));
    const draft = {
      title: 'T',
      tags: [],
      marketView: 'neutral' as const,
      template: null,
      doc: stripPendingFigures(doc),
    };
    expect(JSON.stringify(toInput(draft, 3, 'user'))).not.toContain('pending-');
    expect(JSON.stringify(makeLocalCopy('2026-10-13', draft, 3, false))).not.toContain('pending-');
    expect(JSON.stringify(toInput(draft, 3, 'user'))).toContain(REAL);
  });
});

describe('pendingFigureIds and isPendingAssetId', () => {
  it('lists the figures the server does not hold', () => {
    const doc = docOf(fig('pending-1-a'), para('x'), fig(REAL), { type: 'blockquote', content: [fig('pending-2-b')] });
    expect(pendingFigureIds(doc)).toEqual(['pending-1-a', 'pending-2-b']);
    expect(pendingFigureIds(docOf(para('x'), fig(REAL)))).toEqual([]);
  });

  it('knows a real asset id from a temporary one', () => {
    expect(isPendingAssetId(REAL)).toBe(false);
    expect(isPendingAssetId('pending-1-abc')).toBe(true);
    expect(isPendingAssetId(null)).toBe(true);
    expect(isPendingAssetId(undefined)).toBe(true);
  });
});

describe('finding images in files, a paste and a drop', () => {
  const file = (name: string, type: string) => new File(['x'], name, { type });

  it('takes images by type, and HEIC by name when the type is empty', () => {
    expect(isImageFile(file('a.png', 'image/png'))).toBe(true);
    expect(isImageFile(file('IMG_0001.HEIC', ''))).toBe(true);
    expect(isImageFile(file('notes.txt', 'text/plain'))).toBe(false);
    expect(isImageFile(file('noext', ''))).toBe(false);
    expect(imageFilesOf([file('a.png', 'image/png'), file('b.pdf', 'application/pdf')]).map((f) => f.name)).toEqual([
      'a.png',
    ]);
  });

  it('picks the image items of a paste (an iOS screenshot) and nothing else', () => {
    const shot = file('image.png', 'image/png');
    const data: DataLike = {
      items: [
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => shot },
        { kind: 'file', type: 'application/pdf', getAsFile: () => file('a.pdf', 'application/pdf') },
      ],
      getData: () => '',
    };
    expect(clipboardImageFiles(data)).toEqual([shot]);
  });

  it('falls back to the files of a paste when there are no items', () => {
    const shot = file('image.png', 'image/png');
    expect(clipboardImageFiles({ files: [shot], getData: () => '' })).toEqual([shot]);
  });

  it('leaves a paste that also carries text to the normal text paste (a spreadsheet range)', () => {
    const picture = file('range.png', 'image/png');
    const data: DataLike = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => picture }],
      getData: (format) => (format === 'text/plain' ? 'A1\tB1\n1\t2' : ''),
    };
    expect(clipboardImageFiles(data)).toEqual([]);
  });

  it('copes with no clipboard data at all, and with a drop', () => {
    expect(clipboardImageFiles(null)).toEqual([]);
    expect(clipboardImageFiles(undefined)).toEqual([]);
    const a = file('a.jpg', 'image/jpeg');
    expect(dropImageFiles({ files: [a, file('b.txt', 'text/plain')] })).toEqual([a]);
    expect(dropImageFiles(null)).toEqual([]);
  });
});

describe('UploadManager', () => {
  function setup(
    upload: (file: Blob, o: { onProgress?: (f: number) => void; signal?: AbortSignal }) => Promise<JournalAssetView>,
  ) {
    const revoked: string[] = [];
    let counter = 0;
    const warmed: { url: string; done: () => void }[] = [];
    const manager = new UploadManager({
      upload,
      createPreviewUrl: () => `blob:preview-${++counter}`,
      revokePreviewUrl: (u) => revoked.push(u),
      warm: (url, done) => warmed.push({ url, done }),
    });
    return { manager, revoked, warmed };
  }
  const file = () => new File(['x'], 'a.png', { type: 'image/png' });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('starts an upload with a temporary id (never a UUID) and a local preview', () => {
    const { manager } = setup(() => new Promise(() => undefined));
    const id = manager.start(file());
    expect(isPendingAssetId(id)).toBe(true);
    expect(manager.get(id)).toMatchObject({
      status: 'uploading',
      progress: 0,
      previewUrl: 'blob:preview-1',
      message: null,
    });
    expect(manager.summary([id])).toEqual({ pending: 1, failed: 0 });
  });

  it('follows progress, then on success forgets the record, hands over the real id, and keeps the preview until the stored image is cached', async () => {
    let resolve: (a: JournalAssetView) => void = () => undefined;
    let report: (f: number) => void = () => undefined;
    const { manager, warmed, revoked } = setup((_f, o) => {
      report = o.onProgress ?? (() => undefined);
      return new Promise((r) => {
        resolve = r;
      });
    });
    const uploaded = vi.fn();
    manager.onUploaded = uploaded;
    const versions: number[] = [];
    manager.subscribe(() => versions.push(manager.version()));
    const id = manager.start(file());
    report(0.4);
    expect(manager.get(id)?.progress).toBe(0.4);
    resolve(asset(REAL));
    await flush();
    expect(uploaded).toHaveBeenCalledWith(id, asset(REAL));
    expect(manager.get(id)).toBeUndefined();
    expect(manager.summary([id])).toEqual({ pending: 0, failed: 1 }); // an id with no record is not "uploading"
    expect(manager.previewFor(REAL)).toBe('blob:preview-1');
    expect(warmed[0]?.url).toBe(`/api/journal/assets/${REAL}`);
    warmed[0]?.done();
    expect(manager.previewFor(REAL)).toBeUndefined();
    expect(revoked).toContain('blob:preview-1');
    // every change was announced with a new snapshot number
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('keeps a failed upload with the reason, and Retry sends it again with the same file', async () => {
    const calls: Blob[] = [];
    let fail = true;
    const { manager } = setup(async (f) => {
      calls.push(f);
      if (fail) throw new ApiError('network_error', 'Cannot reach the server. The image was not uploaded.', 0);
      return asset(REAL2);
    });
    const uploaded = vi.fn();
    manager.onUploaded = uploaded;
    const picked = file();
    const id = manager.start(picked);
    await flush();
    expect(manager.get(id)).toMatchObject({
      status: 'failed',
      message: 'Cannot reach the server. The image was not uploaded.',
    });
    expect(manager.summary([id])).toEqual({ pending: 0, failed: 1 });
    fail = false;
    manager.retry(id);
    expect(manager.get(id)).toMatchObject({ status: 'uploading', progress: 0, message: null });
    await flush();
    expect(calls).toEqual([picked, picked]);
    expect(uploaded).toHaveBeenCalledWith(id, asset(REAL2));
    expect(manager.get(id)).toBeUndefined();
  });

  it('retry does nothing for an upload that is not failed', () => {
    const upload = vi.fn(() => new Promise<JournalAssetView>(() => undefined));
    const { manager } = setup(upload);
    const id = manager.start(file());
    manager.retry(id);
    manager.retry('pending-unknown');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('remove stops an upload in flight, frees the preview, and a late answer is ignored', async () => {
    let resolve: (a: JournalAssetView) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const { manager, revoked } = setup((_f, o) => {
      signal = o.signal;
      return new Promise((r) => {
        resolve = r;
      });
    });
    const uploaded = vi.fn();
    manager.onUploaded = uploaded;
    const id = manager.start(file());
    manager.remove(id);
    expect(signal?.aborted).toBe(true);
    expect(revoked).toEqual(['blob:preview-1']);
    expect(manager.get(id)).toBeUndefined();
    resolve(asset(REAL));
    await flush();
    expect(uploaded).not.toHaveBeenCalled();
  });

  it('removes a failed upload, and dispose stops everything and frees every preview', async () => {
    const { manager, revoked } = setup((_f, o) =>
      o.signal ? new Promise(() => undefined) : Promise.reject(new Error('x')),
    );
    const a = manager.start(file());
    const b = manager.start(file());
    manager.remove(a);
    expect(manager.get(a)).toBeUndefined();
    manager.dispose();
    expect(manager.get(b)).toBeUndefined();
    expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2']);
  });
});

describe('inserting images into the editor', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });
  const make = (content?: JSONContent) => {
    editor = new Editor({
      extensions: journalSchemaExtensions(),
      content: content ?? { type: 'doc', content: [para('')] },
    });
    return editor;
  };
  const figures = (e: Editor) => (e.getJSON().content ?? []).filter((n) => n.type === 'figure');
  const file = (name: string, size = 100, type = 'image/png') => new File([new Uint8Array(size)], name, { type });

  it('adds one figure per file, in order, each with its own temporary id, and starts every upload', () => {
    const e = make();
    const started: Blob[] = [];
    const manager = new UploadManager({
      upload: (f) => {
        started.push(f);
        return new Promise(() => undefined);
      },
      createPreviewUrl: () => 'blob:x',
      revokePreviewUrl: () => undefined,
    });
    const problems: string[] = [];
    const n = insertImageFiles(e, manager, [file('first.png'), file('second.png'), file('third.png')], (m) =>
      problems.push(m),
    );
    expect(n).toBe(3);
    expect(problems).toEqual([]);
    expect(started.map((f) => (f as File).name)).toEqual(['first.png', 'second.png', 'third.png']);
    const ids = figures(e).map((f) => f.attrs?.assetId as string);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => isPendingAssetId(id))).toBe(true);
    expect(ids.map((id) => manager.get(id)?.status)).toEqual(['uploading', 'uploading', 'uploading']);
    // the cursor ends on a line below the pictures, so the next thing typed does not replace a selected figure
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
    expect((e.getJSON().content ?? []).map((n) => n.type)).toEqual(['figure', 'figure', 'figure', 'paragraph']);
  });

  it('skips a file the server would refuse and says why', () => {
    const e = make();
    const upload = vi.fn(() => new Promise<JournalAssetView>(() => undefined));
    const manager = new UploadManager({ upload, createPreviewUrl: () => 'blob:x', revokePreviewUrl: () => undefined });
    const problems: string[] = [];
    const n = insertImageFiles(
      e,
      manager,
      [file('huge.png', 9 * 1024 * 1024), file('notes.pdf', 10, 'application/pdf'), file('ok.png')],
      (m) => problems.push(m),
    );
    expect(n).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(problems).toEqual([
      'huge.png: This image is 9.0 MB. Images are limited to 8 MB.',
      'notes.pdf: That file is not an image.',
    ]);
    expect(figures(e)).toHaveLength(1);
  });

  it('swaps the temporary id for the real one when the upload lands, without making an undo step', () => {
    const e = make();
    const manager = new UploadManager({
      upload: () => new Promise(() => undefined),
      createPreviewUrl: () => 'blob:x',
      revokePreviewUrl: () => undefined,
    });
    insertImageFiles(e, manager, [file('a.png')], () => undefined);
    const tempId = figures(e)[0]?.attrs?.assetId as string;
    expect(swapFigureId(e, tempId, REAL)).toBe(true);
    expect(figures(e)[0]?.attrs).toEqual({ assetId: REAL, caption: null });
    expect(validateJournalDoc(e.getJSON()).ok).toBe(true);
    // a figure that was removed meanwhile is simply not found
    expect(swapFigureId(e, 'pending-gone', REAL)).toBe(false);
  });

  it('puts the figure at the cursor, between the text before and after', () => {
    const e = make({ type: 'doc', content: [para('before'), para('after')] });
    e.commands.setTextSelection(8); // end of "before"
    const manager = new UploadManager({
      upload: () => new Promise(() => undefined),
      createPreviewUrl: () => 'blob:x',
      revokePreviewUrl: () => undefined,
    });
    insertImageFiles(e, manager, [file('a.png')], () => undefined);
    const types = (e.getJSON().content ?? []).map((n) => n.type);
    expect(types.indexOf('figure')).toBeGreaterThan(types.indexOf('paragraph'));
    expect(JSON.stringify(e.getJSON())).toContain('after');
  });
});

describe('the paste and drop handlers', () => {
  const shot = new File(['x'], 'shot.png', { type: 'image/png' });
  const text = new File(['x'], 'notes.txt', { type: 'text/plain' });

  it('paste: uploads the images, stops the browser pasting, and leaves text alone', () => {
    const insert = vi.fn();
    const preventDefault = vi.fn();
    const handled = handleImagePaste(
      {
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }], getData: () => '' },
        preventDefault,
      },
      insert,
    );
    expect(handled).toBe(true);
    expect(insert).toHaveBeenCalledWith([shot]);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const none = handleImagePaste({ clipboardData: { items: [], getData: () => 'words' }, preventDefault }, insert);
    expect(none).toBe(false);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('drop: puts the cursor where the file was dropped, then uploads the images', () => {
    const calls: string[] = [];
    const handled = handleImageDrop(
      { dataTransfer: { files: [shot, text] }, clientX: 12, clientY: 34, preventDefault: () => calls.push('prevent') },
      false,
      (files) => calls.push(`insert ${files.map((f) => f.name).join(',')}`),
      (x, y) => calls.push(`place ${x},${y}`),
    );
    expect(handled).toBe(true);
    expect(calls).toEqual(['prevent', 'place 12,34', 'insert shot.png']);
  });

  it('drop: ignores a move inside the document and files that are not images', () => {
    const insert = vi.fn();
    const base = { clientX: 1, clientY: 1, preventDefault: vi.fn() };
    expect(handleImageDrop({ ...base, dataTransfer: { files: [shot] } }, true, insert, vi.fn())).toBe(false);
    expect(handleImageDrop({ ...base, dataTransfer: { files: [text] } }, false, insert, vi.fn())).toBe(false);
    expect(handleImageDrop({ ...base, dataTransfer: null }, false, insert, vi.fn())).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(base.preventDefault).not.toHaveBeenCalled();
  });
});
