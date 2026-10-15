"""Per-ticker fundamentals. Slow (2 Yahoo calls per name), so results are cached for a week."""
from __future__ import annotations

import datetime as dt
import time

import numpy as np
import pandas as pd

from . import config as cfg
from .store import utcnow


class RateLimited(Exception):
    pass


def _is_rate_limit(e: Exception) -> bool:
    s = f"{type(e).__name__} {e}".lower()
    return "ratelimit" in s or "too many requests" in s or "rate limit" in s or "429" in s


def _num(x):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if (np.isnan(f) or np.isinf(f)) else f


def _series(qis, labels) -> pd.Series | None:
    if qis is None or getattr(qis, "empty", True):
        return None
    for label in labels:
        if label in qis.index:
            row = qis.loc[label]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            s = pd.to_numeric(row, errors="coerce").dropna()
            if s.empty:
                continue
            s.index = pd.to_datetime(s.index)
            return s.sort_index()
    return None


def parse_fundamentals(info: dict, qis: pd.DataFrame | None) -> dict:
    """Pure function: Yahoo `info` dict + quarterly income statement → the fields we score on."""
    info = info or {}
    rev = _series(qis, ("Total Revenue", "Operating Revenue", "Revenue"))
    gp = _series(qis, ("Gross Profit",))

    rev_yoy = None
    streak = None
    quarters = 0
    gross_margin = _num(info.get("grossMargins"))
    if rev is not None and len(rev) >= 2:
        v = rev.values.astype(float)
        quarters = len(v)
        s = 0
        for i in range(len(v) - 1, 0, -1):  # consecutive sequential increases, newest first
            if v[i] > v[i - 1]:
                s += 1
            else:
                break
        streak = s
        if len(v) >= 5 and v[-5] > 0:
            rev_yoy = float(v[-1] / v[-5] - 1)
        if gp is not None and rev.index[-1] in gp.index and v[-1] > 0:
            gross_margin = float(gp.loc[rev.index[-1]] / v[-1])
    if rev_yoy is None:
        rev_yoy = _num(info.get("revenueGrowth"))

    cash, fcf = _num(info.get("totalCash")), _num(info.get("freeCashflow"))
    runway = float(cash / (-fcf / 12)) if (cash is not None and fcf is not None and fcf < 0) else None

    return {
        "ok": _num(info.get("marketCap")) is not None,
        "name": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "country": info.get("country"),
        "mkt_cap": _num(info.get("marketCap")),
        "shares_out": _num(info.get("sharesOutstanding")),
        "analyst_count": _num(info.get("numberOfAnalystOpinions")) or 0,
        "inst_pct": _num(info.get("heldPercentInstitutions")),
        "gross_margin": gross_margin,
        "profit_margin": _num(info.get("profitMargins")),
        "debt_to_equity": _num(info.get("debtToEquity")),
        "rev_yoy": rev_yoy,
        "rev_streak": streak,
        "quarters": quarters,
        "runway_months": runway,
    }


def fetch_fundamentals(ticker: str) -> dict:
    """Network call. Raises RateLimited so the caller can stop instead of hammering Yahoo."""
    import yfinance as yf

    try:
        tk = yf.Ticker(ticker)
        info = tk.info or {}
        try:
            qis = tk.quarterly_income_stmt
        except Exception as e:
            if _is_rate_limit(e):
                raise
            qis = None
        return parse_fundamentals(info, qis)
    except Exception as e:
        if _is_rate_limit(e):
            raise RateLimited(str(e)) from e
        return {"ok": False, "error": type(e).__name__}


def refresh_cache(store, tickers: list[str], now: dt.datetime | None = None) -> tuple[dict, dict]:
    """Load the cache, refresh missing/stale entries within budget, return ({ticker: data}, stats)."""
    now = now or utcnow()
    rows = store.select("fundamentals_cache", {"select": "ticker,fetched_at,data", "order": "ticker"})
    cache = {r["ticker"]: r for r in rows}
    ttl = dt.timedelta(days=cfg.FUNDAMENTALS_TTL_DAYS)

    def age_key(t: str):
        r = cache.get(t)
        if r is None:
            return (0, "")  # never fetched: first in line
        fetched = dt.datetime.fromisoformat(str(r["fetched_at"]).replace("Z", "+00:00"))
        return (1, fetched.isoformat()) if now - fetched >= ttl else (2, "")

    queue = sorted((t for t in tickers if age_key(t)[0] < 2), key=age_key)[: cfg.MAX_REFRESH_PER_RUN]
    stats = {"refreshed": 0, "failed": 0, "aborted_rate_limit": False, "queued": len(queue)}
    pending: list[dict] = []
    consecutive_fail = 0

    def flush():
        if pending:
            store.upsert("fundamentals_cache", list(pending), "ticker")
            pending.clear()

    for t in queue:
        try:
            data = fetch_fundamentals(t)
            consecutive_fail = 0
        except RateLimited:
            consecutive_fail += 1
            stats["failed"] += 1
            if consecutive_fail >= cfg.RATE_LIMIT_ABORT_AFTER:
                stats["aborted_rate_limit"] = True
                print("  fundamentals: rate-limited, stopping early (progress is saved)")
                break
            time.sleep(5)
            continue
        if data.get("error"):  # transient failure (network, parse): don't cache it for a week, retry next run
            stats["failed"] += 1
            time.sleep(cfg.REQUEST_PAUSE)
            continue
        entry = {"ticker": t, "fetched_at": now.isoformat(), "data": data}
        cache[t] = entry
        pending.append(entry)
        stats["refreshed"] += 1
        if len(pending) >= 50:
            flush()
        time.sleep(cfg.REQUEST_PAUSE)
    flush()

    out = {t: cache[t]["data"] for t in tickers if t in cache and cache[t]["data"].get("ok")}
    return out, stats
