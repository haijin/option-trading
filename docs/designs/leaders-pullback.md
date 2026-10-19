# Design: Leaders page and the `leaders.pullback` skill (daily pullback-buy shortlist, HK + US)

Written 2026-10-13, autonomous session. Status: BUILT 2026-10-13 (stages L1 to L4, branch `feat/leaders`); see "As built" at the end for what changed from this text.
Prototype: `docs/prototypes/leaders-pullback.html` (phone-first, static sample data).
Relates to: `docs/designs/sell-put-scanner.md` (S0 regime, S2 technical series, S6 sizing are reused),
`docs/designs/latest-news.md` (same brief-and-validator pattern), `src/server/research/skills.ts` (the seven
research skills this page hands off to).

## What the page is for

The sell-put scanner answers "which put should I sell on the names I already follow". This page answers a
different, earlier question every trading day: **of all liquid HK and US stocks, which twenty are market
leaders that have pulled back to a definable support and are starting to turn up again**, so that the user can
look at each one on the phone in under a minute, and then push any of them into the existing research skills
(quality screen, news pulse, thesis, four-masters memo, earnings read, management, checklist) before acting.

The method is Martin Luk's pullback-buy routine (stock division winner, 2025 US Investing Championship,
+969.8%), expressed as deterministic rules the app can run, score and keep a record of:

1. **Screen for leaders**: sort by 1-, 3- and 6-month gains, keep names up more than 30% and in the top quarter
   of the ranking, drop thin ones, then look for names that rallied and are now consolidating.
2. **Map support and wait for the turn**: 9-, 21- and 50-day EMAs, prior swing highs and lows, unfilled gaps,
   and an AVWAP anchored at the high of the consolidation range. Entry is the bounce off support, so the buy
   sits as close as possible to the stop.
3. **Stop and size first**: stop at the day's low or the low of the signal bar or the prior bar; stop distance
   within about 2.5 to 3%; risk about 0.5% of the account per trade; shares derived from those two numbers.
4. **Partial profit at 3R and 5R, trail the rest.**

The app does steps 1 to 3 exactly and shows step 4 as price levels. It never places orders. Everything on the
page is data for a decision, not advice; the record card shows how the app's own past signals did, because the
one honest caveat from that thread (a backtest of a similar setup found about a 45% win rate and said the edge
is in cutting losers fast, not the entry) deserves to be checked on this app's own output.

## Page structure (as prototyped)

Phone first (375 px), one column; on a desktop the cards flow in two columns under the same header.

- **Header**: "Leaders", the run time ("Tue 13 Oct · after US close"), Refresh. Under it a **regime line** from
  S0 ("Bull · calm · VIX 17 · HSI above 200d") with the posture it implies: *Entries allowed* or, in panic or
  crash guard, *Watch only: pullback entries off*. In watch-only every Setup shows as Watch and the reason says
  why.
- **Funnel card**: screened 1,312 (US 842 / HK 470) → leaders 61 → consolidating 29 → shortlist 20
  (Setup 7 / Watch 13). Tapping a stage filters the list to the names that stopped there (so "why is X not on
  the list" has an answer). Also: "New today 3", "Dropped 3".
- **Day navigator**: previous / next day, "Back to today"; every run is kept, so yesterday's list renders as it
  was computed, with each name's later outcome stamped on it (what the record card is built from).
- **Filters**: Market All / US / HK; State Setup / Watch / All; Sort Score / Tightness / Stop %.
- **One card per name** (collapsed):
  symbol (monospace), name, market chip, **state badge** (Setup green, Watch amber), price and day change,
  score bar 0 to 100, a 70-bar sparkline with EMA21 (solid), EMA50 (dashed), AVWAP from the range high (dotted)
  and the stop line for a Setup, a 3 × 3 **KPI grid** (1m / 3m / 6m return with rank percentile, distance to
  EMA21, distance to AVWAP, base depth and length, range contraction, volume dry-up, 20-day dollar volume), and
  three **reason lines** written by the skill from its own numbers ("Top 6% on 3m (+71%); base 14% deep over
  19 days; today closed in the top third of its range off the 21-EMA").
- **Expanded card**: the **trade plan** (reference entry = close, alternative = stop-buy above today's high,
  stop = lower of today's and yesterday's low less 0.2%, stop distance %, risk 0.5% of equity in the name's
  currency, shares rounded to the HK board lot, position value and % of equity, 3R and 5R levels, R in price),
  the **support map** (every level the skill found, its source, distance, and whether it is the one in play),
  **flags** (earnings in n days, ex-dividend, stop wider than 3%, HK lot too big for 0.5% risk, index
  weakness), the optional **put angle** line (when the name is on the watchlist and a chain is stored: the
  nearest monthly put at or below the stop with delta and ROC, as the premium-collecting version of the same
  thesis), and the actions **Investigate**, **Add to watchlist**, **Chart** (TradingView, new tab),
  **Dismiss** (muted 10 trading days, with Undo).
- **Investigate sheet**: the seven research skills with their Chinese and English names, effort and cost as the
  Research page already shows them, two presets ("Leader check": quality screen + news pulse + thesis tracker,
  about 2 minutes; "Full deep dive"), and the note that statements are fetched first when the name has none
  stored (the quality screen is local and needs them). Run queues the research runs and links to Research.
- **Dropped since yesterday**: one quiet row per name that left the list and why (extended, broke the 50-EMA,
  base too deep, earnings inside the window, muted).
- **Record card**: the app's own forward record over the last 60 trading days and all time: setups shown,
  reached 3R before the stop, stopped, still open, average R, median days to 3R, best and worst. Numbers only,
  with the sentence "a signal is counted from the close of the day it was shown; this is not a backtest".
- Footer: method credit, data sources, "the app never places orders".

Navigation (changed 2026-10-14: Leaders now has a tab, Backtests gave up its slot and moved to the "More pages" panel in Settings; the original reasoning follows): with Journal and News the phone tab bar is at nine, so Leaders does **not** get a tab. It is a card
on Today ("Leaders · 7 setups · 3 new ›") and a page under More (Tests, Data, Settings, Leaders). The prototype
shows a Leaders tab only so the page can be reached; decide on the real device.

## The skill: `leaders.pullback`

A pure analysis skill in the existing contract (`src/skills/contract.ts`): `id: 'leaders.pullback'`,
`version: '1.0.0'`, `dependsOn: ['market.regime']`, `paramKey: 'leaders.pullback'`, `cacheable: true`, no clock
(as-of comes from `DataAccess`), one run per (instrument, asOf). It reuses `buildTaSeries` and the indicators
in `src/indicators/ta.ts` (EMA, ATR, rolling max/min, fractal lows) and adds two small pure indicators:
`avwap(highs, lows, closes, volumes, anchorIndex)` and `unfilledGaps(highs, lows, lookback)`.

Stages, each with the rule, the parameter and what it writes to the payload:

### A. Leader screen (every name in the universe)

| Rule | Default | Payload |
|---|---|---|
| History: at least 130 daily bars | `minBars 130` | fail → `state: 'excluded'`, reason |
| Price floor | US ≥ 5, HK ≥ 2 (per market) | |
| Liquidity: 20-day median (close × volume) | US ≥ 20m USD, HK ≥ 30m HKD | `dollarVol20` |
| Returns over 21, 63, 126 bars | | `ret1m ret3m ret6m` |
| Rank percentile of each return within its market, among names that passed the rows above | | `rankPct1m rankPct3m rankPct6m` |
| Leader: `ret3m ≥ 30%` or `ret6m ≥ 30%`, **and** rank ≥ 75th percentile in at least two of the three windows | `leaderMinGain 0.30`, `leaderRankPct 75`, `leaderWindowsNeeded 2` | `isLeader` |
| Relative strength: `ret3m − index ret3m` (SPY / HSI) | | `rs3m`; informational |

The percentile needs the whole market's returns, which a per-instrument skill cannot see. The job computes the
three return columns for every name first (one cheap pass over stored bars), stores them on the run, and the
skill reads `ctx.data.cross('leaders.returns')` for its own rank. This is the same "series published for the
next skill" pattern S2 uses for S3 and S4 (`TA_SERIES_KEY`).

### B. Consolidation (leaders only)

| Rule | Default | Payload |
|---|---|---|
| Anchor high `H`: highest high in the last 60 bars, at least 5 bars ago | `baseLookback 60`, `baseMinLen 5` | `anchorDay anchorHigh` |
| Base low `L`: lowest low since `H` | | `baseLow` |
| Depth `(H − L) / H` within 4% and 25% | `depthMin 0.04`, `depthMax 0.25` | `baseDepth` |
| Length: bars since `H` within 5 and 45 | `baseMaxLen 45` | `baseLen` |
| Range contraction: 10-bar range / 20-bar range | scores below 0.75, hard cap 1.1 | `contraction` |
| Volume dry-up: mean vol 10 / mean vol 50 | scores below 0.9 | `volDryUp` |
| ATR now / ATR at `H` | scores below 1.0 | `atrRatio` |
| Still a base: close ≥ EMA50 and close ≥ `L` | | else `state: 'broken'` |

A name that is a leader but fails depth or length is `state: 'extended'` (too far from any support) or
`'excluded'` with the failing rule as the reason; both are visible from the funnel.

### C. Support map

Levels collected, each as `{ source, level, distPct, inPlay }`:

- EMA9, EMA21, EMA50 (today's values).
- Prior swing lows and swing highs (`fractalLows` and its mirror, last 120 bars), a swing high that price is
  back above counts as support.
- Unfilled gap-ups in the last 120 bars: gap = [prior high, gap-day low]; unfilled while no later low has
  traded down to the prior high; support level = the gap-day low (top of the gap).
- AVWAP anchored at `H` (`avwapHigh`) and AVWAP anchored at `L` (`avwapLow`). Typical price (H+L+C)/3 × volume,
  cumulative from the anchor.
- The base low `L` itself.

**Support in play**: a level is in play when a low in the last 3 bars came within `supportTolerance` of it
(1.5% or 0.5 ATR, whichever is wider) and no close has settled more than 1 ATR below it since. Confluence =
number of distinct levels within 1.5% of the in-play level (two levels from the same family count once).

### D. State

| State | Rule |
|---|---|
| `setup` | a support is in play **and** today is a turn-up bar: close > open, close in the upper half of the day's range, close > prior close, close ≥ EMA21 or close ≥ `avwapHigh` (reclaim), **and** the stop distance from stage E is ≤ `stopMaxPct` |
| `watch` | leader in a valid base, no turn-up bar yet, or a turn-up bar whose stop is wider than `stopMaxPct` (reason says the width), or earnings within `earningsBlackoutDays` (7) of today, or regime watch-only |
| `extended` | close more than `extendedAtr` (3) ATR above EMA21, or more than 8% above EMA21 |
| `broken` | close below EMA50 or below `L` after being on the list |
| `excluded` | failed stage A or B; the reason names the rule |

### E. Trade plan (numbers only)

- Reference entry = today's close. Alternative entry = today's high + 1 tick (stop-buy), shown as a second line.
- Stop = min(today's low, prior bar's low) × (1 − `stopBufferPct` 0.002).
- Stop distance % = (entry − stop) / entry. Target ≤ `stopMaxPct` 0.03; between `stopTightPct` 0.025 and 0.03
  it is flagged "wide"; above 0.03 the state stays `watch`.
- Risk per trade = `riskPctPerTrade` 0.005 × `portfolio_settings.equity`, converted to the name's currency with
  the stored FX (the same conversion S6 uses). Shares = floor(risk / (entry − stop)); HK rounds **down** to the
  board lot and, when one lot already risks more than the budget, flags "1 lot = 0.9% of equity" and shows one
  lot anyway (the user decides).
- 1R = entry − stop. 3R and 5R levels. Position value and % of equity (full notional, the house rule).
- Nothing about trailing is computed; the card says "trail the rest" and leaves it to the trader.

### F. Score (0 to 100) and the shortlist

| Component | Weight | How |
|---|---|---|
| Momentum rank | 25 | mean of the three rank percentiles, scaled |
| Tightness | 20 | contraction, volume dry-up and ATR ratio, each scaled, averaged |
| Support confluence | 20 | 1 level = 8, 2 = 14, 3 or more = 20; AVWAP-high reclaim adds 4 (capped) |
| Trigger quality | 20 | Setup: close position in range × stop tightness; Watch: 0 |
| Liquidity and RS | 15 | dollar volume above twice the floor = full, RS3m > 0 adds |
| Penalties | | earnings ≤ 7 days −15; stop wide −10; lot too big −5; regime watch-only −20 to every name |

Shortlist = the top 20 by score among `setup` and `watch`, Setup first, with a floor of 5 per market when that
market has 5 eligible names (otherwise the other market fills the list). `extended`, `broken` and `excluded`
never appear in the twenty, only in the funnel and the dropped row.

Reason lines (the "why") are built from the payload with the same `pass / warn / info` vocabulary the other
skills use, so the Research page's existing reason renderer shows them unchanged. Every number in a reason is a
payload field; there is no free text.

### Parameters

Stored in `strategy_params` under `leaders.pullback` (schema in `src/core/params.ts`; the seed version bumps
the way migration 0009 did for params v2). Defaults as in the tables above;
every value editable through the existing read-only parameter view once that view gains editing.

## Universe and data

The watchlist is 18 names; the screen needs a market. Universe members are ordinary `instruments` rows (they
already carry market, symbol, currency and board lot) and the `watchlist` table keeps meaning "names the user
follows". A new table says where a name came from:

```
universe_members
  instrument_id, index_code text ('SPX','NDX','MID','HSI','HSCEI','HSTECH','HSCI'),
  added_at date, removed_at date null
  primary key (instrument_id, index_code)
```

Sources (free, replayable HTTP under `src/providers`): US constituents of the S&P 500, Nasdaq-100 and S&P
MidCap 400 from the Wikipedia constituent tables; HK constituents of the Hang Seng, H-share, TECH and
Composite indexes from the Hang Seng Indexes constituent pages (CSV). About 1,300 names after overlap. A seed
CSV (`data/universe-*.csv`) is the fallback when a source changes shape; the job logs the diff and never
removes more than 10% of a market in one run without a flag.

Bars: the existing Yahoo chart ingest (`writeBars`, float32 tolerance) over the universe, 300 bars on first
load then incremental, about 1,300 calls a day at 4 a second, under 7 minutes. Fundamentals, events and chains
are **not** fetched for universe names; the Investigate sheet triggers the statements fetch for one name on
demand, and "Add to watchlist" puts the name into the normal daily ingest. Earnings dates for the blackout come
from Yahoo's calendar on the same chart call when present, else the flag reads "earnings date unknown".

## Jobs and schedule

`src/jobs/scheduler.ts`, same conventions as the rest (weekdays, market time zones, opt-in with `OT_JOBS=on`):

| Job | When | Does |
|---|---|---|
| `universe-refresh` | Sat 08:30 HKT | constituent lists, new instruments rows, `removed_at` stamps |
| `ingest-universe-hk` | 17:45 HKT weekdays | bars (and earnings date) for HK universe names not on the watchlist |
| `ingest-universe-us` | 17:45 NY weekdays | same for US |
| `leaders-scan` | 18:45 HKT (`market: 'HK'`) and 18:45 NY (`market: 'US'`), two pg-boss schedules of one job like `news-brief` | returns pass, skill per name, score, shortlist for that market, outcome stamps for earlier candidates, run stored |
| `leaders-brief` | queued by each scan when `OT_AI_AUTO` is on | one no-tools model call that writes the two-sentence lead and the per-name "in one line" text from the payloads; validator as for news (enum, length, no number not in the input, no link); rejected → the page shows the skill's own reason lines only |

The combined page reads the latest run of each market; the HK run at 18:45 HKT and the US run at 18:45 NY
mean the list is fresh at 07:00 HKT (both) and at 19:00 HKT (HK side). Refresh on the page enqueues the scan
for both markets (`leaders-refresh` extra queue, or in-process when jobs are off), 30-minute debounce.

Outcome stamping (for the record card): each stored candidate gets, as bars arrive, `fwd5 fwd10 fwd20`
(close-to-close returns), `hit3R` (a high reached entry + 3R before any low reached the stop),
`stopped`, `maxR` within 20 bars, `daysTo3R`. A candidate is counted from the close of the day it was shown.
The record card aggregates over Setup rows only; Watch rows are shown separately as "how many later became
setups".

## Storage

```
leaders_runs
  id, market, as_of date, started_at, finished_at, status, screened int, leaders int, consolidating int,
  shortlisted int, regime text, posture text ('entries'|'watch_only'), params_hash, skill_version,
  brief_lead text null, brief_model, brief_cost_usd
leaders_candidates
  id, run_id, instrument_id, rank smallint null (null = not in the twenty), state text
    check in ('setup','watch','extended','broken','excluded'), score numeric(5,2),
  payload jsonb (the full skill payload: returns, ranks, base, levels, plan, flags, reasons),
  brief_line text null,
  fwd5 fwd10 fwd20 numeric null, hit_3r boolean null, stopped boolean null, max_r numeric null,
  days_to_3r smallint null, outcome_as_of date null
  unique (run_id, instrument_id)
leaders_mutes
  instrument_id, until date, reason text, created_at
```

Rows are kept indefinitely (the day navigator and the record need them). Migration number: the next free one
after `0012_journal_ai_runs.sql` (expected 0013; `ai-analysis.md` still claims one on paper).

## API

```
GET  /api/leaders?date=2026-10-13&market=all|US|HK&state=setup|watch|all&stage=screened|leaders|consolidating|shortlist
     → { asOf, runs: { US, HK }, regime, posture, funnel, candidates: CandidateView[], dropped: DroppedView[], brief }
GET  /api/leaders/days?month=2026-10            → calendar dots (setup count per day)
GET  /api/leaders/record?window=60|all          → RecordView
POST /api/leaders/refresh                       → enqueues both scans (debounced)
POST /api/leaders/candidates/:id/mute           → { days: 10, reason }
DELETE /api/leaders/candidates/:id/mute
POST /api/leaders/candidates/:id/watch          → adds the instrument to the watchlist (existing service)
POST /api/research/runs                         → unchanged; the Investigate sheet calls it with the instrument and a preset
```

`CandidateView` mirrors the prototype's `CANDS` records; the sparkline is 70 closes plus EMA21, EMA50, AVWAP
arrays and the stop, computed server-side so the phone does no indicator work.

## Investigate: hand-off to the research skills

The seven skills in `src/server/research/skills.ts` already run on any instrument id through `claude -p` with
read-only tools and a spend cap, and write reports under `reports/<market>-<symbol>/`. The page adds one
preset to `PRESETS`:

```
{ id: 'leader', name: 'Leader check', description: 'Numbers, news, and the reason to hold it if the entry fails',
  skillIds: ['quality-screen', 'news-pulse', 'thesis-tracker'] }
```

and the sheet shows the other two presets unchanged. The quality screen is local and needs statements; when
the name has none stored the service fetches them first (same ingest step the weekly job uses, one name) and
the sheet says so ("fetching statements, about 30 s"). The report list on the Research page is unchanged; the
candidate card shows "Research: 3 reports ›" once any exist, so the second look at a name starts from what was
already written.

### `/leaders` in Claude Code (project skill, `.claude/skills/leaders/SKILL.md`)

For the user working in this repository the same flow is available in chat, so a shortlist can be read and
investigated without opening the app:

- `/leaders` : runs `pnpm cli leaders --json` (the CLI command added with L1; it reads the latest stored runs
  or scans in-process when they are older than a day), prints the twenty as a table (rank, symbol, state,
  score, price, stop %, 3m, flags) and the funnel line.
- `/leaders brief` : writes `reports/leaders/<date>.md`: lead, one block per name (reasons, KPIs, plan, flags),
  dropped names, record. Numbers come only from the JSON; the skill text forbids inventing any.
- `/leaders investigate <symbol> [leader|full|numbers]` : invokes the research skills of the preset in order
  (`quality-screen` locally, then `news-pulse`, `thesis-tracker`, and for `full` also `investment-research`,
  `earnings-review`, `management-deep-dive`), each through the Skill tool so their own prompts apply, and ends
  with one paragraph: "would I hold this name if the pullback entry fails and I am assigned or stopped".
- The SKILL.md draft is in the appendix. It is the only new model-facing text; the research skills are the
  existing ones.

Scheduling: the daily run is the pg-boss job above, inside the app server, so it does not depend on a Claude
Code session being open. When the server runs with `OT_JOBS` off, the Windows Task Scheduler fallback is one
line, `claude -p "/leaders brief"` at 07:00 HKT from the repo root, which runs the scan in-process and writes
the report.

## Guardrails and validators

- The skill never reads the clock; the as-of date comes from `DataAccess` and the run row. Replaying
  `GET /api/leaders?date=` for a past day renders the stored candidates, never a recomputation.
- Model text (brief lead, per-name line) is optional decoration: enum and length checks, no number that is not
  in the payload, no link; rejected text is dropped and the page shows the skill's reason lines. Model output
  is rendered as text. Daily budget shared with news (`OT_NEWS_DAILY_BUDGET_USD`) unless `OT_LEADERS_BUDGET_USD`
  is set; cap US$0.10 a brief.
- Regime watch-only (S0 `panic` or `crash_guard`) demotes every Setup to Watch and says so in the header; the
  numbers are still shown.
- The plan is computed from `portfolio_settings.equity`; while it is NULL the plan shows "set equity in
  Settings" and shares are blank, the rest of the card still renders.
- Nothing here writes to `recommendations`, `positions`, `research_verdicts` or `corporate_events`. A universe
  name becomes part of the sell-put pipeline only by "Add to watchlist".

## What it does not do

- No intraday data: the turn-up bar is judged at the close, so the earliest entry is the next session (the
  stop-buy line above today's high exists for that).
- No trailing-stop management, no position tracking for stock trades (the journal and positions pages are for
  puts; a stock-lot page is a separate design).
- No sector or theme grouping, no fundamentals in the score (the hand-off is where fundamentals come in).
- No short side, no A-shares.

## Build order

- **L1 Numbers**: universe tables and jobs, bars ingest for the universe, the two indicators, the skill and its
  tests (golden cases for a synthetic run-up / base / turn-up series, AVWAP against a hand computation, gap
  detection, HK lot rounding), `leaders_runs` / `leaders_candidates`, the scan job, `cli leaders --json`,
  `GET /api/leaders`, the page with cards, filters, funnel and the plan. Acceptance: a real run over both
  universes finishes under 10 minutes cold, under 1 minute warm; the page at 375 px has no horizontal overflow,
  every control is 44 px, the numeric fields are 16 px.
- **L2 Hand-off**: Investigate sheet, the `leader` preset, statements-on-demand, Add to watchlist, mute,
  TradingView link, the Today card, the `/leaders` project skill.
- **L3 Record**: outcome stamping, record card, day navigator and calendar, dropped row with reasons.
- **L4 Brief**: `leaders-brief` with the validator, the per-name line, `/leaders brief` report, the put-angle
  line for watchlist names with chains.

## Decisions taken in this design

- Universe names are `instruments` rows, not a parallel table: bars, FX, board lots and research runs all key
  on instrument id and nothing else needed to learn a new key. Watchlist stays the only "followed" marker.
- Percentile ranks are computed by the job and published to the skill, keeping the skill per-instrument and
  cacheable like the others.
- The daily run lives in pg-boss, not in a Claude Code schedule, because the numbers need no model and the
  server is already the long-lived process; the model only writes optional text.
- Top 20 with a per-market floor of 5 rather than 10 + 10: on many days one market has few valid bases and
  padding it with weak names is worse than an uneven split.
- Entry reference is the close, not the next open: it is the only price the daily data can state, and the
  stop-buy line gives the intraday alternative.
- No tab: nine tabs is too many; Today card plus More.

## Appendix: `.claude/skills/leaders/SKILL.md` (draft, to be created in L2)

```markdown
---
name: leaders
description: Daily pullback-buy shortlist (Martin Luk method) for HK + US: show today's twenty leaders at support, write the day's brief, or investigate one name with the research skills. Use for "leaders", "pullback list", "who is at support today", "/leaders investigate NVDA".
---

# /leaders

Read-only over the app's stored runs. Never place orders, never invent a number.

## Modes
- `/leaders` (default): run `pnpm cli leaders --json` from the repo root. If it reports `stale: true`, run
  `pnpm cli leaders scan --json` (in-process scan over both markets, 1 to 10 minutes) and read again. Print:
  the regime and posture line, the funnel line, then a table: rank, market, symbol, state, score, price,
  stop %, 1m/3m/6m, flags. Then one line per Setup with its three reasons. End with the hand-off line:
  "`/leaders investigate <symbol>` runs quality screen, news pulse and thesis tracker; add `full` for the
  four-masters memo, earnings read and management".
- `/leaders brief`: same data; write `reports/leaders/<asOf>.md` with: lead (two sentences, regime and what
  the list is made of), one block per name (state, reasons, KPI grid, plan, flags, support map), dropped names,
  the record card. Every number is copied from the JSON; if a field is null write "n/a".
- `/leaders investigate <symbol> [leader|numbers|full]` (default leader): resolve the symbol to market and
  instrument (HK digits → HK); if statements are missing run `pnpm cli ingest --steps fundamentals --symbol
  <symbol>` first. Then invoke, in order, with the Skill tool: `quality-screen`, `news-pulse`,
  `thesis-tracker`; for `full` add `investment-research`, `earnings-review`, `management-deep-dive`. Reports go
  under `reports/<market>-<symbol>/`. Finish with one paragraph answering: would you hold this name if the
  pullback entry fails (stopped out) or if a put sold at the stop level is assigned, and which research
  finding decides it.

## Rules
- Numbers only from the CLI JSON or the research reports. No price targets, no advice wording; say
  "the plan shows" not "you should".
- Do not run the scan more than once per hour; the job already runs it after each close.
- If `pnpm cli` fails, print the error and stop; do not fall back to web prices.
```

## As built (2026-10-13, stages L1 to L4)

Built from this design on `feat/leaders`, one commit per stage. What differs from the text above, and why:

**Where the code lives.** Skill `src/skills/s8-leaders-pullback.ts` (`leaders.pullback` 1.0.0; shared vocabulary and the pure rules around it in `src/core/leaders.ts`), registered in `src/skills/registry.ts` as `STANDALONE_SKILLS` and in `ALL_SKILLS`, never in `SKILLS`, so `runPipeline` cannot run it. Repositories `src/db/leaders.ts` and `src/db/universe.ts`; jobs `src/jobs/leaders-scan.ts` and `src/jobs/universe-jobs.ts`; universe providers `src/providers/universe/`. The read side (the view the page shows, the record, the calendar, the put angle) is `src/leaders/` and not `src/server/`, because only the server may import `server` and `pnpm cli leaders --json` has to print the same shape: the view types are in `src/leaders/types.ts`, re-exported by `src/server/api-types.ts`. Service `src/server/services/leaders-service.ts`, brief `src/server/leaders/brief.ts`, prompt `src/server/research/prompts/leaders-brief.md`, CLI `src/cli/commands/leaders.ts`, project skill `.claude/skills/leaders/SKILL.md`, page `web/src/pages/leaders/`.

**Skill input.** One optional, typed `SkillContext.extras` (set only by the scan): `leaders.ranks` carries the name's own three percentile ranks (the job builds the market's rank table from the returns pass; names that fail the history, price or liquidity rows are not in it), `leaders.earnings` the next earnings and ex-dividend dates. Without `leaders.ranks` the skill returns `excluded: no rank table`. Earnings come from the stored events for names on the watchlist and from one Yahoo calendar call per leader for the other names; nothing is written to `corporate_events`. A name with no known date shows the flag "Earnings date unknown" (all HK names whose Yahoo calendar is empty). The scan keeps its results in `leaders_candidates`, not in `skill_runs`, because a result also depends on the market-wide rank table.

**Runs are per market.** `leaders-scan` runs once per market (HK 18:45 HKT, US 18:45 New York) and stores that market's own list: `rank` is the position in the market's own top 20 (Setup first, then score). The page combines the latest run of each market into the displayed twenty with `selectShortlist` (Setup first, at most 20, a market with 5 or more eligible names keeps at least 5). Archive days (`?date=`) read the stored rows of exactly that date; the combination is the only thing done at read time. `leaders_runs` gained a `detail` JSONB column (regime payload, funnel, bar coverage, notes, duration); `leaders_candidates` also holds the previous list's names that fell out (state `excluded` with the failing rule), so the dropped row can say why. Names that never reached the leader test are counted, not stored, so the funnel stage "screened" lists nothing and says so. Funnel counts: screened = names that passed the history, price and liquidity rows; leaders; consolidating = Setup + Watch + Extended (a valid base that has not broken); shortlist = the combined list.

**Definitions the design left open.** As-of = the market's last completed session (from 16:30 local, the close plus 30 minutes; the universe bars job uses the same rule); a name with no bar for it is excluded with that reason. The anchor high is the highest high of the last 60 bars (the latest if tied) and must be at least 5 bars old, else "no base yet". Base low includes today; "broken" means a close under the 50-EMA or under the base low set before today. A level is in play when a low of the last 3 bars came within the wider of 1.5% and 0.5 ATR of it and no close since is more than 1 ATR under it; the in-play level is the one nearest the lowest low of those bars; confluence counts distinct families (EMA, swing, gap, AVWAP, base) within 1.5%. Tightness scores fall linearly from 0.75 / 0.90 / 1.00 (range, volume, ATR ratio) to 0.50 / 0.60 / 0.80; the hard caps and these anchors are parameters (`leaders.pullback`, seeded as strategy_params v3, migration 0014). Trigger quality = close position in the range x (0.5 to 1 for a stop from 3% down to 1%). Penalties apply to the score of every name in the regime or blackout, Watch included.

**HK lots.** The stock board lot (HKEX list of securities, not the option contract size in `data/hk-board-lots.csv`; 14 of the 43 names there differ) is `instruments.provider_symbols.stockLot`; shares round down to it. 2 names of 519 are not on the HKEX list: lot assumed, flag "Board lot unverified". A name whose lot is not stored falls back to `board_lot`.

**Universe.** US: the S&P 500, Nasdaq-100 (the `Nasdaq-100` page lost its table; `List_of_NASDAQ-100_companies` is used) and S&P 400 through the MediaWiki parse API. HK: HSI, HSCEI and HSTECH from the JSON the hsi.com.hk site itself calls (the constituent pages are JavaScript); HSCI is only partly available (the full list needs a logon): the public change log since 2008 replayed plus the three other indexes gives 519 of 581 names, and the job log says so. Seed CSVs `data/universe-us.csv` (1,004 rows) and `data/universe-hk.csv` (694 rows) are the fallback; a source failure falls back per index, add only; more than 10% of a market's memberships dropping out in one run is flagged and nothing is removed. Cold, real, 2026-10-13: 1,437 names.

**Outcomes and the record.** Stamped inside every scan from the bars after the day shown, counted from that close. `max_r`: for a stopped trade the R of the exit (-1, below -1 when the bar opened through the stop), otherwise the best R any high reached in 20 bars (3 or more once 3R was hit). A bar that touches both the stop and 3R counts as stopped. Realized R for the average = 3 for a 3R hit, the exit R for a stop, else the 20th close marked in R; "open" = neither and fewer than 20 bars. Only the newest run of each (market, date) counts, so scanning a day twice does not double the record. The record counts Setups that were in their market's own list, which can be a few more than the combined twenty on a day with more than 20 eligible names.

**Hand-off.** The `leader` preset is in `PRESETS`. `POST /api/research/runs` fetches the profile and statements of a name first when `quality-screen` is chosen and none are stored (`runIngest` takes an optional `names` list for that); the sheet says "about 30 s". The Research page shows a bare stand-in row for a name that is not on the watchlist when the route asks for it. "Add to watchlist" sets `has_listed_options` (universe names are stored without options so the daily ingest leaves them alone) and uses the watchlist service; a HK name gets its stock lot as the board lot. `pnpm cli leaders statements <symbol>` does the same fetch for the project skill. There is no More page: the entry is a "More pages" panel in Settings plus the Today card.

**Brief and put angle.** One no-tools call per run (`claude-haiku-5-5`, `isolated`, cap US$0.10), the input is the regime, the funnel and the listed names with their own reason lines and flags; line keys are instrument ids; one retry with the reason; a rejected brief stores nothing and its cost still counts against the day (`OT_LEADERS_BUDGET_USD`, else `OT_NEWS_DAILY_BUDGET_USD`, else US$2). The put angle is computed at read time for a followed name with a chain stored within 3 days: the nearest monthly expiry inside the `option.select` DTE window, the highest strike at or below the stop (a Watch: the support in play), stored delta or Black-Scholes from the quote IV, ROC = bid / strike.

**CLI.** `pnpm cli leaders [--json] [--market] [--stage] [--date]`, `leaders scan [--json] [--no-ingest] [--market]` (fetches the universe bars, then scans; no model call), `leaders universe [--seed]`, `leaders statements <symbol>`. The JSON is the API's `LeadersView` plus `stale` and a 60-day `record`; use `pnpm --silent` so pnpm's banner stays out of it.

**Real run (throwaway database, live Yahoo, 2026-10-13, nothing mocked).** Cold: 1,437 names loaded in 12 s, 144,769 HK and 283,477 US bar rows fetched in 12 s and 22 s, both scans 1.3 s and 2.4 s: 42 s end to end. Warm: 7.8 s including the process start. HK 519 names / 281 screened / 22 leaders / 4 in a base / 3 listed; US 918 / 914 / 107 / 37 / 20; combined list 20 (2 Setup, 18 Watch; US 17, HK 3). Setups were rare on this day (a quiet pullback list), which is what the screen is for.

**Not built / known limits.** HSCI is 62 names short; HK earnings dates are often unknown (Yahoo's calendar is empty for many HK names); no intraday data; no stock-lot tracking; no trailing-stop management; the record is the app's own forward record, short at first (it needs weeks of bars). The `leaders-brief` text is optional and was verified against a scripted executor only, not a live model.
