# Design: Sell-Put App, milestone 2 (local web app, Layout A)

Status: APPROVED by the user on 2026-10-11 (prototype review: Layout A "Blotter", seven stock-level skills, database on :5433).
Mode: autonomous build (the user cannot answer questions; every choice is logged in DECISIONS.md).
Prototype (throwaway, kept as a primary source): git branch `prototype/ui-layouts`, file `docs/prototype/app-prototype.html`.

## What it is

The milestone-1 scanner (CLI + PostgreSQL) gets a local web app, started with `pnpm app` and opened at
http://localhost:3004. It is the same decision-support tool, not a new product: the app never places orders, it reads the
same database, runs the same skills S0 to S7, and uses the same ingest. The browser UI is Layout A:

- left rail: Today, Research, Watchlist, Positions, Data, Settings
- Today: ranked list (US, HK) on the left, one candidate in full on the right with tabs Reasons, Chart and evidence,
  Value and KPIs, Scanner skills
- Research: pick one watched stock, see intrinsic value, KPIs, the 7-filter quality screen, and run seven analysis skills
- Watchlist: add, validate, pause or resume, edit per-stock settings; only watched stocks are fetched, scanned, researched. Redesigned 2026-10-14 as a board (one table row per watched stock: price, KPIs, highlights, the scan's recommendation; see DECISIONS.md)
- Positions: open puts with alerts, journal summary, log a fill, close a position
- Data: ingest, per-stock data status, providers, paste an HK chain
- Settings: equity and base currency, read-only strategy parameters, environment checks

## Architecture

```
browser (React, Vite build in web/dist)
   |  JSON over http://127.0.0.1:3004/api
Fastify server (src/server)            composition root #2 next to src/cli
   |-- reuses: cli/pipeline executeRun, db repos/writers, providers/ingest, skills runner
   |-- src/valuation (pure): KPIs, quality screen, intrinsic value
   |-- research runner: quality-screen locally; six AI skills through `claude -p`
   `-- PostgreSQL 16 on :5433 (existing database, three new tables)
```

Module rules (extended in biome.json and tests/structure.test.ts): `valuation` is pure like `skills`
(imports `core` and `indicators` only, no clock, no env, no fetch); `server` may import everything below it; nothing
below imports `server`; `providers` is importable by `cli` and `server` only.

Security: the API can start AI runs and writes to the database, so the server binds to 127.0.0.1 only, rejects any request whose
`Host` is not localhost or 127.0.0.1 (DNS rebinding), rejects cross-origin browser requests (`Origin` present and different),
and requires `Content-Type: application/json` on every write (so a plain HTML form post cannot trigger one). The database
URL and password never leave the server.

## New data (migration 0004)

- `valuation_overrides(instrument_id pk, data jsonb, updated_at)`: per-stock overrides of growth, target P/E, DCF growth, required return.
- `fair_values(id, instrument_id, as_of, value, source, moat, uncertainty, imported_at)`: Morningstar fair values imported from the
  Invest-agent CSV (no scraping of Morningstar from this app).
- `research_runs(id, instrument_id, skill_id, status, created_at, started_at, finished_at, step_index, progress jsonb,
  cost_usd, model, error, report_path, result jsonb)`: one row per skill run; reports are files under `reports/`.

## Intrinsic value (docs/01 style definitions, proposed defaults, all overridable per stock)

Per share, in the trading currency (statement currency converted with the stored FX rate).
- Three-scenario (from Invest-agent `financial_rigor.py three-scenario`): EPS grown for 3 years at bull/base/bear growth, times a
  target P/E, plus the 3 years of dividends, all discounted at the required return (default 8%).
- Owner-earnings DCF: FCF per share, 5 years at the DCF growth then fading linearly to 3% by year 10, terminal value at 3%.
  Skipped for banks and insurers (`solvency_model = financial`).
- Reverse DCF: the 5-year growth the current price implies, compared with the history.
- Fair value: latest imported Morningstar value (US names only).
- Intrinsic value = median of the available methods; range = min and max of methods and the bear/bull scenarios.
- Stars (Buffett checklist gate 5): price/IV <= 0.5 five, <= 0.7 four, <= 1.0 three, <= 1.2 two, else one.
- Defaults from data (need >= 2 annual statements, else the method is skipped and a warning says why): base growth = EPS CAGR clamped to
  0 to 12%, bull = base + 4 points, bear = base - 5 points floored at -5%; target P/E base = median of the stock's own year-end P/E
  clamped 8 to 30 (current P/E if fewer than 3 years), bull x1.15, bear x0.80; DCF growth = FCF CAGR clamped -2 to 10%.

## KPIs and quality screen

KPI rows (25) from stored annual statements plus the last close: profitability (ROE 5y and 10y, ROIC, gross, operating, net margin),
cash quality (FCF yield, OCF/NI, capex/revenue), safety (interest cover, net debt/EBITDA, debt/NI, Altman Z, Piotroski F),
growth (revenue and EPS CAGR, dilution), valuation (P/E with percentile of the stock's own history, P/B, P/FCF, dividend yield),
shareholder (payout, buyback yield). Free data holds about 4 annual statements: rows that the rule wants over more years carry a
window tag such as "4y of 10y". Quality screen = the 7 filters and 3 exemptions of the Invest-agent `quality-screen` skill, exactly.

## Research runner

Seven skills (the user's list): quality-screen (local), investment-checklist, investment-research, earnings-review,
management-deep-dive, news-pulse, thesis-tracker. The six AI skills read their prompt from the Invest-agent repo
(`INVEST_AGENT_ROOT`, no default: `<INVEST_AGENT_ROOT>/skills/<id>.md`), substitute `$ARGUMENTS`, rewrite `~/ai-berkshire` and `python3`
to the configured tool root and interpreter, forbid file writes (the report comes back as the final message and the server saves it
under `reports/<market>-<symbol>/`), and run `claude -p` with `--output-format stream-json`, a read-only tool allow-list, a dollar
budget cap and no session persistence. Executors: `claude-cli` (default when the CLI is found), `fake` (tests), `none`.

## Tasks

- [x] T1 Foundations: dependencies, module rules, scripts, this doc, DECISIONS.md
- [x] T2 Migration 0004 and repos (watchlist update, valuation overrides, fair values, research runs)
- [x] T3 `src/valuation`: KPIs, quality screen, intrinsic value, with tests (hand-computed, properties, purity)
- [x] T4 Server core: app factory, security hooks, error mapping, static files, `pnpm app`
- [x] T5 API: overview, scan, stock explain/chart/value, watchlist, positions, journal, settings, data, ingest, chains, events, fair values
- [x] T6 Research runner and API: catalog, runs, reports, executors, cancellation
- [x] T7 Web UI, Layout A (React, Vite): all six pages, keyboard navigation, light and dark
- [x] T8 Tests: unit, API end-to-end against a throwaway database with replayed HTTP, UI tests, browser end-to-end
- [x] T9 Packaging and docs: README "Run the app", Windows shortcut, PWA manifest, BUILD-LOG, fresh-clone acceptance

## Out of scope (deliberately)

Daily marks of open puts and alerts that need option quotes (Phase 3), backtests (Phase 4), broker adapters, editing strategy
parameters in the UI (shown read-only; edit via SQL until a versioned editor is built), cross-market merged ranking (TODOS.md).

## Build status log (updated as the autonomous build proceeds)

- 2026-10-11 T1 done (commit a8737b7). T2 done: migration 0004 applied to the real database (:5433), `src/db/app-repos.ts`, `src/db/position-ops.ts` (CLI positions add/close now use it).
- T3 `src/valuation` and T7 `web/` were handed to two parallel agents (disjoint directories); results are integrated and verified by the main author, not trusted blind.
- T4/T5 in progress by the main author: `src/server/{deps,errors,security,views}.ts`, `src/server/services/*` written (scan, watch, positions, data, value, stock); still to write: settings/overview services, research runner (T6), routes, app factory, `src/server/index.ts`, `scripts/run-app.mjs`.
- Test plan for T8: `tests/server/*.test.ts` (in-process Fastify against a throwaway database with replayed Yahoo HTTP and the fake skill executor), added to `pnpm test:e2e`; then a real-browser pass against a live instance (Chrome DevTools tools), recorded in BUILD-LOG.md.
- 2026-10-11 T4-T9 done. Server, runner, UI and docs integrated; all suites green (1197 unit/integration, 59 e2e in 8 files, 82 web); real-browser pass against a live server with live Yahoo data and one real AI run recorded in BUILD-LOG.md (milestone 2). The live pass found and fixed four defects (rounding in assumption inputs, UI rebuilds 404 until restart, float32 noise counted as restated bars, zero-size ticket). Follow-ups are in TODOS.md.
