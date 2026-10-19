# 04 — v1 Skill Specifications

> **As built:** this is the original design from 2026-10-10 and the code has moved on. The root [README](../README.md) says what exists today, and the "As built" sections in [docs/designs/](designs/) record what changed. Where they disagree, the code wins.

Every skill has an id, version `1.0.0`, inputs (through `DataAccess`), params with defaults, rules that emit
Reasons, a score 0–100, a verdict and a payload. Reasons are the audit trail that the narrative and the UI render.

---
## S0 `market.regime` (per market, once per day, cached)
Inputs: index bars 260d (SPY or 2800.HK), latest vol index (VIX or VHSI). If the vol index is missing (VHSI source
unverified on free data), classify on index versus SMA200 only and attach Reason `regime.noVolIndex`.
Params: `vixCalm=20, vixVolatile=30, vixCrash=40, belowSma200Panic=0.10`.
Payload: `{regime, deployCapPct, deltaCap, indexVsSma200Pct, volIndex}`.
Verdict: NA (informational), except `crash_guard` → FAIL, which blocks new entries unless `overrideCrashGuard=true`.

---
## S1 `fundamental.gate`
Inputs: statements (point-in-time), latest price, shares outstanding, calendar.
Params:
```
fScoreMin=6, fScoreWarn=4, zPass=2.99, zWarn=1.81, roicMin=0.10, fcfYieldMin=0.04, netDebtEbitdaMax=3,
gmStdevMaxPts=5, revCagr3yMin=0, epsPositiveYearsMin=3, allowEarningsInWindow=false, earningsIvrOverride=60,
valuationZMax=1.5, weights={quality:0.4, strength:0.3, valuation:0.3}
```
Period handling: reads `instrument.reportingFrequency`; "last N periods" means quarters (US) or half-years (HK);
trend tests compare year-over-year annual statements. Missing quarterly data on an HK name is not a `missing` field.
Solvency: switched by `instrument.solvencyModel` (altman | property | financial | reit, thresholds in 01 §A2).
Rules (each emits a Reason): F-score; solvency test per model; ROIC; FCF yield; net debt/EBITDA;
gross-margin stability; revenue CAGR; EPS-positive years; dividend cut; EV/EBIT z versus 5y; P/E z versus 5y;
pending corporate action; earnings inside the candidate window (window from `option.select.dteMax`).
Score: weighted sub-scores, each a linear interpolation between the fail threshold (0) and an "excellent" level (100).
Verdict: FAIL only on a **failed test**: F <= fScoreWarn - 1, solvency below its fail threshold, or a pending
corporate action. **Data gaps never FAIL**: a test whose inputs are missing is skipped and listed in `missing`.
**Milestone 1 gate on free data** (outside-voice finding, 2026-10-10): Yahoo supplies about 4 annual and 4 quarterly
periods, so the 5-year medians in A3/A4 and the 8-period margin series usually cannot be computed. Sub-scores whose
inputs are absent are **NA, not a neutral 50**, and the gate's score is the weighted mean over the sub-scores that
exist, with the weights renormalised; the Reason `fundamentals.partialCoverage` lists what was skipped. In practice
the M1 gate is: F-score (two annuals), sector-switched solvency, pending corporate action, earnings window, plus
whichever A3/A4 metrics the data supports. The point-in-time columns and tests stay (they run on fixture data and
pay off from go-live). If more than half of the tests are skipped the verdict is WARN with
`fundamentals.insufficientData` shown first. Otherwise WARN if any single warn condition, else PASS.
Payload: `{fScore, fComponents[9], zScore, roic5y, fcfYield, netDebtEbitda, gmStdev, revCagr3y, epsPosYears, divCut, evEbitZ, peZ, nextEarnings, dataAgeDays}`.
Note: if the latest statement has `reported_at_estimated`, add Reason `fundamentals.estimatedFilingDate` and set tier `proxy`.

---
## S2 `technical.timing`
Inputs: 300 daily bars, index bars for relative strength.
Params: `rsiLo=30, rsiHi=45, bbTouchDays=5, supportAtrMin=1.0, sma50SlopeDays=20, volSpikeMult=1.5, rsVsIndexMin=-0.05, weights={trend:25, pullback:20, support:20, momentum:15, volume:10, rs:10}`.
Computations: SMA20/50/200, EMA12/26 and MACD(12,26,9), RSI14, ATR14, Bollinger(20,2), ADX14, Donchian 20/55,
swing lows (5-bar fractal), 52-week high and low, 3-month return, index 3-month return.
Support level = the highest of {20-day swing low, SMA50, SMA200, prior calendar-month low, lower Bollinger}
that is **below spot**. If none is below spot, support = spot - 2 x ATR with Reason `support.synthetic`.
Verdict: WARN if close < SMA200 (sizing halved downstream). FAIL only for a falling knife: ADX > 30 with -DI
dominant AND close < SMA200 AND 3-month return < -20%.
Payload: `{support, supportSource, atr14, sma50, sma200, rsi14, macdHist, bbLower, adx14, ret3m, pctFrom52wHigh, trendState: 'up'|'down'|'side'}`.

---
## S3 `volatility.edge`
Inputs: chain snapshot if any (IV30 interpolated from the two expiries bracketing 30 days, at the money),
`iv_daily` history (252d for the rank, about 14 months for the forward series), bars for Yang-Zhang realised vol and
for close-to-close realised vol over the forward windows.
Params: `ivrMin=30, ivrGood=50, ivrGreat=70, vrpMinRatio=1.0, vrpGoodRatio=1.2, termBackwardationMax=1.05, proxyBeta=true,
vrpWindowDays=30, vrpObservations=10, vrpPositiveMin=6, vrpNegativeMin=6, ivSourceEventDays=14, ivSourceFrontHeavyMin=1.02,
ivSourceDemandDays=45, ivFloorPercentileMax=10, ivFloorRampMinDays=30, ivFloorRampMaxDays=60`.
Fallback: with no chain, IV30 = (VIX or VHSI) x (stock RV60 / index RV60), tier `proxy`; IV rank is computed
on the proxy series; Reason `iv.proxy` is attached. If the vol index is also missing, IV30 = RV60 x the IV/RV ratio
(calibrated median from `pricing_calibration` when >= 10 samples exist for that market, else the 05 §1 default:
1.10 HK, 1.15 US); tier `proxy`, Reason `iv.rvOnly`; IV rank is computed on that series and S4 uses it as sigma.
Score: IV rank piecewise (30 → 50, 50 → 75, 70+ → 100), adjusted by the trailing VRP ratio, minus 15 for
backwardation, plus 5 if the 25-delta skew is above its 1-year median.
**Forward-aligned VRP** (2026-10-18, `docs/designs/trade-skills-integration.md` T1, pitfall 36 of trade-skills): the
trailing ratio `vrpRatio = IV30 / RV20` compares today's implied with the window already behind us and is kept as a
display number (Reason `vol.vrp`, labelled trailing). The test that says whether selling this name's IV has paid is
forward-aligned: for a window starting at bar t and ending at t + `vrpWindowDays` trading days, pair the real `iv_daily`
IV30 stored on t with the annualised close-to-close realised vol of the log returns over (t, t + window]. Walk back from
the last bar, keep the last `vrpObservations` non-overlapping windows (a start day without a stored IV shifts that window
one bar earlier), and report: `vol.vrpForward` (how many windows had implied above the realised vol that followed: PASS
at >= `vrpPositiveMin`, rule WARN "structurally negative" at >= `vrpNegativeMin` below, INFO in between), `vol.vrpGap`
(mean IV30 minus subsequent realised, vol points) and `vol.vrpLive` (live IV30 against the most recent completed window).
Measured only when the tier is `real` AND the rank basis is `real`; a proxy or RV-based series would compare a
constant times realised vol with realised vol. Otherwise, or when fewer than `vrpObservations` windows exist (about
fourteen months of stored IV), Reason `vol.vrpUnmeasured` is INFO and is not counted against the name (the
`ai-analysis.md` premise-1 convention). Payload adds `vrpForward` (window, observations, above, meanGapPts, series) and
`rvRecent` (realised vol over the most recent completed window, bars only, so it exists in every tier).
Verdict: FAIL `vol.noEdge` if IV rank < ivrMin AND trailing VRP < vrpMinRatio, unless the forward VRP is positive, in
which case the name stays sellable with INFO `vol.lowRankSize` (take a smaller size). A structurally negative forward
VRP is a rule WARN whatever the rank; when no dated result lies inside the next `option.select.dteMax` days (no event
premium to explain today's IV) it is FAIL `vol.noEdge` too. WARN if either trailing measure is weak. Otherwise PASS.
**IV source and IV floor** (2026-10-19, trade-skills T3, pitfalls 21, 7 and 37). From the next known results date
(calendar, knownAt-bounded) and the term ratio (the live chain's front / next IV, else the latest stored
`iv_daily.term_ratio`), one Reason `vol.ivSource` with value `event` (results within `ivSourceEventDays` and term ratio
>= `ivSourceFrontHeavyMin`: "event IV, will crush on the date", INFO), `demand` (no result within `ivSourceDemandDays`,
or none known, and IV rank > `ivrMin`: "demand IV, may persist", a rule WARN on a short put) or `unknown` (INFO).
Separately, an IV percentile at or below `ivFloorPercentileMax` with results `ivFloorRampMinDays` to `ivFloorRampMaxDays`
days out is rule WARN `vol.ivFloorRamp` ("IV ramp ahead"); the runner's gate treats that WARN as a block
(`GATE_WAIT_RULES` in `src/skills/contract.ts`), so the name is rejected with that binding reason and the Watchlist
shows Wait. Payload adds `ivOrigin` and `daysToResults`. Neither rule fires in the unscored `rvOnly` tier.
**Tier `rvOnly` is not scored.** With IV30 = RV60 x constant, the VRP ratio is that constant and "IV rank" is a
realised-vol rank, so the skill could never fail and its score would be noise next to names with real chains.
In that tier `score = null`, verdict NA, Reason `iv.unscored`, and S5 renormalises the composite weights over the
skills that produced a score. The `proxy` tier (vol index x beta) is scored but flagged.
Payload: `{iv30, ivRank, ivPercentile, rv20, rv60, vrpRatio, vrpForward, rvRecent, termRatio, skew25d, tier, ivOrigin, daysToResults}`.

---
## S4 `option.select` (dependsOn: S0, S2, S3)
Inputs: chain snapshot as of the date. If none and `allowSynthetic=true`, build synthetic strikes (see 05)
priced by Black-Scholes using the S3 IV30 and the skew adjustment.
Params:
```
dteMin=30 (HK 20), dteMax=45, deltaMin=0.15, deltaMax=0.30 (capped by regime), strikeBelowSupport=true,
minAnnRoc=0.12 (HK 0.10), maxSpreadPct=0.10 (HK 0.15), minOI=100 (HK 50), fillAssumption='bid'|'mid_minus_tick',
riskFreeUS=0.04 (or FRED), riskFreeHK=0.035 (or HIBOR 1M), relaxSupport=false, allowSynthetic=true,
hkMarginPctOfNotional=0.25
```
Chain source preference: real snapshot (yahoo / csv / futu / ibkr) for the as-of date, else synthetic. The payload's
`tier` and `source` always say which was used, and the CLI prints it in the shortlist table.
Greeks: when the quote carries no delta (Yahoo, CSV), compute delta, gamma, theta, vega by Black-Scholes from the
quote's IV; when it carries no IV either, imply IV from mid (bisection) first. Mark `source` with `greeks:computed`.
Economics include `collateral` (notional), `collateralBaseCcy`, `marginEstimate` and `rocOnMargin` as defined in 01 §E;
only `collateral` feeds S6.
Expiry rule: US, every Friday expiry in the window, prefer the monthly third Friday when two qualify. HK, expiry =
last business day of the month minus one business day (from `exchange_calendar`); choose the spot month if its DTE
>= dteMin, else the next month; weekly HK options are ignored in v1.
Scan: for each put in the delta band, at or below support, and liquid, compute the economics in 01 §E.
Choose the maximum annualised ROC; store the runner-up (next lower strike).
Verdict: FAIL if no contract satisfies all constraints (the Reason names the binding constraint, e.g. `liquidity.spread`).
WARN if the chosen contract needed the `relaxSupport` relaxation.
Loss probability under both vols (T1): for the chosen put, `P(S_T < breakeven)` lognormal at the IV being sold
(`lossProbIv`, Reason `option.lossProbIv`) and at the realised vol of the most recent completed window from S3
`rvRecent` (`lossProbRv`, Reason `option.lossProbRv`), two INFO rows the Today detail shows side by side; neither moves
the verdict. The breakeven is only known here, so S3 publishes the vols and S4 computes the probabilities.
Payload: `{chosen: {contractId|synthetic, strike, expiry, dte, bid, ask, mid, delta, iv, oi, credit, collateral, roc, annRoc, breakeven, cushionPct, probItm, probTouch, bsProbItm, expectedValue, lossProbIv, lossProbRv}, alternative: {...}, rejected: [{strike, reason}], tier}`.

---
## S5 `rank.composite` (dependsOn: S1–S4)
Params: `weights={fundamental:0.35, technical:0.25, vol:0.20, option:0.20}, targetAnnRoc=0.15, convictionWeight=0.05, priorN=30`.
optionScore = `clamp(annRoc / targetAnnRoc, 0, 1.5) x 60 + clamp(cushionPct / 0.10, 0, 1) x 40`.
composite = sum of weight x score over skills with a non-null score, weights renormalised to 1, times 0.85 if any
**rule-based** WARN (a threshold in the warn band, close below SMA200, relaxed support), plus conviction x
convictionWeight x 20. **Data-quality WARNs** (`fundamentals.partialCoverage`, unknown earnings date, estimated
filing date, proxy IV) do not apply the multiplier; they are shown in the reasons and the data tier column.
Otherwise nearly every HK name would be penalised for the data source rather than the stock.
Output is **one table per market**, each ranked within the market, because free-data HK and US names are scored
by partly different functions; a cross-market merged view is a later option.
confidence = shrunk historical win rate `(n x winRate + priorN x watchlistWinRate) / (n + priorN)` from the latest
completed backtest with the same params (read from `backtest_trades`); null if no backtest yet (UI shows "no backtest").
Exclusion: any instrument with an open `positions` row (status open) is dropped from the shortlist with Reason
`portfolio.alreadyOpen`; `pnpm cli explain` (and later the deep-dive page) still shows its scores.
Payload: `{composite, confidence, backtestCard}`. Until the backtest engine exists, `confidence` is null and
`backtestCard` carries the journal-derived card `{n, winRate, avgRoc, source:'journal'}` when you have past trades on that name.

---
## S6 `size.position` (dependsOn: S0, S5; needs portfolio state: equity, open collateral by sector and currency; never cached, like S5 and S7)
Params: `maxPerNamePct=0.05, maxSectorOpen=3, kellyFraction=0.25`. Deployed cap comes from the regime.
Output: `{contracts, collateral, pctOfEquity, kellySuggested, capsHit: [], governor}`; contracts = 0 with a reason if a cap is hit.
**Drawdown governor** (2026-10-19, trade-skills T3, pitfall 31; `src/core/governor.ts`). Settings live in
`portfolio_settings` (`daily_loss_limit` in the base currency, `consecutive_loss_halt`, `degear_tiers`
[{drawdownPct, multiplier}]) and reach the skill as `portfolio.governor`; the defaults (NULL, NULL, []) leave sizing
unchanged. S6 reads every recorded put and its marks through `DataAccess.ledger()` (bounded by asOf: a close after the
day reads as still open, later marks are absent) and computes, in the base currency: day P&L = closes booked on asOf +
(today's marks - the previous marks of the open puts); drawdown = peak-to-now of the cumulative curve (closes to date +
latest open marks), as a percent of equity; the losing streak = consecutive losing closes ending at the latest close.
A day P&L at or below minus the limit, or a streak at the halt count, is FAIL `size.dailyLossHalt` (value `dailyLoss`
or `consecutiveLosses`), 0 contracts, and the runner drops every shortlisted name with that binding reason: every idea
waits for the day. Otherwise the deepest tier reached multiplies the size factor and is rule WARN `size.drawdownTier`
(a multiplier of 0 gives 0 contracts with `capsHit: ['drawdownTier']`). Puts in a currency with no FX rate are left out
with data note `size.governorFx`. The mark job runs the same arithmetic after writing the marks and pushes one
`drawdown_tier` alert on the day the drawdown enters a deeper tier than it sat in on the previous ledger day (a rerun of
the same day does not repeat it: the job_runs row carries `drawdownTierAsOf`).

---
## S7 `explain.narrative` (dependsOn: all)
Deterministic template built from Reasons. Example of the target output:

> **0700 Tencent: sell 2026-11 Put 540 (delta 0.22, 34 DTE) for HK$9.80 x 100 = HK$980; collateral HK$54,000; 18.1% annualised; breakeven 530.2 (-8.9%).**
> Quality: F-score 7/9, Z 4.1, FCF yield 5.2%, net cash. Valuation: EV/EBIT 0.6 sigma below its 5-year median.
> Timing: pulled back to SMA50 (support 548), RSI 38 turning up, above SMA200. Vol: IV rank 58, IV 31% versus
> realised 24% (VRP 1.29). Events: results on 2026-11-12 fall AFTER expiry. Regime: HK bull-volatile (cap 50%, delta <= 0.25).
> Backtest (synthetic tier, 2016–2026, this rule-set on 0700): 41 trades, 83% win, average 1.9% ROC per trade,
> max drawdown -11%, versus 79% across the watchlist.

Optional later: an `explain.llm` skill that rewrites the template with Claude strictly from the Reasons JSON and never adds facts.
