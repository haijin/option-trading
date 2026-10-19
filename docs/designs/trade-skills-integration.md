# Assessment: what to take from `himself65/trade-skills`

Written 2026-10-18 after reading the repository at a shallow clone (MIT licence, version as of that day).
Status: ASSESSMENT, nothing built. Companion to `docs/designs/ai-analysis.md` (DRAFT), which already defines where
LLM output may enter this app.

## What the repository is

It is not an application and has no runnable code. It is one Claude Code skill, `trade`, made of markdown:

| Part | Size | Content |
|---|---|---|
| `SKILL.md` | 1 file | Always-on rules for an options chat: hard rules, response rules, data tiers, command routing |
| `references/commands/` | 5 recipes | `analysis` (default trade decision), `daily` (one-name state read), `report` (capital flow across names), `import` (digest an article into a personal knowledge dir), `setup` |
| `references/pitfalls/` | 37 files | One analytical or risk-management rule each, severity-tagged, with a "how to apply" list |
| `references/*.md` frameworks | 6 files | Strategy selection (three axes: direction, vega, asymmetry), dealer gamma, price action, macro, overnight futures, parent-order flow |
| `references/ticker/` | 15 case studies | The author's own US trades (INTC, SNOW, APP, NOK, BE, NBIS, MU, VIX, NQ ...) |
| `evals/` | 9 cases | `claude plugin eval` suite that checks routing and gating behaviour of the skill |

The author trades multi-leg event structures on US mega-caps. Market data comes from three paid or MCP-based tiers:
Unusual Whales (options flow, dark pool, dealer GEX, IV rank, forward-aligned realised vol), a TradingView MCP, and
the Funda API. Unusual Whales is **US options only**. Nothing in the repository knows Hong Kong, board lots, or Futu.

## How it lines up with this app

| Trade-skills piece | This app today | Fit |
|---|---|---|
| Pitfall 36: IV rank is a percentile, only the **forward-aligned** variance risk premium (IV at t vs realised over [t, t+30]) says a premium sale has edge | S3 `volatility.edge` scores IV rank and `vrpRatio = IV30 / RV20`, which is today's IV against **trailing** realised, the exact "measurement trap" the pitfall describes | **High.** A deterministic rule change inside S3, computable from `iv_daily` plus `price_bars` through `DataAccess` |
| Pitfall 21 and 7: elevated IV is event-driven (crushes, dated) or demand-driven (persists); check days to earnings and the term structure before selling | S4 has an earnings window; `iv_daily.term_ratio` exists but no rule reads it this way | **Medium.** A small classifier: days to results and `term_ratio` give an "IV source" reason |
| Pitfall 37: IV in its bottom decile with a result 30 to 60 days out is a long-vega regime; a short put sold there fights the pre-event ramp | `iv_percentile` is stored; no rule looks at it together with the results date | **Medium.** One WAIT rule in S3 or S4 |
| Pitfall 31: a per-trade cap is not risk management without a daily loss limit, a consecutive-loss halt and drawdown de-gearing | S6 sizes by full notional with per-name and portfolio caps; no streak or drawdown governor | **Medium.** Portfolio-level rule plus an alert |
| Pitfall 30: stop distance is an input, size the output | S6 already sizes from notional, and a put seller's "stop" is the strike cushion; the app does not pick sizes from a stop | Low. Already consistent in spirit |
| Pitfall 13: close short legs at 50% of the credit | `profit50` and `take_profit` alerts already exist in `src/core/alerts.ts` | Already built |
| Strategies table: "high IV + high-conviction bull: naked short put far OTM or bull put spread" | That row *is* this product; the eight-item bull-conviction count is mostly judgement (channel checks, narrative) | Low as a score; a few items are computable and could feed the S7 narrative |
| `SKILL.md` chat discipline: route state-read vs decision vs lookup, always quantify, base/bull/bear, "self-critical not suggestible" on pushback, reply in the user's language | `docs/designs/ai-analysis.md` item 7 ("Ask" box) is designed and not built | **High for the chat.** This is the pattern to copy |
| `analysis.md` situation to reference map (lazy-load the few pitfalls that match the question) | Research runner loads one whole skill prompt per run | **High for the chat.** Keeps the prompt small and the answer grounded |
| `daily` and `report` commands (block filter ladder, dark pool, GEX, max pain, net premium ticks) | No such data; HK has none of it at all | None without an Unusual Whales subscription, and never for HK |
| Multi-leg structures, VIX hedges, LEAPS replacement, NQ night session, macro and parent-order frameworks | Out of scope: sell-put only, the app never places orders | None |
| Knowledge dir tiers L1/L2/L3, OKF frontmatter, `import` of articles | Daily Journal (with AI rewrite), reports under `reports/`, News page | Low. The app already has its own homes for these |
| Eval suite pattern | `FakeExecutor` tests for research runs | Low-medium. Worth copying the idea of grading "which pitfall did the chat load" once a chat exists |

## Recommendation

### 1. Into the scanner (deterministic, highest value): forward-aligned VRP in S3

Replace or supplement `vrpRatio` with a forward-aligned series. For each day t with at least 30 trading days of
bars after it: `iv30(t)` against realised vol over `[t, t+30]`. Report on the last ten non-overlapping observations:
the sign count (implied above subsequent realised on how many), the mean gap in vol points, and the live `iv30`
against the most recent completed window. Then publish the loss probability under **both** vols, `P(S_T < breakeven)`
at the IV sold and at recent realised, as two Reasons the Today detail can show side by side.

Rules: a structurally negative VRP (implied below subsequent realised on most of the ten) is a WARN that no IV rank
can lift, and when the gate also sees no dated result inside the expiry it becomes FAIL `vol.noEdge`. A positive VRP
at a low IV rank stays sellable with a size note, which fixes the false negative the current rule produces.

Needs about fourteen months of `iv_daily` history per name. HK names have Futu's IV backfill; where the stored series
is a proxy (`rankBasis` 'proxy' or 'rv') the rule emits INFO "VRP unmeasured" and does not count as a skipped test,
the same convention `ai-analysis.md` premise 1 uses. Pure over `DataAccess`, backtestable, no model involved.

### 2. The "Option trading chat": build item 7 of ai-analysis.md with a sell-put knowledge bundle

Do not vendor the repository. Fork the ten pitfalls a put seller needs (36, 19, 7, 21, 37, 30, 31, 13, 24, 4) into
`src/server/research/knowledge/` as short English files with the same frontmatter, rewrite the examples to this app's
vocabulary (Reasons, cushion, assignment, board lot, results date), and add two HK notes of our own: contract
multiplier against board lot, and the "business day before the last business day" expiry. The strategies table shrinks
to its two sell-put rows plus the "never naked into a dated catalyst" line.

The chat itself is an `research_runs` row of kind `ask`, run through the existing `claude -p` executor with no web
tools, a small dollar cap, and a system prompt made of:

- an adapted `SKILL.md`: hard rules (never size, never pick a strike, the app's numbers are the numbers), reply in the
  user's language, quantify, base/bull/bear, hold a correct call under pushback and update a wrong one saying what changed;
- a situation map (the `analysis.md` idea) that attaches only the matching pitfall files to the prompt by keyword:
  "sell", "IV high", "收租", "卖 put" load 36, 19, 7, 21; "results", "earnings", "业绩" load 7, 21, 37; "size", "仓位",
  "drawdown" load 30, 31; "roll", "close", "take profit" load 13, 4;
- the grounding: the idea's Reasons JSON, the name's `iv_daily` row and the new VRP series, open puts and marks, the
  last thesis verdict, the day's news brief. Web content stays out of the chat; it reaches the app only through the
  provenance-tagged rows of `ai-analysis.md`.

Surface: an "Ask" sheet on the Today idea detail and on a position, phone first, answers of a few short paragraphs,
20 to 60 seconds latency shown as a typing state. The answer may add a WARN-level verdict row (kind `ask`) and never
a score, which is premise 3 of `ai-analysis.md`.

Alternative with zero app work: install the skill as published (`npx skills add himself65/trade-skills`) in Claude Code
and point its `knowledge_path` at `reports/` and journal exports. Fine for a personal experiment this week; it does not
run on the phone, its data tiers are US-only, and its advice drifts from the app's own numbers, so it is not the product.

### 3. Then, small deterministic rules

- IV-source reason (pitfalls 21 and 7): days to results under 14 with `term_ratio` front-heavy is "event IV, will
  crush"; over 45 days with elevated rank is "demand IV, may persist", a WARN on a short put.
- IV-floor rule (pitfall 37): `iv_percentile` at or below 10 and a result 30 to 60 days out is WAIT, "IV ramp ahead".
- Drawdown governor (pitfall 31): `portfolio_settings` gains a daily loss limit, a consecutive-loss halt and de-gear
  tiers; S6 reads them and the alerts job fires when a tier is crossed.

### Skip

The `daily` and `report` recipes, the Unusual Whales, TradingView and Funda tiers, the multi-leg, VIX, LEAPS, futures
and macro frameworks, the OKF knowledge-dir architecture, and the case studies as content. The case studies are one
trader's US event trades and several pitfalls record that trader's own model errors; only the mechanical pieces above
survive translation to HK plus US cash-secured puts.

## Build order and effort

| Stage | What | Effort |
|---|---|---|
| T1 | Forward-aligned VRP in S3, two loss probabilities, tests against the golden fixtures. **BUILT 2026-10-18** (see "As built: T1" below) | S, half a day |
| T2 | Knowledge bundle (ten adapted pitfalls, two HK notes) and the Ask chat on Today and Positions via the research executor. **BUILT 2026-10-19** (see "As built: T2" below) | M, one to two days |
| T3 | IV-source reason, IV-floor WAIT, drawdown governor and alert. **BUILT 2026-10-19** (see "As built: T3" below) | S, half a day |

Attribution: the pitfall texts derive from `himself65/trade-skills` (MIT); keep the licence notice in the bundle folder.

## As built: T1 (2026-10-18, uncommitted on `feat/leaders`)

- **S3 `volatility.edge` 1.1.0** (`src/skills/s3-volatility-edge.ts`): `forwardVrpSeries(bars, ivByDay, window, count)`
  is an exported pure helper; it walks back from the last bar, pairs the real stored IV30 on the window's first bar with
  the close-to-close realised vol of the next `window` log returns (`realizedVol` from the indicators), keeps
  non-overlapping windows (a start day without a stored IV shifts that window one bar earlier) and stops at `count`.
  Reasons `vol.vrpForward` (PASS / rule WARN / INFO by the sign count), `vol.vrpGap`, `vol.vrpLive`; `vol.vrp` kept and
  labelled trailing; `vol.vrpUnmeasured` INFO when the tier or rank basis is not real or fewer than ten windows exist;
  `vol.lowRankSize` INFO replaces the old FAIL when the forward series is positive; `vol.noEdge` extended with the
  structurally-negative-and-no-dated-result case (the result window is `option.select.dteMax` read from the calendar
  inside S3, so S3 keeps `dependsOn: []`). Payload adds `vrpForward` and `rvRecent`.
- **S4 `option.select` 1.2.0**: `lossProbIv` and `lossProbRv` on every `ContractChoice` and Reasons `option.lossProbIv`
  / `option.lossProbRv` (INFO). The breakeven is only known in S4, so S3 exposes the vols and S4 prices the probability
  with the same `probItm` it already uses.
- **Params** `vrpWindowDays=30, vrpObservations=10, vrpPositiveMin=6, vrpNegativeMin=6` in `volatility.edge`;
  migration `drizzle/0015_params_v4.sql` merges them into the latest stored version instead of restating the defaults so
  a Settings-edited database keeps its edits.
- **Not shown live:** the live database holds 2 to 4 real IV points per name (chains have been ingested since
  2026-10-08), so every name takes the `vol.vrpUnmeasured` path on a real scan today; the measured path is proven by
  `tests/skills/s3.test.ts` (series construction and every rule outcome) and fires on its own once about fourteen
  months of `iv_daily` accrue, or after an IV backfill. The two loss probabilities already show on every real idea.
- **Web:** no page change; the new rows render through the generic reasons table with glossary entries in
  `web/src/lib/glossary.ts`. A side-by-side tile on the Today detail is a later polish.

## As built: T3 (2026-10-19, uncommitted on `feat/leaders`)

- **IV-source reason** (`src/skills/s3-volatility-edge.ts`, S3 `volatility.edge` 1.2.0; pure helper `classifyIvOrigin`).
  One Reason `vol.ivSource` with value `event` (results within `ivSourceEventDays`=14 and the term ratio, live chain
  front / next IV or else the latest stored `iv_daily.term_ratio`, at or above `ivSourceFrontHeavyMin`=1.02: INFO
  "event IV, will crush on the date"), `demand` (no result within `ivSourceDemandDays`=45, or none known, and IV rank
  above `ivrMin`: rule WARN "demand IV, may persist") or `unknown` (INFO). Payload adds `ivOrigin` and `daysToResults`;
  `IvPoint` carries `termRatio` so the stored ratio reaches the skill.
- **IV-floor rule**: IV percentile <= `ivFloorPercentileMax`=10 with results `ivFloorRampMinDays`=30 to
  `ivFloorRampMaxDays`=60 days out is rule WARN `vol.ivFloorRamp` ("IV ramp ahead"). The runner classifies on
  `gateReason()` (`src/skills/contract.ts`): the first FAIL, else the first WARN whose rule is in `GATE_WAIT_RULES`, so
  the name is `failed` with that binding reason and `src/server/watch-board.ts` shows "Wait: IV is at its floor with
  results 30 to 60 days out: premium ramps into them, wait". S3 itself still scores the name (verdict WARN).
- **Params v5**: the six thresholds above in `volatility.edge`; `drizzle/0017_params_v5.sql` merges them into the latest
  stored version like 0015 did (a Settings-edited database keeps its edits).
- **Drawdown governor** (`src/core/governor.ts`, pure: `summarisePnl`, `governorDecision`, `tierReached`, `tierCrossed`).
  `portfolio_settings` gains `daily_loss_limit` (base currency), `consecutive_loss_halt` and `degear_tiers` jsonb
  (`drizzle/0016_drawdown_governor.sql`); `getSettings`/`setSettings` carry them as `governor`, `loadPortfolio` puts them
  on `PortfolioState.governor`. `DataAccess.ledger()` serves every recorded put (with its currency) and every stored mark
  as they stood on asOf; `createRunStore` loads that ledger once per run (`loadLedger`) and attaches it to each
  `InstrumentHistory`. S6 `size.position` 1.1.0 computes day P&L (closes booked on asOf plus the change in the open
  puts' marks), the peak-to-now drawdown of the cumulative curve as a percent of equity, and the losing streak; a halt is
  FAIL `size.dailyLossHalt` (0 contracts) and the runner drops every shortlisted name with that binding reason, so every
  idea is Wait for the day; a tier reached multiplies the size factor with rule WARN `size.drawdownTier`. Defaults
  (NULL, NULL, []) change nothing: multiplier 1, no Reason.
- **Alert**: `AlertCode` gains `drawdown_tier`. The mark job (`src/jobs/jobs.ts`, `drawdownTierAlert`) recomputes the
  governor after writing the marks and pushes one "portfolio:" line on the day the drawdown enters a deeper tier than on
  the previous ledger day; a rerun of the same day does not repeat it (the job_runs meta carries `drawdownTierAsOf`).
- **API and web**: `SettingsView.governor` / `SettingsPatch.governor` (zod-validated in `routes.ts`); the Settings page
  has a "Drawdown governor" panel (daily loss limit, consecutive-loss halt, an editable tier list) that saves through
  `PUT /api/settings`. Glossary entries for `vol.ivSource`, `vol.ivFloorRamp`, `size.drawdownTier`, `size.dailyLossHalt`,
  `size.governorFx`.
- **Tests**: `tests/core/governor.test.ts` (P&L arithmetic, tiers, halts, crossings), S3 cases for every IV-source
  outcome, the stored term-ratio fallback and the floor window, S6 cases for defaults, both halts, a tier and a zero
  multiplier, runner cases for "every idea waits" and the IV-floor gate, the watch-board sentences, the mark job's
  single push, and the settings API round trip and validation.
- **Behaviour change under default settings**: `vol.ivSource` = `demand` is a rule WARN, so a clean high-IV-rank name
  with no result inside 45 days now carries one WARN (the composite's 0.85 multiplier applies when it is the only rule
  WARN). Recommendation kinds (Sell put / Wait / Avoid) do not change; the ordering of ideas can. Three existing S3
  tests were updated to assert that WARN.

## As built: T2 (2026-10-19, uncommitted on `feat/leaders`)

- **Knowledge bundle** `src/server/research/knowledge/`: `rules.md` (the adapted SKILL.md header: the app's numbers are the
  numbers, never size or pick a strike, reply in the question's language, quantify, base/bull/bear, hold a correct call under
  pushback and update a wrong one saying what changed), ten pitfalls under `pitfalls/` (36, 19, 7, 21, 37, 30, 31, 13, 24, 4)
  rewritten in this app's vocabulary with the rule ids they lean on (`vol.vrpForward`, `option.lossProbRv`,
  `events.earningsWindow`, `size.perNameCap`, `profit50` ...), two notes under `hk/` (contract multiplier against board lot,
  expiry rule), and `LICENSE.md` with the MIT notice and what was changed. No US case study was copied. `index.ts` holds the
  situation map (six situations: sell, results, size, manage, wait, conviction; English and Chinese keywords; ASCII keywords
  match on word boundaries) and the cached file loader; `matchPitfalls(question, kind)` returns the matched lists in map order,
  deduplicated, at most six, with a default of 36 and 19 for an idea and 13 and 4 for a position.
- **Prompt** (`src/server/research/ask-prompt.ts`, pure): rules, the matched pitfalls only, the HK notes when the name is HK,
  the grounding sections, the last four answered turns of the same thread, the question. `validateAnswer` unfences a whole-answer
  code block and refuses empty, fragment, HTML-bearing or over-8000-character answers; a refused answer fails the run with the
  reason, nothing is stored as an answer.
- **Service** (`src/server/services/ask-service.ts`): a question is a `research_runs` row with `skill_id = 'ask'` and
  `result = {kind, target, question, answer, pitfalls, grounding}`; no report file, no verdict row (premise 3 of
  `ai-analysis.md` is deferred to a later stage). Grounding comes from the **cached** scan only (`ScanService.peek`), else the
  newest stored `recommendations` row for the name; Ask never runs the pipeline. A position is grounded on its `PositionView`
  (mark, alerts) plus the cached scan's Reasons for the name. Both add the latest `iv_daily` row, the open puts with their latest
  marks, the latest done `thesis-tracker` report (first 1500 characters; there is no `research_verdicts` table yet, B1 of
  `ai-analysis.md` is unbuilt) and the newest news brief of the Hong Kong day. The executor runs with no tools, `isolated`,
  `OT_ASK_MAX_BUDGET_USD` (0.25) per answer and `OT_ASK_DAILY_BUDGET_USD` (2.00) per Hong Kong day, model `OT_ASK_MODEL`
  (claude-sonnet-5-5), timeout `OT_ASK_TIMEOUT_MS` (150 s). One question at a time per target (409), 429 when the day's budget
  cannot fit another answer. Routes: `POST /api/ask`, `GET /api/ask?kind=...`, `GET /api/ask/:id`. The Research page list
  filters `ask` rows out.
- **Web**: `web/src/components/AskSheet.tsx`, opened by an "Ask" button in the Today idea header and in each open put's actions
  on Positions. Thread oldest first, question bubbles right, answers left rendered through the safe Markdown renderer, a typing
  state with the run's last progress line while queued or running (polled every 2 s), failed answers with the reason and an
  "Ask again" button, suggestion chips while idle, the per-answer and daily spend under the thread; Enter sends, Shift+Enter
  breaks a line. The mock server (`web/mock/ask.ts`) answers after `MOCK_AI_DELAY_MS` with a canned grounded-looking reply
  (Chinese when the question is Chinese) and attaches the real situation map's pitfalls.
- **Tests**: `tests/server/ask-knowledge.test.ts` (files, map, prompt, validation, config), `tests/server/ask-api.test.ts`
  (service through the app with a scripted executor: idea and position grounding, thread and earlier turns, HK notes, limits,
  timeout, fenced and HTML answers, budget), `web/src/components/AskSheet.test.tsx` (thread, send, typing state, chips, retry,
  inline refusal, no executor).
- **Not in this stage**: no verdict row from an answer, no cancel button (the timeout ends a stuck run), no per-name news
  items in the grounding (only the day's brief), and the glossary is unchanged because no new rule id was added.
