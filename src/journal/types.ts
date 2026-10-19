/** Types shared by the journal document model, the server and the web UI. Types only. */

export type JournalMarket = 'US' | 'HK';

export interface JournalMarkJson {
  type: string;
  attrs?: Record<string, unknown>;
}

/** One ProseMirror node in JSON form. */
export interface JournalNodeJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JournalNodeJson[];
  marks?: JournalMarkJson[];
  text?: string;
}

/** The root of a stored entry: `{ type: 'doc', content: [...] }`. */
export type JournalDocJson = JournalNodeJson & { type: 'doc' };

/** A stock name found in an entry (a `stockMention` mark, or a bare `$SYMBOL` in the text). */
export interface JournalMentionRef {
  market: JournalMarket;
  /** Canonical symbol: US upper-case, HK four or five digits. */
  symbol: string;
}

/** What the server derives from a document on every save. */
export interface JournalDerived {
  markdown: string;
  plain: string;
  wordCount: number;
  mentions: JournalMentionRef[];
  /** Asset ids of every figure, in document order, without duplicates. */
  assetIds: string[];
}

export type JournalTemplateId = 'morning' | 'evening' | 'trade' | 'weekly' | 'free';
export type JournalMarketView = 'bullish' | 'neutral' | 'bearish';
export type JournalStatus = 'draft' | 'closed';
