# Data files

Three small CSV files ship with the repository. They are seed data, not market data: no prices, no quotes. **Verify any name against
your broker or the exchange before you rely on it; there is no warranty.**

| File | What it holds | Where it comes from |
|---|---|---|
| `hk-board-lots.csv` | The Hong Kong **option contract size** (shares per contract) per stock, which the app uses as the multiplier | Maintained by hand; some names were checked against moomoo OpenD on 2026-10-12 (see the comments at the top of the file) |
| `universe-us.csv` | The US universe for the Leaders page: S&P 500, Nasdaq-100 and S&P 400 members with a sector | Wikipedia constituent tables, fetched by `scripts/gen-universe-seed.ts` on 2026-10-13 |
| `universe-hk.csv` | The Hong Kong universe: HSI, HSCEI and HSTECH members, the Hang Seng Composite Index members that are known, and the HKEX stock board lot | Hang Seng Indexes and HKEX public pages, fetched by the same script on 2026-10-13 |

The option contract size in `hk-board-lots.csv` is **not** the stock board lot in the `stock_lot` column of `universe-hk.csv`. For many
names the exchange sets the option contract to a multiple of the board lot, and both numbers change over time.

## Sources in detail

- **US lists.** The Wikipedia pages "List of S&P 500 companies", "List of NASDAQ-100 companies" (falling back to "Nasdaq-100") and
  "List of S&P 400 companies", read through the Wikipedia API. Sectors are GICS (S&P lists) or the Nasdaq-100 ICB industry mapped to
  GICS names. A symbol can appear under more than one index.
- **Hong Kong lists.** The constituent lists of HSI, HSCEI and HSTECH that hsi.com.hk shows without a logon (stock code and an
  abbreviated name), and the public change log of the Hang Seng Composite Index. The composite's own list is behind a logon, so it is
  rebuilt by replaying that log, which starts at the 2008 review and lists changes only: 519 of the 581 constituents are known and the
  file says so in its header. The stock board lot comes from the HKEX "List of Securities".
- **Regenerating.** `pnpm tsx scripts/gen-universe-seed.ts` rebuilds both universe files from the live sources (network needed; it
  refuses to write if a source fails). With `--fixtures` it also records the trimmed responses that the universe tests replay.

## Licensing and attribution

The repository is under the MIT license (see `LICENSE`), with these exceptions for the data:

- **`universe-us.csv` reproduces Wikipedia's constituent tables** (names, symbols, sector labels). Wikipedia text is available under the
  [Creative Commons Attribution-ShareAlike 4.0 license](https://creativecommons.org/licenses/by-sa/4.0/). Attribution: Wikipedia
  contributors, the three pages named above. Changes: the tables were parsed into CSV and the Nasdaq-100 industry labels were mapped
  to GICS names. If you redistribute this file or a derivative of it, keep it under the same license.
- **`universe-hk.csv`** lists stock codes, names and board lots that Hang Seng Indexes and HKEX publish. The index names, marks and
  data rights belong to Hang Seng Indexes Company Limited and to HKEX; the lists are included as small factual references and will be
  removed on request.
- **`hk-board-lots.csv`** records facts about exchange-listed contracts, compiled by the repository owner, and is under the MIT license.

This project is not affiliated with or endorsed by Wikipedia, Hang Seng Indexes, HKEX or moomoo / Futu.

## Correcting a row

A wrong contract size or board lot is the most useful kind of issue: use the "Hong Kong contract specification correction" template
and include evidence (an HKEX page, or what your broker or OpenD shows, with the date).
