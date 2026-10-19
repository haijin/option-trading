/**
 * Plain-English help for every rule the scanner can show and every financial KPI. Each entry answers three questions:
 * what is this, why does it matter when you SELL a put (you may end up owning the shares), and how do I read the number.
 * The thresholds quoted are the defaults in src/core/params.ts; the table row itself always shows the live threshold.
 * tests/glossary.test.ts keeps this file in step with the rules the skills emit.
 */
export interface Help {
  what: string;
  why: string;
  read: string;
}

const h = (what: string, why: string, read: string): Help => ({ what, why, read });

export const RULE_HELP: Record<string, Help> = {
  // ------------------------------------------------------------------ market
  'regime.class': h(
    'A mood label for the whole market, from how far the index sits from its 200-day average and how high the fear index is (VIX for the US, a volatility index for Hong Kong).',
    'Selling puts loses most in a falling, panicky market, so the label limits how much of your money may be used and how aggressive the strike may be.',
    'bull_calm: up to 50% deployed, delta up to 0.30. bull_volatile: 50%, 0.25. bear_calm: 30%, 0.20. panic: 25%, 0.15. crash_guard: no new puts.',
  ),
  'regime.noVolIndex': h(
    'There is no history for the Hong Kong volatility index, so the market label uses only the index versus its 200-day average.',
    'The label is a little less precise without a fear gauge, so treat it as slightly rougher.',
    'Informational (a data note). It does not lower the score.',
  ),
  'regime.crashGuard': h(
    'The fear index is above the crash level (VIX 40 by default).',
    'In a crash, puts are assigned together and fast. The scanner stops proposing new ones.',
    'When this fires, no new put is recommended in that market.',
  ),
  'regime.crashGuardOverridden': h(
    'The crash guard condition is present but your setting overrides it.',
    'You are choosing to sell puts through a crash. That is the highest-risk time to do so.',
    'Informational: it reminds you the safety stop is switched off.',
  ),
  'regime.insufficientIndexHistory': h(
    'Not enough index history to compute the 200-day average.',
    'Without it the market label is a conservative guess.',
    'Fix by running ingest so the index history fills in.',
  ),

  // ------------------------------------------------------------------ quality gate
  'fundamentals.fScore': h(
    'Piotroski F-score: nine yes/no health checks on profitability, debt and liquidity, and efficiency (for example: profitable, cash flow positive, debt falling, margins improving).',
    'If a put is assigned you own the company. A higher score means a healthier business to be stuck with.',
    '0 to 9. 6 or more passes, 4 to 5 is a warning, below 4 fails. "5/9 computable" means only 5 of the 9 checks had data.',
  ),
  'fundamentals.insufficientData': h(
    'More than half of the quality tests were skipped because the statements are missing.',
    'The quality verdict rests on too little evidence.',
    'Treat the name as unproven until more statements are ingested.',
  ),
  'fundamentals.partialCoverage': h(
    'Some of the quality tests were skipped because their inputs are missing (the note lists which).',
    'The quality score is the weighted average of the tests that could be run.',
    'Informational. Free data holds about 4 annual statements, so tests that need 5 are often skipped.',
  ),
  'fundamentals.estimatedFilingDate': h(
    'Yahoo does not give the real filing dates, so they are estimated (quarterly +45 days, annual +60 US; +60 and +90 for Hong Kong).',
    'This prevents a backtest from using a report before the market could have seen it.',
    'Informational (a data note).',
  ),
  'solvency.altmanZ': h(
    'Altman Z-score: a formula combining working capital, retained earnings, profitability, equity and sales to estimate bankruptcy risk.',
    'You do not want to be assigned shares of a company that may fail.',
    'Above 2.99 is safe, 1.81 to 2.99 is a grey zone (warning), below 1.81 is the distress zone (fails).',
  ),
  'solvency.gearing': h(
    'Net debt divided by equity, used for property companies instead of the Altman Z-score.',
    'Property firms carry a lot of debt by design, so the ordinary distress formula would mislead.',
    'Below 0.6 is fine, 0.6 to 1.0 is a warning (REITs use 0.45 and 0.5).',
  ),
  'solvency.interestCover': h(
    'Operating profit (EBIT) divided by interest paid.',
    'It shows how comfortably the company pays its lenders.',
    '3 or more is comfortable, 1.5 to 3 is thin, below 1.5 is a warning for property firms.',
  ),
  'solvency.financialSkipped': h(
    'The Altman Z-score is not meaningful for banks and insurers, so it was skipped.',
    'Their balance sheets are different by nature.',
    'Informational.',
  ),
  'quality.roic5y': h(
    'Return on invested capital: after-tax operating profit divided by the money invested (equity plus debt minus cash), median of 5 years.',
    'It shows whether the business earns well on the capital it uses, the mark of a durable company.',
    'At least 10% passes. "Skipped, needs 5 annual statements" means free data has fewer.',
  ),
  'quality.fcfYield': h(
    "Free cash flow (cash from operations minus capital spending) divided by the company's market value.",
    'Real cash earnings are harder to flatter than accounting profit. A higher yield means you buy more cash for the price.',
    'At least 4% passes. Under it is a warning, common for fast-growing tech.',
  ),
  'quality.netDebtEbitda': h(
    'Debt minus cash, divided by operating earnings before depreciation (EBITDA): roughly the years of earnings needed to repay net debt.',
    'Heavy debt makes shares fragile in a downturn.',
    'Net cash (more cash than debt) is best. Up to 3 passes.',
  ),
  'quality.gmStability': h(
    'How steady gross margin has been (standard deviation in percentage points).',
    'A stable margin signals pricing power. Wild swings signal a weak position.',
    'Up to 5 points passes. Needs 8 half-year periods, so it is often skipped on free data.',
  ),
  'quality.revenueCagr3y': h(
    'Average yearly sales growth over 3 years.',
    'Shrinking sales make a falling share price more likely.',
    '0% or more passes.',
  ),
  'quality.epsPositiveYears': h(
    'How many of the last 4 years had positive earnings per share.',
    'Consistent profit matters if you may own the stock.',
    '3 or more of 4 passes.',
  ),
  'quality.dividendCut': h(
    'Whether the dividend was cut by more than 5% in the last 3 years.',
    'A cut often marks a business in trouble.',
    'No cut passes. "Skipped" means fewer than 2 years of dividend figures.',
  ),
  'valuation.evEbitZ': h(
    'How expensive the company is now (enterprise value divided by operating profit) compared with its own last 5 years, as a z-score.',
    'Selling a put on an expensive stock risks being assigned just before it mean-reverts.',
    'Below 1.5 passes, negative means cheaper than usual. Skipped without 5 annual statements.',
  ),
  'valuation.peZ': h(
    "The same idea using price-to-earnings: today's P/E versus its own 5-year history as a z-score.",
    'It keeps you from selling puts on a stock at a record-high valuation.',
    'Below 1.5 passes, negative means cheaper than usual.',
  ),

  // ------------------------------------------------------------------ events
  'events.earningsWindow': h(
    "Where the next earnings report falls compared with the put's expiry.",
    'Results can move a stock 10% or more overnight. A put that expires after earnings carries that jump risk.',
    'Passes when no candidate expiry reaches the report date. Otherwise the name is rejected or only earlier expiries are used.',
  ),
  'events.earningsBeforeExpiry': h(
    'Every expiry in the allowed 30 to 45 day window (20 to 45 for Hong Kong) reaches the next earnings date.',
    'There is no safe expiry to sell: you would always carry results risk.',
    'The name is rejected until the report passes or the expiry window moves.',
  ),
  'events.earningsNeedsIvr': h(
    'You allowed a put across earnings, so it is only accepted when implied volatility is high enough to pay for the jump risk.',
    'Higher premium is the only compensation for the earnings gamble.',
    'Needs IV rank of at least 60 and the position is halved.',
  ),
  'events.earningsUnknown': h(
    'No earnings date is known for this stock.',
    "You cannot tell whether results fall inside the put's life.",
    'Check the company calendar and add the date with events add.',
  ),
  'events.pendingCorporateAction': h(
    'A split, rights issue, spin-off or similar corporate action is pending.',
    "These change the stock's price or the contract terms, so quotes and strikes may not mean what they seem.",
    'Passes when none is pending. Otherwise the name is blocked.',
  ),

  // ------------------------------------------------------------------ technical
  'technical.trend': h(
    'Price is above its 200-day average and the 50-day average is not falling.',
    'Puts on stocks in an uptrend are assigned less often than in a downtrend.',
    'Passes in an uptrend. A downtrend weakens the score and halves the size.',
  ),
  'leaders.leader': h(
    'The name is up at least 30% over 3 or 6 months and ranks in the top quarter of its market on at least two of the 1-, 3- and 6-month returns.',
    'The pullback method only looks at stocks the market has already been paying up for.',
    'Pass means it is a leader; a name that is not never reaches the base test.',
  ),
  'leaders.base': h(
    'The pullback since the highest high of the last 60 days: how deep it is, how many days it has lasted and whether it is getting quieter.',
    'A shallow, tightening base is a pause in an advance; a deep or widening one is a different stock.',
    'Pass means 4% to 25% deep, 5 to 45 days long and not widening.',
  ),
  'leaders.support': h(
    'Which support level the last three bars touched: a moving average, a swing point, an open gap, an anchored VWAP or the base low.',
    'The method buys the bounce off a level, so the stop can sit close underneath it.',
    'Confluence counts how many different kinds of level agree within 1.5%.',
  ),
  'leaders.trigger': h(
    'Whether today is a turn-up bar at that support: a green bar closing in the upper half of its range, above the prior close and back over the 21-day average or the anchored VWAP.',
    'Without the turn there is nothing to buy yet; the name stays on Watch.',
    'Pass means a turn-up bar printed today.',
  ),
  'leaders.stop': h(
    'How far the stop sits under the close: the lower of today and yesterday low, less 0.2%.',
    'The whole plan is sized from this distance, so a wide stop means a small position or no trade.',
    'At most 3% passes; 2.5% or more is flagged as wide.',
  ),
  'leaders.earnings': h(
    'Days to the next earnings report.',
    'A report inside the hold can gap through any stop.',
    'More than 7 days passes; inside 7 the name shows as Watch.',
  ),
  'leaders.regime': h(
    'The market regime from the same rules as the sell-put scan.',
    'In a panic or crash-guard regime pullback entries are switched off.',
    'In those regimes every Setup shows as Watch.',
  ),
  'trend.aboveSma200': h(
    'The latest close is above the 200-day average price.',
    'It is the classic line between a long-term uptrend and downtrend.',
    'Pass means above it.',
  ),
  'trend.belowSma200': h(
    'The latest close is below the 200-day average price.',
    'Selling puts below the long-term average means catching a falling knife more often, so the size is cut by half.',
    'A warning, not a rejection.',
  ),
  'technical.pullback': h(
    'Whether the stock has pulled back (RSI between 30 and 45 or touching its lower Bollinger band) inside an uptrend.',
    'A dip into support is a better time to sell a put than after a spike.',
    'Higher score when the pullback is present.',
  ),
  'technical.support': h(
    "The nearest price floor found from the 50-day average, the previous month's low or a recent swing low.",
    'The scanner wants the strike below that floor so the price has to break support first.',
    'Shown as a price with its source.',
  ),
  'technical.supportDistance': h(
    "How far the price sits above support, measured in ATRs (the stock's average daily range).",
    'Being right on support leaves no room for error.',
    'At least 1 ATR passes.',
  ),
  'technical.momentum': h(
    'Whether upward momentum is building: the MACD histogram has risen three days running, or RSI is turning up from below 40.',
    'A stock whose momentum is turning up is less likely to keep sliding after you sell the put.',
    'Passes when either sign is present. Otherwise it is informational and the technical score is a little lower.',
  ),
  'technical.volume': h(
    'Whether recent down days came on heavy volume (more than 1.5 times the 20-day average).',
    'Heavy-volume selling is institutions leaving.',
    'Passes with none in the last 10 days.',
  ),
  'technical.relativeStrength': h(
    "The stock's 3-month return compared with its market index.",
    'Weak stocks tend to keep lagging.',
    'At least -5% against the index passes.',
  ),
  'technical.fallingKnife': h(
    'A strong, accelerating downtrend: ADX above 30, sellers dominating, below the 200-day average and down more than 20% in 3 months.',
    'This is the worst time to sell a put: assignment is likely and the price keeps falling.',
    'When it fires, the name is rejected.',
  ),
  'technical.insufficientBars': h(
    'Not enough price history for the technical indicators.',
    'The timing score is unreliable.',
    'Run ingest for more history.',
  ),
  'technical.partialInputs': h(
    'Some technical inputs were unavailable.',
    'The score is built from fewer parts.',
    'Informational (a data note).',
  ),
  'support.synthetic': h(
    "No support level (50-day average, previous month's low or swing low) was found below the price, so support is set at the price minus 2 ATRs.",
    'The floor is a rule of thumb, not a level the market has respected, so the cushion is less certain.',
    'Informational (a data note). Look at the chart yourself before trusting this strike.',
  ),

  // ------------------------------------------------------------------ volatility
  'vol.ivRank': h(
    "Where today's implied volatility (the option price level) sits within its range over the past year, from 0 (lowest) to 100 (highest).",
    'You are paid for selling insurance, so you want it expensive. High IV rank means rich premium.',
    'At least 30 passes. 50 is good and 70 is great. "On proxy" means the history is estimated, not stored.',
  ),
  'vol.vrp': h(
    "Trailing volatility risk premium: today's implied volatility divided by the stock's actual volatility over the past 20 days.",
    'When options price in more movement than has just happened, sellers look to have an edge, but this compares the window behind us, not the one being sold.',
    '1.0 or more passes, 1.2 or more is good. Read it next to the forward-aligned premium (vol.vrpForward), which is the real test.',
  ),
  'vol.vrpForward': h(
    'Forward-aligned volatility risk premium: for each of the last ten non-overlapping 30-day windows, the implied volatility at the start against the volatility the stock then actually realised over that window.',
    'Selling premium pays only when implied volatility beats what follows it. A high IV rank says premium is rich against its past, not that it will beat the next month.',
    'Six or more of ten windows above realised passes. Six or more below is a structurally negative premium (a warning no IV rank can lift). In between is mixed.',
  ),
  'vol.vrpGap': h(
    'The mean gap, in volatility points, between the implied volatility sold at the start of each window and the volatility realised over it.',
    'It sizes the forward premium: how much the market has overpaid, or underpaid, for this name per year of volatility.',
    'Informational. Positive is in the seller’s favour; a few points is typical of a name that pays.',
  ),
  'vol.vrpLive': h(
    "Today's implied volatility against the volatility realised over the most recent completed 30-day window, in volatility points.",
    'It shows whether the premium on offer now is above or below what the stock has just done, with the implied volatility that was on offer at the start of that window for comparison.',
    'Informational. Positive means the market is pricing more movement than the last window delivered.',
  ),
  'vol.vrpUnmeasured': h(
    'The forward-aligned premium could not be measured: either the stored implied-volatility history is too short (ten 30-day windows need about fourteen months) or the history is a proxy built from an index or from price swings.',
    'A proxy series cannot be tested against the volatility that followed, and a short one proves nothing, so the rule stays silent instead of guessing.',
    'Informational: it is not counted against the name. Real chain history accumulates one point per ingest.',
  ),
  'vol.lowRankSize': h(
    'Premium is cheap by IV rank and by the trailing comparison, but implied volatility has beaten the volatility that followed in most of the last ten windows.',
    'The old rule would have rejected the name outright; the forward evidence says selling its premium has paid, just at a thinner margin.',
    'The name stays sellable. Take a smaller size than the sizing rule allows.',
  ),
  'vol.ivSource': h(
    "Where today's implied volatility comes from: event IV (results within 14 days and the near expiry priced above the next one), demand IV (no results within 45 days yet IV rank above 30) or unknown.",
    'Event IV collapses the moment results are out, so that premium is the event’s, not a lasting edge. Demand IV means someone is paying for protection with nothing on the calendar to explain it, and it can stay high: a put sold into it may not see the IV decay it counts on.',
    'Event and unknown are informational. Demand is a warning on a short put and lowers the composite a little.',
  ),
  'vol.ivFloorRamp': h(
    'Implied volatility sits at the bottom of its one-year range (percentile 10 or lower) and results are 30 to 60 days away.',
    'Premium is about to ramp into the results: what you sell today is the cheapest it will be before them, and it will be marked against you as IV climbs.',
    'The scan treats it as Wait. Sell after the ramp, or after the results.',
  ),
  'vol.term': h(
    'How near-term volatility compares with longer-term volatility.',
    'Normally later expiries cost more. The reverse means traders expect trouble soon.',
    'A reading above 1.05 is backwardation (a warning).',
  ),
  'vol.backwardation': h(
    'Near-term options are more expensive than later ones.',
    'It signals fear about an imminent event.',
    'Subtracts points from the volatility score.',
  ),
  'vol.skew': h(
    'How much more the market charges for downside puts than for equivalent upside options.',
    'A steeper skew pays more for the same distance from the price.',
    'Adds a small bonus when favourable.',
  ),
  'vol.noEdge': h(
    "No volatility edge. Either both trailing measures are poor (IV rank below 30 and implied volatility below the stock's recent volatility) and the forward-aligned premium does not rescue the name, or implied volatility has trailed the volatility that followed in six or more of the last ten windows with no dated result inside the expiry window to explain today's premium.",
    'The premium is not rich against the past year, not above what the stock moves, or has structurally underpriced the moves that followed, so you are not paid enough for the risk.',
    'It fails the name. A positive forward premium keeps a low-rank name sellable; a dated result inside the window turns the structural case into a warning instead.',
  ),
  'iv.chain': h(
    'The 30-day implied volatility was read from the real option chain.',
    'Real quotes are the most trustworthy.',
    'Informational (a data note).',
  ),
  'iv.proxy': h(
    'Implied volatility is estimated from an index or from price swings, not from a real chain.',
    'It is a rougher guess.',
    'Informational (a data note).',
  ),
  'iv.rankOnProxy': h(
    'IV rank was computed against a proxy history because fewer than 60 real daily IV points are stored.',
    'The rank improves as the app stores more real days.',
    'Informational: it does not trigger a penalty.',
  ),
  'iv.rankOnRv': h(
    'IV rank was computed against realised volatility because no better history exists.',
    'A weaker basis for the rank.',
    'Informational (a data note).',
  ),
  'iv.rvOnly': h(
    'Only realised volatility is known; implied volatility is inferred from it with a typical ratio.',
    'Prices in the model are estimates.',
    'Informational (a data note).',
  ),
  'iv.extrapolatedTenor': h(
    'The 30-day implied volatility was extrapolated from expiries that are not exactly 30 days away.',
    'Slightly less precise.',
    'Informational (a data note).',
  ),
  'iv.noData': h(
    'There is not enough price history to estimate volatility.',
    'Without a volatility estimate the option cannot be judged or priced.',
    'The volatility part is left out. Run ingest for more history.',
  ),
  'iv.unscored': h(
    'Implied volatility here is just realised volatility times a constant, so the "premium versus movement" comparison would be circular.',
    'Scoring it would invent an edge, so the app deliberately does not.',
    'Informational: the volatility part is left unscored and the other weights are re-balanced.',
  ),

  // ------------------------------------------------------------------ option choice
  'option.delta': h(
    "Delta is the option's sensitivity to the stock price, and roughly the market's chance that the put finishes in the money.",
    'It is the main risk dial: a 0.20 delta put has about a 20% chance of assignment.',
    'The scanner wants 0.15 to 0.30, and lower still when the market regime is cautious.',
  ),
  'option.dte': h(
    'Days to expiry.',
    'Time passing earns the premium, but longer gives more time for the price to fall.',
    '30 to 45 days in the US, 20 to 45 in Hong Kong (which has one monthly expiry).',
  ),
  'option.support': h(
    'The strike must sit at or below the support price.',
    'The stock would need to break its floor before you are assigned.',
    'Pass means strike is at or below support.',
  ),
  'option.relaxedSupport': h(
    'You allowed a strike above support.',
    'Higher premium, but the price has less cushion.',
    'Informational: the safety rule is relaxed.',
  ),
  'option.annRoc': h(
    'Annualised return on collateral: the premium as a percentage of the cash set aside, scaled to a year.',
    'It tells you whether the premium is worth the capital you lock up.',
    'At least 12% passes in the US, 10% in Hong Kong. Always on full notional, never on margin.',
  ),
  'option.earningsExpiries': h(
    'Only expiries before the next earnings date were considered.',
    'It avoids jump risk from the report.',
    'Informational.',
  ),
  'option.greeks': h(
    'Where the greeks (delta and others) came from: the quote, or computed by the app.',
    "Computed greeks are consistent but not the broker's own numbers.",
    'Informational (a data note).',
  ),
  'option.synthetic': h(
    'The option price is from a model (Black-Scholes with a skew and haircut), not from a market quote.',
    'Model prices are approximations. Real fills can differ.',
    'Paste or ingest a real chain to confirm before trading.',
  ),
  'option.noChain': h(
    'No option chain is stored for this stock.',
    'The scanner cannot see real contracts.',
    'Run ingest, or paste a chain (CSV) for Hong Kong.',
  ),
  'option.noPrice': h(
    'No usable price exists for the candidate contract.',
    'There is nothing to sell at.',
    'The name has no recommendation.',
  ),
  'option.noSynthetic': h('Model pricing is off and no real chain exists.', 'Nothing can be priced.', 'Informational.'),
  'delta.band': h(
    'No contract met the delta range.',
    'Every available strike was either too risky or paid too little.',
    'The name has no recommendation today.',
  ),
  'delta.regimeCap': h(
    'The market regime caps delta below the lowest delta the scanner accepts (0.15).',
    'In a shaky market only very safe strikes are allowed, and none of them pays enough to qualify.',
    'The name has no recommendation until the regime improves.',
  ),
  'dte.window': h(
    'No expiry falls inside the allowed day range.',
    'Hong Kong has one monthly expiry, so some days none fits.',
    'Try again when the next expiry enters the window.',
  ),
  'option.lossProbIv': h(
    'The probability that the stock closes below the breakeven (strike minus the premium) at expiry, assuming it moves with the implied volatility you are selling.',
    'It is the chance of a loss as the option market prices it.',
    'Informational. Read it next to the same probability at realised volatility: the gap between the two is the premium you are being paid for.',
  ),
  'option.lossProbRv': h(
    'The probability that the stock closes below the breakeven at expiry, assuming it moves with the volatility it actually realised over the last 30 trading days instead of the implied volatility.',
    'If this is lower than the implied-vol probability, the market is pricing more risk than the stock has shown and the seller is paid for the difference; if it is higher, the premium is thin for the moves the stock has been making.',
    'Informational. A lower number than option.lossProbIv is in the seller’s favour.',
  ),
  'liquidity.spread': h(
    'The gap between the bid and ask price as a share of the middle price.',
    'A wide gap means you give away a lot when you trade.',
    '10% or less passes in the US, 15% in Hong Kong.',
  ),
  'liquidity.oi': h(
    'Open interest: how many contracts of this option exist.',
    'More contracts means easier trading and a fairer price.',
    'At least 100 in the US, 50 in Hong Kong.',
  ),
  'liquidity.oiUnknown': h(
    'The open interest is not known for this contract.',
    'Liquidity cannot be confirmed.',
    'Check it in your broker before selling.',
  ),
  'liquidity.bid': h(
    'There is no bid for the contract.',
    'Nobody is currently willing to buy it, so you could not sell it at a decent price.',
    'The contract is skipped.',
  ),

  // ------------------------------------------------------------------ rank and sizing
  'rank.warnMultiplier': h(
    'Each rule that raised a warning multiplies the final score by 0.85.',
    'It pushes names with several weaknesses down the list without removing them.',
    'Shown once with the warnings that caused it.',
  ),
  'rank.conviction': h(
    'Your own 1 to 5 conviction for the stock adds a small bonus.',
    'It lets your view break ties between similar ideas.',
    'Informational.',
  ),
  'rank.weightsRenormalised': h(
    'A part of the score had no data, so the remaining weights were scaled up.',
    'The ranking is built from fewer ingredients.',
    'Informational.',
  ),
  'rank.dataWarningsNotPenalised': h(
    'Data-quality notes are shown but do not lower the score.',
    "A missing input is not the stock's fault.",
    'Informational.',
  ),
  'portfolio.alreadyOpen': h(
    'You already have an open put on this stock.',
    'Another one would double up the risk.',
    'It is not recommended again while open.',
  ),
  'size.perNameCap': h(
    'The most you may commit to one stock, as a share of equity.',
    'It stops one failure from hurting the whole account.',
    'Notional is strike times contract size. Fails when one contract is already above the cap.',
  ),
  'size.regimeCap': h(
    'The most of your equity that may be tied up in puts in this market, set by the market regime.',
    'Shrinks automatically when the market looks dangerous.',
    '50% for US bull_calm, 30% for Hong Kong bear_calm, and so on. "Used up" means nothing is left.',
  ),
  'size.sectorCap': h(
    'How many open puts you already have in the same sector.',
    'Stocks in one sector fall together.',
    'Fewer than 3 per sector.',
  ),
  'size.reducedSize': h(
    'The position was reduced (halved) because of a risk flag such as earnings or a price below the 200-day average.',
    'More risk, smaller bet.',
    'Informational.',
  ),
  'size.drawdownTier': h(
    'The portfolio’s drawdown (how far its cumulative P&L sits under its peak, as a share of equity) has reached one of the de-gear tiers you set in Settings.',
    'Losing streaks are when a put seller does the most damage by pressing on; a tier cuts every new position mechanically instead of leaving it to mood.',
    'The size multiplier of the deepest tier reached applies to every new put. A multiplier of 0 means no new puts until the drawdown recovers.',
  ),
  'size.dailyLossHalt': h(
    'The drawdown governor has halted new puts: today’s P&L (closes booked today plus the change in the marks of open puts) is past the daily loss limit, or the last closes were losses in a row up to the halt count.',
    'A bad day or a losing run is the worst time to add risk; the halt makes every idea wait until tomorrow.',
    'Nothing is recommended today. Limits are set in Settings; the halt clears on the next session with a better day or a winning close.',
  ),
  'size.governorFx': h(
    'Some recorded puts are in a currency with no exchange rate to your base currency.',
    'Their P&L cannot be added into the day P&L or the drawdown, so the governor may under-count a loss.',
    'A data note. Run ingest for FX.',
  ),
  'size.noContract': h('No contract was chosen, so nothing can be sized.', 'There is no trade.', 'Informational.'),
  'size.noEquity': h('Your equity is not set.', 'Sizing needs it.', 'Set it in Settings.'),
  'size.noFx': h(
    'An exchange rate is missing.',
    'Notional in your base currency cannot be computed.',
    'Run ingest for FX.',
  ),

  // ------------------------------------------------------------------ data and system
  'data.stale': h(
    'An input (prices, FX, a chain) is older than the last trading day.',
    'Old data can mislead. The name is held back.',
    'Run ingest. Use "allow stale" only knowingly.',
  ),
  'fx.missing': h(
    'The currency rate needed for this stock is missing.',
    'Risk in your base currency cannot be added up.',
    'Run ingest for FX.',
  ),
  'skill.error': h(
    'An internal analysis step failed for this stock.',
    'That part of the analysis is not available.',
    'Report it: it is a bug, not a market signal.',
  ),
};

export const KPI_HELP: Record<string, Help> = {
  roe5: h(
    "Return on equity: yearly profit divided by shareholders' equity, averaged over 5 years.",
    "It shows how well the business turns owners' money into profit.",
    'Above 15% is good, above 20% is great. Very high figures can come from low equity or buybacks.',
  ),
  roe10: h(
    'The same return on equity, averaged over 10 years.',
    'A long average shows durability through a full cycle.',
    '8% or more passes the quality screen.',
  ),
  roic: h(
    'Return on invested capital: after-tax operating profit divided by equity plus debt minus cash (median).',
    'It is the best single sign of a business that creates value with the money it uses.',
    'Higher is better. Compare it with the cost of capital, roughly 8 to 10%.',
  ),
  gross_margin: h(
    'Sales minus the direct cost of goods, as a share of sales, over the long run.',
    'A high margin suggests pricing power and a stronger moat.',
    'Above 40% suggests pricing power. 15% or more passes the screen.',
  ),
  operating_margin: h(
    'Operating profit as a share of sales.',
    'It shows how much of each sale is left after running costs.',
    'Context only. Compare with peers and over time.',
  ),
  net_margin: h(
    'Net profit as a share of sales, over the long run.',
    'It is what finally reaches shareholders.',
    '5% or more passes the screen.',
  ),
  fcf_yield: h(
    'Free cash flow divided by market value.',
    "It is the cash return you would get if you owned the whole company at today's price.",
    '4% or more passes the scan gate. Low yields are normal for high-growth stocks.',
  ),
  ocf_ni: h(
    'Cash from operations divided by reported net profit.',
    'It tests whether profits are backed by real cash.',
    '0.7 or more passes. Persistently below 1 deserves a question.',
  ),
  capex_revenue: h(
    'Capital spending as a share of sales.',
    'Capital-hungry businesses keep less cash for owners.',
    'Context only. Lighter is better.',
  ),
  interest_cover: h(
    'Operating profit divided by interest expense.',
    'It measures how safely debt is serviced.',
    '2 times or more passes. Huge values mean almost no debt.',
  ),
  net_debt_ebitda: h(
    'Debt minus cash divided by EBITDA.',
    'It is roughly the years of earnings needed to repay debt.',
    'Net cash is best, up to 3 passes.',
  ),
  debt_ni: h(
    'Interest-bearing debt divided by net profit.',
    'How many years of profit it would take to clear the debt.',
    'Under 3 years is comfortable.',
  ),
  altman_z: h(
    'A bankruptcy-risk score built from five ratios.',
    'You do not want shares of a failing company.',
    'Above 2.99 safe, 1.81 to 2.99 grey, below 1.81 distress.',
  ),
  f_score: h(
    'Piotroski score: nine pass/fail checks on profitability, leverage and efficiency.',
    'A broad health check.',
    '6 or more of 9 passes.',
  ),
  revenue_cagr3: h(
    'Average yearly sales growth over 3 years.',
    'Growth supports the share price. Shrinking sales are a warning.',
    '0% or more passes.',
  ),
  revenue_cagr5: h(
    'Average yearly sales growth over 5 years.',
    'It smooths out a single good or bad year.',
    'Context only.',
  ),
  eps_cagr5: h(
    'Average yearly growth of earnings per share over 5 years.',
    'It feeds the intrinsic value estimate.',
    'Context only. Very high growth rarely lasts.',
  ),
  dilution: h(
    'How much the share count changed over the window.',
    'More shares dilute your slice. Fewer shares (buybacks) help.',
    '20% or less passes. Negative means buybacks.',
  ),
  pe: h(
    "Price divided by the last 12 months' earnings per share.",
    'The most common measure of how expensive a stock is.',
    'Compared with its own history: cheap at or below the 33rd percentile, expensive above the 66th.',
  ),
  pb: h(
    'Price divided by book value per share.',
    'Useful for banks and asset-heavy firms.',
    'Context only. Below 1 can mean cheap or troubled.',
  ),
  p_fcf: h(
    'Price divided by free cash flow per share.',
    'The cash version of the P/E.',
    'Context only. Lower is cheaper.',
  ),
  dividend_yield: h(
    'Yearly dividend divided by the price.',
    'Cash you receive while you own the shares.',
    'Context only.',
  ),
  earnings_yield: h(
    'Earnings per share divided by price (the P/E upside down).',
    'It can be compared directly with bond yields.',
    'Context only.',
  ),
  payout: h(
    'The share of profit paid out as dividends.',
    'A very high payout leaves nothing to grow and may force a cut.',
    'Above 100% is not sustainable.',
  ),
  buyback_yield: h(
    'Money spent on buying back shares divided by market value.',
    'Buybacks return cash and shrink the share count.',
    'Context only.',
  ),
};

export function ruleHelp(rule: string): Help | null {
  return RULE_HELP[rule] ?? null;
}

export function kpiHelp(key: string): Help | null {
  return KPI_HELP[key] ?? null;
}
