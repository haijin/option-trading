---
name: leaders
description: Daily pullback-buy shortlist (Martin Luk method) for HK + US: show today's twenty leaders at support, write the day's brief, or investigate one name with the research skills. Use for "leaders", "pullback list", "who is at support today", "/leaders investigate NVDA".
---

# /leaders

Read-only over the app's stored runs. Never place orders, never invent a number. Run every command from the repository root; `pnpm --silent` keeps pnpm's own banner out of the JSON.

## Modes

- `/leaders` (default): run `pnpm --silent cli leaders --json`. If the JSON has `stale: true` (or `asOf` is null), run
  `pnpm --silent cli leaders scan --json` once (an in-process scan of both markets: it fetches the universe bars first, 1 to 10
  minutes cold, under a minute warm; progress goes to stderr) and read the result. On a fresh database run
  `pnpm --silent cli leaders universe --seed` first (no network) and then the scan. Print: the regime and posture line
  (`regime.line`, `regime.postureText`), the funnel line (`funnel`), then a table of `candidates`: rank, market,
  symbol, state, score, price, stop % (`plan.stopPct`), 3m (`ret3mPct`), flags (`flags` with level warn or fail). Then one
  line per Setup with its three `why` lines. End with the hand-off line: "`/leaders investigate <symbol>` runs the quality
  screen, news pulse and thesis tracker; add `full` for the four-masters memo, earnings read and management".
  Add `--market US|HK`, `--stage leaders|consolidating` (the names that stopped at a funnel stage) or `--date YYYY-MM-DD`
  (an archived day) when asked for them. Without `--json` the same command prints the table itself.
- `/leaders brief`: same data; write `reports/leaders/<asOf>.md` (the `reports/` folder is git-ignored) with: the lead
  (`brief.lead` when it is set, else two sentences of your own from `regime` and `funnel`), one block per candidate (state,
  the `why` lines, the KPI numbers `ret1mPct ret3mPct ret6mPct rank1m rank3m rank6m distEma21Pct distAvwapPct base`,
  the `plan`, `flags`, `levels`), the `dropped` names with their reasons, and the record card from the JSON's `record`
  (last 60 days: setups, 3R hits, stops, average R, median days to 3R, best and worst, Watch names that became Setups;
  say it is the app's own forward record, not a backtest). Every number is copied from the JSON; if a field is null write
  "n/a".
- `/leaders investigate <symbol> [leader|numbers|full]` (default leader): the symbol is HK when it is digits, else US.
  The name has to be in the database (it is, when it came from the list). If it has no stored statements run
  `pnpm --silent cli leaders statements <symbol>` first (about 30 s). Then invoke, in order, with the Skill tool:
  `quality-screen`, `news-pulse`, `thesis-tracker`; for `full` use `quality-screen`, `investment-research`,
  `earnings-review`, `management-deep-dive`, `thesis-tracker`; for `numbers` only `quality-screen`. Reports go under
  `reports/<market>-<symbol>/`. Finish with one paragraph answering: would you hold this name if the pullback entry fails
  (stopped out) or if a put sold at the stop level is assigned, and which research finding decides it.

## Rules

- Numbers only from the CLI JSON or the research reports. No price targets and no advice wording: say "the plan shows",
  not "you should".
- Do not run the scan more than once per hour; the server job already runs it after each close.
- If `pnpm cli` fails, print the error and stop; do not fall back to web prices.
- Scheduled use without the app server: `claude -p "/leaders brief"` from the repository root once a day (the scan runs
  in-process when the stored list is stale).
