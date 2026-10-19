/**
 * The copy of the open entry kept in localStorage: the fallback when the network is down or the page is killed before a
 * save lands. Every access is wrapped in try/catch (private windows, blocked site data and quota errors throw), and the
 * page works the same without storage.
 */
import type { JournalDocJson, JournalMarketView, JournalTemplateId } from '../../../../src/journal';
import type { JournalEntryView } from '../../api/types';
import { type Draft, isBlankDraft, sameAsServer } from './entryModel';

const PREFIX = 'ot.journal.entry.';
const KEEP_SYNCED_DAYS = 14;

export interface LocalCopy {
  v: 1;
  date: string;
  title: string;
  tags: string[];
  marketView: JournalMarketView;
  template: JournalTemplateId | null;
  doc: JournalDocJson;
  /** The revision this copy was based on; null when the entry had never reached the server. */
  revisionNo: number | null;
  /** Epoch ms of the last change. */
  savedAt: number;
  /** True once the server has this exact content (the copy is then only an offline cache). */
  synced: boolean;
}

export const localKey = (date: string): string => `${PREFIX}${date}`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isCopy(value: unknown): value is LocalCopy {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<LocalCopy>;
  return (
    c.v === 1 &&
    typeof c.date === 'string' &&
    typeof c.title === 'string' &&
    Array.isArray(c.tags) &&
    (c.marketView === 'bullish' || c.marketView === 'neutral' || c.marketView === 'bearish') &&
    typeof c.doc === 'object' &&
    c.doc !== null &&
    (c.doc as { type?: unknown }).type === 'doc' &&
    typeof c.savedAt === 'number' &&
    typeof c.synced === 'boolean' &&
    (c.revisionNo === null || typeof c.revisionNo === 'number')
  );
}

export function readLocalCopy(date: string, store: Storage | null = storage()): LocalCopy | null {
  try {
    const text = store?.getItem(localKey(date));
    if (!text) return null;
    const value: unknown = JSON.parse(text);
    return isCopy(value) && value.date === date ? value : null;
  } catch {
    return null;
  }
}

/** Returns false when nothing could be written (no storage, quota). */
export function writeLocalCopy(copy: LocalCopy, store: Storage | null = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(localKey(copy.date), JSON.stringify(copy));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalCopy(date: string, store: Storage | null = storage()): void {
  try {
    store?.removeItem(localKey(date));
  } catch {
    // nothing to do: the copy is only a convenience
  }
}

export function makeLocalCopy(
  date: string,
  draft: Draft,
  revisionNo: number | null,
  synced: boolean,
  now: number = Date.now(),
): LocalCopy {
  return {
    v: 1,
    date,
    title: draft.title,
    tags: draft.tags,
    marketView: draft.marketView,
    template: draft.template,
    doc: draft.doc,
    revisionNo,
    savedAt: now,
    synced,
  };
}

export const draftFromLocal = (c: LocalCopy): Draft => ({
  title: c.title,
  tags: c.tags,
  marketView: c.marketView,
  template: c.template,
  doc: c.doc,
});

/** Removes copies the server already has once they are old, so storage does not fill up over a year of entries. */
export function pruneLocalCopies(now: number = Date.now(), store: Storage | null = storage()): void {
  try {
    if (!store) return;
    const limit = now - KEEP_SYNCED_DAYS * 86_400_000;
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const copy = readLocalCopy(key.slice(PREFIX.length), store);
      if (!copy || (copy.synced && copy.savedAt < limit)) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // ignore
  }
}

export type LocalOffer = 'newer' | 'older';

/**
 * Should the editor offer the copy kept on the phone? Only when it was never sent (not `synced`), it has something in
 * it, and it differs from the server's entry. `newer` when it was saved after the server's last update, `older` when
 * another device wrote in between (the person still decides: typed text is never dropped silently).
 */
export function localOffer(local: LocalCopy | null, server: JournalEntryView | null): LocalOffer | null {
  if (!local || local.synced) return null;
  if (server) {
    if (sameAsServer(draftFromLocal(local), server)) return null;
    return local.savedAt > Date.parse(server.updatedAt) ? 'newer' : 'older';
  }
  return isBlankDraft(draftFromLocal(local)) ? null : 'newer';
}
