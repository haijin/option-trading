# 06 — Build roadmap (revised 2026-10-10 after office-hours review: scanner first, journal seeded)

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

Each phase ends with something you can run and check. Milestone 1 = Phases 0 to 2. Nothing in a later phase is
needed to use an earlier one.

Milestone 1 is a CLI only. No HTTP server, no job queue: `pnpm cli ingest --all` is scheduled with Windows Task
Scheduler. Fastify and pg-boss arrive in Phase 3 when alerts need a long-running process. Estimated 12–15 working
days after the eng and outside-voice reviews (Phase 2 re-estimated at 8–10 days).

## Phase 0 — Skeleton (1 day)
- **Single package** (eng review 2026-10-10): `src/{core,indicators,providers,skills,db,cli}` with the same
  boundaries the earlier monorepo diagram showed; split into workspaces only when Phase 3 or 6 needs a second
  process. TS strict, biome, vitest, `.env.example`, CLI entry point.
- Drizzle schema in `src/db/schema.ts` is the **single source of truth**; migrations generated from it;
  `03-schema.sql` is reference documentation.
- PostgreSQL 16 native on the Windows host (no Docker assumption); a `db:check` script that verifies the connection.
- Migration seeds: `strategy_params` row `default` v1 from the defaults in `04-skills-spec.md`; `portfolio_settings`
  single row (equity must be set before the first scan: `pnpm cli settings set equity 2000000 --base HKD`, and
  `scan` refuses to run with a clear message until it is).
Check: `pnpm cli --help` runs; `pnpm db:migrate` creates all tables and both seed rows exist.

## Phase 1 — Data in, including your own history (3–4 days)
- Yahoo provider: bars (US + HK) 10 years, **index and vol-index bars** (SPY, ^VIX, 2800.HK, ^HSI; VHSI see below),
  quoteSummary fundamentals with `reported_at` where given, else market-specific lag clamped by `first_seen_at`
  (02 §3), US chains, US earnings dates, `HKD=X` FX with 10-year backfill (journal P&L and past collateral need
  historical rates). Every writer calls `invalidateSkillRuns`.
- VHSI: verify the Yahoo symbol in this phase; if unavailable, seed from the HKEX VHSI daily CSV as a static file.
  Fallback at runtime: HK regime from HSI versus SMA200 only, with Reason `regime.noVolIndex` (vol index exempt
  from the freshness gate in that mode).
- **Stooq bar provider** (free daily CSV, HK and US, no auth) as the fallback when Yahoo fails; about 50 lines.
  Ingest tries yahoo, then stooq, and records which one succeeded per symbol in `price_bars.source`.
- HK board-lot seed CSV (you maintain it; verified against the provider); `reporting_frequency` and `solvency_model`
  set per watchlist row on add.
- Static exchange calendars (US, HK) 2010–2027; HK monthly expiry computation with unit tests.
- **Journal import** (generic template, columns in `01 §G2`): writes `positions` and journal-tier `option_quotes`
  only. Calibration and attribution need the pricer and the skills, so they run in Phase 2.
- **Futu/moomoo OpenD provider for HK option chains** (moved from Phase 5 on 2026-10-10, the user has a moomoo
  account): official `futu-api` npm package against local OpenD, read-only quote calls, symbol mapping
  `0700` → `HK.00700`, lot size cross-checked against `board_lot`, snapshots stored with source `futu`, greeks from
  the gateway or computed. `pnpm cli futu status` reports OpenD reachability, the quote login, the history quota and
  the HK watchlist as OpenD sees it. OpenD login is a manual step documented in the README.
  Extended 2026-10-13 (HK stock and option data): HK daily bars from OpenD first (Yahoo, then Stooq as fallbacks),
  the HK chain fetched out to the strategy's `dteMax` (180 days), and a `volatility` ingest step that backfills
  `iv_daily` from OpenD's underlying IV history so S3 ranks HK IV against a real year.
- **CSV chain import** stays as the fallback for HK when OpenD is not running (and for any name Yahoo lacks).
  `--spot` and `--date` flags are authoritative; `iv` and `delta` columns optional, computed in-app when absent
  (see Phase 2). Semantic rules per 02 §3, one test each.
- Manual corporate-events entry (`pnpm cli events add 0700 earnings 2026-11-12`).
- `pnpm cli ingest --all` (prices, fundamentals, US chains, calendar, FX) and a Task Scheduler entry for it.
Check: 10 years of bars for 5 HK + 5 US names plus the four indices; FX backfilled; your journal imported with
realised P&L totals matching your own records; one HK chain CSV stored; a point-in-time query returns the right
statement for an old date; **S1 input coverage report**: count of missing fundamental fields per name for those
10 names, so the free-data decision (07 Q3) is made on evidence.

## Phase 2 — Indicators, skills, scanner (8–10 days)  → MILESTONE 1
- Indicators module with golden fixtures generated once from TA-Lib (`tests/fixtures/gen/`, committed CSV). If the
  TA-Lib wheel will not install on the Windows host, generate the fixtures on any other machine once; the committed
  CSVs are what the tests use. Black-Scholes + greeks (Hull table, put-call parity) + implied vol round-trip;
  Yang-Zhang RV. Barone-Adesi–Whaley is only needed for backtest marks and moves to Phase 4.
- Greeks are computed in-app from quote IV (or IV implied from mid when the provider gives none); Yahoo supplies
  no greeks and the CSV paste usually has none. Stored with `source` suffix `greeks:computed`.
- Skills S0–S7 per `04-skills-spec.md`; registry; pipeline runner with `scan` / `full` modes, per-run DataAccess
  cache with indicator memo, params-hash caching, open-position exclusion, and the freshness gate (02 §2).
- `pnpm cli scan` (reads the database only; never fetches; refuses stale inputs unless `--allow-stale`) and
  `pnpm cli explain` (full mode).
- `pnpm cli journal calibrate`: prices every CSV chain row (primary, unbiased) and every journal fill with a `spot`
  column (sanity figure) with the synthetic pricer on the same date, writes `pricing_calibration`, and prints the
  real/synthetic ratio per market and delta bucket.
- Scan output is one table per market plus a "paste chains for these" block (top 5 HK names without a fresh chain).
- Journal attribution report: each past trade re-scored as of its entry date; winners versus losers per rule.
Check: a scan on today's date for 20+ names finishes in under a minute and yields a ranked shortlist with reasons
and data tier for every name; FAILs name their binding rule; a deliberately stale name is dropped with `data.stale`;
`explain` on a FAILed name still shows S2–S4; calibration and attribution run on your journal; the
future-perturbation test passes.

**Use it for real here.** Run the scan daily for 3–4 weeks, paste HK chains, log fills with `pnpm cli positions add`.
This builds the real-tier snapshot history the backtester needs and tells us which reasons you actually act on.

## Phase 3 — Positions, alerts, API (3 days) — BUILT 2026-10-12
- Fastify API per `02 §5` (built with milestone 2), pg-boss schedules replacing Task Scheduler (opt-in, `OT_JOBS=on`), `/health`.
- Daily marks, alert rules (50%, 21 DTE, 2x stop, assignment risk, new earnings date), wheel conversion on assignment.
- Optional email or Telegram push (new alerts only).
Where: `src/core/alerts.ts`, `src/db/marks.ts`, `src/db/lots.ts`, `src/jobs/`, README "Marks, alerts, the wheel and scheduled jobs".
Not verified live: the Telegram and SMTP channels (no credentials here; the Telegram request shape and error handling are unit tested),
and the scheduled times (pg-boss round trip is tested; the cron expressions were not waited for).

## Phase 4 — Backtest engine (5–7 days)
- Signal event studies (05 §5) on price history: forward returns and strike-touch rates when each rule fires.
- Synthetic pricer with journal-derived calibration; portfolio engine; metrics; walk-forward; attribution in observe
  mode; sigma sensitivity labels.
- `POST /backtests`, progress, results, CSV export.
Check: the two reproduction tests in `05 §6` pass within tolerance; a 60-name 10-year synthetic run finishes in < 15 min.

**BUILT 2026-10-12** (`src/backtest/`, `pnpm cli backtest`, the Backtests page). Check status: the two §6 reproductions pass on *simulated*
SPY-like paths (tests/backtest/validation.test.ts); the real-SPY reproduction is `pnpm cli backtest validate` and needs the history
ingested, so it has not been run. The calendar tables start in 2010, so a 2007 start is refused (the plan's "2007-2025" became
"2010-2025"). Speed: the engine with the naive source (which prices a 30-delta strike per name per scan day) does 60 names x 1 year in about 4 seconds, so roughly 40 seconds for 10 years; the pipeline replay measured ~22 ms per name per scan
day on names that fail the gate early (a cached rerun is ~6x faster), which extrapolates to roughly 11 minutes for 60 names x 10 years at weekly scans, so the
15-minute target is plausible but NOT verified at that size.

## Phase 5 — Interactive Brokers gateway (3–5 days, only if an IBKR account exists)
- @stoqey/ib adapter for US and HK chains, greeks, IV; IV history backfill where allowed. Futu is already in Phase 1.

## Phase 6 — Web UI (5–8 days) — built with milestone 2; the Backtests page was added with Phase 4
- React pages per `02 §6`, lightweight-charts for price charts, shared reasons-table and backtest-card components.

## Phase 7 — Hardening
- Monthly walk-forward re-optimisation job; parameter diff review; data-quality dashboard (stale bars, missing
  filings, estimated filing dates, uncalibrated synthetic prices); backups.
