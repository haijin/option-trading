# Sell-Put Strategy App — Prototype Design (Overview)

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

Status: original design, written before any code. Date: 2026-10-10.
Stack decided: Node.js 22 + TypeScript (single package), PostgreSQL 16 native on Windows, Drizzle ORM (schema source of truth), vitest. Milestone 1 is a CLI. pg-boss and Fastify arrive in Phase 3, React/Vite UI in Phase 6.

## 1. What the app does (one paragraph)

You maintain a watchlist of companies you would be happy to own (HK + US). Every trading day the app
runs a pipeline of pluggable **analysis skills** over that watchlist: a fundamental quality gate
("would I accept assignment?"), a technical timing layer ("is now a good entry?"), a volatility layer
("is premium rich enough?"), and an option-selection layer ("which expiry/strike?"). The output is a
ranked **shortlist of cash-secured puts to sell**, each with a structured justification, the expected
return on capital, the probability of assignment, and a backtest card showing how the same signal
performed historically on that stock and across the watchlist. You decide; the app never trades.

## 1a. First milestone (decided 2026-10-10, office-hours review)

Milestone 1 is a **terminal scanner**: `pnpm cli scan` prints a justified shortlist from today's data for
your real watchlist. US option chains are real (Yahoo). HK chains come from a CSV you paste from your broker
screen, or from synthetic pricing when you do not. Your **past put trades are imported first** and are the
ground truth for calibrating HK pricing and for rule attribution. The backtest engine is built after the
scanner has been used for real for a few weeks and real chain snapshots have accumulated. The web UI comes last.

## 2. Design principles

1. **Skills are plugins.** Each skill is a pure, versioned function `(instrument, asOfDate, data) -> SkillResult`.
   Same code runs for today's scan and for every historical date in a backtest. No skill may read "now".
2. **Point-in-time correctness.** Fundamentals are stored with `reported_at`; a skill run for date D only
   sees filings whose `reported_at <= D`. This is the single most common backtest bug and is designed out.
3. **Evidence over opinion.** Every recommendation carries machine-readable reasons (`[{rule, value, threshold, passed}]`)
   and the backtest statistics that justify each rule. Narrative text is generated from the reasons, not the other way around.
4. **Two-tier option data.** Real chains when available (US via Yahoo, both markets via IBKR/Futu). Synthetic
   Black-Scholes pricing from realized volatility + a calibrated IV/RV ratio as fallback, so backtests can
   run 10+ years back on price history alone. Backtest results are always labelled with which tier produced them.
5. **HK and US are first-class.** Contract size = board lot, monthly expiry on the business day before the last
   business day, American physical delivery, HKD, VHSI regime; vs US 100 shares, Fridays, SPX/VIX regime.
6. **Capture from day one.** Daily option-chain snapshots are stored from go-live so that real-data backtests
   get richer every month.
7. **Notional is the risk number.** Collateral for sizing and caps is always strike x multiplier, the amount you
   pay if assigned. Broker margin is shown as a second return figure and never drives sizing.
8. **HK is not US with a different suffix.** Semi-annual reporting, sparse earnings calendars, sector mix heavy in
   property, banks and conglomerates. The fundamental gate is period-aware and solvency is sector-switched.
9. **Your trade journal is first-class data.** Imported fills are real-tier option quotes and the first backtest sample.

## 3. The decision funnel (what the user actually sees)

```
Watchlist (your companies)
   │
   ▼  Fundamental Gate   — quality + solvency + valuation + event risk   → score 0-100, hard PASS/FAIL
   ▼  Regime Filter      — market (SPX/HSI vs 200d, VIX/VHSI level)      → sizing multiplier, or STOP
   ▼  Technical Timing   — trend, pullback, support distance, momentum   → score 0-100
   ▼  Volatility Edge    — IV rank, IV vs realized (VRP), term structure → score 0-100
   ▼  Option Selection   — DTE window, delta band, strike vs support,
                           liquidity, annualized ROC                      → candidate contracts
   ▼  Composite Rank     — weighted score + backtest-derived confidence   → Top-N shortlist
   ▼  Sizing + Portfolio — capital at risk, sector/currency caps          → suggested contracts count
   ▼  Justification      — reasons table + narrative + backtest card
```

## 4. Baseline trading rules (v1, all parameters configurable and backtested)

| Rule | Default | Source / rationale |
|---|---|---|
| Days to expiry at entry | 30–45 (HK: nearest monthly 20–45) | tastylive research: 45 DTE gives best premium decay/risk trade-off |
| Delta band | 0.15–0.30 (short put) | 16Δ ≈ 1 std dev; ~77% realised win rate on SPY vs 68% theoretical |
| Strike placement | Below nearest support AND ≥ 1.0 × ATR(14) below spot | technical cushion |
| Min annualised return on collateral | 12% US / 10% HK | premium / (strike × multiplier) × 365/DTE |
| IV Rank | ≥ 30 (prefer ≥ 50) | sell premium when it is rich |
| Earnings | no earnings inside the holding window (or require IVR ≥ 60 and halve size) | event risk |
| Take profit | buy back at 50% of credit | tastylive "manage winners" studies |
| Time exit | close/roll at 21 DTE | gamma risk rises sharply < 21 DTE |
| Stop | close if loss ≥ 2 × credit, or spot closes below strike with trend break | capped tail |
| Max collateral per underlying | 5% of capital, measured on notional in base currency (FX-converted) | diversification |
| Already-open underlying | never recommended again while a put is open on it | no doubling up |
| Max total collateral deployed | 50% (regime-adjusted: 25% when VIX > 30 or index < 200d) | keep dry powder |
| Assignment | accept, flag for covered-call ("wheel") tracking | you own quality names by construction |

## 5. Document map

- `01-methodology.md` — the analysis methods, formulas, and what research backs them
- `02-architecture.md` — modules, skill plugin interface, data providers, jobs, API
- `03-schema.sql` — PostgreSQL schema (reference; Drizzle `src/db/schema.ts` is the source of truth)
- `04-skills-spec.md` — exact spec of each v1 skill: inputs, rules, scoring, output
- `05-backtest-design.md` — how back-testing and "backfill testing" work, metrics, validation
- `06-roadmap.md` — build phases and what to verify at each step
- `07-decisions-and-open-questions.md` — ADRs and things only you can decide

## 6. Non-goals for v1

- No order execution, no broker write access.
- No intraday data; daily bars and one end-of-day chain snapshot.
- No multi-leg strategies (spreads, strangles) — the data model supports them, the skills do not yet.
- No ML models; v1 is rule-based and transparent. (A later "LLM narrative" skill is optional.)

## 7. Disclaimer baked into the UI

The app is a personal decision-support tool. It shows statistics about rules you configured; it does not
give investment advice. Every screen that shows a recommendation shows the backtest sample size and the
data tier (real vs synthetic) next to it.
