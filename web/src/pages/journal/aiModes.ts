/**
 * The rewrite modes the sheet offers, and what a run is asked with. The server also knows `translate_en`; the sheet offers
 * Chinese only (docs/prototypes/daily-journal.html), so English is only ever read back (a History row, "Last AI").
 */
import type { JournalAiMode, JournalAiStartInput } from '../../api/types';

export type OfferedMode = Exclude<JournalAiMode, 'translate_en'>;

export const AI_MODES: readonly { id: OfferedMode; label: string; blurb: string }[] = [
  { id: 'polish', label: 'Polish', blurb: 'Fix grammar and flow. Keep my words, my view and every number.' },
  { id: 'tighten', label: 'Tighten', blurb: 'Half the length. Drop repetition, keep decisions.' },
  { id: 'structure', label: 'Structure', blurb: 'Headings for Market, Positions, Decisions, Lessons.' },
  {
    id: 'lessons',
    label: 'Lessons & actions',
    blurb: "Append what I learned and tomorrow's to-dos as a checklist.",
  },
  { id: 'translate_zh', label: '中文', blurb: 'Translate to Chinese, keep tickers and numbers.' },
  { id: 'custom', label: 'Custom', blurb: 'Tell it what to do.' },
];

const LABELS: Record<JournalAiMode, string> = {
  polish: 'Polish',
  tighten: 'Tighten',
  structure: 'Structure',
  lessons: 'Lessons & actions',
  translate_zh: '中文',
  translate_en: 'English',
  custom: 'Custom',
};

/** "Polish", "Lessons & actions", "AI" for a mode the server never named. */
export const aiModeLabel = (mode: string | null | undefined): string =>
  mode && mode in LABELS ? LABELS[mode as JournalAiMode] : 'AI';

/** What the author picked in the sheet. Kept while the sheet is closed and across "Try again". */
export interface AiChoices {
  mode: OfferedMode;
  instruction: string;
  withContext: boolean;
}

export const DEFAULT_AI_CHOICES: AiChoices = { mode: 'polish', instruction: '', withContext: false };
export const INSTRUCTION_MAX = 500;

/** Why Rewrite cannot be pressed yet, in words; null when the choices are complete. */
export function choiceProblem(c: AiChoices): string | null {
  if (c.mode === 'custom' && c.instruction.trim() === '') return 'Tell it what to do in the box, or pick another mode.';
  if (c.instruction.length > INSTRUCTION_MAX) return `The instruction is at most ${INSTRUCTION_MAX} characters.`;
  return null;
}

/** The body of `POST /api/journal/entries/:date/ai`. An instruction is sent in any mode when there is one. */
export function startInputOf(c: AiChoices): JournalAiStartInput {
  const instruction = c.instruction.trim();
  const input: JournalAiStartInput = { mode: c.mode, withContext: c.withContext };
  if (instruction !== '') input.instruction = instruction;
  return input;
}
