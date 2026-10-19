# 01 — Methodology: how stocks and puts are selected

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

Everything below is expressed as rules with thresholds. Thresholds live in the `strategy_params`
table and every one of them is a backtest dimension (see `05-backtest-design.md`).

## A. Fundamental gate — "Would I be happy to own this at the strike?"

Selling a put is a conditional purchase. The gate therefore answers one question: is this a business whose
shares I would accept at the strike price, for months, if assigned? It uses three proven, open
frameworks plus event-risk checks. All inputs are **point-in-time** (only filings reported before the scan date).

### A0. Reporting periods differ by market (period-aware inputs)
US companies file quarterly. HK companies publish annual and interim (semi-annual) results only, and the
announcement date is the point-in-time anchor. Every trend test below therefore compares **the last two
comparable periods for that instrument**: year-over-year annuals for both markets, and "last N periods" means
N quarters in the US and N half-years in HK. `instruments.reporting_frequency` drives this; a skill must never
assume quarterly data exists.

### A1. Piotroski F-Score (0–9) — financial strength trend
Nine binary tests from the last two annual statements (US may also use trailing-four-quarter).
Profitability: ROA > 0; CFO > 0; delta ROA > 0; CFO > Net income (accrual quality).
Leverage/liquidity: delta long-term-debt/assets < 0; delta current ratio > 0; no new share issuance.
Efficiency: delta gross margin > 0; delta asset turnover > 0.
Rule: **F >= 6 pass; 4–5 warn (score penalty); <= 3 fail.**

### A2. Altman Z-Score — solvency (non-financials only)
Z = 1.2·WC/TA + 1.4·RE/TA + 3.3·EBIT/TA + 0.6·MktCap/TL + 1.0·Sales/TA.
Rule: **Z > 2.99 pass; 1.81–2.99 warn; < 1.81 fail**, for industrial and consumer businesses only.
Solvency is **sector-switched** via `instruments.solvency_model`:
- `altman`: as above.
- `property` (developers, landlords, HK conglomerates with property books): Z misfires on asset-heavy balance
  sheets. Use net gearing = net debt / total equity (pass <= 60%, warn <= 100%, fail above) and interest
  coverage = EBIT / interest expense (pass >= 3x, warn >= 1.5x, fail below).
- `financial` (banks, insurers): skip with a WARN-level note in v1; v2 adds CET1 ratio or combined ratio.
- `reit`: gearing (pass <= 45%, HK REIT code cap is 50%) and interest coverage as for property.

### A3. Quality and cash generation (continuous sub-score 0–100)
- Return on invested capital, 5-year median >= 10% (Greenblatt "good company" leg)
- Free-cash-flow yield (FCF / EV) >= 4%
- Net debt / EBITDA <= 3 (<= 1 earns full marks; net cash is best)
- Gross-margin stability: standard deviation of gross margin over the last 8 periods (quarters in US, half-years in HK) <= 5 points
- Revenue CAGR 3y >= 0 (not shrinking); EPS positive in >= 3 of the last 4 years
- Dividend not cut in the last 3 years (matters for HK names you may be assigned)

### A4. Valuation (continuous)
- EV/EBIT versus its own 5-year median (Greenblatt "cheap" leg, relative not absolute)
- P/E versus own 5-year median and versus sector median
- Price versus analyst mean target where available (low weight, informational)
Rule: valuation z-score inside [-2, +1.5]. More than 1.5 sigma expensive versus its own history is a
penalty, not a fail. You can still sell far-OTM puts on an expensive compounder.

### A5. Event risk (hard rules, evaluated per candidate expiry)
- Earnings date inside [entry, expiry]: FAIL, unless `allowEarningsInWindow=true` AND IV rank >= 60, then size x 0.5.
  If the next earnings date is **unknown** (common for HK on free data), the Reason says so and the stock is WARN,
  never silently PASS. Dates can be entered manually (`corporate_events.source = 'manual'`).
- Ex-dividend inside the window: fine for short puts (lowers early-assignment risk), informational only
- HK: results announcement, AGM, index rebalance dates; US: FOMC day flagged "elevated"
- Pending corporate action (rights issue, spin-off, privatisation): FAIL

**Gate output:** `{fScore, zScore, qualityScore, valuationScore, eventFlags, fundamentalScore 0-100, verdict PASS|WARN|FAIL}`.
FAIL stops the pipeline for that stock. WARN continues with a weight penalty.

## B. Market regime — how much to deploy

Computed once per day per market (US: SPY/SPX plus VIX; HK: HSI or 2800.HK plus VHSI).

| Regime | Definition | Deploy cap | Delta cap |
|---|---|---|---|
| Bull-calm | Index > 200d SMA and vol index < 20 | 50% | 0.30 |
| Bull-volatile | Index > 200d, vol index 20–30 | 50% | 0.25 |
| Bear-calm | Index < 200d, vol index < 25 | 30% | 0.20 |
| Panic | Vol index > 30 or index 10%+ below 200d | 25% | 0.15 |
| Crash guard | Vol index > 40 | new entries OFF unless manual override | n/a |

Rationale: cash-secured put indices such as the Cboe PUT index outperform in range-bound and bear regimes and lag
in strong bull markets, and losses cluster in crashes. Deploying less when the vol index is extreme caps the tail,
while selling into a 20–30 vol index captures most of the volatility risk premium.

## C. Technical timing — "Is now a good entry?"

Daily bars only. Indicators from the `technicalindicators` npm package or in-house implementations, with golden
tests against TA-Lib outputs.

| Component | Signal | Weight |
|---|---|---|
| Trend | Close > SMA200 and SMA50 slope >= 0 over 20 days is positive; close < SMA200 halves sizing | 25 |
| Pullback | RSI(14) in 30–45 (oversold but not broken) or touched lower Bollinger(20,2) within 5 days | 20 |
| Support distance | Nearest support below spot = max(20-day swing low, SMA50, SMA200, prior-month low); distance / ATR(14) >= 1 | 20 |
| Momentum confirmation | MACD histogram rising 3 days, or RSI turning up from below 40 | 15 |
| Volume | Down-day volume not above 1.5x the 20-day average (no distribution) | 10 |
| Relative strength | 3-month return versus the index >= -5% | 10 |

`technicalScore` 0–100. The support level feeds strike selection (strike <= support).
Secondary diagnostics stored for the justification: 52-week position, distance to SMA200, ADX(14), Donchian 20/55.

## D. Volatility edge — "Is the premium rich?"

- **IV Rank** = (IV30 - min IV30 over 252 days) / (max - min). **IV Percentile** = share of days with lower IV.
- **Volatility risk premium (VRP)** = IV30 - realised vol 20d (Yang-Zhang estimator). Positive VRP is the structural
  edge of put selling. Require VRP >= 0; score higher when IV30 > RV20 x 1.2.
- **Term structure**: IV(front month) / IV(next month). Backwardation above 1.05 usually means an event; penalise.
- **Skew**: 25-delta put IV minus ATM IV. Rich put skew means extra premium for OTM puts; small bonus.
- Where chains are unavailable (HK fallback), IV30 is proxied by VHSI scaled by the stock's RV60 / index RV60
  and labelled `proxy`.

`volScore` 0–100: IV rank 30 gives 50 points, 50 gives 75, 70 and above gives 100, minus penalties.

## E. Option selection — which contract

For each stock that passed, enumerate contracts from the latest chain snapshot:
1. Expiry with DTE in [min, max]. US 30–45. HK: nearest monthly with DTE >= 20 and <= 45; if the spot month
   has fewer than 20 DTE, take the next month.
2. Puts with |delta| inside the band (capped by regime) **and** strike <= support level.
3. Liquidity: bid > 0; (ask - bid)/mid <= 10% US or 15% HK; open interest >= 100 US or >= 50 lots HK.
4. Economics per contract:
   - `collateral = strike x multiplier` (HK multiplier = board lot of that stock). This is the notional and the
     only number used for sizing and caps.
   - `marginEstimate` = broker margin proxy, shown only: US Reg-T style `max(20% x spot - OTM amount, 10% x strike) x 100 + credit`;
     HK: HKEX risk margin is not reproducible from public data, so use `param.hkMarginPctOfNotional` (default 25%).
   - `credit = bid x multiplier` (conservative: fill at bid, or mid minus one tick)
   - `roc = credit / collateral`; `annualizedRoc = roc x 365 / DTE`; `rocOnMargin = credit / marginEstimate` (display only)
   - All amounts also converted to base currency with the day's FX rate for cross-market comparison
   - `breakeven = strike - bid`; `cushion = (spot - breakeven) / spot`
   - `probITM ~ |delta|`, `probTouch ~ 2 x |delta|`, plus Black-Scholes P(S_T < K) from IV as a second opinion
   - `expectedValue = credit x (1 - probITM) - probITM x expectedLossGivenITM` using the lognormal conditional
     expectation (closed form). v1 stores it and ranks on it with low weight.
5. Keep the contract that maximises `annualizedRoc` subject to constraints, plus the next-safer strike as alternative.

## F. Composite ranking

```
composite   = w_f * fundamentalScore + w_t * technicalScore + w_v * volScore + w_o * optionScore
defaults    : w_f = 0.35, w_t = 0.25, w_v = 0.20, w_o = 0.20
optionScore = clamp(annualizedRoc / targetRoc, 0, 1.5) * 60 + clamp(cushion / 0.10, 0, 1) * 40
confidence  = backtest-derived win rate of this rule-set on THIS stock, shrunk toward the watchlist mean
              with a Bayesian prior when n < 30
```
Shortlist = top N by composite where verdict is not FAIL, with at most `maxPerSector` and `maxPerCurrency`,
excluding any underlying with an open put position (live scan and backtest alike).

## G. Position sizing

- Contracts = floor( min(5% x equity, remaining regime cap) / collateral )
- Optional fractional Kelly on the backtest edge: `f* = (p*b - q)/b` where b = credit / (max-loss proxy =
  collateral x 2 x ATR%), p = backtest win rate. Use one quarter Kelly and never exceed the 5% cap.
- Correlation guard: no more than 3 open puts in one sector; HK and US buckets tracked separately; FX exposure shown.

## G2. Trade journal as data (new, 2026-10-10)

Your past put sales are imported from a generic CSV template:
`open_date,symbol,market,expiry,strike,multiplier,contracts,credit,open_fees,close_date,close_price,close_fees,outcome,rolled_to_row`
where `outcome` is one of `closed | expired | assigned | rolled | open`. Broker-specific column mappers are a later
convenience, not a blocker. Import rules:
- `multiplier` comes from the CSV row, never from today's `instruments.board_lot` (board lots change).
- Realised P&L per row = (credit − close_price) × multiplier × contracts − fees. For `expired`, close_price = 0.
  For `assigned`, P&L = (credit − max(0, strike − close on the assignment date)) × multiplier × contracts − fees,
  labelled `mtm_at_assignment`: a put seller's losses are concentrated in assignments and booking them as full wins
  would inflate every win rate downstream. The resulting stock lot is recorded as a note and is not tracked as a
  holding in milestone 1.
- Optional `spot` column: the underlying price at the time of the fill. Without it the calibration step uses the
  day's close, and a 1–2% intraday move shifts an OTM put price by 10–30%, so rows without `spot` are excluded from
  calibration and only used for P&L and attribution.
- A roll is two rows: the closed leg and the new leg, linked by `rolled_to_row`, a 1-based data-row number in the
  source file (header not counted), resolved before same-day fills are merged and before partial closes are split;
  P&L is per leg.
- Rows with `outcome = open` become open positions and block new recommendations on that name until closed with
  `pnpm cli positions close`; the importer prints them as a reminder.
- A partial close is split into two rows by the importer (closed quantity, remaining quantity).
- Several fills on one contract on one day are averaged into one row.
Each fill becomes:
- a real-tier `option_quotes` row (bid = ask = fill price, source `journal`), which is the first and often only
  real HK option price in the database;
- a `positions` row with status, so the P&L history is in the same tables as live positions;
- a calibration sample (`pnpm cli journal calibrate`, Phase 2): the synthetic pricer is run on the same date,
  strike and expiry and the ratio of real to synthetic price is stored **per market and per delta bucket**
  (0–10, 10–20, 20–30, 30+ delta). **Pasted chain rows are the primary calibration set** because they are unbiased;
  journal fills are a selection-biased sample (you sold when premium looked rich) and their ratio is printed as a
  sanity figure only. The chain-derived median per bucket becomes the synthetic haircut when >= 10 samples exist;
- an attribution sample: every skill is run as-of each entry date, so you can see which rules your winners and
  losers passed. Sample sizes will be small and the report says so.

## H. Trade management (tracked with alerts; execution is manual)

- Mark positions daily from the chain snapshot (or Black-Scholes fallback).
- Alerts: >= 50% of credit captured → "close"; DTE <= 21 → "close or roll"; loss >= 2x credit → "stop";
  spot < strike and close < SMA50 → "assignment likely, decide"; earnings newly announced inside the window → "review".
- On assignment: the position converts to a stock lot plus a suggested covered call using the same rule-set.
  This is the "wheel". v1 tracks it and suggests the first call only.

## I. References used in this design

- tastylive research on 45 DTE, 16–30 delta short puts, managing at 50% profit and 21 DTE:
  https://www.tastylive.com/news-insights/selling-options-yields-consistent-success ,
  https://tastylive.com/shows/market-measures/episodes/duration-delta-management-03-17-2016 ,
  https://tastylive.com/shows/market-measures/episodes/managing-winners-exiting-based-on-duration-01-26-2016
- Cboe S&P 500 PutWrite Index (PUT) methodology and performance by regime:
  https://cdn.cboe.com/resources/indices/factsheet/CboeGlobalIndices_PUT-Index.pdf ,
  https://www.cboe.com/insights/posts/generating-income-and-managing-risk-cash-secured-put-writing-in-a-low-equity-return-environment ,
  https://www.cxoadvisory.com/equity-options/performance-of-cboe-putwrite-indexes
- Piotroski F-Score and Altman Z-Score definitions:
  https://metricgate.com/docs/piotroski-f-score/ , https://eodhistoricaldata.com/knowledgebase/altman-z-score-piotrosky-score/
- HKEX stock-option contract specs (board-lot contract size, expiry = business day before the last business day,
  American physical delivery, T+1 premium): https://www.chiefgroup.com.hk/en/options/contract ,
  https://www.hkex.com.hk/-/media/HKEX_Common/Market/Products/Listed-Derivatives/Single-Stock/Weekly-Stock-Options/HKEX_infosheet_WeeklyStockOptions_EN.pdf
- Data libraries: yahoo-finance2 (US chains only; HK quotes and history work with `0700.HK`):
  https://cdn.jsdelivr.net/npm/yahoo-finance2@3.14.0/README.md ; Futu/moomoo OpenAPI for HK option chains:
  https://openapi.futunn.com/mds/Futu-API-Doc-en-Python.md ; @stoqey/ib for IBKR chains and IV history:
  https://awesome.ecosyste.ms/projects/github.com%2Fstoqey%2Fib
- Historical option data landscape (no free complete history; ORATS paid from 2007; FlashAlpha free tier):
  https://orats.com/blog/pros-and-cons-of-orats-backtester , https://flashalpha.com/articles/flashalpha-vs-orats-options-data-api-backtesting ,
  https://qveris.ai/guides/free-options-data-for-backtesting
