"""Actual monthly revenue history. Amounts are thousands of TWD.

MOPS archives contain this month's revenue and the same month last year. Cache
each exchange separately; a failed/empty response is never cached as zero.
fetched_at is observation time, NOT historical publication time. These archives
may contain revisions and must not be used as point-in-time backtest evidence.
"""
from __future__ import annotations

import datetime as dt
import math
import re
import time

import pandas as pd
import requests

from .backtest import MOPS, parse_mops_month

MONTHS = 18
METRICS = ("rev_3m_yoy", "rev_prev_3m_yoy", "rev_accel", "revenue_months", "revenue_streak_months",
           "revenue_as_of", "revenue_observed_at", "revenue_history_status")


def month(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) not in (5, 6):
        return None
    year, m = int(digits[:-2]), int(digits[-2:])
    if year < 1911:
        year += 1911
    return dt.date(year, m, 1) if 2000 <= year <= 2200 and 1 <= m <= 12 else None


def shift(day, n):
    serial = day.year * 12 + day.month - 1 + n
    return dt.date(serial // 12, serial % 12 + 1, 1)


def valid_pair(value):
    return (isinstance(value, (list, tuple)) and len(value) == 2
            and all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in value))


def fetch_month(day, exchange, session=None):
    url = MOPS.format(k="sii" if exchange == "TWSE" else "otc", y=day.year - 1911, m=day.month)
    response = (session or requests).get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=45)
    response.raise_for_status()
    rows = parse_mops_month(response.content.decode("big5hkscs", "replace"))
    rows = {k: list(v) for k, v in rows.items() if valid_pair(v)}
    if not rows:
        raise ValueError(f"No usable revenue rows: {exchange} {day}")
    return rows


def load_history(store, revdf, today=None, session=None):
    today = today or dt.date.today()
    latest = shift(today.replace(day=1), -1)
    dates = [shift(latest, -n) for n in range(MONTHS)]
    cached = store.select("tw_revenue_months", {"select": "*", "ym": f"gte.{dates[-1].isoformat()}"})
    have = {(r["exchange"], str(r["ym"])[:10]): r for r in cached}
    history, failed, fetched = {}, [], 0
    for day in dates:
        for exchange in ("TWSE", "TPEx"):
            key = (exchange, day.isoformat())
            row = have.get(key)
            # Refresh recent months weekly, older months quarterly to pick up revisions.
            ttl = 7 if day >= shift(latest, -1) else 90
            try:
                age = (today - dt.date.fromisoformat(row["fetched_at"][:10])).days if row else ttl
            except (ValueError, KeyError, TypeError):
                age = ttl
            if not row or not row.get("bars") or age >= ttl:
                try:
                    bars = fetch_month(day, exchange, session)
                    row = {"exchange": exchange, "ym": day.isoformat(), "bars": bars,
                           "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat()}
                    store.upsert("tw_revenue_months", [row], "exchange,ym")
                    fetched += 1
                except (requests.RequestException, ValueError, RuntimeError) as error:
                    failed.append(f"{exchange} {day:%Y-%m}: {str(error)[:100]}")
                finally:
                    time.sleep(3.2)
            if row and row.get("bars"):
                history[key] = row
    # The current official feed can be newer than the archive. Overlay actual
    # amounts only; do not reconstruct last-year revenue from rounded growth %.
    for ticker, r in revdf.iterrows():
        day = month(r.get("ym"))
        pair = [r.get("rev_month"), r.get("rev_prior")]
        if day is None or day > latest or not valid_pair(pair):
            continue
        key = (r.get("exchange"), day.isoformat())
        row = history.setdefault(key, {"bars": {}})
        row["fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        row["bars"][ticker] = pair
    return history, {"fetched": fetched, "failed": failed, "status": "partial" if failed else "ok"}


def metrics(ticker, exchange, ym, history, today=None):
    today = today or dt.date.today()
    end = month(ym)
    out = dict.fromkeys(METRICS)
    out.update(revenue_months=0, revenue_history_status="missing")
    if end is None or end >= today.replace(day=1):
        return out
    pairs, stamps = [], []
    for n in range(MONTHS):
        row = history.get((exchange, shift(end, -n).isoformat()), {})
        pair = row.get("bars", {}).get(ticker)
        if not valid_pair(pair):
            break  # Never bridge a missing month.
        pairs.append(pair)
        if row.get("fetched_at"):
            stamps.append(row["fetched_at"])
    out.update(revenue_months=len(pairs), revenue_as_of=end.isoformat(),
               revenue_observed_at=max(stamps) if stamps else None)
    if not pairs:
        return out
    streak = 0
    for cur, prior in pairs:
        if prior <= 0:  # Zero base is not a measurable growth rate.
            break
        if cur <= prior:
            break
        streak += 1
    out["revenue_streak_months"] = streak if pairs[0][1] > 0 else None

    def yoy(window):
        base = sum(p[1] for p in window)
        return sum(p[0] for p in window) / base - 1 if len(window) == 3 and base > 0 else None

    # Trailing-12-month revenue (thousand TWD); only when 12 consecutive months are on file.
    out["rev_ttm"] = sum(p[0] for p in pairs[:12]) if len(pairs) >= 12 else None
    out["rev_3m_yoy"] = yoy(pairs[:3])
    out["rev_prev_3m_yoy"] = yoy(pairs[3:6])
    if out["rev_3m_yoy"] is not None and out["rev_prev_3m_yoy"] is not None:
        out["rev_accel"] = out["rev_3m_yoy"] - out["rev_prev_3m_yoy"]
    out["revenue_history_status"] = ("stale" if end < shift(today.replace(day=1), -2)
                                     else "complete" if out["rev_accel"] is not None else "partial")
    return out


def enrich(revdf, history, today=None):
    extra = pd.DataFrame.from_dict({t: metrics(t, r.get("exchange"), r.get("ym"), history, today)
                                   for t, r in revdf.iterrows()}, orient="index")
    return revdf.join(extra)
