#!/usr/bin/env python3
"""Independent re-computation of tests/fixtures/journal/pnl-fixture.expected.json.

This script does NOT share code with src/providers/csv/journal.ts. It reads the fixture CSV with the standard `csv`
module and recomputes every leg with the `decimal` module (exact decimal arithmetic; ROUND_HALF_UP on a Decimal rounds
ties AWAY from zero, which is the rounding the importer specifies), following docs/01-methodology.md G2 and the
importer's processing order:

  1. read source rows, numbering DATA rows 1..n (header, comments and blank lines are not counted);
  2. resolve rolled_to_row against those source data-row numbers;
  3. merge same-day fills (same market, symbol, expiry, strike, open_date, close_date, outcome): contracts summed,
     credit and close_price contract-weighted averages rounded half up to 6 dp, fees summed;
  4. split partial closes (closed_contracts) into a closed leg and a remaining open leg; the opening fee is allocated
     round-half-up-to-the-cent to the closed leg and the remainder to the open leg.

P&L per leg = (credit - close_price) * multiplier * contracts - open_fees - close_fees, rounded half away from zero
to cents; assigned legs use credit - max(0, strike - underlying_close) instead of credit - close_price.

Usage (PowerShell):
  & "<python>" tests\\fixtures\\gen\\gen_journal_expected.py          # check
  & "<python>" tests\\fixtures\\gen\\gen_journal_expected.py --print  # print JSON
Exit code 0 when the recomputation equals the committed expected.json, 1 otherwise.
"""

import csv
import io
import json
import sys
from decimal import ROUND_HALF_UP, Decimal, getcontext
from pathlib import Path

getcontext().prec = 60
CENT = Decimal("0.01")
MICRO = Decimal("0.000001")

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "journal"
CSV_PATH = FIXTURES / "pnl-fixture.csv"
EXPECTED_PATH = FIXTURES / "pnl-fixture.expected.json"


def q(x: Decimal, unit: Decimal) -> Decimal:
    """Round to `unit`, ties away from zero."""
    return x.quantize(unit, rounding=ROUND_HALF_UP)


def d(text: str) -> Decimal:
    return Decimal(text)


def money6(x: Decimal | None) -> str | None:
    return None if x is None else format(q(x, MICRO), "f")


def money2(x: Decimal) -> str:
    r = q(x, CENT)
    return "0.00" if r == 0 else format(r, "f")


def canon_symbol(market: str, raw: str) -> str:
    s = raw.strip().upper()
    if market == "HK":
        if s.endswith(".HK"):
            s = s[:-3]
        s = s.lstrip("0")
        return s.rjust(4, "0")
    return s


def read_rows(path: Path):
    """Yield (data_row_number, physical_line, dict) skipping blank and comment lines."""
    text = path.read_text(encoding="utf-8")
    header = None
    n = 0
    for line_no, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        cells = next(csv.reader(io.StringIO(raw)))
        cells = [c.strip() for c in cells]
        if header is None:
            header = [c.lower() for c in cells]
            continue
        n += 1
        yield n, line_no, dict(zip(header, cells + [""] * (len(header) - len(cells))))


def build_source_rows():
    rows = []
    for n, line, c in read_rows(CSV_PATH):
        market = c["market"].upper()
        outcome = c["outcome"].lower()
        contracts = int(c["contracts"])
        cc = int(c["closed_contracts"]) if c.get("closed_contracts") else None
        if outcome == "open":
            closed_qty = cc if (cc is not None and cc < contracts) else 0
        else:
            closed_qty = cc if cc is not None else contracts
        carved = outcome == "open" and closed_qty > 0
        has_close = outcome != "open" or carved
        close_date = c["close_date"] or None
        if outcome == "expired" and not close_date:
            close_date = c["expiry"]
        if not has_close:
            close_date = None
        close_price = d(c["close_price"]) if (c["close_price"] and has_close and outcome not in ("assigned", "expired")) else None
        rows.append(
            {
                "d": n,
                "line": line,
                "market": market,
                "symbol": canon_symbol(market, c["symbol"]),
                "open_date": c["open_date"],
                "expiry": c["expiry"],
                "strike": d(c["strike"]),
                "multiplier": int(c["multiplier"]),
                "contracts": contracts,
                "credit": d(c["credit"]),
                "open_fees": d(c["open_fees"] or "0"),
                "close_date": close_date,
                "close_price": close_price,
                "close_fees": d(c["close_fees"] or "0") if has_close else Decimal(0),
                "outcome": outcome,
                "rolled_to_row": int(c["rolled_to_row"]) if c["rolled_to_row"] else None,
                "closed_qty": closed_qty,
                "spot": d(c["spot"]) if c.get("spot") else None,
                "underlying_close": d(c["underlying_close"]) if c.get("underlying_close") else None,
                "notes": c.get("notes") or None,
            }
        )
    return rows


def compute():
    rows = build_source_rows()
    by_d = {r["d"]: r for r in rows}

    # step 2: resolve roll links on SOURCE data-row numbers (before merge / split)
    for r in rows:
        t = r["rolled_to_row"]
        if t is not None:
            assert t in by_d and t != r["d"], f"unresolved rolled_to_row {t} on data row {r['d']}"
            assert (by_d[t]["market"], by_d[t]["symbol"]) == (r["market"], r["symbol"]), f"roll across symbols on data row {r['d']}"

    # step 3: merge same-day fills
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        key = (r["market"], r["symbol"], r["expiry"], r["strike"], r["open_date"], r["close_date"], r["outcome"])
        groups.setdefault(key, []).append(r)
    group_list = list(groups.values())
    group_of_row = {m["d"]: gi for gi, ms in enumerate(group_list) for m in ms}

    legs = []
    first_leg_of_group = {}
    for gi, ms in enumerate(group_list):
        first = ms[0]
        n_total = sum(m["contracts"] for m in ms)
        n_closed = sum(m["closed_qty"] for m in ms)
        credit = q(sum(m["credit"] * m["contracts"] for m in ms) / n_total, MICRO)
        if first["outcome"] == "expired":
            close_price = Decimal(0)
        elif first["outcome"] == "assigned" or n_closed == 0:
            close_price = None
        else:
            close_price = q(sum((m["close_price"] or Decimal(0)) * m["closed_qty"] for m in ms) / n_closed, MICRO)
        spot = q(sum(m["spot"] * m["contracts"] for m in ms) / n_total, MICRO) if all(m["spot"] is not None for m in ms) else None
        notes = " | ".join(dict.fromkeys(m["notes"] for m in ms if m["notes"])) or None
        open_fees = sum((m["open_fees"] for m in ms), Decimal(0))
        close_fees = sum((m["close_fees"] for m in ms), Decimal(0))
        u_close = next((m["underlying_close"] for m in ms if m["underlying_close"] is not None), None)
        targets = {group_of_row[m["rolled_to_row"]] for m in ms if m["rolled_to_row"] is not None}
        assert len(targets) <= 1, "rolledToConflict"
        rolled_group = next(iter(targets)) if targets else None

        common = dict(
            market=first["market"], symbol=first["symbol"], open_date=first["open_date"], expiry=first["expiry"],
            strike=first["strike"], multiplier=first["multiplier"], credit=credit, spot=spot, notes=notes,
            src_rows=[m["d"] for m in ms], lines=[m["line"] for m in ms],
        )
        first_leg_of_group[gi] = len(legs)
        if n_closed == 0:
            legs.append(dict(common, contracts=n_total, open_fees=open_fees, close_fees=Decimal(0), close_date=None,
                             close_price=None, outcome="open", rolled_group=rolled_group, underlying_close=u_close))
        elif n_closed >= n_total:
            legs.append(dict(common, contracts=n_total, open_fees=open_fees, close_fees=close_fees,
                             close_date=first["close_date"], close_price=close_price, outcome=first["outcome"],
                             rolled_group=rolled_group, underlying_close=u_close))
        else:  # step 4: split the partial close
            closed_fee = q(open_fees * n_closed / n_total, CENT)
            legs.append(dict(common, contracts=n_closed, open_fees=closed_fee, close_fees=close_fees,
                             close_date=first["close_date"], close_price=close_price,
                             outcome="closed" if first["outcome"] == "open" else first["outcome"],
                             rolled_group=rolled_group, underlying_close=u_close))
            legs.append(dict(common, contracts=n_total - n_closed, open_fees=open_fees - closed_fee,
                             close_fees=Decimal(0), close_date=None, close_price=None, outcome="open",
                             rolled_group=None, underlying_close=None))

    out_legs = []
    for i, leg in enumerate(legs):
        pnl_cents = None
        basis = None
        if leg["outcome"] != "open":
            if leg["outcome"] == "assigned":
                per_share = leg["credit"] - max(Decimal(0), leg["strike"] - leg["underlying_close"])
                basis = "mtm_at_assignment"
            else:
                per_share = leg["credit"] - leg["close_price"]
                basis = "cash"
            net = per_share * leg["multiplier"] * leg["contracts"] - leg["open_fees"] - leg["close_fees"]
            pnl_cents = int(q(net, CENT) * 100)
        out_legs.append(
            {
                "id": i,
                "srcRows": leg["src_rows"],
                "lines": leg["lines"],
                "market": leg["market"],
                "symbol": leg["symbol"],
                "openDate": leg["open_date"],
                "expiry": leg["expiry"],
                "strike": money6(leg["strike"]),
                "multiplier": leg["multiplier"],
                "contracts": leg["contracts"],
                "credit": money6(leg["credit"]),
                "closePrice": money6(leg["close_price"]),
                "openFeesCents": int(q(leg["open_fees"], CENT) * 100),
                "closeFeesCents": int(q(leg["close_fees"], CENT) * 100),
                "closeDate": leg["close_date"],
                "outcome": leg["outcome"],
                "rolledToLeg": None if leg["rolled_group"] is None else first_leg_of_group[leg["rolled_group"]],
                "spot": money6(leg["spot"]),
                "underlyingClose": money6(leg["underlying_close"]) if leg["outcome"] == "assigned" else None,
                "notes": leg["notes"],
                "pnlCents": pnl_cents,
                "pnl": None if pnl_cents is None else money2(Decimal(pnl_cents) / 100),
                "pnlBasis": basis,
            }
        )

    totals = []
    for market, currency in (("US", "USD"), ("HK", "HKD")):
        mine = [leg for leg in out_legs if leg["market"] == market]
        if not mine:
            continue
        cents = sum(leg["pnlCents"] or 0 for leg in mine)
        count = lambda status: sum(1 for leg in mine if leg["outcome"] == status)  # noqa: E731
        totals.append(
            {
                "market": market,
                "legs": len(mine),
                "open": count("open"),
                "closed": count("closed"),
                "expired": count("expired"),
                "assigned": count("assigned"),
                "rolled": count("rolled"),
                "realizedPnlCents": cents,
                "realizedPnl": money2(Decimal(cents) / 100),
                "currencyNote": currency,
            }
        )

    no_spot_lines = [r["line"] for r in rows if r["spot"] is None]
    return {"legs": out_legs, "totals": totals, "noSpotLines": no_spot_lines}


def main() -> int:
    computed = compute()
    if "--print" in sys.argv:
        print(json.dumps(computed, indent=2))
        return 0
    expected = json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))
    if computed == expected:
        print(f"OK: independent recomputation equals {EXPECTED_PATH.name} "
              f"({len(computed['legs'])} legs, {', '.join(t['market'] + ' ' + t['realizedPnl'] for t in computed['totals'])})")
        return 0
    print("MISMATCH between the recomputation and the committed expected.json:")
    for i, (a, b) in enumerate(zip(computed["legs"], expected["legs"])):
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key):
                print(f"  leg {i} {key}: recomputed={a.get(key)!r} committed={b.get(key)!r}")
    if len(computed["legs"]) != len(expected["legs"]):
        print(f"  leg count: recomputed={len(computed['legs'])} committed={len(expected['legs'])}")
    if computed["totals"] != expected["totals"]:
        print(f"  totals: recomputed={computed['totals']} committed={expected['totals']}")
    if computed["noSpotLines"] != expected["noSpotLines"]:
        print(f"  noSpotLines: recomputed={computed['noSpotLines']} committed={expected['noSpotLines']}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
