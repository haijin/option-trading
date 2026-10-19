import type { JournalAiRunView } from '../../api/types';
import { aiModeLabel } from './aiModes';

export interface CostLine {
  mode: string;
  model: string;
  cost: string;
  took: string;
  locked: string;
}

/** "$0.03", "<$0.01" for a fraction of a cent, "-" when the CLI did not say. */
export function dollars(costUsd: number | null): string {
  if (costUsd === null) return '-';
  if (costUsd > 0 && costUsd < 0.005) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

/** "9 s", "<1 s". */
export function seconds(durationMs: number | null): string {
  if (durationMs === null) return '-';
  return durationMs < 1000 ? '<1 s' : `${Math.round(durationMs / 1000)} s`;
}

/** The line under a suggestion: mode, model, cost, time, and how many locked blocks came back untouched. */
export function costLine(run: JournalAiRunView): CostLine {
  const result = run.result;
  return {
    mode: aiModeLabel(run.mode),
    model: run.model ?? '-',
    cost: dollars(run.costUsd),
    took: seconds(run.durationMs),
    locked: result && result.lockedTotal > 0 ? `${result.lockedKept} of ${result.lockedTotal}` : 'none',
  };
}
