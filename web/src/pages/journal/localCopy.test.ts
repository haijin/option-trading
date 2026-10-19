import { describe, expect, it } from 'vitest';
import { type JournalDocJson, renderMarkdown } from '../../../../src/journal';
import type { JournalEntryView } from '../../api/types';
import { blankDraft, type Draft } from './entryModel';
import {
  clearLocalCopy,
  draftFromLocal,
  localKey,
  localOffer,
  makeLocalCopy,
  pruneLocalCopies,
  readLocalCopy,
  writeLocalCopy,
} from './localCopy';

const docOf = (text: string): JournalDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const draftOf = (text: string): Draft => ({ ...blankDraft(), doc: docOf(text), title: 'T' });

/** A Storage that keeps strings in a Map. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

/** A Storage whose every method throws, like a blocked or full one. */
function brokenStorage(): Storage {
  const boom = () => {
    throw new Error('SecurityError');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

function serverEntry(draft: Draft, updatedAt: string): JournalEntryView {
  return {
    id: 'e1',
    date: '2026-10-13',
    title: draft.title || null,
    template: draft.template,
    marketView: draft.marketView,
    tags: draft.tags,
    status: 'draft',
    wordCount: 1,
    excerpt: '',
    mentions: [],
    thumbnailAssetId: null,
    aiPolished: false,
    updatedAt,
    doc: draft.doc,
    markdown: renderMarkdown(draft.doc),
    revisionNo: 2,
    createdAt: updatedAt,
    revisionCount: 1,
    lastAi: null,
  };
}

describe('the copy kept on the phone', () => {
  it('round-trips under a per-date key', () => {
    const store = memoryStorage();
    const copy = makeLocalCopy('2026-10-13', draftOf('hello'), 3, false, 1000);
    expect(writeLocalCopy(copy, store)).toBe(true);
    expect(store.getItem(localKey('2026-10-13'))).not.toBeNull();
    expect(readLocalCopy('2026-10-13', store)).toEqual(copy);
    expect(readLocalCopy('2026-10-12', store)).toBeNull();
    expect(draftFromLocal(copy).doc).toEqual(docOf('hello'));
    clearLocalCopy('2026-10-13', store);
    expect(readLocalCopy('2026-10-13', store)).toBeNull();
  });

  it('survives storage that throws on every call', () => {
    const store = brokenStorage();
    const copy = makeLocalCopy('2026-10-13', draftOf('x'), null, false);
    expect(writeLocalCopy(copy, store)).toBe(false);
    expect(readLocalCopy('2026-10-13', store)).toBeNull();
    expect(() => clearLocalCopy('2026-10-13', store)).not.toThrow();
    expect(() => pruneLocalCopies(Date.now(), store)).not.toThrow();
  });

  it('works without any storage at all', () => {
    const copy = makeLocalCopy('2026-10-13', draftOf('x'), null, false);
    expect(writeLocalCopy(copy, null)).toBe(false);
    expect(readLocalCopy('2026-10-13', null)).toBeNull();
    expect(() => clearLocalCopy('2026-10-13', null)).not.toThrow();
  });

  it('ignores corrupt or foreign values', () => {
    const store = memoryStorage();
    store.setItem(localKey('2026-10-13'), '{not json');
    expect(readLocalCopy('2026-10-13', store)).toBeNull();
    store.setItem(localKey('2026-10-13'), JSON.stringify({ v: 2 }));
    expect(readLocalCopy('2026-10-13', store)).toBeNull();
    // a copy stored under another date's key is not trusted
    const other = makeLocalCopy('2026-10-12', draftOf('x'), null, false);
    store.setItem(localKey('2026-10-13'), JSON.stringify(other));
    expect(readLocalCopy('2026-10-13', store)).toBeNull();
  });

  it('prunes old synced copies and keeps unsent or recent ones', () => {
    const store = memoryStorage();
    const day = 86_400_000;
    const now = 100 * day;
    writeLocalCopy(makeLocalCopy('2026-01-01', draftOf('old synced'), 1, true, now - 30 * day), store);
    writeLocalCopy(makeLocalCopy('2026-01-02', draftOf('old unsent'), 1, false, now - 30 * day), store);
    writeLocalCopy(makeLocalCopy('2026-01-03', draftOf('new synced'), 1, true, now - 2 * day), store);
    store.setItem('unrelated', 'x');
    pruneLocalCopies(now, store);
    expect(readLocalCopy('2026-01-01', store)).toBeNull();
    expect(readLocalCopy('2026-01-02', store)).not.toBeNull();
    expect(readLocalCopy('2026-01-03', store)).not.toBeNull();
    expect(store.getItem('unrelated')).toBe('x');
  });
});

describe('offering the copy from the phone', () => {
  const serverAt = '2026-10-13T08:00:00.000Z';
  const serverMs = Date.parse(serverAt);

  it('offers a newer unsent copy that differs from the server', () => {
    const server = serverEntry(draftOf('server text'), serverAt);
    const local = makeLocalCopy('2026-10-13', draftOf('typed offline'), 2, false, serverMs + 60_000);
    expect(localOffer(local, server)).toBe('newer');
  });

  it('still offers an older unsent copy (another device wrote after it), marked older', () => {
    const server = serverEntry(draftOf('server text'), serverAt);
    const local = makeLocalCopy('2026-10-13', draftOf('typed offline'), 2, false, serverMs - 60_000);
    expect(localOffer(local, server)).toBe('older');
  });

  it('offers nothing when the content is the same, the copy was already sent, or there is no copy', () => {
    const draft = draftOf('same');
    const server = serverEntry(draft, serverAt);
    expect(localOffer(makeLocalCopy('2026-10-13', draft, 2, false, serverMs + 1), server)).toBeNull();
    expect(localOffer(makeLocalCopy('2026-10-13', draftOf('other'), 2, true, serverMs + 1), server)).toBeNull();
    expect(localOffer(null, server)).toBeNull();
  });

  it('offers an unsent copy of an entry the server does not have, unless it is blank', () => {
    expect(localOffer(makeLocalCopy('2026-10-13', draftOf('typed'), null, false), null)).toBe('newer');
    expect(localOffer(makeLocalCopy('2026-10-13', blankDraft(), null, false), null)).toBeNull();
  });
});
