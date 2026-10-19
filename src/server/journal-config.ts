/** Settings of the journal's AI rewrite. Environment names are in docs/designs/daily-journal.md. */
export interface JournalAiConfig {
  /** Model for rewrites (fast and cheap for prose). Research keeps its own model setting. */
  model: string;
  /** Dollar cap per run, passed to the CLI as --max-budget-usd. */
  maxBudgetUsd: number;
  /** Runs per user per day (every run counts, whatever became of it). */
  dailyRuns: number;
  timeoutMs: number;
}

export const JOURNAL_AI_DEFAULTS: JournalAiConfig = {
  model: 'claude-haiku-5-5',
  maxBudgetUsd: 0.1,
  dailyRuns: 20,
  timeoutMs: 90_000,
};

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** OT_JOURNAL_MODEL, OT_JOURNAL_MAX_BUDGET_USD, OT_JOURNAL_DAILY_RUNS; `override` wins (tests). */
export function journalAiConfig(env: NodeJS.ProcessEnv, override: Partial<JournalAiConfig> = {}): JournalAiConfig {
  return {
    model: override.model ?? (env.OT_JOURNAL_MODEL?.trim() || JOURNAL_AI_DEFAULTS.model),
    maxBudgetUsd: override.maxBudgetUsd ?? positive(env.OT_JOURNAL_MAX_BUDGET_USD, JOURNAL_AI_DEFAULTS.maxBudgetUsd),
    dailyRuns: override.dailyRuns ?? Math.floor(positive(env.OT_JOURNAL_DAILY_RUNS, JOURNAL_AI_DEFAULTS.dailyRuns)),
    timeoutMs: override.timeoutMs ?? JOURNAL_AI_DEFAULTS.timeoutMs,
  };
}
