"""Taiwan market (TWSE listed + TPEx OTC) – same idea as the US pipeline, official free data only.

Sources (all public open data, JSON):
  * per-date closing quotes of every stock: TWSE MI_INDEX and TPEx afterTrading/otc (also gives index level / shares issued)
  * monthly revenue incl. YoY %: TWSE t187ap05_L, TPEx mopsfin_t187ap05_O
  * shares issued / industry: TWSE t187ap03_L, TPEx mopsfin_t187ap03_O
Nothing here touches the US tables: everything is stored in tw_* tables.

score = same formula as score.compute_scores (growth × validated × accessibility, minus crowding), with
  * TWD thresholds (US thresholds × TWD_PER_USD),
  * revenue growth = latest monthly revenue YoY (monthly instead of quarterly),
  * validated = revenue-growth persistence only (Taiwan open data has no gross margin in these feeds),
  * crowding = trading value only (no Hacker News for Taiwan names).
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import re
import time

import numpy as np
import pandas as pd
import requests

from . import config as cfg
from . import score

TWD_PER_USD = 32.0
TWSE_DAY = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d}&type=ALLBUT0999&response=json"
TPEX_DAY = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date={d}&type=EW&response=json"
TWSE_REV = ["https://openapi.twse.com.tw/v1/opendata/t187ap05_L"]
TPEX_REV = ["https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O", "https://openapi.tpex.org.tw/v1/mopsfin_t187ap05_O"]
TWSE_CO = ["https://openapi.twse.com.tw/v1/opendata/t187ap03_L"]
TPEX_CO = ["https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"]
INDEX_NAME = "發行量加權股價指數"
BENCH = "_TAIEX"
HISTORY_DAYS = 215
PAUSE = 3.2           # TWSE throttles to roughly 3 requests per 5 seconds
UA = {"User-Agent": "Mozilla/5.0 (trend-crawler personal research)", "Accept": "application/json"}
CODE_OK = re.compile(r"^[1-9]\d{3}$")   # ordinary stocks: 4 digits (ETFs 00xx..., warrants 6 digits, etc. are excluded)

# Thresholds, in TWD. Mirrors config.py (US dollars) so the two markets are screened the same way.
TW_CFG = {
    "MIN_PRICE": 10.0,
    "MIN_DOLLAR_VOL": 300_000 * TWD_PER_USD,
    "MAIN_CAP_MIN": 50e6 * TWD_PER_USD,
    "MAIN_CAP_MAX": 10e9 * TWD_PER_USD,
    "CAP_SWEET_MAX": 2e9 * TWD_PER_USD,
    "ATTENTION_W": {"analyst_count": 0.0, "inst_pct": 0.0, "hn_mentions": 0.0, "dollar_vol": 1.0},
    "VALIDATED_W": {"streak": 1.0, "gross_margin": 0.0},
    "GROWTH_W": {"rev_yoy": 0.6, "rs_6m": 0.4},
}


@contextlib.contextmanager
def tw_thresholds():
    """Temporarily swap config values so score.compute_scores uses Taiwan thresholds."""
    old = {k: getattr(cfg, k) for k in TW_CFG}
    try:
        for k, v in TW_CFG.items():
            setattr(cfg, k, v)
        yield
    finally:
        for k, v in old.items():
            setattr(cfg, k, v)


def _num(v):
    if v is None:
        return None
    s = str(v).replace(",", "").replace("+", "").strip()
    if s in ("", "-", "--", "---", "X", "除息", "除權"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ── fetching ────────────────────────────────────────────────────────────────

def _get(url, session=None, tries: int = 4):
    """url may be a list of mirrors: each is tried in turn, `tries` rounds in total."""
    s = session or requests
    urls = [url] if isinstance(url, str) else list(url)
    last = None
    for i in range(tries):
        for u in urls:
            try:
                r = s.get(u, headers=UA, timeout=60)
                if r.status_code == 200:
                    return r.content.decode("utf-8", "replace")
                last = RuntimeError(f"HTTP {r.status_code}")
            except requests.RequestException as e:  # includes dropped connections and DNS hiccups
                last = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"{urls[0][:70]}…: {last!r}")


def load_json_list(text: str) -> list[dict]:
    """A JSON array of objects. If the connection was cut mid-way, salvage the complete objects."""
    try:
        v = json.loads(text)
        return v if isinstance(v, list) else []
    except json.JSONDecodeError:
        out, dec, i = [], json.JSONDecoder(), text.find("{")
        while 0 <= i < len(text):
            try:
                o, j = dec.raw_decode(text, i)
            except json.JSONDecodeError:
                break
            out.append(o)
            i = text.find("{", j)
        return out


def _field(row: dict, *needles: str):
    """Value of the first key containing one of the needles (field names differ a little between feeds)."""
    for n in needles:
        for k, v in row.items():
            if n in k:
                return v
    return None


# ── parsing: one trading day ────────────────────────────────────────────────

def _cols(fields: list[str]) -> dict:
    return {re.sub(r"<[^>]+>|\s", "", f): i for i, f in enumerate(fields)}


def parse_twse_day(payload: dict) -> dict | None:
    """-> {code: [close, shares_traded, value_twd, None], BENCH: [index_close,0,0,None]}; None on holidays."""
    if not isinstance(payload, dict) or payload.get("stat") != "OK":
        return None
    out: dict = {}
    for t in payload.get("tables") or []:
        title, f, data = t.get("title") or "", t.get("fields") or [], t.get("data") or []
        c = _cols(f)
        if "每日收盤行情" in title and "證券代號" in c and "收盤價" in c:
            for r in data:
                code = str(r[c["證券代號"]]).strip()
                close = _num(r[c["收盤價"]])
                if CODE_OK.match(code) and close:
                    out[code] = [close, _num(r[c["成交股數"]]) or 0, _num(r[c["成交金額"]]) or 0, None]
        elif c.get("指數") == 0 and "收盤指數" in c:
            for r in data:
                if str(r[0]).strip() == INDEX_NAME and _num(r[c["收盤指數"]]):
                    out[BENCH] = [_num(r[c["收盤指數"]]), 0, 0, None]
    return out if any(k != BENCH for k in out) else None


def parse_tpex_day(payload: dict) -> dict | None:
    """-> {code: [close, shares_traded, value_twd, shares_issued]}; None on holidays."""
    if not isinstance(payload, dict) or str(payload.get("stat", "ok")).lower() != "ok":
        return None
    out: dict = {}
    for t in payload.get("tables") or []:
        c = _cols(t.get("fields") or [])
        if "代號" in c and "收盤" in c and "成交股數" in c:
            for r in t.get("data") or []:
                code = str(r[c["代號"]]).strip()
                close = _num(r[c["收盤"]])
                if CODE_OK.match(code) and close:
                    out[code] = [close, _num(r[c["成交股數"]]) or 0, _num(r[c["成交金額(元)"]]) or 0,
                                 _num(r[c["發行股數"]]) if "發行股數" in c else None]
    return out or None


def fetch_day(day: dt.date, session=None) -> dict | None:
    """Both markets for one date, merged. None if the exchange was closed."""
    a = parse_twse_day(json.loads(_get(TWSE_DAY.format(d=day.strftime("%Y%m%d")), session)))
    time.sleep(PAUSE)
    b = parse_tpex_day(json.loads(_get(TPEX_DAY.format(d=day.strftime("%Y/%m/%d")), session)))
    time.sleep(PAUSE)
    if a is None and b is None:
        return None
    return {**(b or {}), **(a or {})}


# ── price cache + metrics ───────────────────────────────────────────────────

def load_prices(store, today: dt.date | None = None, max_new_days: int = 260, session=None):
    """Fetch the missing trading days (cached in tw_price_days). Returns {day: bars}."""
    today = today or dt.date.today()
    lo = today - dt.timedelta(days=HISTORY_DAYS)
    have: dict[dt.date, dict] = {}
    try:
        for r in store.select("tw_price_days", {"select": "day,bars", "day": f"gte.{lo.isoformat()}"}, page=10):
            have[dt.date.fromisoformat(str(r["day"])[:10])] = r["bars"] or {}
    except Exception as e:  # noqa: BLE001
        print(f"  tw price cache unavailable ({str(e)[:100]})")
    days = [lo + dt.timedelta(days=i) for i in range((today - lo).days + 1)]
    todo = [d for d in days if d.weekday() < 5 and d not in have][-max_new_days:]
    fetched = 0
    for d in reversed(todo):          # newest first, so a time-out still leaves the recent days
        try:
            bars = fetch_day(d, session)
        except Exception as e:  # noqa: BLE001
            print(f"  tw {d}: {str(e)[:100]}")
            continue
        have[d] = bars or {}
        fetched += 1
        try:
            store.upsert("tw_price_days", [{"day": d.isoformat(), "bars": bars or {}}], on_conflict="day")
        except Exception as e:  # noqa: BLE001
            print(f"  tw could not cache {d}: {str(e)[:100]}")
    print(f"  tw prices: {fetched} days fetched, {sum(1 for v in have.values() if v)} trading days available")
    return {d: b for d, b in have.items() if b}


def price_frame(history: dict) -> pd.DataFrame:
    """{day: bars} -> one row per code: price, returns, dollar_vol, shares_issued (TPEx only), last_date."""
    days = sorted(history)
    close = pd.DataFrame({d: {k: v[0] for k, v in history[d].items()} for d in days}).T
    value = pd.DataFrame({d: {k: v[2] for k, v in history[d].items() if k != BENCH} for d in days}).T
    shares = {}
    for d in days:
        for k, v in history[d].items():
            if len(v) > 3 and v[3]:
                shares[k] = v[3]
    rows = {}
    bench = close[BENCH].dropna() if BENCH in close else pd.Series(dtype=float)
    b6 = bench.iloc[-1] / bench.iloc[-127] - 1 if len(bench) > 126 else np.nan
    for code in close.columns:
        if code == BENCH:
            continue
        c = close[code].dropna()
        if len(c) < 60 or c.index[-1] != days[-1]:   # need history and a quote on the latest day
            continue
        last = float(c.iloc[-1])
        ret = lambda n: last / float(c.iloc[-1 - n]) - 1 if len(c) > n else np.nan  # noqa: E731
        r6 = ret(126) if len(c) > 126 else ret(len(c) - 1)
        rows[code] = {"price": last, "ret_1m": ret(21), "ret_3m": ret(63), "ret_6m": r6,
                      "rs_6m": r6 - b6 if pd.notna(b6) else np.nan,
                      "dist_high": last / float(c.iloc[-252:].max()) - 1,
                      "dollar_vol": float(value[code].dropna().iloc[-20:].mean()), "shares_issued": shares.get(code)}
    df = pd.DataFrame.from_dict(rows, orient="index")
    df.attrs["as_of"] = days[-1]
    df.attrs["history_days"] = len(days)
    return df


# ── fundamentals: monthly revenue, shares, industry ─────────────────────────

def parse_revenue(rows: list[dict], exchange: str = "TWSE") -> pd.DataFrame:
    out = {}
    for r in rows:
        code = str(_field(r, "公司代號") or "").strip()
        if not CODE_OK.match(code):
            continue
        yoy = _num(_field(r, "去年同月增減"))
        cum = _num(_field(r, "前期比較增減"))
        out[code] = {
            "name": _field(r, "公司名稱"), "exchange": exchange, "sector": _field(r, "產業別"), "ym": _field(r, "資料年月"),
            "rev_month": _num(_field(r, "營業收入-當月營收")),
            "rev_yoy": yoy / 100 if yoy is not None else np.nan,
            "rev_cum_yoy": cum / 100 if cum is not None else np.nan,
        }
    return pd.DataFrame.from_dict(out, orient="index")


def revenue_streak(yoy, cum_yoy):
    """Persistence proxy 0-4 until monthly history accumulates: this month and year-to-date both growing."""
    s = 0
    if pd.notna(yoy) and yoy > 0:
        s += 2
    if pd.notna(cum_yoy) and cum_yoy > 0:
        s += 2
    return s


def parse_shares(rows: list[dict]) -> dict[str, float]:
    """code -> shares issued, from either company feed (TWSE 已發行普通股數…, TPEx Paidin.Capital / par 10)."""
    out = {}
    for r in rows:
        code = str(_field(r, "公司代號", "SecuritiesCompanyCode") or "").strip()
        if not CODE_OK.match(code):
            continue
        sh = _num(_field(r, "已發行普通股數"))
        if sh is None:
            cap = _num(_field(r, "Paidin.Capital", "實收資本額"))
            sh = cap / 10 if cap else None
        if sh:
            out[code] = sh
    return out


def load_fundamentals(session=None) -> tuple[pd.DataFrame, dict, dict]:
    rev = []
    for url, ex in ((TWSE_REV, "TWSE"), (TPEX_REV, "TPEx")):
        rev.append(parse_revenue(load_json_list(_get(url, session)), ex))
    revdf = pd.concat(rev)
    revdf = revdf[~revdf.index.duplicated()]
    shares, idx = {}, {}
    for url in (TWSE_CO, TPEX_CO):
        try:
            shares.update(parse_shares(load_json_list(_get(url, session))))
        except Exception as e:  # noqa: BLE001 - market cap can fall back to TPEx daily shares
            print(f"  tw company feed skipped: {str(e)[:100]}")
    return revdf, shares, idx


# ── scoring ─────────────────────────────────────────────────────────────────

def build_universe(px: pd.DataFrame, revdf: pd.DataFrame, shares: dict) -> pd.DataFrame:
    df = px.join(revdf, how="inner")
    sh = pd.Series({c: shares.get(c) for c in df.index}, dtype="float64")
    sh = sh.fillna(pd.to_numeric(df["shares_issued"], errors="coerce"))
    df["shares_out"] = sh
    df["mkt_cap"] = df["price"] * sh
    df["rev_streak"] = [revenue_streak(y, c) for y, c in zip(df["rev_yoy"], df["rev_cum_yoy"])]
    df["quarters"] = 4
    df["hn_mentions"] = np.nan
    df["gross_margin"] = np.nan
    return df.dropna(subset=["mkt_cap", "dollar_vol", "rev_yoy", "rs_6m"])


def compute_tw_scores(df: pd.DataFrame, max_main: int | None = None) -> pd.DataFrame:
    """Reuse score.compute_scores with Taiwan thresholds, then apply the Taiwan board gates."""
    max_main = max_main or cfg.MAIN_MAX_NAMES
    with tw_thresholds():
        d = score.compute_scores(df)
        main = (
            d["mkt_cap"].between(cfg.MAIN_CAP_MIN, cfg.MAIN_CAP_MAX)
            & (d["dollar_vol"] >= cfg.MIN_DOLLAR_VOL)
            & (d["price"] >= cfg.MIN_PRICE)
        )
    d["flags"] = d["flags"].map(lambda f: [x for x in f if x != "data_thin"])
    if main.sum() > max_main:
        main = main & (d["score"].where(main).rank(ascending=False, method="first") <= max_main)
    d["board"] = np.where(main, "tw_main", "tw_watch")
    d["rank"] = d.groupby("board")["score"].rank(ascending=False, method="first").astype(int)
    return d


def run_tw(store, today: dt.date | None = None) -> dict:
    stats: dict = {}
    try:  # fail fast: do not spend 30 minutes fetching prices if the tables are not there
        for t in ("tw_price_days", "tw_scores", "tw_signals", "tw_entities"):
            store.select(t, {"select": "*", "limit": "1"})
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Taiwan tables are missing or unreadable ({str(e)[:120]}). Run supabase/schema_tw.sql in the Supabase SQL Editor first.") from e
    hist = load_prices(store, today)
    if len(hist) < 60:
        raise RuntimeError(f"Only {len(hist)} Taiwan trading days of prices so far; need ≥60. Run again (it keeps what it fetched).")
    px = price_frame(hist)
    as_of = px.attrs["as_of"]
    stats.update(priced=len(px), as_of=as_of.isoformat(), days=len(hist))
    revdf, shares, _ = load_fundamentals()
    df = build_universe(px, revdf, shares)
    stats["scorable"] = len(df)
    if df.empty:
        raise RuntimeError("Nothing scorable in Taiwan after joining prices and revenue.")
    scored = compute_tw_scores(df)
    stats["main"] = int((scored["board"] == "tw_main").sum())
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    store.upsert("tw_entities", [
        {"ticker": t, "name": r.get("name"), "sector": r.get("sector"),
         "exchange": r.get("exchange"), "updated_at": now}
        for t, r in scored.iterrows()], "ticker")
    cols = ["price", "mkt_cap", "dollar_vol", "ret_1m", "ret_3m", "ret_6m", "rs_6m", "dist_high", "rev_yoy", "rev_streak", "shares_out"]
    store.upsert("tw_signals", [{"ticker": t, "as_of": as_of, "ym": r.get("ym"), "rev_cum_yoy": r.get("rev_cum_yoy"),
                                 **{c: (int(r[c]) if c == "rev_streak" and pd.notna(r[c]) else r.get(c)) for c in cols}}
                                for t, r in scored.iterrows()], "ticker,as_of")
    store.upsert("tw_scores", [
        {"ticker": t, "as_of": as_of, "board": r["board"], "rank": int(r["rank"]), "score": r["score"],
         "growth": r["growth"], "validated": r["validated"], "accessibility": r["accessibility"],
         "attention": r["attention"], "flags": list(r["flags"])} for t, r in scored.iterrows()], "ticker,as_of")
    print(f"  tw: wrote {len(scored)} scores ({stats['main']} main)")
    return stats


def main() -> int:
    """python -m crawler.tw   (needs SUPABASE_URL and SUPABASE_SERVICE_KEY)"""
    import sys
    import traceback

    from .store import Supabase
    try:
        stats = run_tw(Supabase())
        print(json.dumps(stats, ensure_ascii=False))
        return 0
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
