"""Daily prices from Stooq (free CSV, no Yahoo) and the metrics we derive from them."""
from __future__ import annotations

import datetime as dt
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

from . import config as cfg

STOOQ_URL = "https://stooq.com/q/d/l/"


class PriceSourceError(RuntimeError):
    pass


def price_metrics(close: pd.Series, volume: pd.Series) -> dict | None:
    """Pure function: one ticker's daily close/volume -> metrics. None if there isn't enough history."""
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


def parse_stooq_csv(text: str) -> pd.DataFrame | None:
    """Stooq CSV (Date,Open,High,Low,Close,Volume) -> DataFrame indexed by date. None for 'no data' replies.
    Raises PriceSourceError if Stooq answers with something that looks like an access wall instead of data."""
    head = (text or "").lstrip()[:300]
    if head.startswith("Date,"):
        df = pd.read_csv(io.StringIO(text), parse_dates=["Date"]).set_index("Date").sort_index()
        return df if {"Close", "Volume"} <= set(df.columns) else None
    low = head.lower()
    if "apikey" in low or "captcha" in low or "limit" in low:
        raise PriceSourceError(f"Stooq refused the request: {head[:120]!r}")
    return None  # 'No data' for an unknown symbol


def _fetch_one(sym: str, d1: str, d2: str) -> pd.DataFrame | None:
    params = {"s": f"{sym.lower()}.us", "i": "d", "d1": d1, "d2": d2}
    if os.getenv("STOOQ_APIKEY"):
        params["apikey"] = os.environ["STOOQ_APIKEY"]
    time.sleep(cfg.PRICE_PAUSE)
    r = requests.get(STOOQ_URL, params=params, timeout=30, headers={"User-Agent": "trend-crawler/1.0 (personal research)"})
    r.raise_for_status()
    return parse_stooq_csv(r.text)


def load_prices(tickers: list[str]):
    """Returns (metrics DataFrame indexed by ticker, {ticker: close Series}, as_of date, SPY 6m return)."""
    today = dt.date.today()
    d1, d2 = (today - dt.timedelta(days=420)).strftime("%Y%m%d"), today.strftime("%Y%m%d")
    syms = ["SPY"] + list(tickers)
    frames: dict[str, pd.DataFrame | None] = {}
    errors = 0

    def work(sym):
        try:
            return sym, _fetch_one(sym, d1, d2), None
        except PriceSourceError:
            raise
        except Exception as e:  # network hiccup on one symbol: skip it
            return sym, None, e

    with ThreadPoolExecutor(max_workers=cfg.PRICE_WORKERS) as ex:
        for i, (sym, df, err) in enumerate(ex.map(work, syms)):
            frames[sym] = df
            errors += err is not None
            if i == 39 and not any(f is not None for f in frames.values()):
                raise PriceSourceError("Stooq returned no data for the first 40 symbols; the source is blocked or changed.")

    spy = frames.get("SPY")
    if spy is None or len(spy) < 130:
        raise PriceSourceError("Could not load SPY benchmark prices from Stooq.")
    spy_close = pd.to_numeric(spy["Close"], errors="coerce").dropna()

    rows: dict[str, dict] = {}
    closes: dict[str, pd.Series] = {}
    for t in tickers:
        f = frames.get(t)
        if f is None:
            continue
        m = price_metrics(f["Close"], f["Volume"])
        if m:
            rows[t] = m
            closes[t] = pd.to_numeric(f["Close"], errors="coerce").dropna()
    if not rows:
        raise PriceSourceError("No usable price history came back for any ticker.")

    as_of: dt.date = pd.Timestamp(spy_close.index[-1]).date()
    spy_6m = float(spy_close.iloc[-1] / spy_close.iloc[-127] - 1)
    df = pd.DataFrame.from_dict(rows, orient="index")
    df = df[df["last_date"].map(lambda d: (as_of - d).days <= 5)]  # drop stale quotes (halted / delisted)
    df["rs_6m"] = df["ret_6m"] - spy_6m
    closes = {t: closes[t] for t in df.index}
    print(f"  priced {len(df)} of {len(tickers)} tickers, as_of {as_of}, request errors {errors}")
    return df, closes, as_of, spy_6m
