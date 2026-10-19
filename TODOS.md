# TODOS

Deferred work with enough context to pick up cold. Added by /plan-eng-review on 2026-10-10.

## ~~Pull Futu/moomoo chains into milestone 1 if the account exists~~ DONE 2026-10-10
- User confirmed a moomoo account. The Futu OpenD adapter is now in Phase 1 (docs/06) and in the build prompt; CSV paste is the fallback. Decision D16 in docs/07.

## Cross-market merged ranking
- **What:** A single ranked table across HK and US once both markets are scored by the same functions.
- **Why:** Milestone 1 prints one table per market because free-data HK names are scored with partial fundamentals and proxy volatility; merging them would compare different scoring functions.
- **Pros:** One list to act on. **Cons:** Misleading until HK has real chains and fuller fundamentals.
- **Depends on:** Futu or IBKR chains for HK; paid fundamentals or the Phase 1 coverage report showing Yahoo is enough.

## Paid fundamentals (FMP or EODHD) if the coverage report is poor
- **What:** Add a provider for 5-year statement history with filing dates.
- **Why:** The A3/A4 quality and valuation metrics need 5-year medians; Yahoo gives about 4 periods.
- **Pros:** Full fundamental gate, real `reported_at`. **Cons:** Subscription cost; another adapter.
- **Depends on:** Phase 1 coverage report (docs/06 Phase 1 check).

## ~~Barone-Adesi–Whaley early-exercise pricing~~ DONE 2026-10-12
- Built in `src/backtest/pricer.ts` and checked against a 1,500-step binomial tree (tests/backtest/pricer.test.ts).

## Added by the milestone-1 build (2026-10-10)

### A second free bar source now that Stooq blocks scripts
- **What:** Stooq answers automated requests with HTTP 403 or a JavaScript proof-of-work page, so the T15 adapter is built and tested but cannot carry live bars today. Add a provider with an API key (Tiingo, Alpha Vantage, EODHD) behind the same fallback slot in `src/providers/ingest.ts`.
- **Why:** Yahoo is currently the single live bar source; an overnight Yahoo outage drops names as `data.stale` until it returns.
- **Depends on:** you choosing a key-based provider (a credential only you can create).

### HK volatility index history (VHSI)
- **What:** Yahoo has no VHSI history (verified 2026-10-10). Put an HKEX VHSI daily CSV (`date,close`) at `data/vhsi.csv`; `ingest` loads it automatically.
- **Why:** without it the HK regime and the S3 proxy tier run on the index versus its 200-day average and RV (`regime.noVolIndex`).

### Calendar upkeep and gaps
- Holiday tables cover 2010-2027 (`scripts/gen-calendars.ts`); regenerate before 2028. Unplanned closures (typhoon, emergencies) are not modelled: a closure the table does not know shows up as a false `data.stale` with the date printed. HK weekly options are ignored in v1.

### Housekeeping and polish
- `skill_runs` rows of older skill versions or params hashes are never pruned (keys include version and params hash); add a prune command if the table grows.
- Assigned puts book the intrinsic loss but the resulting stock lot is only a note (no holding or wheel tracking until Phase 3).
- `positions mark`, alerts (50% / 21 DTE / 2x stop / assignment risk) and the wheel are Phase 3 per the roadmap.
- Journal attribution is descriptive on small samples; the observe-mode attribution and event studies wait for the Phase 4 backtester.
- Broker-specific journal mappers (moomoo, IBKR, HSBC, Futu): the generic template is the default.
- Per-name `max_collateral_pct` can only be set in SQL today (no CLI flag yet).

## Added by the milestone-2 build (2026-10-11)

### Thesis tracker should receive the previous thesis
- **What:** the thesis-tracker skill has a "check an existing thesis" mode, but the app starts every run fresh (the report says it could not find a thesis file). Pass the latest saved thesis report for the stock into the prompt as context.
- **Why:** otherwise the tracker can only ever write version 1.0.

### Strategy parameter editor
- **What:** parameters are read-only in Settings. A versioned editor needs re-scoring of cached results and a diff view of two parameter versions.

### ~~Live marks, P&L and alerts for open puts (Phase 3)~~ DONE 2026-10-12
- `position_marks`, the shared alert rules, the daily job and the Mark now button. See DECISIONS.md (2026-10-12).

### `rolled` close kind in the UI
- **What:** the close dialog offers bought back, expired and assigned; rolling is two fills today (close, then log the new put). Add a roll action that links the two.

### Browser e2e in the repository
- **What:** the real-UI pass (BUILD-LOG, milestone 2) was driven by hand through the browser pane. Add a scripted Playwright smoke test against a seeded throwaway database so it can be rerun in CI.

### ~~Prefill spot price in the Data page chain paste~~ DONE 2026-10-12
- **What:** the paste dialog opened from the Data page has an empty spot field (the Today page prefills it); use the last stored close.

## Added by the login build (2026-10-11)

### Account management in Settings
- **What:** the login has no UI to change the password, set a first password on a Google-only account, or end other sessions. Today a forgotten password is recovered with an email link, then nothing else. Add change password, "sign out everywhere", and the list of active sessions (`app_sessions` already stores method and times).

### Per-user data, if a second person ever needs access
- **What:** sign-in is a gate in front of one shared portfolio; `watchlist`, `positions` and settings have no owner column. Adding accounts without that would show everyone the same book.

### ~~Fix the SGD fallout (found while testing the login, not caused by it)~~ DONE 2026-10-12
- **What:** `SGDHKD` was added to `FX_PAIRS` without a recorded fixture, so ingest-from-fixtures tests and e2e 01 to 05, 07, 08 fail; `src/server/services/portfolio.ts:39` and `web/mock/state.ts:208` no longer type-check. Record `SGDHKD=X` with `scripts/record-fixtures.ts` and widen the two types.

### ~~Let the CSP load the UI fonts~~ DONE 2026-10-12 (self-hosted via @fontsource)
- **What:** `web/index.html` links Google Fonts but the server's CSP only allows same-origin styles, so Inter and JetBrains Mono never load. Either self-host the fonts or allow `fonts.googleapis.com` and `fonts.gstatic.com`.

## Added by the Phase 3 and 4 build (2026-10-12)

### ~~Run the real-history validation~~ DONE 2026-10-12 (all 5 checks pass on 2,514 SPY bars)
- **What:** `pnpm cli ingest --only SPY --years 15` then `pnpm cli backtest validate` (docs/05 section 6). The simulated-path version passes in the test suite; the real SPY comparison has not been run. The calendar tables start in 2010, so it is 2010 to today, not 2007.

### Test a 60-name run and the pipeline's cold-cache speed (partly done)
- **What:** measured 2026-10-12: 32 names x 7.8 years, no sensitivity, no benchmarks, took 208 s on this machine (about 17 ms per name per scan day). Full runs add sensitivity (x3) and benchmarks, so budget about 10 minutes for 32 names. 60 names x 10 years is still unmeasured (linear estimate 15 to 25 minutes, over the 15-minute target); batching the `skill_runs` writes per scan day is the first lever.

### Real rate history for cash and the risk-free rate
- **What:** backtests credit cash with one flat rate (a strategy parameter). Use a T-bill / HIBOR series by date; it moves every benchmark comparison, especially 2017-2021 when rates were near zero.

### Dividends in synthetic prices
- **What:** the synthetic pricer runs with yield 0. Use `corporate_events` ex-dividend amounts (docs/05 section 1 asks for the present value of a discrete dividend inside the DTE window); it matters most for high-yield names.

### Covered calls for the wheel
- **What:** assignment now creates a stock lot and shows the effective cost, but the app does not suggest or track covered calls. Add a call leg (strike above the effective cost) and lot-level alerts.

### ~~Backtest cards on the stock detail pages~~ DONE 2026-10-12 (Research > Value, from the latest finished run)
- **What:** the per-stock card (n, win rate, average ROC, drawdown, tier mix) is in each run's metrics and API; show it on Today / Research. Do NOT feed it into S5 inside a backtest (lookahead): attach it at presentation time.

### Mock server for `pnpm web:dev`
- **What:** `web/mock` now answers `/api/backtests`, `/api/lots` and `/studies` with empty results (2026-10-12). `/api/positions/marks/run` is still not mocked.

### Live-test the alert channels and the schedule
- **What:** set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (or `OT_SMTP_URL` + `OT_ALERT_EMAIL`) and run `pnpm cli positions mark --notify` once; run the app with `OT_JOBS=on` over a market close and check `job_runs`.

### ~~Record the missing SGD fixture (blocks the end-to-end suites)~~ DONE 2026-10-12
- This is the item above ("Fix the SGD fallout"); it also means `pnpm test:e2e` cannot reach its real tests today (every file stops in `bootstrap` on the ingest failure). The Phase 3/4 changes were e2e-checked by running the suites with `SGDHKD` temporarily removed from `FX_PAIRS` (restored afterwards).

## Daily Journal (built 2026-10-13, branch feat/journal)

### Journal migrations: DONE 2026-10-13
- `feat/journal` was merged into main (79f2d1d) with the journal migrations renumbered to 0010-0012 after news (0008) and params v2 (0009); `pnpm db:migrate` applied them to `option_trading` (13 migrations recorded, five journal tables present). The journal routes no longer answer 503.

### Real-device pass for the journal (iPhone, Safari and the home-screen app)
- **What:** things a desktop browser cannot show: the `visualViewport` toolbar pinning above the keyboard and the `kb` class that hides the tab bar, safe-area insets, swipe-back from an entry to the list, tapping a checklist row, camera and photo-library upload, paste of a screenshot, "Add to Home Screen" with the new PNG icons. The pinning logic is unit-tested with a fake `visualViewport` only.

### HEIC photos
- **What:** the prebuilt `sharp` here decodes AVIF but not HEVC, so a HEIC upload answers 415 with "choose Most Compatible in Settings > Camera > Formats". iOS Safari normally converts to JPEG for `<input accept="image/*">`; if it does not on the real device, build sharp against a libvips with an HEVC-capable libheif, or convert in the browser before upload.

### Journal ideas parked
- Weekly review generated by the AI from the week's entries (design doc open question; reuse the J3 pipeline with several entries as input).
- Chinese full-text search: today a query with CJK characters falls back to a substring scan; add `pg_trgm` (or a bigram column) if the journal grows large.
- Read-only closed days: Draft/Closed is only a chip today (design open question).
- `translate_en` is in the API but the sheet offers 中文 only.
- Tab bar: Journal makes eight tabs and the news page nine; the planned fallback is a "More" tab (Tests, Data, Settings), decide on the real device.
- Move the trade-CSV import from `/api/journal/import` to `/api/positions/import` (the old name now sits next to the diary routes).

## Added by the Leaders build (2026-10-13)

### Apply the Leaders migrations to the real database, then load the universe
- **What:** `pnpm db:migrate` on `option_trading` (0013 creates the four Leaders tables, 0014 seeds `strategy_params` v3), then `pnpm cli leaders universe` (live sources; `--seed` works offline) and `pnpm cli leaders scan` once. The build was verified only on throwaway databases; the real one was not touched. Until it is migrated the Leaders endpoints answer 503 `migration_needed`.
- **Then:** set `OT_JOBS=on` to run `universe-refresh` (Sat 08:30 HKT), `ingest-universe-hk/us` (17:45) and `leaders-scan` (18:45 HKT and 18:45 NY); no scheduled run has been waited for yet.

### HSCI is 62 names short
- **What:** the Hang Seng Composite list needs a Hang Seng logon; the build replays the public change log since 2008 and adds HSI/HSCEI/HSTECH (519 of 581). Either a logon-free source or a periodic manual CSV drop into `data/universe-hk.csv` closes it.
- **Why it matters:** a leader that is only in the 62 never reaches the screen.

### HK earnings dates are often unknown on the Leaders cards
- **What:** Yahoo's calendar is empty for many HK names, so the blackout rule cannot demote them and the card says "Earnings date unknown". A HKEX board-meeting-date source would fix it.

### The record card needs weeks of data
- **What:** it counts Setups from the day the feature ran; with a few Setups a day the 60-day numbers are noise until about a month in. Nothing to do but wait, and read the "Watch names that later printed a Setup" line meanwhile.

### Research page for names that are not on the watchlist
- **What:** it shows a bare stand-in row (no price, no data status) so that "Research: n reports" works; a proper view of an investigated-only name (price, last bar, statements) would need the data-status endpoint to include names that have research runs.

## Added by the app redesign D1 (2026-10-18)

### Leaders page tests still expect cards for the shortlist
- **What:** `web/src/pages/leaders/LeadersPage.test.tsx` has 20 failing tests since the shortlist stage became a table (`ShortlistTable.tsx`, 2026-10-16): they query `role="article"` by name. Rewrite them against the table rows and the expanded detail panel, or give the table an accessible shape they can find.

### News page: the "no brief" test is date-sensitive
- **What:** `says why there is no brief...` fails on the committed tree ("No brief has been written for today yet" is not rendered). Check the brief fixture against the mocked today before changing the page.

### D2 to D4 of the redesign
- **What:** D2 `GET /api/reminders` (corporate events incl. ex-dividend, HKEX notices, the 08:00 digest on the alert channels); D3 the restyle (tokens, type, shared panel and row components on Puts, Leaders, News, Research); D4 research verdict extraction and the quality screen on Leaders rows. See `docs/designs/app-dashboard.md`.
## Added by the Futu HK data build (2026-10-13, branch feat/futu-hk)
- **First real-database run restates every HK bar once.** HK bars now come from OpenD (`source` futu) ahead of Yahoo, so the next `pnpm cli ingest` (or the 17:30 HKT `ingest-hk` job) rewrites the stored HK history and drops the cached HK skill results; they recompute on the next scan. One-off, expected, recorded in DECISIONS.md.
- **US IV history from OpenD.** `GetOptionUnderlyingHisVolatility` is market-agnostic; the `volatility` step is HK-only because that is what was asked for and verified. If the moomoo account has US option quote rights, lifting the `inst.market === 'HK'` guard in `src/providers/ingest.ts` gives US names the same real IV rank.
- **OpenD's HV window is undocumented**, so the `hv` field is parsed but not stored. S3 computes Yang-Zhang realised vol from bars itself.
- **The SDK prints `登录成功` on login** (a console.log inside `futu-api`); harmless in the CLI, noise in the job log. Silence it by wrapping the SDK's logger if it bothers you.
- **`explain`/`scan` default as-of is the last day both markets completed** (17:00 New York), so a same-day HK chain and IV from the 17:30 HKT ingest become visible to the scanner only the next morning HKT, or with `--as-of today`. Unchanged behaviour, noted because the live check tripped over it.
