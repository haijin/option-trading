---
id: 13
title: Take-profit discipline beats holding a short put for the last cent of credit
severity: MEDIUM
appliesTo: open-put, close, roll, exit
source: himself65/trade-skills pitfall 13 (MIT), adapted to this app
---

In a volatile name, book 60 to 70% of the expected move rather than waiting for the full target. For a short put the mechanical
version is: buy it back at 50% of the credit received. The last half of the credit takes most of the remaining time and carries
all of the gap risk; the capital freed re-enters a new put at a fresh cushion.

The app already watches this: the `profit50` and `take_profit` alerts fire from the daily mark, and the Positions page shows the
share of credit captured and the days left. The `dte21` alert marks the point where gamma risk rises faster than theta pays.

**How to apply**

1. At 50% of credit captured with more than a third of the days left, the default is close; holding for the rest needs a written
   reason.
2. Under 21 days to expiry, close or roll rather than sit, unless the put is far out of the money and the mark says the rest is
   pennies.
3. Never wait for the theoretical maximum on a put whose life now crosses a dated event; the event rule (pitfall 7) wins.
4. A roll is a close plus a new sale: judge the new sale on its own Reasons (vol edge, results date, cushion), not on the loss it
   papers over. A roll that only moves a broken precondition forward is pitfall 4.
5. The decision is the user's; the app marks the level, it does not place the buy-back.
