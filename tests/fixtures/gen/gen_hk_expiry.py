"""
Independent oracle for the static exchange calendars (src/core/calendar-data.ts).

Uses the third-party `holidays` package (a different implementation from scripts/gen-calendars.ts, which derives the
HK lunar holidays from Node's ICU Chinese calendar) to write:
  tests/fixtures/hk_holidays_expected.csv   weekday HKEX closures 2010-2027
  tests/fixtures/us_holidays_expected.csv   weekday NYSE closures 2010-2027
  tests/fixtures/hk_expiry_expected.csv     HKEX monthly stock-option expiry for every month 2010-2027
                                            (business day immediately before the last business day of the month)

Regenerate:  py -m pip install holidays ; py tests/fixtures/gen/gen_hk_expiry.py
Never hand-edit the CSVs. Where the oracle and the TypeScript table disagree the test fails and the difference is
resolved by checking HKEX/NYSE circulars, then recorded in DECISIONS.md.
"""
import calendar
import csv
import datetime as dt
import pathlib

import holidays

OUT = pathlib.Path(__file__).resolve().parent.parent
YEARS = range(2010, 2028)

hk = holidays.HK(years=YEARS, categories=("public", "optional"))  # Easter holidays are "optional" in this package
nyse = holidays.financial_holidays("NYSE", years=YEARS)


def weekday_closures(h):
    return sorted(d for d in h if d.weekday() < 5)


# The `holidays` package lists the 2015-09-03 victory-anniversary holiday for HK; keep whatever it reports.
hk_days = weekday_closures(hk)
us_days = weekday_closures(nyse)


def write_days(name, days):
    with open(OUT / name, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["date"])
        for d in days:
            w.writerow([d.isoformat()])


write_days("hk_holidays_expected.csv", hk_days)
write_days("us_holidays_expected.csv", us_days)

hk_set = set(hk_days)


def is_trading(d):
    return d.weekday() < 5 and d not in hk_set


def last_business_day(y, m):
    d = dt.date(y, m, calendar.monthrange(y, m)[1])
    while not is_trading(d):
        d -= dt.timedelta(days=1)
    return d


def prev_business_day(d):
    d -= dt.timedelta(days=1)
    while not is_trading(d):
        d -= dt.timedelta(days=1)
    return d


with open(OUT / "hk_expiry_expected.csv", "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["month", "expiry"])
    for y in YEARS:
        for m in range(1, 13):
            w.writerow([f"{y}-{m:02d}", prev_business_day(last_business_day(y, m)).isoformat()])

print(f"hk weekday closures: {len(hk_days)}, us: {len(us_days)}")
