---
id: 7
title: IV crush favours short premium, but a cash-secured put does not get to sit through the gap
severity: HIGH
appliesTo: results, iv-high, sell-put
source: himself65/trade-skills pitfall 7 (MIT), adapted to this app
---

A dated event (results, an index rebalance, a regulator's decision) pumps implied vol into the date and drains it the session
after. That drain is a mechanical gain for a short put and a loss for anyone long options, whatever direction the stock takes.

The put seller's version has a catch the original rule did not need: the event is also when the stock gaps. The app's S1 and S4
rules treat results inside the put's life as a block (`events.earningsWindow`, `events.earningsBeforeExpiry`,
`option.earningsExpiries`) because a cash-secured put has no defined-risk leg. A crush you collect through a 15% gap is not a
crush you keep.

**How to apply**

1. Check the results date first. `events.earningsUnknown` means the app does not know it, which is common for Hong Kong names
   whose dates free data misses. An unknown date is a reason to find the date, not to assume there is none.
2. Elevated IV with a result inside the expiry is event IV: it will crush, and the app does not sell through the date.
3. Elevated IV with the result after the expiry, and the rank still high, is the case this rule is for: the sale collects the
   pre-event ramp and is out before the gap.
4. Never read "high IV favours selling" as a strike or a size. It is a statement about the vega sign only (pitfall 19); whether
   the credit has edge is pitfall 36.
