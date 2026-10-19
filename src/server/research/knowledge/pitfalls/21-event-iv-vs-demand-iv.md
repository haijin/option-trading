---
id: 21
title: Elevated IV with no dated event is demand IV and persists; event IV crushes on a calendar
severity: HIGH
appliesTo: iv-high, sell-put, results, open-put
source: himself65/trade-skills pitfall 21 (MIT), adapted to this app
---

Elevated IV has two sources with opposite futures. Event IV builds into a dated catalyst and mean-reverts hard after it. Demand IV
comes from a sustained bid for options on a name being re-rated (a theme, index inclusion, a crowd) and can persist or expand for
weeks with nothing on the calendar. Saying "IV is high, it must come down" without asking which one it is sells premium into a
bid that keeps rising.

The app has no options-flow feed, so the classification uses the catalyst clock and the term structure it stores:

- days to results under 14: event IV; it will crush, and the app does not sell through the date (pitfall 7);
- 14 to 45 days: mixed; event premium is building;
- over 45 days with `vol.ivRank` elevated: demand IV by default. `vol.term` (IV60 against IV30) helps: a front-heavy curve
  points at an event, a curve elevated at every tenor points at demand. `vol.backwardation` marks the front-heavy case.

**How to apply**

1. State the source before the sign. "Rank 72, results in 60 days, flat term structure" is demand IV.
2. Demand IV is where a high IV level coexists with a negative forward VRP (pitfall 36): the name keeps realising what it
   implies. Rank alone would wave the sale through.
3. A put sold into demand IV can be marked against you for weeks while nothing is wrong with the company: the thesis is intact
   and the mark is still red. Say that plainly when it applies, and do not call it an invalidation (pitfall 4).
4. The legitimate change of mind is the catalyst clock moving (a date appears inside the expiry) or the term structure
   flattening, both of which the app shows in the Reasons.
