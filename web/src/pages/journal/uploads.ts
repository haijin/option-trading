/**
 * Images in the editor: what a figure that is still uploading looks like to the rest of the app, the upload manager that
 * holds a local preview and a progress value per figure, and the helpers that find image files in a picker, a paste or a drop.
 *
 * A figure that is still uploading (or whose upload failed) carries a client-only temporary id. It is never sent to the
 * server and never written to the localStorage copy: `stripPendingFigures` takes it out of the document first, so a saved
 * entry can only ever point at an image the server really holds.
 */
import type { Editor } from '@tiptap/core';
import { isAssetId, type JournalDocJson, type JournalNodeJson } from '../../../../src/journal';
import { errorMessage } from '../../api/client';
import type { JournalAssetView } from '../../api/types';
import { imageFileProblem, type UploadOptions } from '../../api/upload';

// ------------------------------------------------------------------------------------------------ the document
/** True for an id the server never issued: a temporary client id, or no id at all. */
export const isPendingAssetId = (id: unknown): boolean => typeof id !== 'string' || !isAssetId(id);

/** Parents that cannot be empty in the schema: when stripping a figure leaves them without content they go too. */
const GOES_WHEN_EMPTY = new Set(['blockquote', 'listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList']);

function strip(node: JournalNodeJson): JournalNodeJson | null {
  if (node.type === 'figure' && isPendingAssetId(node.attrs?.assetId)) return null;
  if (!node.content) return node;
  let changed = false;
  const kept: JournalNodeJson[] = [];
  for (const child of node.content) {
    const result = strip(child);
    if (result !== child) changed = true;
    if (result) kept.push(result);
  }
  if (!changed) return node;
  if (kept.length === 0 && GOES_WHEN_EMPTY.has(node.type)) return null;
  return { ...node, content: kept };
}

/**
 * The document without figures that are still uploading or failed (they have no real image id). Returns the same object
 * when there are none. The result always has at least one block, as the schema needs.
 */
export function stripPendingFigures(doc: JournalDocJson): JournalDocJson {
  const result = strip(doc) as JournalDocJson | null;
  if (result === doc) return doc;
  const content = result?.content ?? [];
  return { ...doc, content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/** Ids of the figures in a document that the server does not hold (uploading, failed, or left over). */
export function pendingFigureIds(doc: JournalDocJson): string[] {
  const ids: string[] = [];
  const walk = (n: JournalNodeJson): void => {
    if (n.type === 'figure') {
      if (isPendingAssetId(n.attrs?.assetId)) ids.push(typeof n.attrs?.assetId === 'string' ? n.attrs.assetId : '');
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return ids;
}

// ------------------------------------------------------------------------------------------------ files
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif)$/i;

/** An image by its declared type, or by its name when the browser leaves the type empty (HEIC from an iPhone does). */
export const isImageFile = (file: { type: string; name?: string }): boolean =>
  file.type.startsWith('image/') || (file.type === '' && IMAGE_EXT.test(file.name ?? ''));

export const imageFilesOf = (files: ArrayLike<File> | null | undefined): File[] =>
  Array.from(files ?? []).filter(isImageFile);

/** The part of a clipboard or drag payload the helpers read (what `DataTransfer` offers, and what a test can build). */
export interface DataLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }>;
  files?: ArrayLike<File>;
  getData?: (format: string) => string;
}

/**
 * Image files in a paste (iOS 16+ pastes a screenshot as an image item). A paste that also carries text (a spreadsheet
 * range comes as text and a picture) is left to the editor's normal text paste.
 */
export function clipboardImageFiles(data: DataLike | null | undefined): File[] {
  if (!data) return [];
  if ((data.getData?.('text/plain') ?? '').trim() !== '') return [];
  const found: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) found.push(file);
    }
  }
  return found.length > 0 ? found : imageFilesOf(data.files);
}

/** Image files in a drop (desktop). */
export const dropImageFiles = (data: DataLike | null | undefined): File[] => imageFilesOf(data?.files);

// ------------------------------------------------------------------------------------------------ the manager
export interface UploadState {
  status: 'uploading' | 'failed';
  /** 0 to 1. */
  progress: number;
  /** A `blob:` URL of the picked file, so the figure shows at once. */
  previewUrl: string;
  /** Why it failed, in words; null while uploading. */
  message: string | null;
}

export interface UploaderDeps {
  upload: (file: Blob, options: UploadOptions) => Promise<JournalAssetView>;
  createPreviewUrl?: (file: Blob) => string;
  revokePreviewUrl?: (url: string) => void;
  /** Loads the stored image once in the background and calls `done` when it is in the cache (the figure then swaps to it). */
  warm?: (url: string, done: () => void) => void;
}

const defaultWarm = (url: string, done: () => void): void => {
  const image = new Image();
  image.onload = done;
  image.src = url;
};

/**
 * Holds one record per figure that is still uploading or failed. The node view of a figure reads its record to show the
 * preview, the progress ring or the "Upload failed" box; `onUploaded` lets the editor swap the temporary id for the real one.
 */
export class UploadManager {
  private readonly states = new Map<string, UploadState>();
  private readonly files = new Map<string, Blob>();
  private readonly controllers = new Map<string, AbortController>();
  /** Real id -> preview URL, kept until the stored image has loaded once so the swap does not flash. */
  private readonly previews = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private versionNo = 0;
  /** Called when an upload succeeds: swap `tempId` for `asset.id` in the document. */
  onUploaded: ((tempId: string, asset: JournalAssetView) => void) | null = null;

  constructor(private readonly deps: UploaderDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes on every update: the snapshot for `useSyncExternalStore`. */
  version = (): number => this.versionNo;

  private changed(): void {
    this.versionNo++;
    for (const listener of this.listeners) listener();
  }

  get(id: string | null | undefined): UploadState | undefined {
    return id ? this.states.get(id) : undefined;
  }

  previewFor(realId: string | null | undefined): string | undefined {
    return realId ? this.previews.get(realId) : undefined;
  }

  /** Starts uploading `file` and returns the temporary id the figure carries meanwhile. */
  start(file: Blob): string {
    const id = `pending-${++this.counter}-${Math.random().toString(36).slice(2, 8)}`;
    const create = this.deps.createPreviewUrl ?? ((f: Blob) => URL.createObjectURL(f));
    this.files.set(id, file);
    this.states.set(id, { status: 'uploading', progress: 0, previewUrl: create(file), message: null });
    this.changed();
    void this.run(id);
    return id;
  }

  /** Tries a failed upload again. */
  retry(id: string): void {
    const state = this.states.get(id);
    if (state?.status !== 'failed' || !this.files.has(id)) return;
    this.states.set(id, { ...state, status: 'uploading', progress: 0, message: null });
    this.changed();
    void this.run(id);
  }

  /** The figure was removed: stop its upload and let go of its preview. */
  remove(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.files.delete(id);
    const state = this.states.get(id);
    if (state) this.revoke(state.previewUrl);
    if (this.states.delete(id)) this.changed();
  }

  private revoke(url: string): void {
    (this.deps.revokePreviewUrl ?? ((u: string) => URL.revokeObjectURL(u)))(url);
  }

  private async run(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const asset = await this.deps.upload(file, {
        signal: controller.signal,
        onProgress: (fraction) => {
          const state = this.states.get(id);
          if (state?.status === 'uploading') {
            this.states.set(id, { ...state, progress: fraction });
            this.changed();
          }
        },
      });
      if (controller.signal.aborted || !this.states.has(id)) return;
      const state = this.states.get(id);
      this.states.delete(id);
      this.files.delete(id);
      this.controllers.delete(id);
      if (state) this.keepPreview(asset, state.previewUrl);
      this.changed();
      this.onUploaded?.(id, asset);
    } catch (error) {
      if (controller.signal.aborted || !this.states.has(id)) return;
      const state = this.states.get(id) as UploadState;
      this.controllers.delete(id);
      this.states.set(id, { ...state, status: 'failed', message: errorMessage(error) });
      this.changed();
    }
  }

  private keepPreview(asset: JournalAssetView, url: string): void {
    this.previews.set(asset.id, url);
    (this.deps.warm ?? defaultWarm)(asset.url, () => {
      if (this.previews.get(asset.id) === url) {
        this.previews.delete(asset.id);
        this.revoke(url);
        this.changed();
      }
    });
  }

  /** How many of these figure ids are uploading and how many are failed (an id nobody knows counts as failed). */
  summary(ids: readonly string[]): { pending: number; failed: number } {
    let pending = 0;
    let failed = 0;
    for (const id of ids) {
      if (this.states.get(id)?.status === 'uploading') pending++;
      else failed++;
    }
    return { pending, failed };
  }

  /** The editor is gone: stop every upload and free every preview. */
  dispose(): void {
    for (const c of this.controllers.values()) c.abort();
    for (const s of this.states.values()) this.revoke(s.previewUrl);
    for (const url of this.previews.values()) this.revoke(url);
    this.controllers.clear();
    this.files.clear();
    this.states.clear();
    this.previews.clear();
  }
}

// ------------------------------------------------------------------------------------------------ the editor
/** Replaces the temporary id of a figure with the id the server issued. Not an undo step. Returns false when the figure is gone. */
export function swapFigureId(editor: Editor, tempId: string, realId: string): boolean {
  return editor
    .chain()
    .command(({ tr, state }) => {
      let at = -1;
      let attrs: Record<string, unknown> = {};
      state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === 'figure' && node.attrs.assetId === tempId) {
          at = pos;
          attrs = node.attrs;
          return false;
        }
        return at < 0;
      });
      if (at < 0) return false;
      tr.setNodeMarkup(at, undefined, { ...attrs, assetId: realId });
      tr.setMeta('addToHistory', false);
      return true;
    })
    .run();
}

/**
 * Puts one figure per picked image into the document (in order, at the cursor) and uploads each. A file the server would
 * refuse anyway (not an image, empty, over 8 MB) is reported through `onProblem` and skipped. Returns how many were added.
 */
export function insertImageFiles(
  editor: Editor,
  manager: UploadManager,
  files: readonly File[],
  onProblem: (message: string) => void,
): number {
  const nodes: { type: string; attrs?: Record<string, unknown> }[] = [];
  for (const file of files) {
    const problem = imageFileProblem(file);
    if (problem) {
      onProblem(file.name ? `${file.name}: ${problem}` : problem);
      continue;
    }
    nodes.push({ type: 'figure', attrs: { assetId: manager.start(file), caption: null } });
  }
  if (nodes.length === 0) return 0;
  // One insert for all of them, followed by an empty line: a figure that stays selected would be replaced by the next
  // thing typed (or by the next file), and the cursor belongs on a line of its own below the pictures.
  editor
    .chain()
    .focus()
    .insertContent([...nodes, { type: 'paragraph' }])
    .run();
  return nodes.length;
}

// ------------------------------------------------------------------------------------------------ paste and drop
/** The ProseMirror `handlePaste`: images in the clipboard are uploaded, anything else is left to the normal paste. */
export function handleImagePaste(
  event: { clipboardData: DataLike | null; preventDefault: () => void },
  insert: (files: File[]) => void,
): boolean {
  const files = clipboardImageFiles(event.clipboardData);
  if (files.length === 0) return false;
  event.preventDefault();
  insert(files);
  return true;
}

/**
 * The ProseMirror `handleDrop`: image files dropped from outside the page are uploaded at the drop point (`placeCursor` puts
 * the cursor there). Moving content around inside the document, or dropping something that is not an image, is not ours.
 */
export function handleImageDrop(
  event: { dataTransfer: DataLike | null; clientX: number; clientY: number; preventDefault: () => void },
  moved: boolean,
  insert: (files: File[]) => void,
  placeCursor: (x: number, y: number) => void,
): boolean {
  const files = moved ? [] : dropImageFiles(event.dataTransfer);
  if (files.length === 0) return false;
  event.preventDefault();
  placeCursor(event.clientX, event.clientY);
  insert(files);
  return true;
}
