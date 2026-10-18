"""Per-company fundamentals from SEC EDGAR XBRL "companyfacts" (official, free, no API key).

One request per company (https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json), cached for a week.
XBRL gives quarterly revenue / gross profit / net income, cash, debt, equity and the cover-page share count.
It does NOT give analyst counts, institutional ownership or sector (left empty; the score ignores them).
Market cap is price x shares, computed in run.py.
"""
from __future__ import annotations

import datetime as dt
import time

import pandas as pd
import requests

from . import config as cfg
from .store import utcnow

COMPANYFACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

REVENUE_TAGS = ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet")
GROSS_PROFIT_TAGS = ("GrossProfit",)
COST_TAGS = ("CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold")
NET_INCOME_TAGS = ("NetIncomeLoss", "ProfitLoss")
CASH_TAGS = ("CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents")
DEBT_TAGS = ("LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations")
EQUITY_TAGS = ("StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest")

_CIKS: dict[str, int] = {}  # ticker -> CIK, filled by refresh_cache


class RateLimited(Exception):
    pass


def _date(s: str) -> dt.date:
    return dt.date.fromisoformat(s[:10])


def _facts(cf: dict, tags, unit: str = "USD", taxonomy: str = "us-gaap") -> list[tuple[str, list[dict]]]:
    out = []
    node = (cf.get("facts") or {}).get(taxonomy) or {}
    for t in tags:
        rows = ((node.get(t) or {}).get("units") or {}).get(unit)
        if rows:
            out.append((t, rows))
    return out


def _dedupe(rows: list[dict]) -> dict[tuple, float]:
    """(start, end) -> value, keeping the most recently filed figure for each period."""
    best: dict[tuple, tuple[str, float]] = {}
    for r in rows:
        if r.get("val") is None or not r.get("end"):
            continue
        key = (r.get("start"), r["end"])
        filed = r.get("filed") or ""
        if key not in best or filed >= best[key][0]:
            best[key] = (filed, float(r["val"]))
    return {k: v for k, (_, v) in best.items()}


def quarterly_series(rows: list[dict]) -> list[tuple[dt.date, float]]:
    """Flow items (revenue, income): 3-month values, plus Q4 derived as fiscal year minus the 9-month figure."""
    d = _dedupe(rows)
    quarters: dict[dt.date, float] = {}
    for (start, end), v in d.items():
        if not start:
            continue
        days = (_date(end) - _date(start)).days
        if 80 <= days <= 100:
            quarters[_date(end)] = v
    for (start, end), v in d.items():  # Q4 = annual - nine months
        if not start:
            continue
        days = (_date(end) - _date(start)).days
        if not 350 <= days <= 380 or _date(end) in quarters:
            continue
        for (s2, e2), v2 in d.items():
            if s2 == start and 255 <= (_date(e2) - _date(s2)).days <= 285 and 80 <= (_date(end) - _date(e2)).days <= 100:
                quarters[_date(end)] = v - v2
                break
    return sorted(quarters.items())


def _best_quarterly(cf: dict, tags) -> list[tuple[dt.date, float]]:
    """Of several candidate tags, take the one that reaches the most recent quarter (then the longest history)."""
    best: list[tuple[dt.date, float]] = []
    for _, rows in _facts(cf, tags):
        s = quarterly_series(rows)
        if s and (not best or (s[-1][0], len(s)) > (best[-1][0], len(best))):
            best = s
    return best


def _latest_instant(cf: dict, tags, taxonomy: str = "us-gaap", unit: str = "USD"):
    best = None
    for _, rows in _facts(cf, tags, unit=unit, taxonomy=taxonomy):
        for r in rows:
            if r.get("start") or r.get("val") is None:
                continue
            key = (r["end"], r.get("filed") or "")
            if best is None or key > best[0]:
                best = (key, float(r["val"]))
    return None if best is None else best[1]


def _shares(cf: dict):
    rows = []
    for _, r in _facts(cf, ("EntityCommonStockSharesOutstanding",), unit="shares", taxonomy="dei"):
        rows += r
    if not rows:
        return None
    last = max(r["end"] for r in rows)
    vals = [float(r["val"]) for r in rows if r["end"] == last and r.get("val")]
    return max(vals) if vals else None  # several share classes report separately: the largest is a floor, not a sum


def parse_companyfacts(cf: dict, today: dt.date | None = None) -> dict:
    """Pure function: SEC companyfacts JSON -> the fields we score on."""
    today = today or dt.date.today()
    rev = _best_quarterly(cf, REVENUE_TAGS)
    shares = _shares(cf)
    out = {"ok": False, "name": cf.get("entityName"), "sector": None, "industry": None, "country": None,
           "mkt_cap": None, "shares_out": shares, "analyst_count": None, "inst_pct": None,
           "gross_margin": None, "profit_margin": None, "debt_to_equity": None, "rev_yoy": None,
           "rev_streak": None, "quarters": 0, "runway_months": None}
    if not rev or shares is None or (today - rev[-1][0]).days > 550:
        return out

    out["ok"] = True
    rev = rev[-8:]
    out["quarters"] = len(rev)
    last_end, last_rev = rev[-1]

    streak = 0
    for i in range(len(rev) - 1, 0, -1):  # consecutive sequential increases, newest first, no gaps
        gap = (rev[i][0] - rev[i - 1][0]).days
        if gap <= 120 and rev[i][1] > rev[i - 1][1]:
            streak += 1
        else:
            break
    out["rev_streak"] = streak

    for end, val in rev[:-1]:  # same quarter one year earlier
        if abs((last_end - end).days - 365) <= 20 and val > 0:
            out["rev_yoy"] = last_rev / val - 1

    if last_rev > 0:
        gp = dict(_best_quarterly(cf, GROSS_PROFIT_TAGS))
        cost = dict(_best_quarterly(cf, COST_TAGS))
        if last_end in gp:
            out["gross_margin"] = gp[last_end] / last_rev
        elif last_end in cost:
            out["gross_margin"] = (last_rev - cost[last_end]) / last_rev
        ni = dict(_best_quarterly(cf, NET_INCOME_TAGS))
        if last_end in ni:
            out["profit_margin"] = ni[last_end] / last_rev
            cash = _latest_instant(cf, CASH_TAGS)
            if ni[last_end] < 0 and cash is not None:  # proxy: burn = net loss, not free cash flow
                out["runway_months"] = cash / (-ni[last_end] / 3)

    debt, equity = _latest_instant(cf, DEBT_TAGS), _latest_instant(cf, EQUITY_TAGS)
    if debt is not None and equity is not None and equity > 0:
        out["debt_to_equity"] = debt / equity * 100  # percentage
    return out


def fetch_fundamentals(ticker: str) -> dict:
    """Network call. Raises RateLimited so the caller can stop instead of hammering the SEC."""
    cik = _CIKS.get(ticker)
    if not cik:
        return {"ok": False}
    try:
        r = requests.get(COMPANYFACTS.format(cik=int(cik)), headers=cfg.sec_headers(), timeout=60)
        if r.status_code == 404:  # no XBRL financials (foreign filers, trusts): legitimately empty
            return {"ok": False}
        if r.status_code in (403, 429):
            raise RateLimited(f"SEC returned {r.status_code}")
        r.raise_for_status()
        return parse_companyfacts(r.json())
    except RateLimited:
        raise
    except Exception as e:
        return {"ok": False, "error": type(e).__name__}


def refresh_cache(store, tickers: list[str], now: dt.datetime | None = None, ciks: dict | None = None):
    """Load the cache, refresh missing/stale entries within budget, return ({ticker: data}, stats)."""
    if ciks:
        _CIKS.update({t: int(c) for t, c in ciks.items() if c is not None and not pd.isna(c)})
    now = now or utcnow()
    rows = store.select("fundamentals_cache", {"select": "ticker,fetched_at,data", "order": "ticker"})
    cache = {r["ticker"]: r for r in rows}
    ttl = dt.timedelta(days=cfg.FUNDAMENTALS_TTL_DAYS)
    max_age = dt.timedelta(days=cfg.FUNDAMENTALS_MAX_AGE_DAYS)

    def fetched_at(r):
        try:
            value = dt.datetime.fromisoformat(str(r["fetched_at"]).replace("Z", "+00:00"))
            return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
        except (KeyError, TypeError, ValueError):
            return dt.datetime.min.replace(tzinfo=dt.timezone.utc)

    def age_key(t: str):
        r = cache.get(t)
        if r is None:
            return (0, "")  # never fetched: first in line
        fetched = fetched_at(r)
        return (1, fetched.isoformat()) if now - fetched >= ttl else (2, "")

    due = sorted((t for t in tickers if cfg.FULL_REFRESH or age_key(t)[0] < 2), key=age_key)
    queue = due[: cfg.MAX_REFRESH_PER_RUN]
    stats = {"refreshed": 0, "failed": 0, "aborted_rate_limit": False, "queued": len(queue),
             "deferred": len(due) - len(queue), "expired": 0, "stale": 0, "missing": 0}
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
        if data.get("error"):  # transient failure: don't cache it for a week, retry next run
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

    out = {}
    for t in tickers:
        entry = cache.get(t)
        if not entry or not entry["data"].get("ok"):
            stats["missing"] += 1
            continue
        age = now - fetched_at(entry)
        if age < dt.timedelta(0) or age > max_age:
            stats["expired"] += 1
            continue
        stale = age >= ttl
        stats["stale"] += int(stale)
        out[t] = {**entry["data"], "fundamentals_fetched_at": fetched_at(entry).isoformat(),
                  "fundamentals_age_days": age.days, "fundamentals_source": "sec",
                  "fundamentals_stale": stale}
    return out, stats
