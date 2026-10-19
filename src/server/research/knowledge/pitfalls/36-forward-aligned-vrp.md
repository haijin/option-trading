---
id: 36
title: IV rank ranks vol against its own history; only the forward-aligned variance risk premium says whether selling it pays
severity: HIGH
appliesTo: sell-put, iv-high, iv-low, edge
source: himself65/trade-skills pitfall 36 (MIT), adapted to this app
---

IV rank answers one question: where today's implied vol sits inside this name's own past year. It does not answer the two
questions a put seller has. How much do I collect? That is the IV level and the credit (`option.annRoc`). Is what I collect
more than the vol that then shows up? That is the variance risk premium (VRP).

**The measurement trap.** Comparing today's IV with the realised vol of the last 20 days (`vol.vrp`, labelled trailing) pairs a
forecast of the next month with a measurement of the last one. The honest test is forward-aligned: IV on day t against realised
vol over [t, t+30]. The app computes it in S3 as `vol.vrpForward` (how many of the last ten non-overlapping windows had implied
above the realised that followed), `vol.vrpGap` (the mean gap in vol points) and `vol.vrpLive` (today's IV30 against the most
recent completed window). `vol.vrpUnmeasured` means the name lacks about fourteen months of real IV history: the question is
open, not answered, and no rank can close it.

Four cells, opposite instructions:

- high rank, VRP positive: the textbook sale;
- high rank, VRP negative: do not sell. Vol is high because the name keeps delivering it;
- low rank, VRP positive: sellable, the edge is real, size is the question (`vol.lowRankSize`);
- low rank, VRP negative: no premium sale.

**How to apply**

1. Read `vol.vrpForward` before `vol.ivRank`. Six or more of ten above is positive; six or more below is structurally negative,
   which the app turns into `vol.noEdge` when no dated result sits inside the expiry.
2. Read both loss probabilities: `option.lossProbIv` (priced at the IV sold) and `option.lossProbRv` (priced at recent
   realised). The gap between them is the size of the vol bet hidden inside the put.
3. Name what inflated the trailing window (a results gap, one bad day) and whether it recurs. Say it as a forecast, not a fact.
4. Keep rank in its lane: rank picks the vega side (pitfall 19), the VRP says whether there is edge, the IV level says what you
   collect. Three questions, three instruments.
5. The app models only the single cash-secured put. A negative VRP is a reason to wait, never a reason to sell smaller.
