---
id: hk-multiplier
title: The HK option contract multiplier is not always the stock board lot
appliesTo: HK, size, notional, assignment
source: this app (docs/00-overview.md D8, data/hk-board-lots.csv)
---

On HKEX the option contract size equals the stock board lot only where the exchange set them equal. For nine of the fourteen
names in `data/hk-board-lots.csv` they differ: SMIC 2500 against a 500-share board lot, BYD 500, Xiaomi 1000, China Vanke
1000, Meituan 500, JD 500, Baidu 150, Trip.com 150, Alibaba 500 (checked against moomoo OpenD on 2026-10-12). The app uses the
contract size as the multiplier everywhere: credit, collateral and full notional are strike times contract size times
contracts, and S6 counts that notional against equity. A Futu chain import refuses a name whose feed multiplier differs from the
file.

**How to apply**

1. "One contract" of a Hong Kong name can be several board lots of shares at assignment; say the share count when assignment
   comes up.
2. Compare notional, never contract counts, across Hong Kong and US names.
3. If the user quotes a lot size that differs from the app's multiplier, the app's number wins for the arithmetic, and the
   file is the thing to check.
