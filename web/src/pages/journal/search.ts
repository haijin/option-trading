import { mentionLabel, parseMention } from '../../../../src/journal';

/** What the search box turns into: the `q`, `symbol` and `tag` parameters of `GET /api/journal/entries`. */
export interface JournalSearch {
  /** Free words, space separated. */
  q: string;
  /** `NKE` or `0700.HK` (from `$NKE` / `$0700.HK`), the way the server expects a symbol. */
  symbol?: string;
  /** A tag without the leading `#`. */
  tag?: string;
}

/**
 * Splits the search box into words, one `$symbol` and one `#tag`. A lone `$` or `#` (the person is still typing) is
 * ignored; a `$word` that is not a stock name stays a word; a second `$symbol` or `#tag` becomes a plain word.
 */
export function parseSearch(text: string): JournalSearch {
  const words: string[] = [];
  let symbol: string | undefined;
  let tag: string | undefined;
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('$')) {
      if (token.length === 1) continue;
      const ref = parseMention(token);
      if (ref && symbol === undefined) symbol = mentionLabel(ref);
      else words.push(token.slice(1));
    } else if (token.startsWith('#')) {
      const name = token.replace(/^#+/, '');
      if (!name) continue;
      if (tag === undefined) tag = name.toLowerCase();
      else words.push(name);
    } else {
      words.push(token);
    }
  }
  const out: JournalSearch = { q: words.join(' ') };
  if (symbol !== undefined) out.symbol = symbol;
  if (tag !== undefined) out.tag = tag;
  return out;
}

export const isFiltering = (s: JournalSearch): boolean => s.q !== '' || s.symbol !== undefined || s.tag !== undefined;
