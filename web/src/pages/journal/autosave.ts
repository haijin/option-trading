/**
 * Autosave for the open entry: a pure text for the header, and a small state machine that decides when to send.
 *
 * Rules (docs/designs/daily-journal.md, "Autosave and conflicts"):
 * - 1.5 s after the last change, and at once on blur, on page hide and when a template is applied;
 * - one save at a time: a change or a flush while one is in flight sends again when it returns, with the newest
 *   `revisionNo` the server handed back;
 * - an entry that does not exist on the server and has nothing in it is never created;
 * - 409 stops saving until the person picks Reload or Keep mine; a lost connection keeps the text (the host mirrors it
 *   to localStorage) and retries; any other failure retries with a growing delay.
 *
 * No React and no `fetch` in here: the host passes `save`, so the machine runs under fake timers in a test.
 */
import { type ApiError, isApiError } from '../../api/client';
import type { JournalEntryInput, JournalEntryView } from '../../api/types';
import { localTime } from './dates';
import { type Draft, isBlankDraft, type SaveSource, toInput } from './entryModel';

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number; words: number }
  | { kind: 'offline' }
  | { kind: 'conflict' }
  | { kind: 'error' };

/** Images in the document that the server does not hold yet: still uploading, or failed. */
export interface UploadSummary {
  pending: number;
  failed: number;
}

/**
 * The line under the date in the editor header. A figure that is still uploading is not saved, so while one is the line
 * says so (never "Saved"); connection and conflict problems keep their own words.
 */
export function autosaveText(status: SaveStatus, uploads: UploadSummary = { pending: 0, failed: 0 }): string {
  const own = status.kind === 'offline' || status.kind === 'conflict' || status.kind === 'error';
  if (!own && uploads.pending > 0)
    return uploads.pending === 1 ? 'Uploading image…' : `Uploading ${uploads.pending} images…`;
  if (!own && uploads.failed > 0)
    return uploads.failed === 1
      ? 'Image not uploaded. Retry or remove it'
      : 'Images not uploaded. Retry or remove them';
  switch (status.kind) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return `Saved ${localTime(status.at)} · ${status.words} ${status.words === 1 ? 'word' : 'words'}`;
    case 'offline':
      return 'Offline, saved on this phone';
    case 'conflict':
      return 'Not saved: changed on another device';
    case 'error':
      return 'Not saved. Will retry';
    case 'idle':
      return 'Saves as you type';
  }
}

export const DEBOUNCE_MS = 1500;
/** Waits between retries after a failed save; the last value repeats. */
export const RETRY_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

export interface SaverDeps {
  save: (input: JournalEntryInput, options: { keepalive: boolean }) => Promise<JournalEntryView>;
  /** The newest content in the editor (called when a save starts). */
  getDraft: () => Draft;
  onStatus: (status: SaveStatus) => void;
  /** A save landed: the host adopts `revisionNo`, `updatedAt`, mentions, word count. It must not replace editor text. */
  onSaved: (view: JournalEntryView, sent: Draft) => void;
  /** The server holds a different revision. `currentRevisionNo` is its number when it said so. */
  onConflict: (currentRevisionNo: number | null) => void;
  /** A failure other than a conflict or a lost connection (a validation error, a 5xx). */
  onError: (error: ApiError) => void;
  /** Keep a copy on the phone. `synced` is true when the server has exactly this content. */
  mirror: (draft: Draft, revisionNo: number | null, synced: boolean) => void;
  now?: () => number;
  debounceMs?: number;
}

const isConflict = (e: unknown): e is ApiError => isApiError(e) && e.status === 409 && e.code === 'revision_conflict';
// 503 = Fastify graceful shutdown; 502/504 = transient gateway error — all treated as "offline, will retry"
const isOffline = (e: unknown): boolean =>
  isApiError(e) &&
  (e.code === 'network_error' || e.status === 0 || e.status === 503 || e.status === 502 || e.status === 504);

function currentRevisionOf(e: ApiError): number | null {
  const details = e.details;
  if (typeof details === 'object' && details !== null) {
    const n = (details as { currentRevisionNo?: unknown }).currentRevisionNo;
    if (typeof n === 'number' && Number.isInteger(n)) return n;
  }
  return null;
}

export class Autosaver {
  private revision: number | null;
  private dirty = false;
  private inflight: Promise<void> | null = null;
  private again = false;
  private source: SaveSource = 'user';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private conflict = false;
  private offline = false;
  private stopped = false;
  private lastStatus: SaveStatus = { kind: 'idle' };

  constructor(
    private readonly deps: SaverDeps,
    initialRevisionNo: number | null,
  ) {
    this.revision = initialRevisionNo;
  }

  get revisionNo(): number | null {
    return this.revision;
  }
  get hasUnsaved(): boolean {
    return this.dirty || this.inflight !== null;
  }
  get inConflict(): boolean {
    return this.conflict;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private status(s: SaveStatus): void {
    this.lastStatus = s;
    this.deps.onStatus(s);
  }

  /** The editor content changed because a person edited it (never call this for a programmatic reload). */
  change(options: { source?: SaveSource; immediate?: boolean } = {}): void {
    this.stopped = false;
    this.dirty = true;
    if (options.source === 'template') this.source = 'template';
    this.deps.mirror(this.deps.getDraft(), this.revision, false);
    if (this.conflict) return;
    if (this.revision === null && isBlankDraft(this.deps.getDraft())) {
      // typed and deleted again before anything reached the server: nothing to create
      this.dirty = false;
      this.clearTimer();
      if (!this.inflight) this.status({ kind: 'idle' });
      return;
    }
    if (options.immediate) {
      void this.flush();
      return;
    }
    // While the connection is down the retry timer does the work; do not flicker "Saving…" on every keystroke.
    if (!this.offline) this.status({ kind: 'saving' });
    this.clearTimer();
    if (!this.offline) this.timer = setTimeout(() => void this.flush(), this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Sends what is unsaved now (blur, page hide, before History or Export). Resolves when nothing is left in flight.
   * `keepalive` lets the request outlive the page.
   */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    this.clearTimer();
    if (this.stopped || this.conflict) return this.inflight ?? Promise.resolve();
    if (this.inflight) {
      if (this.dirty) this.again = true;
      return this.inflight;
    }
    if (!this.dirty) return Promise.resolve();
    const draft = this.deps.getDraft();
    if (this.revision === null && isBlankDraft(draft)) {
      this.dirty = false;
      return Promise.resolve();
    }
    this.clearRetry();
    this.dirty = false;
    const source = this.source;
    const input = toInput(draft, this.revision, source);
    this.status({ kind: 'saving' });
    const run = async (): Promise<void> => {
      try {
        const view = await this.deps.save(input, { keepalive: options.keepalive ?? false });
        this.revision = view.revisionNo;
        this.attempts = 0;
        this.offline = false;
        if (source === 'template' && this.source === 'template' && !this.dirty) this.source = 'user';
        this.deps.onSaved(view, draft);
        if (!this.dirty) {
          this.deps.mirror(draft, this.revision, true);
          this.status({ kind: 'saved', at: this.now(), words: view.wordCount });
        } else {
          this.status({ kind: 'saving' });
        }
      } catch (error) {
        this.dirty = true;
        if (isConflict(error)) {
          this.conflict = true;
          this.status({ kind: 'conflict' });
          this.deps.onConflict(currentRevisionOf(error));
        } else if (isOffline(error)) {
          this.offline = true;
          this.status({ kind: 'offline' });
          this.scheduleRetry();
        } else {
          this.status({ kind: 'error' });
          if (this.attempts === 0 && isApiError(error)) this.deps.onError(error);
          this.scheduleRetry();
        }
      } finally {
        this.inflight = null;
      }
      // A flush or a template asked for another save while this one was in flight: send it now, newest revision.
      if (this.again && !this.conflict && !this.stopped) {
        this.again = false;
        if (this.dirty && !this.retryTimer) await this.flush(options);
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  private scheduleRetry(): void {
    this.clearRetry();
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)] ?? 30_000;
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.offline = false;
      void this.flush();
    }, wait);
  }

  /** Adopt a revision number the server returned for a write that did not go through the autosave (close, reopen). */
  setRevision(revisionNo: number): void {
    this.revision = revisionNo;
  }

  /** The browser says the connection is back (`online` event): try again now. */
  retryNow(): void {
    if (!this.dirty || this.conflict) return;
    this.clearRetry();
    this.offline = false;
    void this.flush();
  }

  /** Keep mine: send again over the server's newer revision (null when the entry no longer exists). Last write wins. */
  keepMine(currentRevisionNo: number | null): void {
    this.conflict = false;
    this.revision = currentRevisionNo;
    this.dirty = true;
    void this.flush();
  }

  /**
   * The editor now shows exactly what the server holds (after Reload, Restore, or using the copy from the phone):
   * nothing is unsaved, any conflict is over.
   */
  adopt(view: JournalEntryView): void {
    this.clearTimer();
    this.clearRetry();
    this.dirty = false;
    this.again = false;
    this.conflict = false;
    this.offline = false;
    this.attempts = 0;
    this.source = 'user';
    this.revision = view.revisionNo;
    this.status({ kind: 'saved', at: Date.parse(view.updatedAt) || this.now(), words: view.wordCount });
  }

  /** The entry was deleted: drop anything pending so a late retry cannot bring it back. */
  discard(): void {
    this.clearTimer();
    this.clearRetry();
    this.dirty = false;
    this.again = false;
    this.stopped = true;
  }

  /** The editor goes away: send what is pending (the request outlives the component), stop timers. */
  stop(): void {
    if (this.dirty && !this.conflict && !this.stopped) void this.flush();
    this.clearTimer();
    this.clearRetry();
    this.stopped = true;
  }

  /** Mounted (again, under StrictMode): accept changes. */
  start(): void {
    this.stopped = false;
  }

  /** What the header currently says (for tests and the host). */
  get statusNow(): SaveStatus {
    return this.lastStatus;
  }
}
