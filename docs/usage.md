# Usage guide: install, command line, web app, jobs, backtests

> Moved here from the old `README.md` on 2026-10-19. It was written for milestones 1 to 4 (last edited 2026-10-14), so it does
> not cover the Leaders, News, Journal, Home and Ask pages; the root [README](../README.md) lists them. Where this guide and
> the code disagree, the code wins. The server port is **3004** (`OT_PORT`); this guide used to say 4317 by mistake. The six
> prompt-driven research skills need a clone of [ai-berkshire](https://github.com/xbtlin/ai-berkshire): set `INVEST_AGENT_ROOT`
> to it.


A personal decision-support CLI for selling puts on a HK + US watchlist. Every morning it prints a ranked, justified
shortlist: each row carries a reasons table you can argue with and a data tier (real, proxy or synthetic). Your own trade
history is imported as ground truth for calibration. **The app never places orders and never calls a broker's trading API.**

Node.js + TypeScript (strict, ESM) + PostgreSQL 16, single package `src/{core,indicators,providers,skills,db,cli}`.
Design: `docs/00-overview.md` first, then `docs/designs/sell-put-scanner.md`. Build record: `BUILD-LOG.md`, `DECISIONS.md`,
`TODOS.md`.

## Run it

1. **Install PostgreSQL 16** (native, no Docker). On Windows: `winget install PostgreSQL.PostgreSQL.16` (the installer asks
   for a superuser password and a port; remember both). Create the database:
   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "create database option_trading"
   ```
2. **Install dependencies** (Node 22 or newer, pnpm 10): `pnpm install`
3. **Set `.env`**: copy `.env.example` to `.env` and fill in `DATABASE_URL` and `PG_ADMIN_URL` (the admin URL is only used by
   the tests to create throwaway databases). `.env` is git-ignored; never commit it.
4. **Migrate**: `pnpm db:migrate` (creates every table, seeds the `default` strategy params and the single portfolio row,
   loads the exchange calendars 2010-2027 and the index instruments); `pnpm db:check` verifies it.
5. **Set your equity** (required once; `scan` refuses without it):
   `pnpm cli settings set equity 2000000 --base HKD`
6. **Add your watchlist**: `pnpm cli watchlist add AAPL US` and `pnpm cli watchlist add 0700 HK`. HK board lots come from
   `data/hk-board-lots.csv` (you maintain it; `--lot N` overrides). Set `--solvency altman|property|financial|reit` for names
   where the default would mislead (banks and insurers: `financial`; developers and landlords: `property`; REITs: `reit`),
   otherwise it is inferred from Yahoo's sector at the first ingest.
7. **Import your trade journal** (optional but recommended): `pnpm cli journal import ./my-trades.csv`
   ```
   open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row
   ```
   plus optional `spot` (underlying price at the fill, enables calibration), `underlying_close` (assignment day close),
   `closed_contracts` (partial close) and `notes`. `outcome` is `closed|expired|assigned|rolled|open`; fees are totals per row;
   an assigned row books `credit - intrinsic loss at assignment`. See `docs/01-methodology.md` G2 and
   `tests/fixtures/e2e/journal.csv` for a worked example. A file with any rule violation is rejected with line numbers and
   nothing is stored; the importer prints realised P&L per market so you can compare it with your broker statement. Open rows
   block new recommendations on that name until `pnpm cli positions close <id> ...`.
8. **Fetch data**: `pnpm cli ingest --all` (the only command that touches the network: Yahoo prices, fundamentals, US chains,
   earnings dates, FX). Schedule it with `scripts/register-ingest-task.ps1` (review it first; the build does not run it).
   With moomoo OpenD running and logged in (`FUTU_PORT` in `.env`), HK names also get their daily bars, put chains and
   IV history from OpenD; `pnpm cli futu status` checks the gateway and lists the HK watchlist as OpenD knows it.
9. **Scan**: `pnpm cli scan` (database only, never fetches; `--as-of YYYY-MM-DD`, `--json`, `--allow-stale`). One table per
   market, reasons per row, FAILs with their binding rule, and a "paste chains for these" block for HK names without a fresh
   chain. Then `pnpm cli explain 0700` for every skill result on one name, including names that FAIL the gate.
10. **HK chains**: paste your broker's option chain into a CSV
    (`expiry,strike,right,bid,ask,last,volume,oi[,iv][,delta]`) and run
    `pnpm cli chain import 0700 HK ./0700-chain.csv --spot 545.2 --date 2026-10-10`. Crossed quotes, duplicates, non-expiry
    days, strikes outside 40-160% of spot and bad numbers reject the file with line numbers; `bid = 0` / `oi = 0` rows are
    kept with `chain.illiquid` warnings. A paste is usable by `scan` for 3 days (`runner.chainMaxAgeDays`).
11. **Calibrate**: `pnpm cli journal calibrate` prices your pasted chains (primary, unbiased) and journal fills with a `spot`
    (sanity) with the synthetic pricer and prints real/synthetic per market and delta bucket; with fewer than 10 chain samples
    a market prints `uncalibrated` and synthetic prices keep the default haircuts. `pnpm cli journal attribution` re-scores each
    past trade as of its entry date and compares winners with losers per rule (small samples: a hint, not a result).

Other commands: `pnpm cli settings show`, `watchlist list|remove`, `events add 0700 earnings 2026-11-12`,
`positions add|close|list`, `report coverage` (which fundamentals the free data actually supplies), `pnpm cli --help`.

## The web app (milestone 2)

The same scanner, as a local app you open in the browser. Everything runs on your machine; nothing is hosted.

```powershell
pnpm install
pnpm db:migrate        # adds the three app tables (valuation_overrides, fair_values, research_runs) to your existing database
pnpm app               # builds the UI the first time, starts the server, opens http://127.0.0.1:3004
```

Use it as a desktop app: in Edge or Chrome open the address, then menu, "Install Option Trading" (a standalone window with its own icon).
Windows shortcut: point a shortcut at `scripts\Start-OptionTrading.cmd`. `pnpm app --no-open` starts without opening a browser.

Screens (left rail): **Today** (ranked ideas per market, reasons, chart, value and KPIs), **Research** (pick one stock: intrinsic value with a
required-return slider and editable assumptions, 25 KPIs, the 7-filter quality screen, and seven analysis skills), **Watchlist** (one table row per
watched stock: price and day change, trend and distance to support, IV rank, ROE, FCF yield, P/E, price against intrinsic value, next results date,
a highlight line and today's recommendation: Sell put, Wait, Avoid, Hold or Needs data; filter, search and sort it; click a stock for its lot,
solvency model, conviction, max collateral and notes; add and validate symbols with the same rules as the command line, pause or resume;
only watched stocks are fetched, scanned and researched), **Positions** (log a fill, close it, journal import, alerts that can be computed from
stored data), **Data** (ingest with a live log, per-stock data status, paste an HK chain, import Morningstar fair values), **Settings**
(equity, base currency, read-only strategy parameters, environment checks). The app never places orders.

Intrinsic value is a range, not a number: the median of a three-scenario method, an owner-earnings DCF (not for banks and insurers) and an
imported Morningstar fair value (optional, US names), with every assumption shown as data, default or override. KPIs and the quality screen
come from the stored statements; free data holds about four annual statements, so rows that want ten years carry a "4y of 10y" tag.

**AI skills.** Six of the seven research skills (checklist, four-masters research, earnings read, management, news pulse, thesis tracker) are the
prompts in your clone of the ai-berkshire repository, run through the `claude` command line (`claude -p`) with read-only tools (web search, web fetch, read),
no file writes, your global hooks switched off, and a spending cap per run. The report is saved under `reports/<market>-<symbol>/`. The quality
screen runs locally from your numbers. Set these in `.env` when the defaults are wrong:

| Variable | Default | Meaning |
|---|---|---|
| `INVEST_AGENT_ROOT` | none: set it to your clone of ai-berkshire | repository that holds `skills/*.md` and `tools/` |
| `OT_CLAUDE_CLI` | found on PATH | the `claude.exe` to run |
| `OT_PYTHON` | `%LOCALAPPDATA%\Python\bin\python.exe`, then PATH (the Microsoft Store stub is ignored) | interpreter for the skills' exact-decimal checks |
| `OT_SKILL_MAX_BUDGET_USD` | `5` | spending cap per AI run |
| `OT_SKILL_MODEL` | the CLI default | model alias for AI runs |
| `OT_SKILL_EXECUTOR` | `auto` | `none` disables AI runs, `fake` is for demos and tests |
| `OT_PORT` | `3004` | server port (always bound to 127.0.0.1) |

Security: the server listens on 127.0.0.1 only, rejects any request whose `Host` is not localhost (or the host of `APP_URL`, see below),
rejects cross-origin browser requests, requires `Content-Type: application/json` on every write, and requires a signed-in session for every data
endpoint. The database password never leaves the server.

### Signing in

The app opens on a login page with three ways in: **username and password**, **Google**, and an **email link** (a one-time link, valid 15 minutes).
Run `pnpm db:migrate` once after updating (it adds `app_users`, `app_sessions` and `login_links`; the server refuses to start until it has run).

- **First run:** the page offers "Create your account" (username, email, password) and asks for a **setup code**, which the server prints in its
  terminal when it starts with no account (`First-run setup: ... enter the setup code ABCD-EFGH`). It only works in a browser on the machine that
  runs the server, never through a public address or a tunnel, and only with that code. After that nothing creates another account: Google and
  email links sign in to the existing one by its email address.
- **Google:** create an OAuth client of type "Web application" in Google Cloud Console, add the redirect URIs
  `http://127.0.0.1:3004/api/auth/google/callback` and (if you use one) `<APP_URL>/api/auth/google/callback`, and set `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` in `.env`. Until then the Google button is shown disabled.
- **Email link:** set `OT_SMTP_URL` (and `OT_MAIL_FROM`) to any SMTP server. Without it the link is printed in the terminal where the server runs,
  and the login page says so.
- **A public address:** set `APP_URL=https://your.domain` and point a tunnel or reverse proxy at `127.0.0.1:3004`. That host is then the one
  non-loopback `Host` the server answers on, session cookies get the `Secure` flag on it, and emailed links and the Google redirect use it. Make
  the proxy add `X-Forwarded-For` (most do; stock nginx needs `proxy_set_header X-Forwarded-For $remote_addr;`): rate limits are shared out per
  caller with it. Create the first account before you expose the address.
- **No login at all:** `OT_AUTH=off` (only for a machine nobody else can reach; `APP_URL` is then ignored).

| Variable | Meaning |
|---|---|
| `APP_URL` | public address of the app, e.g. `https://app.example.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | turn the Google button on |
| `OT_SMTP_URL`, `OT_MAIL_FROM` | send email links, e.g. `smtps://user:password@smtp.example.com:465` |
| `OT_AUTH` | `off` removes the login requirement |

The login is a gate, not multi-user: the watchlist, positions and settings are one shared portfolio. Sessions last 30 days; passwords are hashed
with scrypt; session and link tokens are stored only as SHA-256 hashes. Ten wrong passwords from one caller for one name block that caller for 15
minutes (and 50 for one name from anywhere, 30 from one caller for any name), so a stranger cannot lock you out from your own address.
Without a session `/api/health` answers only `{ "ok": true }`.

Developing the UI: `pnpm app:server` in one terminal and `pnpm web:dev` in another (Vite on :5173 proxies `/api`), or
`pnpm exec tsx web/mock/server.ts` for a stateful mock API with no database.

## Marks, alerts, the wheel and scheduled jobs (Phase 3)

```powershell
pnpm db:migrate                  # adds stock_lots and backtest_runs.request (migrations 0006, 0007); the server refuses to start without them
pnpm cli positions mark          # price every open put (a stored quote, else the model), store the marks, print P&L and alerts
pnpm cli lots list               # shares you received when a put was assigned; `lots sell <id> --price P` records the sale
pnpm cli jobs list               # the schedule; `jobs run <name>` runs one job now
```

- **Marks** are one row per put per day (`position_marks`). A stored chain quote for the exact contract is used when it is at most
  5 days old (tier `real`); otherwise the model prices it (Barone-Adesi-Whaley on the stored 30-day IV, else realised vol times the
  market's IV/RV ratio; tier `synthetic`). The Positions page shows the latest mark, its date and P&L, and **Mark now** runs the job.
- **Alerts** (one rule set, `src/core/alerts.ts`): 50% of the credit captured, 21 DTE, loss reaching 2x the credit, assignment risk
  (in the money with under 1% of the strike left as time value), in the money, within 5% of the strike, earnings before expiry, and an
  earnings date announced after you sold the put. Rules that need a price are skipped when there is no mark.
- **The wheel**: recording a put as assigned opens a stock lot at the assignment close (the put's own P&L already booked the move to
  that price, so the shares start there). The lot also shows the *effective cost* (strike less premium) to compare a covered-call
  strike with. The app records the sale you made in your broker; it never sells anything.
- **Scheduled jobs** (docs/02 section 4) run inside the server with `OT_JOBS=on` (pg-boss keeps its queue in a `pgboss` schema of the
  same database; nothing is created until you turn it on): `ingest-us/hk` 17:30, `snapshot-chains-us/hk` 15:45, `mark-positions` 18:15,
  `daily-scan` 18:30 New York time, weekly fundamentals and daily events, each in its market's own time zone. Every run writes a
  `job_runs` row. New alerts can be pushed to **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) or **email** (`OT_SMTP_URL`,
  `OT_ALERT_EMAIL`); only alerts that were not in the previous mark are sent, and nothing is sent unless a channel is configured.

## Backtests (Phase 4)

```powershell
pnpm cli backtest run --from 2019-01-02 --to 2025-12-31 --tier synthetic_only --capital 1000000
pnpm cli backtest run --from 2016-01-04 --to 2025-12-31 --observe --walk-forward 36,12 --set option.select.deltaMax=0.25
pnpm cli backtest list | show <id> | trades <id> > trades.csv
pnpm cli backtest studies AAPL   # what each entry rule has historically been followed by (docs/05 section 5)
pnpm cli backtest validate       # reproduce the docs/05 section 6 checks on stored SPY history
```

The engine replays the **live pipeline** as of each day (the skills only ever see data up to that day), opens the shortlist's puts at
the close with full notional locked as collateral, and exits on the 2x stop, the 50% target or 21 DTE, filled at the **next** close.
It reports trade and portfolio metrics, a bootstrap confidence interval on the win rate, three benchmarks (the naive "every name, 30
delta, 45 days" strategy with the same pricing and exits, buy and hold, the index), a pricing-error check (model volatility plus and
minus 20%: it says when the sign of the result flips), per-rule attribution (`--observe`) and walk-forward results (out of sample
only, with an overfitting warning). The web app has a **Backtests** page for the same runs; `POST /api/backtests` starts one in the
background. Limits you should know: the exchange calendars start in 2010, so earlier dates are refused; prices without a stored chain
are model prices (the report counts them); the watchlist is "names I like today"; dividends are not in the synthetic prices.

## Develop

| | |
|---|---|
| `pnpm test` | unit and integration tests (needs PostgreSQL via `PG_ADMIN_URL`; every file clones a throwaway database) |
| `pnpm test:e2e` | eight end-to-end files (the milestone-1 scenarios and the app API, security, ingest and research runner) on recorded fixtures, one throwaway database each, ~4 min (each file in its own process; a file is retried only if the OS kills its worker, see DECISIONS.md) |
| `pnpm test:web` | UI unit tests (no database) |
| `pnpm lint` / `pnpm typecheck` | biome (including the module-boundary rules) / `tsc --noEmit` |
| `pnpm db:generate` | generate a migration after editing `src/db/schema.ts` (the schema source of truth) |

Tests never touch the network: `tests/helpers/no-network.ts` makes a stray `fetch` fail, and providers are tested against
recorded HTTP fixtures (`tests/fixtures/http/`, re-record with `pnpm tsx scripts/record-fixtures.ts`). Indicator golden
fixtures come from real TA-Lib (`tests/fixtures/gen/`, never hand-edited). Test/CI hooks for the CLI:
`OT_NOW=<ISO time>` pins the clock, `OT_HTTP_REPLAY_DIR=<dir>` replays recorded HTTP instead of calling Yahoo.

## Known limits (milestone 1)

Free data only: Yahoo gives about 4-5 annual statements (so 5-year medians and valuation z-scores are skipped as NA, never
scored as 50), no HK option chains and no HK volatility index history (HK regime then uses index versus its 200-day average,
flagged `regime.noVolIndex`); Stooq now blocks scripts, so Yahoo is the only live bar source. HK earnings dates are often
missing: add them with `events add`. See `TODOS.md` for what was deliberately left out.
