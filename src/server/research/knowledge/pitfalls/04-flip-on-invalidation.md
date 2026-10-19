---
id: 4
title: When a thesis precondition breaks, act; do not hold the put to get the credit back
severity: HIGH
appliesTo: open-put, close, roll, assignment
source: himself65/trade-skills pitfall 4 (MIT), adapted to this app
---

A thesis has preconditions. When one stops being true, the position is a sunk cost, not a view. Holding through invalidation
"to get the credit back" is the most expensive habit in premium selling, because the put that broke is the one with the fat
tail.

For a short put the preconditions are the Reasons the app wrote when it recommended the sale: the quality gate, the support
level, the vol edge, no dated result inside the expiry. Any of these can change after the fill: a results date appears
(`events.earningsBeforeExpiry`), the thesis tracker writes a red line, support breaks, `vol.vrpForward` flips as history
accrues.

**How to apply**

1. Write the preconditions at entry; the app's Reasons table is that list. Re-read it when news arrives.
2. If a precondition broke, the review is immediate. The choices are close, roll down and out, or accept assignment as a
   deliberate share purchase; state each in one line with what it costs now, and leave the choice to the user.
3. Reversing is not weakness; it is the skill. Averaging into a broken precondition is pitfall 30's corollary.
4. Distinguish a broken precondition from a red mark. A put marked against you while every Reason still holds is demand IV or
   noise (pitfall 21), not an invalidation; a put that is green while a precondition broke is still a problem.
