---
id: 30
title: Stop distance is an input from structure and volatility; size is the output
severity: HIGH
appliesTo: size, risk, sell-put, open-put
source: himself65/trade-skills pitfall 30 (MIT), adapted to this app
---

There is one causal order for sizing: invalidation level, then stop distance, then size equals risk budget divided by stop
distance times point value. Fixing size first ("I always sell five contracts") and back-solving the stop puts the stop at an
account-arithmetic distance that has nothing to do with the chart, usually inside the noise band, where ordinary oscillation
hits it and the thesis never had a chance to be wrong.

For a cash-secured put the "stop" is two things the app already prices:

- the cushion (`option.support`, the strike's distance under spot and under support): the structural level below which the put
  is no longer the put you wanted;
- the mark stop (the `stop2x` alert: buying back at twice the credit).

Size is the output: S6 sizes from full notional (strike times multiplier) against equity, with per-name, sector and regime caps
(`size.perNameCap`, `size.sectorCap`, `size.regimeCap`). Margin return is a display number only.

**How to apply**

1. Express the cushion in weekly moves or ATR, not in money. A 6% cushion on a name that moves 5% a week is a coin flip.
2. Never add to a losing put to lower the average credit. Under a fixed loss budget the second contract shrinks the room the
   first one had; averaging down tightens the noose it claims to loosen.
3. Treat the loss cap as a target, not a floor: an assignment on a gap lands far past the stop. Size so that a two-times
   overshoot is survivable.
4. Hong Kong multiplies this: the contract multiplier can be a multiple of the board lot, so one contract is more notional than
   one lot (see the HK multiplier note).
5. If the honest size rounds down to zero contracts (`size.noContract`), the trade is too big for the account. Skip it rather than
   tighten the cushion.
