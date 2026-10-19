<div align="center">

# Option Trading

**A local-first decision-support app for selling puts on a Hong Kong + US watchlist.**<br>
Every day it ranks the puts worth selling, shows its reasons, and never places an order.

English · [简体中文](README.zh-CN.md)

</div>

![Home: the whole trading desk on one screen](docs/images/home.png)

> **Disclaimer.** This is a personal research tool. It is not investment advice and not a broker: it never connects to a
> trading API and never places, changes or cancels an order. Selling options can lose far more than the premium you collect.
> Market data comes from free, unofficial sources and can be late or wrong. You are responsible for every trade you make.
> Provided "as is" under the MIT license, with no warranty. The screenshots in this README come from the bundled mock API and
> show sample numbers, not recommendations.

## What it does

You keep a watchlist of companies you would be happy to own. Each trading day the app runs a pipeline of small, versioned
analysis skills over it and prints a ranked shortlist of cash-secured puts to sell, each one with the reasons behind it:

```
Watchlist ─▶ Fundamental gate   quality, solvency, valuation, event risk        hard PASS / FAIL
          ─▶ Market regime      SPX / HSI against the 200-day, VIX / VHSI       delta cap and deployment cap
          ─▶ Technical timing   trend, pullback, distance to support
          ─▶ Volatility edge    IV rank, implied against realised volatility
          ─▶ Option selection   expiry window, delta band, strike against support, liquidity, annualised return
          ─▶ Rank ─▶ Sizing     full notional against per-name and portfolio caps
          ─▶ Justification      a reasons table you can argue with
```

The defaults are a v1 baseline (about 30 to 45 days to expiry, delta 0.15 to 0.30, strike below support, take profit at 50% of
the credit, close at 21 days, stop at twice the credit; see [docs/00-overview.md](docs/00-overview.md) section 4) and every
parameter is configurable and backtestable.

**Design rules the code enforces**

- **Skills are pure functions over data bounded to an "as of" date and never read the clock.** The same code scores today's
  watchlist and every day of a backtest.
- **Fundamentals are point-in-time.** A run for date D only sees filings with `reported_at <= D`.
- **Every row carries evidence**: machine-readable reasons (`rule`, `value`, `threshold`, `passed`) and a data tier
  (`real`, `proxy` or `synthetic`) so you can see how much to trust it.
- **Risk is the full notional** (strike x contract multiplier), the amount you pay if assigned. Broker margin is shown as a
  second return figure and never drives sizing.
- **Hong Kong is not the US with a different suffix.** Option contract size comes from its own table
  ([data/hk-board-lots.csv](data/hk-board-lots.csv)) and often differs from the stock board lot; expiry is the business day
  before the last business day of the month; reporting is semi-annual and earnings dates are sparse.

## Screens

| Page | What it is for |
|---|---|
| **Home** | The whole desk on one screen: puts to sell, leaders at support, key news, reminders, research. A one-line glance bar on phones. |
| **Puts** | The ranked shortlist per market with the reasons table, chart, value and KPIs, and a copy-able ticket. **Ask** puts one question to the model, grounded in the scan's own numbers. |
| **Leaders** | A daily pullback-buy shortlist of twenty HK + US market leaders sitting at support, with a screening funnel. |
| **News** | Market brief and the stories that touch your shortlist and open puts, each read as Supports, Caution or Blocks against a rule. |
| **Research** | Intrinsic value as a range (three scenarios, owner-earnings DCF, optional Morningstar fair value), 25 KPIs, a 7-filter quality screen and AI research skills. |
| **Watchlist** | One row per stock: price, trend, IV rank, ROE, FCF yield, results date and today's recommendation. |
| **Positions** | Log fills by hand, daily marks, alerts (profit 50%, 21 DTE, 2x stop, assignment risk, earnings before expiry) and the wheel's stock lots. |
| **Journal** | A daily trading diary with an AI rewrite (polish, tighten, structure, lessons, translate). |
| **Backtests** | Replays the live rules over past years with benchmarks, a pricing-error check and walk-forward results. |
| **Data, Settings, Reminders** | Ingest with a live log, paste an HK chain, equity and parameters, upcoming results dates and expiries. |

A command-line interface covers the same ground (`pnpm cli --help`), and an optional in-process scheduler (pg-boss, no Redis)
runs the daily ingest, chain snapshots, position marks, scans, news and reminders.

<table>
<tr>
<td width="68%"><img src="docs/images/puts.png" alt="Puts: ranked shortlist with the reasons table"></td>
<td width="32%"><img src="docs/images/home-phone.png" alt="Home on a phone"></td>
</tr>
<tr>
<td><img src="docs/images/leaders.png" alt="Leaders: daily funnel and pullback shortlist"></td>
<td><img src="docs/images/research.png" alt="Research: intrinsic value range"></td>
</tr>
</table>

## Status

A personal project shared as it is. It is built for one user with one portfolio (the login is a gate, not multi-user), for
Hong Kong and US stocks only, and it has been developed and run on **Windows**. macOS and Linux are untested; the
Windows-specific parts are the helper scripts in `scripts/` and the default search paths for the `claude` and Python
executables. Nothing is hosted: everything runs on your machine against your own PostgreSQL database.

## Quick look without any setup

The mock API serves sample data with no database, so you can see every page in a minute (Node 22 and pnpm 10 are enough):

```bash
pnpm install
pnpm demo        # sample-data API on :4318 and the UI on http://127.0.0.1:5173 (the "Local" line says which port Vite took)
```

Ctrl+C stops both. Nothing is saved and every number is sample data.

## Install and run with real data

**Requirements:** Node.js 22 or newer, pnpm 10, PostgreSQL 16 (native; no Docker needed).

1. `pnpm install`
2. Create a database (for example `createdb option_trading`), copy `.env.example` to `.env` and set `DATABASE_URL`. Set
   `PG_ADMIN_URL` too if you will run the tests; they use it to create throwaway databases.
3. `pnpm db:migrate` creates every table, seeds the default strategy parameters and loads the exchange calendars.
4. `pnpm app` builds the UI the first time, starts the server and opens <http://127.0.0.1:3004>. On the first run the login
   page asks you to create your account with a **setup code** that the server prints in its terminal.
5. In the app: **Settings** to set your equity, **Watchlist** to add stocks, **Data** to ingest prices and fundamentals, then
   **Puts** and **Run scan**.

The same steps on the command line, and the HK chain paste, trade-journal import, marks, the wheel, the scheduler and the
backtest commands, are in the **[usage guide](docs/usage.md)**.

## Data sources and optional integrations

| Source | Used for | Required |
|---|---|---|
| Yahoo Finance through [yahoo-finance2](https://github.com/gadicc/node-yahoo-finance2) (unofficial) | prices, fundamentals, US option chains, earnings dates, FX | yes, for live data |
| moomoo / Futu **OpenD** (read-only) | HK daily bars, HK option chains up to 180 days, IV history backfill | no; paste a chain CSV instead |
| CSV import | HK chains copied from your broker screen, your past put trades | no |
| [Claude Code](https://claude.com/claude-code) CLI | AI features: research skills, Ask, News brief and classification, Leaders brief, Journal rewrite | no; `OT_SKILL_EXECUTOR=none` or no CLI turns them off |
| [ai-berkshire](https://github.com/xbtlin/ai-berkshire) prompts | the six prompt-driven research skills only; clone it and set `INVEST_AGENT_ROOT` | no |
| SMTP, Telegram, Google OAuth | email sign-in links, alert push, Google sign-in | no |

AI runs call the `claude` command line with read-only tools (or none at all) and a spending cap per run
(`OT_SKILL_MAX_BUDGET_USD`). Model output is shown and stored as labelled text; it does not feed back into the scanner's
scores, rules or numbers, because the skills only ever see stored market data.

## Architecture

One TypeScript package (strict, ESM) with enforced module boundaries, plus a React UI:

```
src/core         domain types, HK / US calendars, contract specs, alert and reminder rules, the drawdown governor
src/indicators   technical indicators, volatility estimators, Black-Scholes, implied volatility
src/skills       the analysis skills S0 to S8, their registry and the pipeline runner (pure; as-of data only)
src/valuation    intrinsic value, KPIs, quality screen
src/providers    Yahoo, Futu OpenD, CSV, news and index-universe adapters (only the CLI and jobs may import them)
src/backtest     replay engine, synthetic option pricer (Barone-Adesi-Whaley), metrics
src/leaders      put selection and view helpers for the Leaders page
src/journal      diary schema, templates, derived fields and the AI rewrite rules
src/db           Drizzle schema (the schema source of truth), migrations, repositories
src/jobs         scheduled jobs on pg-boss
src/server       Fastify API, login, research and Ask runners, services
src/cli          the command line
web/             React 19 + Vite UI (phone-first; a mock API in web/mock)
```

Boundaries are enforced twice: by Biome `noRestrictedImports` rules and by [tests/structure.test.ts](tests/structure.test.ts)
(skills import only `core` and `indicators`; they never read the clock or the environment). Start with
[docs/00-overview.md](docs/00-overview.md), then [docs/02-architecture.md](docs/02-architecture.md); the as-built notes are at the
end of each file in [docs/designs](docs/designs). The decision log is [DECISIONS.md](DECISIONS.md) and the backlog is
[TODOS.md](TODOS.md).

## Development

| Command | What it does |
|---|---|
| `pnpm test` | unit and integration tests; needs PostgreSQL through `PG_ADMIN_URL` (each file clones a throwaway database) |
| `pnpm test:web` | UI unit tests, no database |
| `pnpm test:e2e` | end-to-end scenarios on recorded fixtures, one throwaway database per file |
| `pnpm lint` / `pnpm typecheck` | Biome (including the module-boundary rules) / `tsc --noEmit` for the server and the UI |
| `pnpm db:generate` | generate a migration after editing `src/db/schema.ts` |
| `pnpm app:server` + `pnpm web:dev` | develop against the real server (Vite proxies `/api` to port 3004; set `API_TARGET` to aim it elsewhere) |
| `pnpm demo` | the UI against the sample-data mock API, no database |

Tests never touch the network: `tests/helpers/no-network.ts` makes a stray `fetch` fail, and providers are tested against recorded
HTTP fixtures. The indicator golden fixtures come from TA-Lib on a synthetic series (`tests/fixtures/gen/`) and are never edited
by hand.

## Security notes

The server listens on `127.0.0.1` only, rejects requests whose `Host` is not local, rejects cross-origin browser requests,
requires `Content-Type: application/json` on writes, and requires a signed-in session for every data endpoint. Sign-in is a
password (scrypt), Google, or a one-time email link. Do not expose it to the internet without a reverse proxy, `APP_URL` and an
account you created first; `OT_AUTH=off` is only for a machine nobody else can reach. No secret is stored in the repository
(`.env` is git-ignored; copy `.env.example`). To report a vulnerability, please use GitHub's private security advisory for this
repository instead of a public issue.

## Data and legal notes

- This project is not affiliated with or endorsed by Yahoo, moomoo / Futu, Morningstar, Hang Seng Indexes, HKEX, Wikipedia or
  Anthropic. Product names belong to their owners.
- **Yahoo Finance data.** The Yahoo endpoints are unofficial and subject to Yahoo's terms of use. The app fetches data to your own
  database, on your own machine, for your own use; do not redistribute what it fetches. `tests/fixtures/http/` holds trimmed
  recorded responses that exist only so the tests run offline; they will be removed on request.
- **Index lists.** [data/universe-us.csv](data/universe-us.csv) and [data/universe-hk.csv](data/universe-hk.csv) are compiled from
  public sources, including Wikipedia (CC BY-SA 4.0) and public Hang Seng and HKEX lists. Verify any name before relying on it.
  HK option contract sizes in `data/hk-board-lots.csv` change over time: check them with your broker or HKEX.
- **Adapted text.** `src/server/research/knowledge/` adapts ten pitfalls from
  [himself65/trade-skills](https://github.com/himself65/trade-skills) (MIT, as stated in its README); see the `LICENSE.md` in that
  folder.
- **AI prompts.** The research skills read prompts from your own clone of [ai-berkshire](https://github.com/xbtlin/ai-berkshire)
  (MIT) at run time; they are not bundled here.

## Contributing

Issues are welcome: bugs, data sources that stopped working, and corrections to the HK contract specifications. This is a personal
project, so open an issue before you write a large pull request, and expect slow replies.

## License

[MIT](LICENSE) © 2026 haijin
