/** Settings of the news model calls (docs/designs/latest-news.md, "Data and pipeline"). All from the environment. */
export interface NewsConfig {
  /** `OT_NEWS_MODEL`: the light model that judges one story at a time. */
  model: string;
  /** `OT_NEWS_DAILY_BUDGET_USD`: what story and brief calls may cost per Hong Kong day. */
  dailyBudgetUsd: number;
  /** The most one call may cost; the executor stops it there. */
  perCallCapUsd: number;
  /** `OT_AI_AUTO` is not `off`: the schedule may call the model. Off keeps classification and briefs to the Refresh button. */
  auto: boolean;
  /** The most one brief call may cost (it reads a day of headlines, so it is larger than a story call). */
  briefCapUsd: number;
  /** A manual brief is not written again within this long of the last one. */
  minBriefGapMs: number;
  /** One call's time limit. */
  timeoutMs: number;
  /** Stories judged in one classify run. */
  maxPerRun: number;
  /** Stories older than this are not worth a call. */
  lookbackDays: number;
}

export const DEFAULT_NEWS_MODEL = 'claude-haiku-5-5';

export function newsConfigFromEnv(env: NodeJS.ProcessEnv): NewsConfig {
  const budget = Number(env.OT_NEWS_DAILY_BUDGET_USD);
  return {
    model: env.OT_NEWS_MODEL?.trim() || DEFAULT_NEWS_MODEL,
    dailyBudgetUsd: Number.isFinite(budget) && env.OT_NEWS_DAILY_BUDGET_USD?.trim() ? Math.max(0, budget) : 2,
    perCallCapUsd: 0.05,
    briefCapUsd: 0.1,
    minBriefGapMs: 30 * 60_000,
    auto: (env.OT_AI_AUTO ?? 'on').trim().toLowerCase() !== 'off',
    timeoutMs: 90_000,
    maxPerRun: 40,
    lookbackDays: 7,
  };
}
