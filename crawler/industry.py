"""Industry labels from the SEC's own SIC codes (data.sec.gov/submissions/CIK##########.json).

SIC rarely changes, so each ticker is looked up once and kept in entities.industry (the SEC's description)
and entities.sector (a coarser group defined here). Only tickers still missing a label are fetched, within
a per-run budget, so the first runs fill the table gradually and later runs cost nothing.
"""
from __future__ import annotations

import time

import requests

from . import config as cfg

SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
BUDGET = 600  # lookups per run (~2 minutes at the SEC pause)

# (low, high, label): first match wins, so narrow ranges come before the broad ones
_GROUPS = [
    (6770, 6770, "空殼公司（SPAC）"),
    (2833, 2836, "生技與製藥"), (8731, 8731, "生技與製藥"),
    (3841, 3851, "醫療器材"), (3826, 3826, "醫療器材"), (8000, 8099, "醫療服務"),
    (3570, 3579, "電腦與硬體"), (3670, 3679, "半導體與電子"), (3600, 3669, "半導體與電子"), (3820, 3829, "半導體與電子"),
    (3661, 3669, "通訊設備"), (4800, 4899, "通訊與媒體"),
    (7370, 7379, "軟體與資訊服務"),
    (1311, 1389, "能源"), (2911, 2911, "能源"), (4900, 4991, "公用事業"), (3433, 3433, "能源"),
    (6000, 6499, "金融與保險"), (6500, 6599, "不動產"), (6700, 6799, "金融與保險"),
    (3711, 3799, "汽車與運輸設備"), (4000, 4799, "運輸與物流"),
    (5200, 5999, "零售與餐飲"), (5000, 5199, "批發"),
    (1000, 1299, "礦業與金屬"), (1400, 1499, "礦業與金屬"),
    (1500, 1799, "營建"),
    (100, 999, "農林漁"),
    (2000, 3999, "製造業"),
    (7000, 8999, "服務業"),
]


def sector_of(sic) -> str | None:
    try:
        n = int(sic)
    except (TypeError, ValueError):
        return None
    for lo, hi, label in _GROUPS:
        if lo <= n <= hi:
            return label
    return "其他"


def parse_submissions(payload: dict) -> dict:
    sic = payload.get("sic")
    desc = (payload.get("sicDescription") or "").strip() or None
    return {"sic": str(sic) if sic else None, "industry": desc, "sector": sector_of(sic)}


def fill(store, tickers, ciks: dict, budget: int = BUDGET) -> dict:
    """Return {ticker: {"sector", "industry"}} for every ticker we know, fetching a limited number of new ones."""
    known = {r["ticker"]: r for r in store.select("entities", {"select": "ticker,sector,industry"})
             if r.get("sector") or r.get("industry")}
    out = {t: {"sector": known[t].get("sector"), "industry": known[t].get("industry")} for t in tickers if t in known}
    todo = [t for t in tickers if t not in out and ciks.get(t) is not None]
    fetched = failed = 0
    s = requests.Session()
    if todo and budget > 0:
        s.headers.update(cfg.sec_headers())
    for t in todo[:budget]:
        time.sleep(cfg.SEC_PAUSE)
        try:
            r = s.get(SUBMISSIONS.format(cik=int(ciks[t])), timeout=30)
            if r.status_code in (403, 429):
                print(f"  industry: SEC returned {r.status_code}, stopping early")
                break
            if r.status_code == 404:
                failed += 1
                continue
            r.raise_for_status()
            p = parse_submissions(r.json())
            if p["sector"] or p["industry"]:
                out[t] = {"sector": p["sector"], "industry": p["industry"]}
                fetched += 1
        except Exception as e:  # noqa: BLE001 - labels are a nicety, never fatal
            failed += 1
            print(f"  industry {t} failed: {e!r}")
    print(f"  industry: {len(known)} known, {fetched} fetched, {failed} failed, {max(0, len(todo) - budget)} deferred")
    return out
