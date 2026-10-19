# 05 — Backtesting and "backfill testing"

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

Goal: for any parameter set, replay the exact live pipeline over history and report whether the rules have an
edge, per stock, per market, per regime and per rule. Results feed the `confidence` field and the backtest card
on every recommendation.

## 1. Two data tiers (always labelled)

| Tier | Option prices from | Available for | Honesty |
|---|---|---|---|
| **real** | stored `option_quotes` snapshots (ours from go-live; optional ORATS or IBKR backfill for US) | US and HK from the first day of capture | best: real bid/ask, open interest, skew |
| **synthetic** | Black-Scholes on daily bars. Sigma = IV30 where known, else realised vol x a calibrated IV/RV ratio (median ratio over the period where both exist; defaults 1.15 US, 1.10 HK), plus a skew bump for OTM puts (default +2 vol points per 10 delta below ATM) | 10–20 years on any stock with price history | approximate, mid-price only. A slippage haircut (10% of premium US, 15% HK) and a model-risk haircut (5%) are subtracted |

Policy `real_then_synthetic` uses real where a snapshot exists for (instrument, date) and synthetic otherwise. Each trade
carries its tier, and metrics are reported both pooled and per tier.
Dividends: adjusted close for returns, raw close for strikes; synthetic pricing includes the present value of a discrete
dividend when an ex-dividend date falls inside the DTE window (from `corporate_events`).
Early exercise (American puts in both markets): Barone-Adesi–Whaley approximation for synthetic marks. Assignment is
assumed at expiry when ITM. Early assignment of a **put** is driven by deep in-the-money with little extrinsic value
left and higher interest rates (the holder wants the cash now); dividends matter for calls, not puts. Heuristic:
flag early assignment when extrinsic value < 1% of strike and the put is more than 10% ITM.

**Journal fills are the first real-tier data.** Imported trades (01 §G2) create real quotes on their entry and exit
dates and seed `pricing_calibration`. Before the engine runs any synthetic HK trade, it reads the median
real/synthetic ratio from that table; if fewer than 10 samples exist the report prints "HK synthetic prices
uncalibrated, indicative only".

## 2. Engine (event-driven, daily)

```
for each trading day D in [from, to] (per market calendar):
  update regime(D)
  mark open trades at D (real quote if it exists, else Black-Scholes with sigma_D); apply exits in this order:
     stop_loss (loss >= 2 x credit) -> take_profit (>= 50% captured) -> dte_exit (DTE <= 21) -> expiry settlement
  if the regime allows and capital is available:
     run pipeline(asOf = D) for each watchlist instrument   (skill results cached in skill_runs, so re-runs are fast)
     take the top-N recommendations not already open on that underlying
     size -> open the trade at the D close (entry credit = bid, or mid minus haircut); apply fees
  record equity, deployed %, benchmark values
```
Capital model: cash-secured. Collateral is locked; idle cash earns the risk-free rate (T-bill or HIBOR), so the comparison
with the Cboe PUT methodology is fair.
Benchmarks: buy-and-hold equal-weight watchlist; index total return; naive "always sell 30-delta 45-DTE on every name"
(to measure what the fundamental and technical filters add).

## 3. Lookahead and bias controls (enforced by tests, not just documented)

- `DataAccess` is constructed with `asOf`. The engine test suite runs a **future-perturbation test**: change all data
  after D and assert that skill results at D are unchanged.
- Fundamentals: filtered by `reported_at`; if estimated, a conservative +90-day lag.
- Calendar: earnings dates are used only when `known_at <= D` (we only know what had been announced).
- Survivorship: the watchlist is yours, so this is a "names I like today" bias. It is printed as a caveat on every
  report. Optionally run on historical HSI and S&P constituent lists to measure it.
- Chain snapshots are end of day. Entries assume the close; exits triggered on a close are filled at the next close
  (no same-bar fills).
- Parameter search uses **walk-forward**: optimise on a training window (36 months), test on the next 12, roll;
  report only out-of-sample aggregates. Grid sizes are limited, and an overfitting warning fires if the out-of-sample
  Sharpe is below half of the in-sample Sharpe.

## 4. Metrics (stored in `backtest_runs.metrics`)

Trade level: n, win rate, average and median P&L, average ROC per trade, annualised ROC on collateral, profit factor,
average days held, exit-reason mix, assignment rate, maximum adverse excursion distribution, the worst 5 trades.
Portfolio level: CAGR, volatility, Sharpe, Sortino, max drawdown and its duration, Calmar, % of time deployed,
return per unit of collateral, comparison with each benchmark, monthly return table, regime breakdown.
Attribution per rule: win rate and average ROC of trades where the rule passed versus failed. This needs the pipeline in
"observe" mode that records would-be trades it rejected (`observeRejected=true`, roughly doubles compute; run monthly).
Per-stock card (feeds recommendations): `{n, winRate, avgRoc, maxDD, tierMix, from, to}`.
Statistical sanity: bootstrap confidence intervals for win rate and mean ROC (1,000 resamples); t-statistic of mean trade P&L.

## 5. Signal-level "backfill" tests (fast, no portfolio simulation)

Because you want justification per rule, each skill also gets an event study. For every historical date where a rule
fired on a stock, compute the forward 30-day and 45-day return, the probability that price touched the chosen strike
before expiry, and the realised premium capture of a Black-Scholes-priced put at that strike.
Report fired-versus-not-fired distributions with sample counts. This is what a sentence like "the RSI 30–45 pullback rule
improves put-sale win rate by X points on this watchlist" is backed by.

## 6. Validation plan before trusting the engine

1. Reproduce a known result. Synthetic tier, SPY, monthly ATM put, 2007–2025. It should track the published Cboe PUT index
   behaviour: lower volatility than SPX, lagging in strong bull years, outperforming in 2008 and 2022. Tolerance is loose,
   direction must match.
2. Reproduce a tastylive-style SPY 16-delta 45-DTE strategy managed at 50% and 21 DTE. Expect a win rate around 75–80%.
   A large deviation means the synthetic pricer or the exit logic is wrong.
3. Once at least 3 months of real snapshots exist, compare synthetic versus real entry credits on the same contracts;
   recalibrate the IV/RV ratio and skew bump per market; show the error band in the UI.
4. Sensitivity: every synthetic result is re-run with sigma +/- 20%. If the strategy's sign flips inside that band,
   the result is labelled "not robust to pricing error" and the recommendation card says so.

## 8. When this gets built

**Built 2026-10-12 (Phase 4).** Implementation notes that differ from or add to the text above: entries are proposed by the replayed
pipeline (or the naive benchmark) and the engine adds only cash, exits and fills; sensitivity re-runs reuse the base run's entries
and sizes and re-price them (so they measure pricing error, not a different portfolio); observe mode records rejected entries as
*shadow* trades that never touch cash; the exchange calendars start in 2010 so a backtest must too; S5's confidence card still comes
from the journal because a card computed from a full-history backtest would be lookahead inside a backtest.

Original plan:

After milestone 1 has been used live for several weeks (see `06-roadmap.md`). Journal import and calibration are
built in milestone 1; the event studies in §5, the portfolio engine, walk-forward and attribution in observe mode
all wait for Phase 4.

## 7. Runtime estimate

A 60-name watchlist x 2,500 trading days x 7 skills is about 1M skill runs. With caching and vectorised indicators this is
minutes on a laptop. Backtests run as a pg-boss job with progress updates.
