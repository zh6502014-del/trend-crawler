"""Valuation backtest: does "cheap relative to revenue" (and growth) predict returns?  US and Taiwan.

Method (monthly, cross-sectional, point-in-time):
  at each month-end t, using only what was public at t:
    PS      = market cap / trailing-twelve-month revenue
    growth  = year-over-year growth of the latest 3 months (Taiwan, monthly revenue) or the latest quarter (US)
  factors (higher = better):  cheap (-log PS), growth, growth_cheap (average rank of the two), psg (-PS / growth)
  then look at the return from t to t+1, t+3 (and t+6) months: rank IC and quintile returns.

Honest limits (also written into the output):
  * universe = companies that exist today (survivorship bias); prices are not adjusted for dividends (Taiwan) ;
  * Taiwan market cap uses today's share count;  * US price history is only about 2 years deep on the free plan;
  * overlapping windows and few months => weak statistics.  Treat it as evidence, not proof.

Run:  python -m crawler.backtest us|tw   (needs network; Taiwan sites and SEC are reachable from GitHub Actions)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import time

import numpy as np
import pandas as pd
import requests

HORIZONS = (1, 3, 6)          # months ahead
FACTORS = ("cheap", "growth", "growth_cheap", "psg")
OUT_DIR = "backtest/results"


# ── generic helpers ─────────────────────────────────────────────────────────

def month_ends(start: dt.date, end: dt.date) -> list[dt.date]:
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
        out.append(nxt - dt.timedelta(days=1))
        y, m = nxt.year, nxt.month
    return [d for d in out if start <= d <= end]


def _rank(s: pd.Series) -> pd.Series:
    return s.rank(pct=True)


def add_factors(df: pd.DataFrame) -> pd.DataFrame:
    """df has ps (price-to-sales) and growth per row of ONE date. Adds the four factors."""
    d = df.copy()
    d = d[(d["ps"] > 0) & np.isfinite(d["ps"]) & np.isfinite(d["growth"])]
    d["growth"] = d["growth"].clip(-0.9, 5.0)
    d["cheap"] = -np.log(d["ps"])
    d["growth_cheap"] = (_rank(d["growth"]) + _rank(d["cheap"])) / 2
    d["psg"] = -(d["ps"] / d["growth"].clip(lower=0.05))
    return d


def spearman(x: pd.Series, y: pd.Series) -> float:
    ok = x.notna() & y.notna()
    if ok.sum() < 30:
        return np.nan
    return float(x[ok].rank().corr(y[ok].rank()))


def evaluate(panel: pd.DataFrame, horizons=HORIZONS, factors=FACTORS) -> dict:
    """panel: one row per (date, ticker) with factor columns and fwd_{h}m returns."""
    res = {}
    for h in horizons:
        col = f"fwd_{h}m"
        if col not in panel:
            continue
        for f in factors:
            ics, spreads, quint = [], [], []
            for d, g in panel.groupby("date"):
                g = g.dropna(subset=[f, col])
                if len(g) < 50:
                    continue
                ics.append(spearman(g[f], g[col]))
                q = pd.qcut(g[f].rank(method="first"), 5, labels=False)
                means = g.groupby(q)[col].mean()
                if len(means) == 5:
                    quint.append(means.values)
                    spreads.append(means.iloc[4] - means.iloc[0])
            ics = [x for x in ics if pd.notna(x)]
            if len(ics) < 3:
                continue
            n = len(ics)
            res[f"{f}_{h}m"] = {
                "months": n,
                "ic_mean": round(float(np.mean(ics)), 4),
                "ic_t": round(float(np.mean(ics) / (np.std(ics, ddof=1) / np.sqrt(n))) if np.std(ics, ddof=1) > 0 else 0.0, 2),
                "ic_pos_share": round(float(np.mean([x > 0 for x in ics])), 3),
                "q1_to_q5": [round(float(x), 4) for x in np.mean(quint, axis=0)],
                "spread_q5_q1": round(float(np.mean(spreads)), 4),
                "spread_pos_share": round(float(np.mean([s > 0 for s in spreads])), 3),
                "universe_mean": round(float(panel[col].mean()), 4),
            }
    return res


def attach_forward(panel: pd.DataFrame, price: pd.DataFrame, dates: list[dt.date], horizons=HORIZONS) -> pd.DataFrame:
    """price: index = ticker, columns = month-end dates (close). Adds fwd_{h}m = price[t+h]/price[t]-1."""
    p = panel.copy()
    pos = {d: i for i, d in enumerate(dates)}
    for h in horizons:
        fw = []
        for d, t in zip(p["date"], p["ticker"]):
            i = pos.get(d)
            j = None if i is None or i + h >= len(dates) else dates[i + h]
            a = price.at[t, d] if t in price.index and d in price.columns else np.nan
            b = price.at[t, j] if j is not None and t in price.index else np.nan
            fw.append(b / a - 1 if pd.notna(a) and pd.notna(b) and a > 0 else np.nan)
        p[f"fwd_{h}m"] = fw
    return p


def write_result(name: str, result: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    result["generated"] = dt.datetime.now(dt.timezone.utc).isoformat()
    with open(f"{OUT_DIR}/{name}.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result.get("summary", {}), ensure_ascii=False, indent=1)[:3000])


# ── Taiwan ──────────────────────────────────────────────────────────────────

MOPS = "https://mopsov.twse.com.tw/nas/t21/{k}/t21sc03_{y}_{m}_0.html"
_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
_TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)


def _n(s: str):
    s = re.sub(r"<[^>]+>|&nbsp;|,|\s", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def parse_mops_month(html: str) -> dict:
    """{code: (this_month_revenue (thousand TWD), same_month_last_year)} from a MOPS monthly-revenue page."""
    out = {}
    for tr in _TR.findall(html):
        tds = _TD.findall(tr)
        if len(tds) < 5:
            continue
        code = re.sub(r"<[^>]+>|&nbsp;|\s", "", tds[0])
        if not re.match(r"^[1-9]\d{3}$", code):
            continue
        cur, ly = _n(tds[2]), _n(tds[4])
        if cur is not None:
            out[code] = (cur, ly)
    return out


def fetch_mops_month(year: int, month: int, session=None) -> dict:
    s = session or requests
    out = {}
    for k in ("sii", "otc"):
        url = MOPS.format(k=k, y=year - 1911, m=month)
        for attempt in range(3):
            try:
                r = s.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
                if r.status_code == 200:
                    out.update(parse_mops_month(r.content.decode("big5hkscs", "replace")))
                    break
                if r.status_code == 404:
                    break
            except requests.RequestException:
                pass
            time.sleep(3 * (attempt + 1))
        time.sleep(1.5)
    return out


def tw_panel(rev: dict, bars: dict, shares: dict, dates: list[dt.date]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """rev: {(y, m): {code: (cur, last_year)}}, bars: {date: {code: [close, shares, value, issued]}}."""
    price = pd.DataFrame({d: {k: v[0] for k, v in bars[d].items() if k != "_TAIEX"} for d in dates})
    rows = []
    for d in dates:
        if d not in bars or not bars[d]:
            continue
        # revenue public by the 10th of the next month: at month-end t use months up to t-1 ... (t itself is not yet out)
        y, m = d.year, d.month
        months = []
        for k in range(1, 14):
            mm = m - k
            yy = y + (mm - 1) // 12
            mm = (mm - 1) % 12 + 1
            months.append((yy, mm))
        last12 = months[:12]
        last3 = months[:3]
        for code, bar in bars[d].items():
            if code == "_TAIEX" or not re.match(r"^[1-9]\d{3}$", code):
                continue
            sh = shares.get(code)
            px = bar[0]
            if not sh or px < 10 or bar[2] < 5e6:     # price >= 10 TWD, traded value that day >= 5M TWD
                continue
            try:
                ttm = sum(rev[ym][code][0] for ym in last12)
                cur3 = sum(rev[ym][code][0] for ym in last3)
                ly3 = sum(rev[ym][code][1] for ym in last3)
            except KeyError:
                continue
            if ttm <= 0 or not ly3 or ly3 <= 0:
                continue
            cap = px * sh
            if not 1.6e9 <= cap <= 3.2e11:
                continue
            rows.append({"date": d, "ticker": code, "ps": cap / (ttm * 1000.0), "growth": cur3 / ly3 - 1})
    return pd.DataFrame(rows), price


def run_tw() -> int:
    from . import tw

    s = requests.Session()
    dates = month_ends(dt.date(2021, 1, 1), dt.date.today().replace(day=1) - dt.timedelta(days=1))
    bars: dict = {}
    real_dates = []
    for d in dates:           # last trading day on or before the month-end
        for back in range(0, 6):
            day = d - dt.timedelta(days=back)
            if day.weekday() >= 5:
                continue
            try:
                b = tw.fetch_day(day, s)
            except Exception as e:  # noqa: BLE001
                print(f"  {day}: {str(e)[:80]}")
                b = None
            if b:
                bars[d] = b           # keyed by the month-end label
                real_dates.append(d)
                break
    print(f"tw prices: {len(bars)}/{len(dates)} month-ends")
    ym = sorted({(d.year + (d.month - k - 1) // 12, (d.month - k - 1) % 12 + 1) for d in dates for k in range(0, 14)})
    rev = {}
    for y, m in ym:
        rev[(y, m)] = fetch_mops_month(y, m, s)
        print(f"  revenue {y}-{m:02d}: {len(rev[(y, m)])} companies")
    _, shares_map, _ = tw.load_fundamentals(s)
    panel, price = tw_panel(rev, bars, shares_map, real_dates)
    panel = attach_forward(panel, price, real_dates)
    panel = pd.concat([add_factors(g) for _, g in panel.groupby("date")])
    result = {"market": "tw", "dates": [str(d) for d in real_dates], "rows": int(len(panel)),
              "summary": evaluate(panel),
              "limits": ["universe = companies listed today (survivorship bias)", "prices are not adjusted for dividends",
                         "market cap uses today's share count", "overlapping windows; months are not independent"]}
    write_result("tw_valuation", result)
    return 0


# ── United States ───────────────────────────────────────────────────────────

def us_quarters(cf: dict) -> tuple[list, list]:
    """-> (quarters [(end, filed, revenue)], shares [(filed, count)]) with the date each figure became public."""
    from .fundamentals import REVENUE_TAGS, _date, _facts

    best: list = []
    for _, rows in _facts(cf, REVENUE_TAGS):
        first: dict = {}
        for r in rows:
            if not r.get("start") or not r.get("filed"):
                continue
            days = (_date(r["end"]) - _date(r["start"])).days
            if 80 <= days <= 100:
                k = (r["start"], r["end"])
                if k not in first or r["filed"] < first[k][0]:
                    first[k] = (r["filed"], float(r["val"]))
        q = sorted((_date(e), _date(f), v) for (s, e), (f, v) in first.items())
        if q and (not best or (q[-1][0], len(q)) > (best[-1][0], len(best))):
            best = q
    sh = []
    for _, rows in _facts(cf, ("EntityCommonStockSharesOutstanding",), unit="shares", taxonomy="dei"):
        for r in rows:
            if r.get("filed") and r.get("val"):
                sh.append((_date(r["filed"]), float(r["val"])))
    return best, sorted(sh)


def us_point(q: list, sh: list, d: dt.date):
    """Public-at-d view: (ttm revenue, latest-quarter yoy growth, shares) or None."""
    pub = [(e, v) for e, f, v in q if f <= d]
    if len(pub) < 5:
        return None
    pub.sort()
    last4 = pub[-4:]
    if (d - last4[-1][0]).days > 200:
        return None
    ttm = sum(v for _, v in last4)
    prev = [v for e, v in pub if 350 <= (last4[-1][0] - e).days <= 380]
    if not prev or prev[0] <= 0:
        return None
    shares = [c for f, c in sh if f <= d]
    if not shares or ttm <= 0:
        return None
    return ttm, last4[-1][1] / prev[0] - 1, shares[-1]


def run_us() -> int:
    from . import config as cfg
    from . import prices, universe

    key = os.environ["MASSIVE_API_KEY"]
    s = requests.Session()
    dates = month_ends(dt.date(2024, 11, 1), dt.date.today().replace(day=1) - dt.timedelta(days=1))
    bars: dict = {}
    for d in dates:
        for back in range(0, 5):
            day = d - dt.timedelta(days=back)
            if day.weekday() >= 5:
                continue
            b = prices._fetch_day(s, day, key)
            time.sleep(13)
            if b:
                bars[d] = {x["T"]: x for x in b if "T" in x}
                break
    real = [d for d in dates if d in bars]
    print(f"us prices: {len(real)}/{len(dates)} month-ends")
    last = bars[real[-1]]
    uni = universe.get_universe()
    cands = [t for t in uni["ticker"] if t in last and last[t].get("c", 0) >= 2 and last[t]["c"] * last[t].get("v", 0) >= 2e5]
    print(f"us candidates: {len(cands)}")
    from .fundamentals import COMPANYFACTS
    ciks = dict(zip(uni["ticker"], uni.get("cik", pd.Series(dtype=float)))) if "cik" in uni else {}
    facts = {}
    for i, t in enumerate(cands):
        cik = ciks.get(t)
        if not cik or pd.isna(cik):
            continue
        try:
            r = s.get(COMPANYFACTS.format(cik=int(cik)), headers=cfg.sec_headers(), timeout=60)
            if r.status_code == 200:
                facts[t] = us_quarters(r.json())
        except requests.RequestException:
            pass
        time.sleep(0.13)
        if i % 500 == 0:
            print(f"  facts {i}/{len(cands)}")
    rows = []
    price = pd.DataFrame({d: {t: v.get("c") for t, v in bars[d].items()} for d in real})
    for d in real:
        for t, (q, sh) in facts.items():
            bar = bars[d].get(t)
            if not bar or bar.get("c", 0) < 2:
                continue
            pt = us_point(q, sh, d)
            if not pt:
                continue
            ttm, g, shares = pt
            cap = bar["c"] * shares
            if not 5e7 <= cap <= 1e10 or bar["c"] * bar.get("v", 0) < 2e5:
                continue
            rows.append({"date": d, "ticker": t, "ps": cap / ttm, "growth": g})
    panel = pd.DataFrame(rows)
    panel = attach_forward(panel, price, real, horizons=(1, 3))
    panel = pd.concat([add_factors(g) for _, g in panel.groupby("date")])
    result = {"market": "us", "dates": [str(d) for d in real], "rows": int(len(panel)),
              "summary": evaluate(panel, horizons=(1, 3)),
              "limits": ["universe = companies listed today (survivorship bias)", "only about 24 monthly observations (price history is ~2 years on the free plan)",
                         "overlapping windows; months are not independent", "shares outstanding from the cover page of each filing"]}
    write_result("us_valuation", result)
    return 0


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which == "tw":
        return run_tw()
    if which == "us":
        return run_us()
    print("usage: python -m crawler.backtest us|tw")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
