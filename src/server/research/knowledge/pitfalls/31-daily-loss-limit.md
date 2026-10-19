---
id: 31
title: A per-trade cap is not risk management without a loss limit, a streak halt and drawdown de-gearing
severity: HIGH
appliesTo: size, risk, drawdown, portfolio
source: himself65/trade-skills pitfall 31 (MIT), adapted to this app
---

A per-trade cap bounds one trade, not a week or a drawdown. Several correctly sized puts on correlated names (two US AI names,
two Hong Kong platform names, anything in the same index) are one bet with several tickets; when the read is wrong they go red
together. Eight disciplined stops in a row is minus 15% with a perfect rule-following record, and recovery is asymmetric: minus
20% needs plus 25%, minus 30% needs plus 43%.

Three governors, all needed:

- a weekly loss limit of two to three times the per-trade risk: when hit, no new puts until the next week;
- a consecutive-loss halt: three stops or assignments in a row, flat and a written review before the next sale;
- drawdown-tiered de-gearing: minus 5% from the equity high, size times 0.75; minus 10%, times 0.5; minus 15%, no new puts
  until a review.

The app sizes per name and per sector (`size.perNameCap`, `size.sectorCap`), caps deployment by regime (`size.regimeCap`) and
stops new puts in a crash (`regime.crashGuard`). It does not yet track a loss streak or a drawdown tier; that is stage T3 of the
integration design. Until then the user keeps the count, and you should ask for it when the question is about size.

**How to apply**

1. Count heat across open puts, not per put: sum the full notional of correlated names and compare it with the regime's deploy
   cap.
2. Convert the loss limit into a bullet count before the week: how many full-risk puts does it allow?
3. On a halt or a de-gear tier, the answer to "should I sell this one" is no, whatever the Reasons say about the name.
4. Never widen a stop, add size or lift the limit to recover a loss.
