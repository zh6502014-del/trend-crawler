"""Taiwan "big money" signals: institutional net buying (三大法人), director pledging and insider transfer filings.

Sources (all official, free):
- TWSE  T86  三大法人買賣超日報 (per day, JSON)         https://www.twse.com.tw/rwd/zh/fund/T86
- TPEx  三大法人買賣明細 (per day, JSON)                 https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade
- 董監事持股餘額明細 (設質): OpenAPI t187ap11_L / mopsfin_t187ap11_O
- 內部人持股轉讓事前申報: OpenAPI t187ap12_L / mopsfin_t187ap12_O

Daily institutional flows are cached in tw_inst_days (day -> {code: [foreign_net, trust_net, total_net]}, in shares).
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time

import numpy as np
import pandas as pd

from . import tw

TWSE_T86 = "https://www.twse.com.tw/rwd/zh/fund/T86?date={d}&selectType=ALLBUT0999&response=json"
TPEX_INSTI = "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={d}&response=json"
TWSE_PLEDGE = ["https://openapi.twse.com.tw/v1/opendata/t187ap11_L"]
TPEX_PLEDGE = ["https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O"]
TWSE_XFER = ["https://openapi.twse.com.tw/v1/opendata/t187ap12_L"]
TPEX_XFER = ["https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_O"]

KEEP_DAYS = 30           # trading days of flows we keep around (20 are used)
BUY_20D = 0.10           # "法人買超": net buying over 20 days >= 10% of the traded volume (about the top quarter) ...
PLEDGE_WARN = 0.30       # directors pledged >= 30% of what they hold
XFER_WARN = 0.002        # insiders declared a transfer of >= 0.2% of the shares outstanding


def _clean(f: str) -> str:
    return re.sub(r"\s", "", str(f))


# ── one trading day ─────────────────────────────────────────────────────────

def parse_twse_t86(payload: dict) -> dict | None:
    """-> {code: [foreign_net, trust_net, total_net]} in shares; None when closed / no data."""
    if not isinstance(payload, dict) or payload.get("stat") != "OK":
        return None
    f = [_clean(x) for x in payload.get("fields") or []]

    def idx(name):
        return f.index(name) if name in f else None

    i_code = idx("證券代號")
    i_f1, i_f2 = idx("外陸資買賣超股數(不含外資自營商)"), idx("外資自營商買賣超股數")
    i_t, i_all = idx("投信買賣超股數"), idx("三大法人買賣超股數")
    if None in (i_code, i_t, i_all) or (i_f1 is None and i_f2 is None):
        return None
    out = {}
    for r in payload.get("data") or []:
        code = str(r[i_code]).strip()
        if not tw.CODE_OK.match(code):
            continue
        fo = sum((tw._num(r[i]) or 0) for i in (i_f1, i_f2) if i is not None)
        out[code] = [fo, tw._num(r[i_t]) or 0, tw._num(r[i_all]) or 0]
    return out or None


def parse_tpex_insti(payload: dict) -> dict | None:
    """TPEx table: code, name, then 7 groups of (buy, sell, net): foreign ex-dealer, foreign dealer, foreign total,
    trust, dealer self, dealer hedge, dealer total; then the grand total."""
    if not isinstance(payload, dict) or str(payload.get("stat", "ok")).lower() != "ok":
        return None
    for t in payload.get("tables") or []:
        f = t.get("fields") or []
        if len(f) != 24 or "三大法人" not in _clean(f[-1]):
            continue
        out = {}
        for r in t.get("data") or []:
            code = str(r[0]).strip()
            if tw.CODE_OK.match(code):
                out[code] = [tw._num(r[10]) or 0, tw._num(r[13]) or 0, tw._num(r[23]) or 0]
        return out or None
    return None


def fetch_inst_day(day: dt.date, session=None) -> dict | None:
    a = parse_twse_t86(json.loads(tw._get(TWSE_T86.format(d=day.strftime("%Y%m%d")), session)))
    time.sleep(tw.PAUSE)
    b = parse_tpex_insti(json.loads(tw._get(TPEX_INSTI.format(d=day.strftime("%Y/%m/%d")), session)))
    time.sleep(tw.PAUSE)
    if a is None and b is None:
        return None
    return {**(b or {}), **(a or {})}


def load_inst(store, days: list[dt.date], session=None) -> dict:
    """Flows for the given trading days (cached in tw_inst_days). Returns {day: {code: [..]}}."""
    days = sorted(days)[-KEEP_DAYS:]
    have: dict[dt.date, dict] = {}
    try:
        for r in store.select("tw_inst_days", {"select": "day,bars", "day": f"gte.{days[0].isoformat()}"}, page=10):
            have[dt.date.fromisoformat(str(r["day"])[:10])] = r["bars"] or {}
    except Exception as e:  # noqa: BLE001
        print(f"  tw inst cache unavailable ({str(e)[:100]})")
    fetched = 0
    for d in reversed([d for d in days if d not in have]):
        try:
            bars = fetch_inst_day(d, session)
        except Exception as e:  # noqa: BLE001
            print(f"  tw inst {d}: {str(e)[:100]}")
            continue
        have[d] = bars or {}
        fetched += 1
        try:
            store.upsert("tw_inst_days", [{"day": d.isoformat(), "bars": bars or {}}], on_conflict="day")
        except Exception as e:  # noqa: BLE001
            print(f"  tw inst could not cache {d}: {str(e)[:100]}")
    print(f"  tw inst: {fetched} days fetched, {sum(1 for v in have.values() if v)} days available")
    return {d: b for d, b in have.items() if b and d in days}


def inst_frame(inst: dict, price_hist: dict) -> pd.DataFrame:
    """Net buying as a share of the traded volume: inst_5d / inst_20d (all three), foreign_20d, trust_20d."""
    days = sorted(d for d in inst if d in price_hist)
    if len(days) < 5:
        return pd.DataFrame()
    rows = {}
    codes = set().union(*[set(inst[d]) for d in days])

    def ratio(code, ds, k):
        net = sum(inst[d].get(code, [0, 0, 0])[k] for d in ds)
        vol = sum((price_hist[d].get(code) or [0, 0])[1] for d in ds)
        return net / vol if vol else np.nan

    d5, d20 = days[-5:], days[-20:]
    for c in codes:
        rows[c] = {"inst_5d": ratio(c, d5, 2), "inst_20d": ratio(c, d20, 2),
                   "foreign_20d": ratio(c, d20, 0), "trust_20d": ratio(c, d20, 1)}
    return pd.DataFrame.from_dict(rows, orient="index")


# ── pledging and insider transfer filings ───────────────────────────────────

def _val(row: dict, *needles: str):
    """First key that equals a needle (after trimming), else the first containing it."""
    norm = {_clean(k): v for k, v in row.items()}
    for n in needles:
        if n in norm:
            return norm[n]
    for n in needles:
        for k, v in norm.items():
            if n in k:
                return v
    return None


def parse_pledge(rows: list[dict]) -> dict:
    """{code: pledged shares / shares held} summed over the directors and supervisors of each company."""
    held: dict[str, float] = {}
    pledged: dict[str, float] = {}
    for r in rows:
        code = str(_val(r, "公司代號", "SecuritiesCompanyCode") or "").strip()
        if not tw.CODE_OK.match(code):
            continue
        held[code] = held.get(code, 0.0) + (tw._num(_val(r, "目前持股")) or 0.0)
        pledged[code] = pledged.get(code, 0.0) + (tw._num(_val(r, "設質股數")) or 0.0)
    return {c: pledged[c] / held[c] for c in held if held[c] > 0}


def parse_transfers(rows: list[dict]) -> dict:
    """{code: shares the insiders announced they will transfer} (pre-declaration filings)."""
    out: dict[str, float] = {}
    for r in rows:
        code = str(_val(r, "公司代號", "SecuritiesCompanyCode") or "").strip()
        n = tw._num(_val(r, "預定轉讓總股數-自有持股")) or 0.0
        if tw.CODE_OK.match(code) and n > 0:
            out[code] = out.get(code, 0.0) + n
    return out


def load_insider(session=None) -> tuple[dict, dict]:
    pledge, xfer = {}, {}
    for urls in (TWSE_PLEDGE, TPEX_PLEDGE):
        try:
            pledge.update(parse_pledge(tw.load_json_list(tw._get(urls, session))))
        except Exception as e:  # noqa: BLE001
            print(f"  tw pledge feed skipped: {str(e)[:100]}")
    for urls in (TWSE_XFER, TPEX_XFER):
        try:
            for c, n in parse_transfers(tw.load_json_list(tw._get(urls, session))).items():
                xfer[c] = xfer.get(c, 0.0) + n
        except Exception as e:  # noqa: BLE001
            print(f"  tw insider-transfer feed skipped: {str(e)[:100]}")
    return pledge, xfer


# ── glue ────────────────────────────────────────────────────────────────────

def add_flags(df: pd.DataFrame) -> pd.DataFrame:
    """Append inst_buy / high_pledge / insider_selling to the flags list (they do not change the score)."""
    def flags(r):
        f = list(r["flags"])
        if pd.notna(r.get("inst_20d")) and r["inst_20d"] >= BUY_20D and pd.notna(r.get("inst_5d")) and r["inst_5d"] > 0:
            f.append("inst_buy")
        if pd.notna(r.get("pledge_ratio")) and r["pledge_ratio"] >= PLEDGE_WARN:
            f.append("high_pledge")
        sh = r.get("shares_out")
        if pd.notna(r.get("xfer_shares")) and pd.notna(sh) and sh and r["xfer_shares"] / sh >= XFER_WARN:
            f.append("insider_selling")
        return f
    df = df.copy()
    df["flags"] = df.apply(flags, axis=1)
    return df


def enrich(store, scored: pd.DataFrame, price_hist: dict, session=None) -> pd.DataFrame:
    """Add institutional-flow columns, pledge ratio and the flags. Any failure just returns `scored` unchanged."""
    try:
        inst = load_inst(store, list(price_hist), session)
        frame = inst_frame(inst, price_hist)
        out = scored.join(frame, how="left") if not frame.empty else scored.copy()
        pledge, xfer = load_insider(session)
        out["pledge_ratio"] = pd.Series(pledge).reindex(out.index)
        out["xfer_shares"] = pd.Series(xfer).reindex(out.index)
        return add_flags(out)
    except Exception as e:  # noqa: BLE001
        print(f"  tw inst enrichment skipped: {str(e)[:150]}")
        return scored
