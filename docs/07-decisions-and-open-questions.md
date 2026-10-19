# 07 — Decisions (ADR-style) and open questions for you

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

## Decisions made in this design

| # | Decision | Why | Alternative rejected |
|---|---|---|---|
| D1 | Skills as versioned pure plugins over an `asOf`-bounded data interface | Makes live scan and backtest literally the same code; prevents lookahead by construction | Separate "scanner" and "backtester" code paths (classic source of divergence) |
| D2 | pg-boss instead of BullMQ | One stateful dependency (Postgres) | Redis + BullMQ (more ops) |
| D3 | Drizzle ORM | SQL-close, light, good TS types, migrations from SQL | Prisma (heavier, less SQL control for analytics queries) |
| D4 | Two-tier option data with synthetic Black-Scholes fallback | Free complete option history does not exist; price history does | Buy ORATS from day one (possible later, US only) |
| D5 | Daily end-of-day granularity | Matches a 30–45 DTE strategy; cheap data; honest fills | Intraday (expensive, no benefit for this holding period) |
| D6 | App never trades | Keeps it a decision tool; avoids broker write permissions and execution risk | Auto-execution via IBKR |
| D7 | Rule-based, transparent scoring; no ML in v1 | You need justifications; small sample sizes per stock make ML overfit | Gradient-boosted ranking |
| D8 | HK contract size = board lot stored per instrument | HKEX contracts are 1 board lot (some differ); economics are wrong otherwise | Hard-coded 100 |
| D9 | Fundamentals point-in-time with `reported_at` | Largest bias source in fundamental backtests | Use period_end (lookahead of 1–3 months) |
| D10 | Fill assumption = bid (or mid − tick) + haircuts in synthetic tier | Conservative; put sellers get filled near bid | Mid |
| D11 (2026-10-10) | Scanner first; backtest engine after live use | Backtester needs real snapshots that only accrue by using the scanner; a usable tool in days beats a complete one in months | Full build in design order |
| D12 (2026-10-10) | Trade journal imported first as real-tier data | Only real HK option prices available; calibrates synthetic pricing; rule attribution on real outcomes | Guessed HK haircut constants |
| D13 (2026-10-10) | Sizing on notional, margin shown only | Assignment cost is the real exposure; margin return flatters risk | Size on broker margin |
| D14 (2026-10-10) | HK is period-aware and solvency is sector-switched | Semi-annual reporting; Altman Z misfires on property and conglomerates | One quarterly, Altman-only gate |
| D15 (2026-10-10, superseded same day) | HK chains by CSV paste in milestone 1 | Zero integration cost while the broker question was open | Synthetic-only HK until OpenD |
| D16 (2026-10-10) | Futu/moomoo OpenD adapter in milestone 1, CSV paste as fallback | User confirmed a moomoo account; one read-only API call replaces a daily manual paste and gives greeks and IV | Keep CSV as primary until Phase 5 |

## Open questions only you can answer (defaults assumed if unanswered)

1. ~~Broker/data accounts~~ Answered 2026-10-10: the user has a **moomoo account**. The Futu OpenD adapter for HK
   option chains moves into milestone 1 (Phase 1); pasted CSV stays as the fallback when OpenD is not running.
   Interactive Brokers: unknown, stays Phase 5.
2. **Capital and currency split**: approximate equity and HK/US split, to set per-name 5% cap defaults and whether sizing is per-currency bucket. Default: one equity figure, per-currency buckets reported, caps applied globally.
3. **Watchlist size**: 20 names or 200? Affects provider rate limits and whether we need paid fundamentals (FMP/EODHD). Default: ≤ 60, free Yahoo data.
4. **Earnings inside the window**: strictly avoid (default) or allow with high IV rank and half size?
5. **Assignment appetite**: happy to be assigned and wheel (default), or do you prefer rolling for credit? Changes the management skill and the backtest exit rules.
6. **Stop-loss style**: 2× credit (default) vs none (tastylive-style "hold and manage") — both will be backtested; pick the default you want to see first.
7. **Fees**: your actual per-contract commission for US and HK, HK stamp duty on assignment, to put in the fee model. Default: US $0.65/contract, HK HK$15/contract + exchange levy.
8. ~~UI vs API-first~~ Decided 2026-10-10: CLI first (D11).
9. **Narrative generation**: template only (default) or add an LLM rewrite step using Claude later?
10. **Weekly HK stock options**: ignore in v1 (default) or include for the few names that have them?
11. **Journal CSV**: the milestone-1 importer reads the generic template in `01 §G2`. If you want a mapper for a
    specific broker export (moomoo, IBKR, HSBC, Futu), say which; it is a convenience, not a blocker.
12. **Base currency**: HKD or USD for equity and caps? Default: HKD.
13. **Property names on the watchlist**: which ones should use the `property` solvency model? Default: inferred from
    Yahoo sector "Real Estate", you can override per name.
14. **Free fundamentals coverage**: the Phase 1 coverage report decides whether FMP/EODHD is needed. Default: decide on evidence, not now.
