---
id: 37
title: An IV floor with a result 30 to 60 days out is a ramp; a put sold there fights it
severity: HIGH
appliesTo: iv-low, results, timing, wait
source: himself65/trade-skills pitfall 37 (MIT), adapted to this app
---

When a name's IV sits in the bottom decile of its own year (`iv_percentile` at or under 10 in the IV row) and a dated result is
30 to 60 days out, the base rate is a ramp: IV rises into the event and realised vol over the pre-event window tends to exceed
the implied you could sell today. That is a long-vega regime. A put sold at the floor fights the ramp: the credit is the thinnest
of the year and the mark goes against you even when the stock does nothing.

**The trap inside the trap.** A trailing VRP measured in the post-results lull looks positive (implied beat realised for weeks),
and that is the window that just ended, not the one you would hold through.

The original rule goes on to express the long-vega view with calendars and debit spreads. This app models only the short put,
so for the put seller the rule reduces to timing.

**How to apply**

1. Gate: percentile at or under 10 and a result 30 to 60 days out. Without the result it is pitfall 21 territory; with the result
   inside 14 days the ramp is mostly in the price.
2. The answer at the floor is wait. The same strike pays more in two to four weeks, and by then the results date sits inside the
   window the app blocks anyway, so the real question is the expiry after the result.
3. Match the VRP window to the holding window. `vol.vrpForward` counts ten windows across the year; ask whether the recent ones
   fell in a lull.
4. Direction is untouched: the floor moves the vega side only (pitfall 19). Whether you would own the shares at the strike is
   S1's question.
