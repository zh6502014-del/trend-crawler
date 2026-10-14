"""Attention proxy: how many Hacker News story titles mention the company in the last 30 days.

Uses the free, documented HN Search API (hn.algolia.com). It is a rough proxy: most small caps score zero,
and that is the point, because zero means nobody in the tech crowd is talking about them yet.
"""
from __future__ import annotations

import re
import time

import requests

from . import config as cfg

HN_URL = "https://hn.algolia.com/api/v1/search_by_date"
_SUFFIX = re.compile(
    r"\b(inc|incorporated|corp|corporation|co|company|ltd|limited|holdings?|group|plc|llc|lp|nv|sa|ag|"
    r"class [a-c]|common stock|ordinary shares)\b\.?",
    re.I,
)


def clean_name(name: str | None) -> str | None:
    if not name:
        return None
    n = _SUFFIX.sub(" ", name)
    n = re.sub(r"[^\w\s&'-]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n if len(n) >= 3 else None


def hn_mentions(session: requests.Session, name: str, since_ts: int) -> int | None:
    q = clean_name(name)
    if not q:
        return None
    r = session.get(
        HN_URL,
        params={
            "query": f'"{q}"',
            "tags": "story",
            "numericFilters": f"created_at_i>{since_ts}",
            "restrictSearchableAttributes": "title",
            "hitsPerPage": 0,
        },
        timeout=20,
    )
    r.raise_for_status()
    return int(r.json().get("nbHits", 0))


def fetch_all(names: dict[str, str], now_ts: int | None = None) -> dict[str, int | None]:
    """{ticker: company name} → {ticker: mentions or None if the lookup failed}."""
    now_ts = now_ts or int(time.time())
    since = now_ts - cfg.HN_WINDOW_DAYS * 86400
    out: dict[str, int | None] = {}
    s = requests.Session()
    s.headers["User-Agent"] = "trend-crawler/1.0 (personal research)"
    fails = 0
    for t, name in names.items():
        try:
            out[t] = hn_mentions(s, name, since)
            fails = 0
        except Exception:
            out[t] = None
            fails += 1
            if fails >= 15:  # source is down: stop, leave the rest as unknown (NaN), not as zero
                for rest in names:
                    out.setdefault(rest, None)
                print("  HN: too many failures, giving up for this run")
                break
        time.sleep(cfg.HN_PAUSE)
    return out
