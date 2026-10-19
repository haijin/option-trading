import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalDocJson } from '../../../../src/journal';
import { ApiError } from '../../api/client';
import type { JournalEntryInput, JournalEntryView } from '../../api/types';
import { Autosaver, autosaveText, DEBOUNCE_MS, RETRY_MS, type SaverDeps, type SaveStatus } from './autosave';
import { blankDraft, type Draft } from './entryModel';

describe('autosaveText', () => {
  const at = new Date(2026, 9, 13, 16, 42).getTime();

  it('says what is happening, in the exact words of the design', () => {
    expect(autosaveText({ kind: 'saving' })).toBe('Saving…');
    expect(autosaveText({ kind: 'saved', at, words: 412 })).toBe('Saved 16:42 · 412 words');
    expect(autosaveText({ kind: 'offline' })).toBe('Offline, saved on this phone');
    expect(autosaveText({ kind: 'conflict' })).toBe('Not saved: changed on another device');
    expect(autosaveText({ kind: 'error' })).toBe('Not saved. Will retry');
  });

  it('uses the singular for one word, pads the clock, and has a line for a brand-new entry', () => {
    expect(autosaveText({ kind: 'saved', at: new Date(2026, 0, 2, 7, 5).getTime(), words: 1 })).toBe(
      'Saved 07:05 · 1 word',
    );
    expect(autosaveText({ kind: 'saved', at, words: 0 })).toBe('Saved 16:42 · 0 words');
    expect(autosaveText({ kind: 'idle' })).toBe('Saves as you type');
  });
});

describe('autosaveText with images', () => {
  const at = new Date(2026, 9, 13, 16, 42).getTime();
  const saved = { kind: 'saved', at, words: 412 } as const;

  it('never says Saved while an image is still uploading', () => {
    expect(autosaveText(saved, { pending: 1, failed: 0 })).toBe('Uploading image…');
    expect(autosaveText(saved, { pending: 3, failed: 0 })).toBe('Uploading 3 images…');
    expect(autosaveText({ kind: 'saving' }, { pending: 1, failed: 0 })).toBe('Uploading image…');
    expect(autosaveText({ kind: 'idle' }, { pending: 1, failed: 0 })).toBe('Uploading image…');
  });

  it('says an image was not uploaded while a failed one is still in the entry', () => {
    expect(autosaveText(saved, { pending: 0, failed: 1 })).toBe('Image not uploaded. Retry or remove it');
    expect(autosaveText(saved, { pending: 0, failed: 2 })).toBe('Images not uploaded. Retry or remove them');
    // an upload under way outranks an old failure
    expect(autosaveText(saved, { pending: 1, failed: 1 })).toBe('Uploading image…');
  });

  it('keeps the words for a lost connection, a conflict and a save error', () => {
    const both = { pending: 1, failed: 1 };
    expect(autosaveText({ kind: 'offline' }, both)).toBe('Offline, saved on this phone');
    expect(autosaveText({ kind: 'conflict' }, both)).toBe('Not saved: changed on another device');
    expect(autosaveText({ kind: 'error' }, both)).toBe('Not saved. Will retry');
  });

  it('is the plain text when there are no images in flight', () => {
    expect(autosaveText(saved, { pending: 0, failed: 0 })).toBe('Saved 16:42 · 412 words');
    expect(autosaveText(saved)).toBe('Saved 16:42 · 412 words');
  });
});

// ---------------------------------------------------------------------------------------------- the machine
const docOf = (text: string): JournalDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function viewOf(input: JournalEntryInput, revisionNo: number): JournalEntryView {
  return {
    id: 'e1',
    date: '2026-10-13',
    title: input.title,
    template: input.template,
    marketView: input.marketView,
    tags: input.tags,
    status: 'draft',
    wordCount: 7,
    excerpt: '',
    mentions: [],
    thumbnailAssetId: null,
    aiPolished: false,
    updatedAt: '2026-10-13T08:00:00.000Z',
    doc: input.doc,
    markdown: '',
    revisionNo,
    createdAt: '2026-10-13T07:00:00.000Z',
    revisionCount: 1,
    lastAi: null,
  };
}

interface Harness {
  saver: Autosaver;
  draft: { current: Draft };
  statuses: SaveStatus[];
  calls: { input: JournalEntryInput; keepalive: boolean }[];
  saved: JournalEntryView[];
  conflicts: (number | null)[];
  errors: ApiError[];
  mirrors: { draft: Draft; revisionNo: number | null; synced: boolean }[];
  /** Resolve or reject the oldest save still waiting. */
  settle: (result: { revisionNo: number } | Error) => Promise<void>;
  waiting: () => number;
}

function harness(initialRevision: number | null, start: Draft = blankDraft()): Harness {
  const draft = { current: start };
  const statuses: SaveStatus[] = [];
  const calls: Harness['calls'] = [];
  const pending: { input: JournalEntryInput; resolve: (v: JournalEntryView) => void; reject: (e: Error) => void }[] =
    [];
  const saved: JournalEntryView[] = [];
  const conflicts: (number | null)[] = [];
  const errors: ApiError[] = [];
  const mirrors: Harness['mirrors'] = [];
  const deps: SaverDeps = {
    save: (input, options) => {
      calls.push({ input, keepalive: options.keepalive });
      return new Promise<JournalEntryView>((resolve, reject) => pending.push({ input, resolve, reject }));
    },
    getDraft: () => draft.current,
    onStatus: (s) => statuses.push(s),
    onSaved: (view) => saved.push(view),
    onConflict: (n) => conflicts.push(n),
    onError: (e) => errors.push(e),
    mirror: (d, revisionNo, synced) => mirrors.push({ draft: d, revisionNo, synced }),
    now: () => 1_000,
  };
  const saver = new Autosaver(deps, initialRevision);
  return {
    saver,
    draft,
    statuses,
    calls,
    saved,
    conflicts,
    errors,
    mirrors,
    waiting: () => pending.length,
    settle: async (result) => {
      const next = pending.shift();
      if (!next) throw new Error('no save is waiting');
      if (result instanceof Error) next.reject(result);
      else next.resolve(viewOf(next.input, result.revisionNo));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

const typed = (text: string): Draft => ({ ...blankDraft(), doc: docOf(text) });
const last = (h: Harness): SaveStatus | undefined => h.statuses[h.statuses.length - 1];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Autosaver', () => {
  it('saves 1.5 s after the last change, not before, and restarts the wait on every change', async () => {
    const h = harness(null);
    h.draft.current = typed('a');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    h.draft.current = typed('ab');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    expect(h.calls).toHaveLength(0);
    expect(last(h)).toEqual({ kind: 'saving' });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.input.doc).toEqual(docOf('ab'));
    expect(h.calls[0]?.input.revisionNo).toBeNull();
    await h.settle({ revisionNo: 1 });
    expect(last(h)).toEqual({ kind: 'saved', at: 1_000, words: 7 });
    expect(h.saver.revisionNo).toBe(1);
    expect(h.saved).toHaveLength(1);
  });

  it('never creates an entry nobody wrote in, even if the change was typed and deleted again', async () => {
    const h = harness(null);
    h.draft.current = typed('a');
    h.saver.change();
    h.draft.current = blankDraft();
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(h.calls).toHaveLength(0);
    expect(last(h)).toEqual({ kind: 'idle' });
    // but an entry that already exists on the server may be saved as blank (the person cleared it)
    const existing = harness(5, blankDraft());
    existing.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(existing.calls).toHaveLength(1);
    expect(existing.calls[0]?.input.revisionNo).toBe(5);
  });

  it('mirrors every change to the phone as unsent, and the saved content as synced', async () => {
    const h = harness(2);
    h.draft.current = typed('x');
    h.saver.change();
    expect(h.mirrors.at(-1)).toMatchObject({ revisionNo: 2, synced: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle({ revisionNo: 3 });
    expect(h.mirrors.at(-1)).toMatchObject({ revisionNo: 3, synced: true });
  });

  it('flushes at once (blur, page hide) and passes keepalive through', async () => {
    const h = harness(2);
    h.draft.current = typed('x');
    h.saver.change();
    void h.saver.flush({ keepalive: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.keepalive).toBe(true);
    // the pending 1.5 s timer was cancelled: no second save is made for the same change
    await h.settle({ revisionNo: 3 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.calls).toHaveLength(1);
  });

  it('does nothing on flush when nothing changed', async () => {
    const h = harness(2);
    await h.saver.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('sends one save at a time and sends again with the newest revisionNo when the first returns', async () => {
    const h = harness(1);
    h.draft.current = typed('one');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    // typing continues while the first save is in flight; blur asks for another save
    h.draft.current = typed('one two');
    h.saver.change();
    void h.saver.flush();
    expect(h.calls).toHaveLength(1);
    await h.settle({ revisionNo: 2 });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input.revisionNo).toBe(2);
    expect(h.calls[1]?.input.doc).toEqual(docOf('one two'));
    await h.settle({ revisionNo: 3 });
    expect(h.saver.revisionNo).toBe(3);
    expect(last(h)).toMatchObject({ kind: 'saved' });
    expect(h.waiting()).toBe(0);
  });

  it('lets the debounce handle changes made during a save instead of sending after every round trip', async () => {
    const h = harness(1);
    h.draft.current = typed('one');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    h.draft.current = typed('one two');
    h.saver.change();
    await h.settle({ revisionNo: 2 });
    expect(h.calls).toHaveLength(1);
    expect(last(h)).toEqual({ kind: 'saving' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input.revisionNo).toBe(2);
  });

  it('keeps the text and the offline line when the connection is down, then retries and recovers', async () => {
    const h = harness(1);
    h.draft.current = typed('x');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('network_error', 'Cannot reach the server.', 0));
    expect(last(h)).toEqual({ kind: 'offline' });
    expect(h.errors).toHaveLength(0);
    expect(h.saver.hasUnsaved).toBe(true);
    // more typing while offline does not flicker "Saving…" and does not hammer the network
    h.draft.current = typed('xy');
    h.saver.change();
    expect(last(h)).toEqual({ kind: 'offline' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.calls).toHaveLength(1);
    expect(h.mirrors.at(-1)).toMatchObject({ synced: false });
    // the retry fires after the first back-off and sends the newest text
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 5000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input.doc).toEqual(docOf('xy'));
    await h.settle({ revisionNo: 2 });
    expect(last(h)).toMatchObject({ kind: 'saved' });
    expect(h.mirrors.at(-1)).toMatchObject({ synced: true, revisionNo: 2 });
  });

  it('treats 503 (Fastify graceful shutdown) as offline, not a persistent error', async () => {
    const h = harness(1);
    h.draft.current = typed('x');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('http_error', 'Service Unavailable', 503));
    expect(last(h)).toEqual({ kind: 'offline' });
    expect(h.errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 5000);
    expect(h.calls).toHaveLength(2);
    await h.settle({ revisionNo: 2 });
    expect(last(h)).toMatchObject({ kind: 'saved' });
  });

  it('retries at once when the browser reports the connection is back', async () => {
    const h = harness(1);
    h.draft.current = typed('x');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('network_error', 'down', 0));
    h.saver.retryNow();
    expect(h.calls).toHaveLength(2);
    await h.settle({ revisionNo: 2 });
    expect(last(h)).toMatchObject({ kind: 'saved' });
  });

  it('says "Not saved. Will retry" for a server error, toasts it once and backs off', async () => {
    const h = harness(1);
    h.draft.current = typed('x');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('internal_error', 'boom', 500));
    expect(last(h)).toEqual({ kind: 'error' });
    expect(h.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 5000);
    await h.settle(new ApiError('internal_error', 'boom', 500));
    expect(h.errors).toHaveLength(1);
    // the second wait is longer than the first
    await vi.advanceTimersByTimeAsync((RETRY_MS[0] ?? 5000) + 100);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync((RETRY_MS[1] ?? 10000) - (RETRY_MS[0] ?? 5000));
    expect(h.calls).toHaveLength(3);
  });

  it('stops on 409, keeps typing local, and resends over the server revision on Keep mine', async () => {
    const h = harness(1);
    h.draft.current = typed('mine');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('revision_conflict', 'changed', 409, { currentRevisionNo: 5 }));
    expect(last(h)).toEqual({ kind: 'conflict' });
    expect(h.conflicts).toEqual([5]);
    expect(h.saver.inConflict).toBe(true);
    // typing on keeps the copy on the phone but sends nothing
    h.draft.current = typed('mine more');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    void h.saver.flush();
    expect(h.calls).toHaveLength(1);
    expect(last(h)).toEqual({ kind: 'conflict' });
    expect(h.mirrors.at(-1)).toMatchObject({ synced: false });
    h.saver.keepMine(5);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.input.revisionNo).toBe(5);
    expect(h.calls[1]?.input.doc).toEqual(docOf('mine more'));
    await h.settle({ revisionNo: 6 });
    expect(last(h)).toMatchObject({ kind: 'saved' });
    expect(h.saver.inConflict).toBe(false);
  });

  it('reports a conflict without a revision number as null', async () => {
    const h = harness(1);
    h.draft.current = typed('mine');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('revision_conflict', 'changed', 409));
    expect(h.conflicts).toEqual([null]);
  });

  it('adopt() (after Reload or Restore) ends a conflict and clears the unsaved state', async () => {
    const h = harness(1);
    h.draft.current = typed('mine');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await h.settle(new ApiError('revision_conflict', 'changed', 409, { currentRevisionNo: 5 }));
    h.saver.adopt(viewOf({ ...blankDraftInput(), doc: docOf('theirs') }, 5));
    expect(h.saver.revisionNo).toBe(5);
    expect(h.saver.hasUnsaved).toBe(false);
    expect(h.saver.inConflict).toBe(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.calls).toHaveLength(1);
  });

  it('sends a template save at once with source "template", then goes back to normal saves', async () => {
    const h = harness(3, typed('notes'));
    h.draft.current = typed('notes plus template');
    h.saver.change({ source: 'template', immediate: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.input.source).toBe('template');
    await h.settle({ revisionNo: 4 });
    h.draft.current = typed('notes plus template, edited');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect('source' in (h.calls[1]?.input ?? {})).toBe(false);
  });

  it('keeps asking for the template flag when the template save has to be retried', async () => {
    const h = harness(3, typed('notes'));
    h.saver.change({ source: 'template', immediate: true });
    await h.settle(new ApiError('network_error', 'down', 0));
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 5000);
    expect(h.calls[1]?.input.source).toBe('template');
  });

  it('sends a pending change when the editor goes away, and discard() stops everything for good', async () => {
    const h = harness(1);
    h.draft.current = typed('x');
    h.saver.change();
    h.saver.stop();
    expect(h.calls).toHaveLength(1);
    await h.settle({ revisionNo: 2 });

    const d = harness(1);
    d.draft.current = typed('y');
    d.saver.change();
    d.saver.discard();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    void d.saver.flush();
    d.saver.stop();
    expect(d.calls).toHaveLength(0);
  });

  it('can start again after stop (React StrictMode mounts, unmounts and mounts again)', async () => {
    const h = harness(1);
    h.saver.stop();
    h.saver.start();
    h.draft.current = typed('x');
    h.saver.change();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
  });
});

function blankDraftInput(): JournalEntryInput {
  return { title: null, template: null, marketView: 'neutral', tags: [], doc: docOf(''), revisionNo: null };
}
