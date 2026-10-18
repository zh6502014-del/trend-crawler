"""Bulk daily prices via yfinance (unofficial Yahoo wrapper) and the metrics we derive from them."""
from __future__ import annotations

import datetime as dt
import time

import numpy as np
import pandas as pd

from . import config as cfg


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


def _split(raw: pd.DataFrame, batch: list[str]):
    """Yield (ticker, close, volume) from a yf.download frame, whatever shape it came back in."""
    if raw is None or raw.empty:
        return
    if isinstance(raw.columns, pd.MultiIndex):
        top = set(raw.columns.get_level_values(0))
        for t in batch:
            if t in top:
                sub = raw[t]
                if "Close" in sub and "Volume" in sub:
                    yield t, sub["Close"], sub["Volume"]
    elif len(batch) == 1 and "Close" in raw:
        yield batch[0], raw["Close"], raw["Volume"]


def load_prices(tickers: list[str], store=None):
    if cfg.PRICE_SOURCE == "massive":
        from .massive_prices import load_prices as load_massive
        return load_massive(tickers, store)
    if cfg.PRICE_SOURCE != "yahoo":
        raise ValueError("PRICE_SOURCE must be yahoo or massive")
    return _load_yahoo(tickers)


def validate_asof(as_of):
    age = (dt.datetime.now(dt.timezone.utc).date() - as_of).days
    if not 0 <= age <= cfg.PRICE_MAX_AGE_DAYS:
        raise RuntimeError(f"Price benchmark is stale or in the future: {as_of}")


def _load_yahoo(tickers: list[str]):
    """Returns (metrics DataFrame indexed by ticker, {ticker: close Series}, as_of date, SPY 6m return)."""
    import yfinance as yf

    rows: dict[str, dict] = {}
    closes: dict[str, pd.Series] = {}
    spy_close = None
    failed_batches = 0
    batches = [tickers[i : i + cfg.PRICE_CHUNK] for i in range(0, len(tickers), cfg.PRICE_CHUNK)]

    for i, batch in enumerate(batches):
        want = (["SPY"] + batch) if i == 0 else batch
        try:
            raw = yf.download(
                want, period="1y", interval="1d", auto_adjust=True,
                group_by="ticker", threads=True, progress=False,
            )
        except Exception as e:  # network hiccup / rate limit: skip this batch, keep going
            failed_batches += 1
            print(f"  price batch {i + 1}/{len(batches)} failed: {e!r}")
            time.sleep(5)
            continue
        for t, c, v in _split(raw, want):
            if t == "SPY":
                spy_close = pd.to_numeric(c, errors="coerce").dropna()
                continue
            m = price_metrics(c, v)
            if m:
                rows[t] = m
                closes[t] = pd.to_numeric(c, errors="coerce").dropna()
        time.sleep(1.0)

    if spy_close is None or len(spy_close) < 130:
        raise RuntimeError("Could not load SPY benchmark prices — Yahoo may be rate-limiting or down.")
    if not rows:
        raise RuntimeError("No price data came back for any ticker.")

    as_of: dt.date = pd.Timestamp(spy_close.index[-1]).date()
    validate_asof(as_of)
    spy_6m = float(spy_close.iloc[-1] / spy_close.iloc[-127] - 1)

    df = pd.DataFrame.from_dict(rows, orient="index")
    # Drop stale quotes (halted / delisted): last bar more than 5 days behind the benchmark.
    df = df[df["last_date"].map(lambda d: 0 <= (as_of - d).days <= 5)]
    df["rs_6m"] = df["ret_6m"] - spy_6m
    closes = {t: closes[t] for t in df.index}
    df.attrs["source_stats"] = {"source": "yahoo", "as_of": as_of.isoformat(),
                                "failed_batches": failed_batches, "return_basis": "splits_and_dividends"}
    print(f"  priced {len(df)} tickers, as_of {as_of}, failed batches {failed_batches}")
    return df, closes, as_of, spy_6m
