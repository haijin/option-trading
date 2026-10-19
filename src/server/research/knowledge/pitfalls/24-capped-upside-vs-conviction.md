---
id: 24
title: A short put caps the upside; it is the wrong tool for a view that says "going up a lot"
severity: HIGH
appliesTo: conviction, structure, sell-put, assignment
source: himself65/trade-skills pitfall 24 (MIT), adapted to this app
---

Beyond direction (pitfall 19) and vega there is a third axis: payoff shape. A structure can match the regime on both and still be
wrong because it caps the gain in the very scenario you are most convinced of. The original rule forbids Jade Lizards, iron
condors and calendars in a high-conviction bull setup. This app models only the cash-secured put, so the rule turns into a
question about the put itself.

A short put's upside is capped at the credit by construction. That is the right shape only when the view is "I would be glad to
own this lower, and I do not need the rally". When the honest view is "this is going up a lot" (a results beat likely, a theme
re-rating, a de-risked chart after a 20% drop, three of the last four results reactions positive), the put collects a few
percent and misses the move; the better expression is the shares, which the app does not model.

**How to apply**

1. Ask which conviction the user holds: "fine to own lower" (sell the put) or "going up a lot" (the put is the wrong tool, and
   the answer is to say so).
2. The counterfactual table is one line: what does the put make if the stock is up 20%, 35%, 50%? The credit, each time.
3. High conviction is not a reason to sell a bigger put; size is pitfall 30.
4. Assignment is the put seller's conviction test in reverse: a view that would make you buy the shares at the strike is the
   view a put wants (S1's "would I accept assignment").
