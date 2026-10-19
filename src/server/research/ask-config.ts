/** Settings of the Ask chat (docs/designs/trade-skills-integration.md, stage T2): environment defaults, tests override them. */
export interface AskConfig {
  /** A reasoning model: the answer weighs a Reasons table against the pitfalls. */
  model: string;
  /** What one answer may cost, in US dollars. */
  maxBudgetUsd: number;
  /** What all answers may cost in one Hong Kong day. */
  dailyBudgetUsd: number;
  timeoutMs: number;
}

export const ASK_DEFAULTS: AskConfig = {
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 0.25,
  dailyBudgetUsd: 2,
  timeoutMs: 150_000,
};

const positive = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

/** OT_ASK_MODEL, OT_ASK_MAX_BUDGET_USD, OT_ASK_DAILY_BUDGET_USD, OT_ASK_TIMEOUT_MS; `override` wins (tests). */
export function askConfig(env: NodeJS.ProcessEnv, override: Partial<AskConfig> = {}): AskConfig {
  return {
    model: override.model ?? (env.OT_ASK_MODEL?.trim() || ASK_DEFAULTS.model),
    maxBudgetUsd: override.maxBudgetUsd ?? positive(env.OT_ASK_MAX_BUDGET_USD, ASK_DEFAULTS.maxBudgetUsd),
    dailyBudgetUsd: override.dailyBudgetUsd ?? positive(env.OT_ASK_DAILY_BUDGET_USD, ASK_DEFAULTS.dailyBudgetUsd),
    timeoutMs: override.timeoutMs ?? positive(env.OT_ASK_TIMEOUT_MS, ASK_DEFAULTS.timeoutMs),
  };
}
