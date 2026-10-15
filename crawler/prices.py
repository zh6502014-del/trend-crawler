"""Daily prices from Massive (formerly Polygon.io) free plan, and the metrics we derive from them.

The "grouped daily" endpoint returns OHLCV for EVERY US stock on one date in a single call, so ~150 trading days of
history for the whole market costs ~150 calls (the free plan allows 5 calls/minute, so ~30 minutes).
Each fetched day is cached in Supabase (table price_days), so a normal run only fetches the 1-2 days it is missing.
"""
from __future__ import annotations

import datetime as dt
import os
import time

import numpy as np
import pandas as pd
import requests

from . import config as cfg

GROUPED_URL = "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{day}"
HISTORY_DAYS = 215   # calendar days (~150 trading days)


class PriceSourceError(RuntimeError):
    pass


def price_metrics(close: pd.Series, volume: pd.Series) -> dict | None:
    """Pure function: one ticker's daily close/volume → metrics. None if there isn't enough history."""
    close = pd.to_numeric(close, errors="coerce").dropna()
    if len(close) < 130:
        return None
    volume = pd.to_numeric(volume, errors="coerce").reindex(close.index)
    last = float(close.iloc[-1])

    def ret(n: int) -> float:
        return last / float(close.iloc[-1 - n]) - 1 if len(close) > n else np.nan

    high = float(close.iloc[-252:].max())
    dv = float((close * volume).iloc[-20:].mean())
    return {
        "price": last,
        "ret_1m": ret(21),
        "ret_3m": ret(63),
        "ret_6m": ret(126),
        "dist_high": last / high - 1,
        "dollar_vol": dv,
        "last_date": pd.Timestamp(close.index[-1]).date(),
    }


def parse_grouped(payload: dict) -> list[dict]:
    """One grouped-daily response -> [{T, c, v}]. Empty list on holidays."""
    return [{"T": r["T"], "c": r.get("c"), "v": r.get("v")} for r in (payload.get("results") or []) if r.get("T")]


def _fetch_day(session, day: dt.date, key: str):
    """Returns list of bars, [] for market holidays, None if the day is not published yet,
    raises PriceSourceError on auth/plan problems."""
    for attempt in range(4):
        r = session.get(GROUPED_URL.format(day=day.isoformat()), params={"adjusted": "true", "apiKey": key}, timeout=60)
        if r.status_code == 429:  # free plan: 5 calls/minute
            time.sleep(15 * (attempt + 1))
            continue
        if r.status_code == 403 and "before end of day" in r.text.lower():
            return None  # not published yet (free plan): skip it (and do not cache it), the previous day becomes as_of
        if r.status_code in (401, 403):
            raise PriceSourceError(f"Price API refused the request ({r.status_code}): check MASSIVE_API_KEY / plan. {r.text[:150]}")
        r.raise_for_status()
        return parse_grouped(r.json())
    raise PriceSourceError("Price API kept rate-limiting us (429).")


def frames_from_bars(by_day: dict[dt.date, list[dict]], tickers: list[str]):
    """{day: bars} -> (close DataFrame, volume DataFrame), columns = SPY + wanted tickers."""
    want = set(tickers) | {"SPY"}
    close: dict[dt.date, dict] = {}
    vol: dict[dt.date, dict] = {}
    for d, bars in by_day.items():
        if not bars:
            continue
        close[d] = {b["T"]: b["c"] for b in bars if b["T"] in want and b["c"] is not None}
        vol[d] = {b["T"]: b["v"] for b in bars if b["T"] in want and b["v"] is not None}
    c = pd.DataFrame.from_dict(close, orient="index").sort_index()
    v = pd.DataFrame.from_dict(vol, orient="index").sort_index()
    c.index = pd.to_datetime(c.index)
    v.index = pd.to_datetime(v.index)
    return c, v


def _load_cache(store, lo: dt.date) -> dict[dt.date, list[dict]] | None:
    """Cached days from Supabase, or None if the cache is unavailable (table missing etc.)."""
    if store is None:
        return None
    try:
        rows = store.select("price_days", {"select": "day,bars", "day": f"gte.{lo.isoformat()}"}, page=10)
    except Exception as e:  # noqa: BLE001 - the cache is an optimisation, never fatal
        print(f"  price cache unavailable ({str(e)[:120]}); fetching everything")
        return None
    out = {}
    for r in rows:
        out[dt.date.fromisoformat(str(r["day"])[:10])] = [{"T": t, "c": v[0], "v": v[1]} for t, v in (r["bars"] or {}).items()]
    return out


def _save_day(store, day: dt.date, bars: list[dict], want: set[str]) -> None:
    packed = {b["T"]: [b["c"], b["v"]] for b in bars if b["T"] in want and b["c"] is not None}
    try:
        store.upsert("price_days", [{"day": day.isoformat(), "bars": packed}], on_conflict="day")
    except Exception as e:  # noqa: BLE001
        print(f"  could not cache {day}: {str(e)[:120]}")


def load_prices(tickers: list[str], store=None):
    """Returns (metrics DataFrame indexed by ticker, {ticker: close Series}, as_of date, SPY 6m return)."""
    key = os.getenv("MASSIVE_API_KEY") or os.getenv("POLYGON_API_KEY")
    if not key:
        raise PriceSourceError("MASSIVE_API_KEY is not set (free key from massive.com).")
    today = dt.date.today()
    days = sorted(today - dt.timedelta(days=i) for i in range(1, HISTORY_DAYS) if (today - dt.timedelta(days=i)).weekday() < 5)
    want = set(tickers) | {"SPY"}
    full = os.getenv("FULL_REFRESH") == "1"          # full refresh = ignore the cache, but still refill it
    loaded = None if full else _load_cache(store, days[0])
    cache_ok = store is not None and (full or loaded is not None)
    cached = loaded or {}
    by_day: dict[dt.date, list[dict]] = {d: b for d, b in cached.items() if d in set(days)}
    todo = [d for d in days if d not in by_day]
    print(f"  price cache: {len(by_day)} days cached, {len(todo)} to fetch")
    s = requests.Session()
    for i, d in enumerate(todo):
        bars = _fetch_day(s, d, key)
        if bars is not None:
            by_day[d] = bars
            if cache_ok:
                _save_day(store, d, bars, want)
        if i < len(todo) - 1:
            time.sleep(cfg.PRICE_PAUSE)
    close, volume = frames_from_bars(by_day, tickers)
    if "SPY" not in close or close["SPY"].dropna().shape[0] < 130:
        raise PriceSourceError("Could not load enough SPY benchmark history from the price API.")
    spy_close = close["SPY"].dropna()

    rows: dict[str, dict] = {}
    closes: dict[str, pd.Series] = {}
    for t in tickers:
        if t not in close:
            continue
        m = price_metrics(close[t], volume[t] if t in volume else pd.Series(dtype=float))
        if m:
            rows[t] = m
            closes[t] = close[t].dropna()
    if not rows:
        raise PriceSourceError("No usable price history came back for any ticker.")

    as_of: dt.date = pd.Timestamp(spy_close.index[-1]).date()
    spy_6m = float(spy_close.iloc[-1] / spy_close.iloc[-127] - 1)
    df = pd.DataFrame.from_dict(rows, orient="index")
    df = df[df["last_date"].map(lambda d: (as_of - d).days <= 5)]  # drop stale quotes (halted / delisted)
    df["rs_6m"] = df["ret_6m"] - spy_6m
    closes = {t: closes[t] for t in df.index}
    print(f"  priced {len(df)} of {len(tickers)} tickers, as_of {as_of}, {len(todo)} days fetched")
    return df, closes, as_of, spy_6m
