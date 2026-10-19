/** Small rules for the fields around the document: title and tags. Shared by the server and the editor. */
import { JOURNAL_LIMITS } from './schema';

/** One tag as stored: no `#`, lower-case, letters, digits, `_` and `-`; null when it cannot be one. */
export function normaliseTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').toLowerCase();
  if (t === '' || t.length > JOURNAL_LIMITS.tagChars) return null;
  return /^[\p{L}\p{N}_-]+$/u.test(t) ? t : null;
}

/** The tag list of an entry, normalised and without duplicates; null when any tag is invalid or there are too many. */
export function normaliseTags(raw: string[]): string[] | null {
  const out: string[] = [];
  for (const r of raw) {
    const t = normaliseTag(r);
    if (t === null) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out.length > JOURNAL_LIMITS.tags ? null : out;
}

/** What a person types into the tags box (`#roll-rule #hk, breach`) as a tag list; words that cannot be tags are dropped. */
export function parseTagInput(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const t = normaliseTag(part);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out.slice(0, JOURNAL_LIMITS.tags);
}

/** The title as stored: trimmed, null when empty. */
export const cleanTitle = (raw: string | null | undefined): string | null => {
  const t = (raw ?? '').trim();
  return t === '' ? null : t;
};
