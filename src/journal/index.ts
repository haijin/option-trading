/**
 * The journal document model: schema, validation, derived text, templates. Pure (no database, clock or network), so the
 * server and the editor share it. See docs/designs/daily-journal.md.
 */
export {
  ASSET_LIMITS,
  assetRelPath,
  EXT_OF,
  isAssetId,
  MIME_OF,
  type SniffedImage,
  type StoredFormat,
  sniffImage,
  storedFormatOf,
  thumbRelPath,
} from './assets';
export {
  countWords,
  deriveFromDoc,
  excerptOf,
  extractLessons,
  type LessonItem,
  lessonsOf,
  mentionLabel,
  mentionsOfMarkdown,
  parseMention,
  renderMarkdown,
  snippetFor,
} from './derive';
export { cleanTitle, normaliseTag, normaliseTags, parseTagInput } from './meta';
export {
  EMPTY_DOC,
  Figure,
  JOURNAL_LIMITS,
  JOURNAL_MARK_NAMES,
  JOURNAL_NODE_NAMES,
  journalSchema,
  journalSchemaExtensions,
  Snapshot,
  StockMention,
} from './schema';
export { applyTemplate, isEmptyDoc, JOURNAL_TEMPLATES, type JournalTemplate, templateById } from './templates';
export type * from './types';
export { type DocIssue, isStorableText, type ValidateResult, validateJournalDoc } from './validate';
