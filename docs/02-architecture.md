# 02 — Architecture

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

## 1. Shape of the system

Single Node.js process in v1 (API + scheduler + workers), split later if needed. PostgreSQL is the only
stateful dependency. pg-boss runs scheduled jobs inside Postgres, so no Redis.

```
+---------------------------------------------------------------------+
|  apps/web (React + Vite, phase 2)                                    |
|  watchlist · shortlist · justification · backtests · positions       |
+-------------------------------^-------------------------------------+
                                | REST/JSON (Fastify, zod-validated, OpenAPI generated)
+-------------------------------+-------------------------------------+
|  apps/api                                                            |
|   routes/  watchlist · scan · recommendations · backtests ·          |
|            positions · params · providers                            |
|   jobs/    (pg-boss) ingest-prices · ingest-fundamentals ·           |
|            snapshot-chains · daily-scan · mark-positions ·           |
|            run-backtest · calendar-refresh                           |
+-------------------------------+-------------------------------------+
                                | imports
+-------------------------------+-------------------------------------+
|  src/core        domain types, HK/US calendars, contract specs       |
|  src/skills      AnalysisSkill plugins + registry + runner           |
|  src/indicators  TA, vol estimators, Black-Scholes, greeks           |
|  src/providers   MarketDataProvider implementations                  |
|  src/backtest    engine, synthetic option pricer, metrics (Phase 4)  |
|  src/db          drizzle schema (source of truth), migrations, repos |
|  src/cli         commands (milestone 1 surface)                      |
+---------------------------------------------------------------------+
```

**Single package** (eng review 2026-10-10). The folders above are module boundaries enforced by import rules
(biome `noRestrictedImports`: `skills` may import `core` and `indicators`, never `providers` or `cli`). They become
pnpm workspaces only when Phase 3 (API process) or Phase 6 (web) needs a separately built artifact. Strict
TypeScript, ESM, zod at every boundary, vitest, biome for lint and format.

## 2. The skill plugin contract (the core idea)

```ts
// src/skills/contract.ts
export interface SkillContext {
  instrument: Instrument;           // id, symbol, market, multiplier (board lot), sector, solvencyModel, reportingFrequency
  asOf: ISODate;                     // the scan date; skills NEVER read the clock
  params: Record<string, unknown>;   // strategy params resolved for this run
  data: DataAccess;                  // point-in-time, asOf-bounded accessors
  log: (msg: string, meta?: object) => void;
}

export interface DataAccess {
  bars(lookbackDays: number): Promise<DailyBar[]>;          // bars with date <= asOf
  fundamentals(): Promise<PointInTimeFundamentals>;         // only filings with reported_at <= asOf
  chain(): Promise<OptionChainSnapshot | null>;             // latest snapshot_date <= asOf, or null
  ivHistory(days: number): Promise<IvPoint[]>;
  calendar(): Promise<EventCalendar>;                       // events with known_at <= asOf
  market(): Promise<MarketRegimeSnapshot>;                  // index and vol-index state as of asOf
  priorSkillResult<T>(skillId: string): T | undefined;      // upstream results in this run
}

export interface Reason {
  rule: string; value: number | string | boolean; threshold?: string;
  passed: boolean; weight?: number; note?: string;
}

export interface SkillResult<TPayload = unknown> {
  skillId: string; version: string;
  score: number | null;              // 0-100, or null for non-scoring skills
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'NA';
  reasons: Reason[];                 // machine-readable justification rows
  payload: TPayload;                 // skill-specific output (support level, chosen contract, ...)
  dataQuality: { tier: 'real' | 'proxy' | 'synthetic'; missing: string[] };
}

export interface AnalysisSkill<P = unknown> {
  id: string;                        // e.g. 'fundamental.gate'
  version: string;                   // semver; stored with every result; bump when logic changes
  dependsOn: string[];               // upstream skill ids
  paramSchema: ZodSchema;            // own parameters with defaults
  run(ctx: SkillContext): Promise<SkillResult<P>>;
}
```

Rules that keep backtests honest (eng review 2026-10-10 folded in):
- Skills are deterministic for (instrument, asOf, params, data). Results are cached in `skill_runs`, keyed by
  (instrument, asOf, skillId, version, paramsHash). **Cache invalidation is the writer's job:** every function that
  writes bars, fundamentals, corporate events, FX or option quotes for an instrument calls
  `invalidateSkillRuns(instrumentId, fromDate)`, which deletes cached rows with `as_of >= fromDate`. A test asserts
  every writer calls it. Adjusted closes restate all history on each dividend, so `fromDate` is the earliest bar
  that changed, not today.
- `DataAccess` is the only way to get data, and it is constructed with `asOf` baked in. It is **built once per
  (run, instrument)** with the instrument's full history in memory; `bars(lookback)` slices at `asOf`. S2 publishes
  its indicator series into a run-scoped memo that S3 and S4 read, so indicators are computed once per
  (instrument, asOf). Skills stay pure; only the factory holds the cache.
- The **pipeline runner** topologically sorts skills by `dependsOn` and takes a `mode`:
  `scan` short-circuits on FAIL from the gate (speed); `full` runs every skill regardless and records verdicts
  without ranking. `explain`, `journal calibrate` and the attribution report use `full`, so names that fail the
  gate today still get technical, volatility and option scores and losing trades are never dropped from attribution.
- **Freshness gate** (runs before S0), with a window per input source: bars and FX must be dated the last trading
  day of that market; a chain snapshot from an automated source (yahoo, futu, ibkr) likewise; a **pasted CSV chain
  may be up to `chainMaxAgeDays` old (default 3)** so HK does not need a paste per name per day; the vol index is
  exempt whenever `regime.noVolIndex` is in effect (the proxy is already labelled). A stale input drops the name
  with Reason `data.stale` naming the input and its date, and the scan header lists every drop. `--allow-stale`
  ranks them anyway with a `STALE` tag. The scanner never fetches, so this is the only place a failed overnight
  ingest becomes visible before you act.
- **Two-pass HK workflow.** HK names with no fresh chain are scored on synthetic pricing and listed in a
  "paste chains for these" block at the end of the scan output, ordered by composite, capped at `pasteTopN`
  (default 5). You paste those few, re-run `scan`, and only the names you might actually trade carry real quotes.
- **Never cache S5, S6, S7.** They depend on portfolio state (open positions, equity, sector exposure) that
  `positions add` and `settings set` change without touching market data. They are cheap; recompute every run.

v1 skill set (specified in `04-skills-spec.md`):
`market.regime` → `fundamental.gate` → `technical.timing` → `volatility.edge` → `option.select` → `rank.composite` → `size.position` → `explain.narrative`.

## 3. Data providers

```ts
export interface MarketDataProvider {
  id: 'yahoo' | 'ibkr' | 'futu' | 'hkex-file' | 'fmp' | 'csv' | 'journal';
  supports(market: 'US' | 'HK', cap: 'bars' | 'fundamentals' | 'chain' | 'iv' | 'calendar'): boolean;
  bars(symbol: string, from: ISODate, to: ISODate): Promise<DailyBar[]>;
  fundamentals(symbol: string): Promise<FundamentalStatement[]>;  // each with period_end and reported_at
  chain(symbol: string, asOf?: ISODate): Promise<OptionChainSnapshot>;
  calendar(symbol: string): Promise<EventCalendar>;
}
```

Routing table (configurable per market and capability, with fallback order):

| Capability | US | HK |
|---|---|---|
| Daily bars | yahoo (free) → **stooq** (free CSV, no auth, milestone 1 fallback) → ibkr | **futu OpenD** (built 2026-10-13: raw OHLCV plus forward-adjusted close, 10 years, source `futu`) → yahoo (`0700.HK`) → stooq (`0700.hk`) → ibkr |
| Fundamentals, point-in-time | yahoo quoteSummary + FMP/EODHD for filing dates | futu / EODHD; HKEXnews filings for `reported_at` |
| Option chain, greeks, IV | yahoo (free, delayed) → ibkr (needs TWS or IB Gateway) | **futu OpenD** (milestone 1; user has a moomoo account; puts out to `max(75, dteMax[HK])` days) → csv paste (fallback when OpenD is down) → ibkr |
| Option fills (real tier) | journal CSV import | journal CSV import |
| FX rates (HKD/USD to base currency) | yahoo `HKD=X` daily close, 10-year backfill | same |
| Index and vol index | yahoo SPY, ^VIX | yahoo 2800.HK, ^HSI; VHSI symbol verified in Phase 1, else HKEX CSV seed |
| IV history | our own daily snapshots; ibkr `OPTION_IMPLIED_VOLATILITY` history for backfill | our own daily snapshots, **backfilled from futu OpenD's underlying IV series** (built 2026-10-13, ~400 days, never overwrites an app row); fallback VHSI-scaled proxy |
| Calendar | yahoo earnings dates; static exchange holiday table | futu / HKEX calendar; static HKEX holiday table |
| Static facts (name, stock board lot, delisting) | yahoo profile | yahoo profile, cross-checked against futu OpenD static info (`pnpm cli futu status`) |

Provider adapters normalise symbols (`700` → `0700.HK` for Yahoo, `HK.00700` for Futu, `700` on `SEHK` for IBKR)
and contract multipliers. The HK multiplier is the option contract size from `data/hk-board-lots.csv`; OpenD's stock
board lot is reported next to it but never written over it (nine of the fourteen listed names differ).

The OpenD source (`src/providers/futu/`) is read-only quote data over the official `futu-api` WebSocket SDK: option
expirations, chain, snapshots, static info, daily history K-lines (two requests per name, raw and forward-adjusted),
the underlying's IV/HV history and the gateway state. Each call type is throttled below OpenD's 30-second limit, and
history K-lines count one security per 30-day quota window (1,000 per login), which is why only the watchlist uses it.
Without `FUTU_PORT` the source is absent and ingest runs exactly as before.

The **csv chain provider** reads a fixed-column file (`expiry,strike,right,bid,ask,last,volume,oi[,iv][,delta]`);
underlying price and snapshot date come from the `--spot` and `--date` flags. It validates shape with zod, then
applies **semantic rules** and either rejects the whole file with a line-numbered report or stores a real-tier
snapshot with source `csv`:

| Rule | Action |
|---|---|
| bid > ask | reject, `chain.crossed` |
| duplicate (expiry, strike, right) | reject, `chain.duplicate` |
| expiry is not an expiry day on that market's calendar | reject, `chain.badExpiry` |
| strike outside 40–160% of `--spot` | reject, `chain.strikeRange` |
| negative or non-numeric price, volume, oi | reject, `chain.badNumber` |
| bid = 0 or oi = 0 | keep, warn `chain.illiquid` (S4 liquidity rules decide) |
| iv missing | keep, imply from mid; delta missing → compute (04 S4) |

The **journal provider** imports your historical fills (see `01-methodology.md` §G2) and is run once at setup and
whenever you add trades. Its semantic rules: `rolled_to_row` must resolve; expiry must be an expiry day; a fill
price outside 0.5–2x the stored or synthetic price for that contract and day is kept but flagged `journal.priceOutlier`
and excluded from calibration; P&L totals are printed per market for you to check against your broker statement.

**Filing dates.** Yahoo rarely supplies `reported_at`. The estimate is market-specific: US quarterly
period_end + 45 days, US annual + 60; HK interim + 60, HK annual + 90. From go-live, ingest records `first_seen_at`
for every statement and `reported_at = min(estimate, first_seen_at)`, flagged `reported_at_estimated` until a real
filing date is known. Pre-go-live history keeps the estimate.
This is the milestone-1 path for HK: one paste per watchlist name per scan day, about a minute of your time, and
every row becomes permanent backtest data.

The **journal provider** imports your historical fills (see `01-methodology.md` §G2) and is run once at setup and
whenever you add trades.

## 4. Jobs (Phase 3, built; pg-boss schedules; all idempotent; each records a `job_runs` row)

Implemented in `src/jobs/` (`jobs.ts` the job bodies, `scheduler.ts` the schedule and pg-boss wiring, `notifier.ts` alert push). `jobs` is an
application layer like `cli` and `server`: it may import providers; nothing below it may import it. Schedule and time zones: `pnpm cli jobs list`.

In milestone 1 there is no queue: `pnpm cli ingest --all` under Windows Task Scheduler does the first four rows
of this table, and `scan` is run by hand. The diagram in §1 shows the Phase 3 shape.

| Job | Schedule | Notes |
|---|---|---|
| `ingest-prices` | US 17:30 ET, HK 17:30 HKT | incremental since last bar |
| `ingest-fundamentals` | weekly, plus earnings date + 2 days | upserts statements, sets `reported_at` |
| `snapshot-chains` | 15 min before each close and at close | one snapshot per day per underlying is the backtest unit |
| `calendar-refresh` | daily | earnings, ex-dividend, holidays |
| `fx-refresh` | daily | USDHKD close into `fx_rates` |
| `daily-scan` | after ingest and snapshot | runs the pipeline for every watchlist item, writes `recommendations` |
| `mark-positions` | after snapshot | P&L and alerts (50%, 21 DTE, stop, assignment risk) |
| `run-backtest` | on demand | long-running, progress in `backtest_runs.progress` |

## 5. API surface (v1)

```
GET  /watchlist                          POST /watchlist {symbol, market, notes}      DELETE /watchlist/:id
POST /scan/run?asOf=                     GET  /scan/latest                            GET  /scan/:runId
GET  /recommendations?date=&market=      GET  /recommendations/:id   (reasons, contract, backtest card)
GET  /instruments/:id/analysis?asOf=     (every skill result for one stock on one date: the deep-dive page)
POST /backtests {paramsOverride, symbols?, from, to, tierPolicy}   GET /backtests/:id   GET /backtests/:id/trades
GET  /positions   POST /positions (manual fill)   PATCH /positions/:id (close / roll / assign)
GET  /params      PUT  /params  (versioned; each scan records the param version used)
GET  /providers/health
```

## 6. UI pages (phase 2; API-first means you can use it with curl or Postman in phase 1)

1. **Today's shortlist**: stock, contract, DTE, delta, credit, annualised ROC, cushion, composite, confidence, data tier.
   A row expands to the reasons table, the narrative and the backtest card.
2. **Stock deep dive**: chart with SMA50/200, support line and chosen strike; fundamentals scorecard; IV rank chart; event calendar.
3. **Backtests**: run form (params grid); results: equity curve versus buy-and-hold and the index put-write proxy, trade list, per-rule attribution.
4. **Positions**: open puts with alerts; wheel tracker.
5. **Settings**: params with a "what changed" diff, providers, watchlist CSV import.

## 6a. CLI (milestone 1 surface, before any UI)

```
pnpm cli settings set equity 2000000 --base HKD  # required once before the first scan
pnpm cli watchlist add 0700 HK --lot 100 --solvency altman --reporting semiannual
pnpm cli journal import ./my-trades.csv          # generic template, see 01 §G2
pnpm cli chain import 0700 HK ./0700-chain.csv --spot 545.2 --date 2026-10-10   # flags are authoritative
pnpm cli events add 0700 earnings 2026-11-12
pnpm cli ingest --all                            # the only command that fetches from providers; scheduled by Task Scheduler
pnpm cli scan [--as-of 2026-10-10] [--json]     # reads the database only; prints the shortlist, then reasons per row
pnpm cli explain 0700 [--as-of ...]              # every skill result for one name
pnpm cli journal calibrate                       # real vs synthetic prices on your fills and pasted chains
pnpm cli positions add|mark                      # record a fill; alerts for open positions (mark is Phase 3)
```
Milestone 1 has no HTTP server and no job queue. Fastify and pg-boss (sections 1, 4, 5) are Phase 3.

## 7. Config and secrets

`.env`: `DATABASE_URL`, `BASE_CURRENCY` (HKD or USD), `IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`, `FUTU_HOST`,
`FUTU_PORT`, `FMP_API_KEY`. Broker gateways (TWS or IB Gateway, moomoo OpenD) run as separate local processes;
the app only reads from them.

Host: Windows Server 2025. Docker Desktop is not assumed. PostgreSQL 16 is installed natively (EDB installer) or
an existing instance is reused; the app connects over `DATABASE_URL` either way.

## 8. Testing strategy

- Indicators: golden fixtures generated once by `tests/fixtures/gen/` (a Python script using TA-Lib on a committed 500-bar series) for SMA, EMA, RSI, ATR, MACD, Bollinger, ADX, and committed as CSV; Black-Scholes against Hull's published table plus put-call parity; implied vol round-trips price → iv → price; Barone-Adesi–Whaley ≥ Black-Scholes and converges; Yang-Zhang against a reference implementation.
- Importers: one test per semantic rule in §3 (reject vs warn), journal P&L fixture covering closed, expired, assigned, rolled and partial rows.
- Runner: scan vs full mode; cache hit by params hash; invalidation called by every writer; freshness gate drop, allow-stale tag, equity-unset refusal.
- Skills: snapshot tests with fixture data (one HK and one US stock across 3 regimes); a property test that `asOf` bounds hold (a fixture with a future-dated filing must not change the result).
- Backtest: a deterministic fixture run with hand-computed expected P&L for 5 trades; a lookahead detector that perturbs future data and asserts results are unchanged.
- Providers: contract tests with recorded HTTP fixtures; no live calls in CI.
