---
id: 19
title: Direction and vega are independent axes; a put sale needs a yes on both
severity: HIGH
appliesTo: sell-put, structure, iv-low, iv-high
source: himself65/trade-skills pitfall 19 (MIT), adapted to this app
---

A bullish view is not a bullish structure. Direction (would I own the shares lower) and vega (do I want to be short
volatility) are two separate axes. A cash-secured put is always long delta and short vega, so a put sale needs two yeses: yes,
I would accept assignment at this strike, and yes, implied vol is worth selling here. One yes is a reason to do something else,
not a reason to sell the put.

Low rank (`vol.ivRank` under 30) favours long vega: vol tends to mean-revert upward and the credit is thin. High rank (over 70)
favours short vega. In the middle either can be right. The app marks the thin case as a `vol.ivRank` WARN or FAIL.

**Scope limit.** Rank selects the vega side; it does not certify edge. A high-rank name can still be a losing sale when implied
keeps landing below the realised that follows (`vol.vrpForward` negative). Run pitfall 36 before trusting the short-vega half of
this rule.

**How to apply**

1. Split the question. "Should I sell this put" is two questions: would I accept assignment (S1's quality gate, the thesis
   note) and is the vol worth selling (S3). Answer both, separately.
2. When the pushback is about vega ("IV is low"), do not flip direction; when it is about direction ("the chart broke"), do not
   argue vega. Answer the axis the pushback is on.
3. If S1 and S2 say yes but S3 says `vol.noEdge`, the answer is wait, not a smaller size.
4. A red mark on an open put is not evidence against the direction when every direction Reason still holds; it may be the vega
   axis moving (pitfall 21).
