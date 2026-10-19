"""Incremental raw daily bars with split adjustments applied consistently at read time.

API contracts: https://massive.com/docs/rest/stocks/aggregates/daily-market-summary
and https://massive.com/docs/rest/stocks/corporate-actions/splits
"""
from __future__ import annotations

import datetime as dt
import os
import time
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from . import config as cfg
from .prices import price_metrics, validate_asof

BASE = "https://api.massive.com"


class PriceSourceError(RuntimeError):
    pass


class Client:
    def __init__(self, key):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {key}"
        self.last_request = None

    def get(self, url, params=None, allow_pending=False):
        # Never forward credentials to a host supplied by an unexpected pagination URL.
        if urlparse(url).scheme != "https" or urlparse(url).netloc != "api.massive.com":
            raise PriceSourceError("Unexpected Massive pagination host")
        for attempt in range(4):
            if self.last_request is not None:
                time.sleep(max(0, cfg.PRICE_PAUSE - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                r = self.session.get(url, params=params, timeout=60)
            except requests.RequestException:
                if attempt == 3:
                    raise PriceSourceError("Massive network request failed after retries") from None
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 403 and allow_pending and "before end of day" in r.text.lower():
                return None
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 15 * (attempt + 1)))
                continue
            if not r.ok:
                raise PriceSourceError(f"Massive HTTP {r.status_code}; check API key and plan access")
            payload = r.json()
            if payload.get("status") not in ("OK", "DELAYED"):
                raise PriceSourceError("Massive returned an unsuccessful response")
            return payload
        raise PriceSourceError("Massive retry budget exhausted")


def parse_grouped(payload):
    if payload.get("results") and payload.get("adjusted") is not False:
        raise PriceSourceError("Expected unadjusted daily bars for the raw price cache")
    return {r["T"]: [r.get("c"), r.get("v")] for r in (payload.get("results") or [])
            if r.get("T") and r.get("c") is not None}


def fetch_splits(client, lo, hi):
    url = BASE + "/stocks/v1/splits"
    params = {"execution_date.gte": lo.isoformat(), "execution_date.lte": hi.isoformat(),
              "limit": 5000, "sort": "execution_date.asc"}
    out, seen = [], set()
    while url:
        if url in seen:
            raise PriceSourceError("Repeated split pagination cursor")
        seen.add(url)
        page = client.get(url, params=params)
        out.extend(page.get("results", []))
        url, params = page.get("next_url"), None
    return out


def frames_from_bars(by_day, tickers, splits=()):
    want = set(tickers) | {"SPY"}
    close = pd.DataFrame.from_dict({d: {t: v[0] for t, v in bars.items() if t in want}
                                   for d, bars in by_day.items() if bars}, orient="index").sort_index()
    volume = pd.DataFrame.from_dict({d: {t: v[1] for t, v in bars.items() if t in want}
                                    for d, bars in by_day.items() if bars}, orient="index").sort_index()
    close.index, volume.index = pd.to_datetime(close.index), pd.to_datetime(volume.index)
    close, volume = close.astype(float), volume.astype(float)
    seen = set()
    for event in splits:
        t = event.get("ticker")
        if t not in close:
            continue
        # Apply each event once. Do not use cumulative factors as a per-event ratio.
        key = event.get("id") or (t, event.get("execution_date"), event.get("split_from"), event.get("split_to"))
        if key in seen:
            continue
        seen.add(key)
        try:
            ratio = float(event["split_from"]) / float(event["split_to"])
            day = pd.Timestamp(event["execution_date"])
            if not 0 < ratio < float("inf") or pd.isna(day):
                raise ValueError()
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            raise PriceSourceError("Invalid split event; refusing inconsistent price history") from None
        close.loc[close.index < day, t] *= ratio
        volume.loc[volume.index < day, t] /= ratio
    return close, volume


def load_prices(tickers, store=None):
    key = os.getenv("MASSIVE_API_KEY") or os.getenv("POLYGON_API_KEY")
    if not key:
        raise PriceSourceError("MASSIVE_API_KEY is required when PRICE_SOURCE=massive")
    # Fetch completed New York calendar days, independent of the execution host timezone.
    today = dt.datetime.now(ZoneInfo("America/New_York")).date()
    lo = today - dt.timedelta(days=cfg.PRICE_HISTORY_DAYS)
    days = [lo + dt.timedelta(days=i) for i in range((today - lo).days)
            if (lo + dt.timedelta(days=i)).weekday() < 5]
    rows = store.select("price_days", {"day": f"gte.{lo}", "order": "day"}, page=10) if store else []
    # All market tickers are cached, so changing the universe never creates false cache hits.
    cached = {dt.date.fromisoformat(r["day"]): r["bars"] for r in rows
              if r.get("format") == "massive_raw_v1" and not cfg.FULL_REFRESH}
    by_day = {d: cached[d] for d in days if d in cached}
    todo = [d for d in days if d not in by_day]
    client = Client(key)
    pending = 0
    for day in todo:
        result = client.get(BASE + f"/v2/aggs/grouped/locale/us/market/stocks/{day}",
                            params={"adjusted": "false"}, allow_pending=day == days[-1])
        if result is None:
            pending += 1
            continue
        bars = parse_grouped(result)
        # A recent empty response may not have been published yet. Retry on the next run.
        if not bars and (today - day).days <= 2:
            pending += 1
            continue
        by_day[day] = bars
        if store:
            store.upsert("price_days", [{"day": day, "bars": bars, "format": "massive_raw_v1"}], "day")
    close, volume = frames_from_bars(by_day, tickers, fetch_splits(client, lo, today - dt.timedelta(days=1)))
    if "SPY" not in close or close["SPY"].dropna().size < 130:
        raise PriceSourceError("Insufficient SPY benchmark history")
    spy = close["SPY"].dropna()
    as_of = spy.index[-1].date()
    validate_asof(as_of)
    spy_6m = float(spy.iloc[-1] / spy.iloc[-127] - 1)
    metrics, closes = {}, {}
    for t in tickers:
        if t not in close:
            continue
        m = price_metrics(close[t], volume[t])
        if m and 0 <= (as_of - m["last_date"]).days <= 5:
            metrics[t], closes[t] = m, close[t].dropna()
    if not metrics:
        raise PriceSourceError("No usable stock price history")
    df = pd.DataFrame.from_dict(metrics, orient="index")
    df["rs_6m"] = df["ret_6m"] - spy_6m
    df.attrs["source_stats"] = {"source": "massive", "as_of": as_of.isoformat(), "cached_days": len(cached),
                                "fetched_days": len(todo) - pending, "pending_days": pending,
                                "return_basis": "splits_only"}
    if store:
        store.delete("price_days", {"day": f"lt.{lo}"})
    return df, closes, as_of, spy_6m
