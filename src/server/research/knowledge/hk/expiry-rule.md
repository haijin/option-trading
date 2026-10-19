---
id: hk-expiry
title: HK stock options expire on the business day before the last business day of the month
appliesTo: HK, expiry, dte, results
source: this app (docs/00-overview.md)
---

HKEX stock options expire on the business day before the last business day of the contract month, not on the third Friday as
in the US. The app's calendar computes that date with Hong Kong holidays, so `option.dte` and the DTE on the Positions page are
right; a broker screen or a memory of "end of month" can be a day or two off. The expiry day is also the last trading day.
Settlement is physical: an in-the-money put at expiry delivers shares in contract-size multiples (see the multiplier note).

**How to apply**

1. When a results date and an expiry are close, count the days from the app's expiry, not from month end.
2. Hong Kong stock options have no weekly or mid-month expiries; a question that assumes one is about a different market.
3. Monthly expiries mean the next expiry after a results date can be five weeks away; the app's `events.earningsWindow` rule and
   `option.dte` window decide together whether a put fits before or after the date.
