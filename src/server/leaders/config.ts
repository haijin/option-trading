/** Model settings of the Leaders brief (docs/designs/leaders-pullback.md, stage L4): environment defaults, tests override them. */
export interface LeadersConfig {
  /** Scheduled scans may call the model (OT_AI_AUTO is not off). */
  auto: boolean;
  model: string;
  /** What one brief may cost, in US dollars. */
  briefCapUsd: number;
  /** What all Leaders briefs may cost in one Hong Kong day. */
  dailyBudgetUsd: number;
  timeoutMs: number;
}

export function leadersConfigFromEnv(env: NodeJS.ProcessEnv): LeadersConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    auto: (env.OT_AI_AUTO ?? 'on').toLowerCase() !== 'off',
    model: env.OT_LEADERS_MODEL?.trim() || 'claude-haiku-5-5',
    briefCapUsd: 0.1,
    // the budget the news briefs share unless Leaders has its own
    dailyBudgetUsd: num(env.OT_LEADERS_BUDGET_USD, num(env.OT_NEWS_DAILY_BUDGET_USD, 2)),
    timeoutMs: num(env.OT_LEADERS_TIMEOUT_MS, 120_000),
  };
}
