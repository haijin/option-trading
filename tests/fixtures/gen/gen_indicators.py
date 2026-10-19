#!/usr/bin/env python
"""Golden-fixture generator for src/indicators.

WHAT IT DOES
  1. Generates a deterministic 500-bar OHLCV series  -> tests/fixtures/ohlcv_500.csv
  2. Computes reference indicator values with TA-Lib  -> tests/fixtures/golden/<name>.csv
  3. Computes Donchian, 5-bar fractal lows and Yang-Zhang volatility with clearly-commented pure-python
     reference implementations (TA-Lib has no such functions)  -> tests/fixtures/golden/<name>.csv

HOW TO REGENERATE (Windows, PowerShell or bash; Python 3.10+)
    py -m pip install TA-Lib numpy          # ta_lib 0.8.1 ships a cp314 win_amd64 wheel on PyPI
    py tests/fixtures/gen/gen_indicators.py
  (use `python` instead of `py` if the launcher is not available)

RULES
  * Fixtures are generated ONCE and committed. Never hand-edit them. Re-running this script on the same
    Python/TA-Lib versions reproduces them byte for byte (the series only uses random.Random(42).random()).
  * Prices are rounded to 4 decimals BEFORE any indicator is computed, so the TypeScript tests read exactly
    the same numbers the reference saw. Golden values are written with repr() (shortest round-trip, full
    double precision). A blank cell means "undefined / warm-up" (TA-Lib returns NaN there).
  * The pure-python references below are deliberately written independently of the TypeScript code
    (different data flow, stdlib `statistics` / `math.fsum`), so a shared bug cannot hide.
"""

from __future__ import annotations

import datetime as dt
import math
import random
import statistics
from pathlib import Path

import numpy as np
import talib

FIXTURES = Path(__file__).resolve().parents[1]
GOLDEN = FIXTURES / "golden"
N_BARS = 500
SEED = 42
START_DATE = dt.date(2022, 1, 3)  # a Monday

# --------------------------------------------------------------------------------------------------------------
# 1. Synthetic OHLCV series
# --------------------------------------------------------------------------------------------------------------

# (first bar index, daily sigma): volatility regimes of a geometric random walk.
REGIMES = [(0, 0.009), (110, 0.018), (220, 0.007), (300, 0.030), (360, 0.012), (440, 0.020)]
DRIFT = 0.0003


def sigma_at(i: int) -> float:
    s = REGIMES[0][1]
    for start, sig in REGIMES:
        if i >= start:
            s = sig
    return s


def gauss(rng: random.Random) -> float:
    """Box-Muller; uses only rng.random() so the stream is stable across Python versions."""
    u1 = 1.0 - rng.random()  # (0, 1]
    u2 = rng.random()
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def weekdays(start: dt.date, n: int) -> list[dt.date]:
    out: list[dt.date] = []
    d = start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def make_series() -> dict[str, list]:
    rng = random.Random(SEED)
    dates = weekdays(START_DATE, N_BARS)
    o: list[float] = []
    h: list[float] = []
    lo: list[float] = []
    c: list[float] = []
    v: list[int] = []
    prev_close = 100.0
    for i in range(N_BARS):
        s = sigma_at(i)
        gap = 0.5 * s * gauss(rng)  # overnight gap, so Yang-Zhang's overnight term is non-trivial
        op = prev_close * math.exp(gap)
        cl = op * math.exp(DRIFT + 0.9 * s * gauss(rng))
        hi = max(op, cl) * math.exp(abs(0.6 * s * gauss(rng)))
        low = min(op, cl) * math.exp(-abs(0.6 * s * gauss(rng)))
        vol = int(1_000_000 * math.exp(0.4 * gauss(rng)) * (1.0 + 20.0 * s))
        op, hi, low, cl = (round(x, 4) for x in (op, hi, low, cl))
        hi = max(hi, op, cl)
        low = min(low, op, cl)
        o.append(op)
        h.append(hi)
        lo.append(low)
        c.append(cl)
        v.append(vol)
        prev_close = cl
    return {"date": dates, "open": o, "high": h, "low": lo, "close": c, "volume": v}


# --------------------------------------------------------------------------------------------------------------
# 2. Pure-python references (no TA-Lib equivalent)
# --------------------------------------------------------------------------------------------------------------


def donchian_reference(high: list[float], low: list[float], period: int):
    """Donchian channel: rolling max(high) / min(low) over the last `period` bars INCLUDING the current bar.
    Undefined (None) for the first period-1 bars."""
    upper: list[float | None] = [None] * len(high)
    lower: list[float | None] = [None] * len(low)
    for i in range(period - 1, len(high)):
        upper[i] = max(high[i - period + 1 : i + 1])
        lower[i] = min(low[i - period + 1 : i + 1])
    return upper, lower


def fractal_lows_reference(low: list[float]):
    """Williams-style 5-bar fractal low. Bar i is a fractal low iff low[i] is STRICTLY lower than the two bars
    before and the two bars after. Value = low[i], else None. The last two bars can never be confirmed."""
    n = len(low)
    out: list[float | None] = [None] * n
    for i in range(2, n - 2):
        if all(low[i] < low[j] for j in (i - 2, i - 1, i + 1, i + 2)):
            out[i] = low[i]
    return out


def yang_zhang_reference(op, hi, lo, cl, n: int, trading_days: int = 252):
    """Yang & Zhang (2000), "Drift-Independent Volatility Estimation Based on High, Low, Open, and Close
    Prices", Journal of Business 73(3). For a window of n bars ending at t (bar t-n+1 needs the previous close):

        o_i  = ln(O_i / C_{i-1})                          overnight (close-to-open) return
        c_i  = ln(C_i / O_i)                              open-to-close return
        rs_i = ln(H/C)ln(H/O) + ln(L/C)ln(L/O)            Rogers-Satchell term
        s2_o  = sample variance of o_i  (divisor n-1)
        s2_c  = sample variance of c_i  (divisor n-1)
        s2_rs = (1/n) * sum(rs_i)
        k     = 0.34 / (1.34 + (n+1)/(n-1))
        s2_yz = s2_o + k * s2_c + (1-k) * s2_rs
        vol   = sqrt(s2_yz * trading_days)

    First defined at index n (needs bar n-n=0's close as C_{i-1} of the first bar in the window)."""
    out: list[float | None] = [None] * len(cl)
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    for t in range(n, len(cl)):
        idx = range(t - n + 1, t + 1)
        overnight = [math.log(op[i] / cl[i - 1]) for i in idx]
        open_close = [math.log(cl[i] / op[i]) for i in idx]
        rs = [math.log(hi[i] / cl[i]) * math.log(hi[i] / op[i]) + math.log(lo[i] / cl[i]) * math.log(lo[i] / op[i]) for i in idx]
        var_o = statistics.variance(overnight)
        var_c = statistics.variance(open_close)
        var_rs = math.fsum(rs) / n
        out[t] = math.sqrt((var_o + k * var_c + (1.0 - k) * var_rs) * trading_days)
    return out


# --------------------------------------------------------------------------------------------------------------
# 3. Writers
# --------------------------------------------------------------------------------------------------------------


def cell(x) -> str:
    if x is None:
        return ""
    x = float(x)
    if math.isnan(x):
        return ""
    return repr(x)


def write_series_csv(path: Path, s: dict[str, list]) -> None:
    lines = ["date,open,high,low,close,volume"]
    for i in range(N_BARS):
        lines.append(
            ",".join(
                [
                    s["date"][i].isoformat(),
                    repr(s["open"][i]),
                    repr(s["high"][i]),
                    repr(s["low"][i]),
                    repr(s["close"][i]),
                    str(s["volume"][i]),
                ]
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def write_golden(name: str, dates: list[dt.date], columns: dict[str, object]) -> None:
    """One row per bar; `columns` maps header -> sequence (None / NaN = blank cell)."""
    GOLDEN.mkdir(parents=True, exist_ok=True)
    headers = list(columns.keys())
    lines = ["date," + ",".join(headers)]
    for i, d in enumerate(dates):
        lines.append(d.isoformat() + "," + ",".join(cell(columns[h][i]) for h in headers))
    (GOLDEN / f"{name}.csv").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def fmt(p: float) -> str:
    return f"{p:g}".replace(".", "p")


def main() -> None:
    s = make_series()
    write_series_csv(FIXTURES / "ohlcv_500.csv", s)

    dates = s["date"]
    op, hi, lo, cl = (np.asarray(s[k], dtype=np.float64) for k in ("open", "high", "low", "close"))

    # ---- TA-Lib references (TA-Lib defaults everywhere; MA type for BBANDS is SMA) ----------------------
    for p in (20, 50, 200):
        write_golden(f"sma_{p}", dates, {"value": talib.SMA(cl, timeperiod=p)})
    for p in (12, 26):
        write_golden(f"ema_{p}", dates, {"value": talib.EMA(cl, timeperiod=p)})
    for p in (14, 7):
        write_golden(f"rsi_{p}", dates, {"value": talib.RSI(cl, timeperiod=p)})
    for p in (14, 5):
        write_golden(f"atr_{p}", dates, {"value": talib.ATR(hi, lo, cl, timeperiod=p)})
    write_golden("trange", dates, {"value": talib.TRANGE(hi, lo, cl)})

    for fast, slow, sig in ((12, 26, 9), (8, 21, 5)):
        m, sg, hist = talib.MACD(cl, fastperiod=fast, slowperiod=slow, signalperiod=sig)
        write_golden(f"macd_{fast}_{slow}_{sig}", dates, {"macd": m, "signal": sg, "hist": hist})

    for p, k in ((20, 2.0), (10, 1.5)):
        up, mid, low_b = talib.BBANDS(cl, timeperiod=p, nbdevup=k, nbdevdn=k, matype=0)
        write_golden(f"bbands_{p}_{fmt(k)}", dates, {"upper": up, "middle": mid, "lower": low_b})

    for p in (14, 7):
        write_golden(
            f"adx_{p}",
            dates,
            {
                "adx": talib.ADX(hi, lo, cl, timeperiod=p),
                "plus_di": talib.PLUS_DI(hi, lo, cl, timeperiod=p),
                "minus_di": talib.MINUS_DI(hi, lo, cl, timeperiod=p),
            },
        )

    # ---- pure-python references -------------------------------------------------------------------------
    for p in (20, 55):
        up, dn = donchian_reference(s["high"], s["low"], p)
        write_golden(f"donchian_{p}", dates, {"upper": up, "lower": dn})
    write_golden("fractal_lows", dates, {"value": fractal_lows_reference(s["low"])})
    write_golden("yang_zhang_20", dates, {"value": yang_zhang_reference(s["open"], s["high"], s["low"], s["close"], 20)})

    print(f"wrote {FIXTURES / 'ohlcv_500.csv'} and {len(list(GOLDEN.glob('*.csv')))} golden files in {GOLDEN}")
    print(f"TA-Lib {talib.__version__}, numpy {np.__version__}")


if __name__ == "__main__":
    main()
