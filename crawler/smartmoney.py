"""Big-money signals from SEC EDGAR (free, official): who is buying, and who just crossed 5%.

Sources (both come from the same daily index we already use for Form C):
  * Form 4        insider transactions, filed within 2 business days. We keep open-market buys (P) and sells (S).
  * Schedule 13D/G  anyone who crosses 5% of a company. 13D = wants influence (activist), 13G = passive.
Form 13F (institutional holdings) is NOT here: it is quarterly, 45 days late, and needs a CUSIP->ticker map.

Only filings whose issuer is a company we score are downloaded, so a normal day is ~100-300 small requests.
The signal is kept separate from the score on purpose: the history page (feature 2) will show whether it helps.
"""
from __future__ import annotations

import datetime as dt
import re
import time
import xml.etree.ElementTree as ET

import requests

from . import config as cfg
from .formc import ARCHIVES, _daily_index_url, _to_date, _to_num

FORM4 = {"4", "4/A"}
SCHED_13D = {"SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A"}
SCHED_13G = {"SC 13G", "SC 13G/A", "SCHEDULE 13G", "SCHEDULE 13G/A"}
WANTED = FORM4 | SCHED_13D | SCHED_13G

# points for the 0-100 big-money score (see compute_signals)
PTS = {"cluster": 50, "extra_buyer": 10, "officer": 15, "big_buy": 10, "activist_13d": 35, "new_5pct": 20}
BIG_BUY_USD = 250_000
SINGLE_BUY_USD = 100_000


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _find(el, name: str):
    for e in el.iter():
        if _local(e.tag) == name:
            return e
    return None


def _text(el, *path: str):
    """Text of the first descendant chain el/path[0]/path[1]/... (namespace-agnostic), or None."""
    cur = el
    for name in path:
        nxt = None
        for ch in cur.iter():
            if ch is not cur and _local(ch.tag) == name:
                nxt = ch
                break
        if nxt is None:
            return None
        cur = nxt
    t = (cur.text or "").strip()
    return t or None


def _flag(s: str | None) -> bool:
    return (s or "").strip().lower() in ("1", "true", "y")


# ── index ───────────────────────────────────────────────────────────────────
def parse_index(text: str, ciks: set[str]) -> list[dict]:
    """master.idx -> wanted filings whose row CIK is one of ours (issuer rows). Filers' own rows are ignored."""
    rows, started = [], False
    for line in text.splitlines():
        if line.startswith("-----"):
            started = True
            continue
        if not started:
            continue
        parts = line.split("|")
        if len(parts) != 5:
            continue
        cik, company, form, date, fname = (p.strip() for p in parts)
        if form not in WANTED:
            continue
        cik = str(int(cik)) if cik.isdigit() else cik
        if cik not in ciks:
            continue
        m = re.search(r"/(\d{10}-\d{2}-\d{6})\.txt$", fname)
        if m:
            rows.append({"cik": cik, "company": company, "form": form, "filed_at": _to_date(date),
                         "accession": m.group(1), "path": fname})
    return rows


# ── Form 4 ──────────────────────────────────────────────────────────────────
def _xml_block(text: str, root_tag: str) -> str | None:
    m = re.search(rf"<{root_tag}[\s>].*?</{root_tag}>", text, re.S | re.I)
    return m.group(0) if m else None


def parse_form4(text: str) -> dict | None:
    """Full-submission text or bare XML -> {owner, title, is_*, rows:[{code,shares,price,value,tx_date,acq}]}."""
    xml = _xml_block(text, "ownershipDocument")
    if not xml:
        return None
    root = ET.fromstring(xml)
    owners, officer, director, ten, titles = [], False, False, False, []
    for ro in root.iter():
        if _local(ro.tag) != "reportingOwner":
            continue
        name = _text(ro, "rptOwnerName")
        if name:
            owners.append(name)
        officer |= _flag(_text(ro, "isOfficer"))
        director |= _flag(_text(ro, "isDirector"))
        ten |= _flag(_text(ro, "isTenPercentOwner"))
        t = _text(ro, "officerTitle")
        if t:
            titles.append(t)
    rows = []
    for tx in root.iter():
        if _local(tx.tag) != "nonDerivativeTransaction":
            continue
        code = _text(tx, "transactionCoding", "transactionCode")
        shares = _to_num(_text(tx, "transactionShares", "value"))
        price = _to_num(_text(tx, "transactionPricePerShare", "value"))
        rows.append({
            "code": code,
            "acq": _text(tx, "transactionAcquiredDisposedCode", "value"),
            "shares": shares,
            "price": price,
            "value": round(shares * price, 2) if shares is not None and price else None,
            "tx_date": _to_date(_text(tx, "transactionDate", "value")),
        })
    return {"owner": "; ".join(owners) or None, "title": "; ".join(titles) or None,
            "is_officer": officer, "is_director": director, "is_ten_pct": ten,
            "issuer_cik": _text(root, "issuer", "issuerCik"), "symbol": _text(root, "issuer", "issuerTradingSymbol"),
            "rows": [r for r in rows if r["code"] in ("P", "S")]}


# ── Schedule 13D / 13G ──────────────────────────────────────────────────────
def parse_13dg(text: str) -> dict | None:
    """Structured 13D/13G XML -> {holder, shares, pct}. Loose tag matching, like Form C (schemas differ a little)."""
    xml = _xml_block(text, "edgarSubmission")
    if not xml:
        return None
    root = ET.fromstring(xml)
    holder, shares, pct = None, None, None
    for e in root.iter():
        tag = _local(e.tag).lower()
        val = (e.text or "").strip()
        if not val:
            continue
        if holder is None and tag in ("reportingpersonname", "nameofreportingperson", "reportingpersonname1"):
            holder = val
        elif shares is None and ("aggregateamountowned" in tag or "beneficiallyownedaggregatenumberofshares" in tag
                                 or tag == "aggregateamountbeneficiallyowned"):
            shares = _to_num(val)
        elif pct is None and tag in ("percentofclass", "classpercent", "percentofclassrepresentedbyamountinrowaggregate"):
            pct = _to_num(val)
    if holder is None and shares is None and pct is None:
        return None
    return {"holder": holder, "shares": shares, "pct": pct}


# ── signals ─────────────────────────────────────────────────────────────────
def compute_signals(trades: list[dict], holders: list[dict], today: dt.date) -> dict:
    """Pure function: one ticker's recent insider rows + 13D/G filings -> signal fields."""
    lo30, lo90 = today - dt.timedelta(days=30), today - dt.timedelta(days=90)
    buys = [t for t in trades if t.get("code") == "P" and t.get("filed_at") and t["filed_at"] >= lo30]
    sells = [t for t in trades if t.get("code") == "S" and t.get("filed_at") and t["filed_at"] >= lo30]
    buyers = {t.get("owner") for t in buys if t.get("owner")}
    officers = {t.get("owner") for t in buys if t.get("owner") and (t.get("is_officer") or t.get("is_director"))}
    buy_val = sum(t.get("value") or 0 for t in buys)
    sell_val = sum(t.get("value") or 0 for t in sells)
    h90 = [h for h in holders if h.get("filed_at") and h["filed_at"] >= lo90]
    n13d = [h for h in h90 if "13D" in (h.get("form_type") or "") and not (h.get("form_type") or "").endswith("/A")]
    n13g = [h for h in h90 if "13G" in (h.get("form_type") or "") and not (h.get("form_type") or "").endswith("/A")]

    tags, pts = [], 0
    if len(buyers) >= 2:
        tags.append("insider_cluster")
        pts += PTS["cluster"] + PTS["extra_buyer"] * min(len(buyers) - 2, 2)
    elif buy_val >= SINGLE_BUY_USD:
        tags.append("insider_buy")
        pts += PTS["cluster"] // 2
    if officers:
        pts += PTS["officer"]
    if buy_val >= BIG_BUY_USD:
        pts += PTS["big_buy"]
    if n13d:
        tags.append("activist_13d")
        pts += PTS["activist_13d"]
    if n13g:
        tags.append("new_5pct")
        pts += PTS["new_5pct"]
    return {
        "score": min(100, pts), "tags": tags,
        "buyers_30d": len(buyers), "buy_value_30d": round(buy_val, 2), "officer_buyers_30d": len(officers),
        "sellers_30d": len({t.get("owner") for t in sells if t.get("owner")}), "sell_value_30d": round(sell_val, 2),
        "n_13d_90d": len(n13d), "n_13g_90d": len(n13g),
        "detail": {"holders": [{"holder": h.get("holder"), "form": h.get("form_type"), "pct": h.get("pct"),
                                "filed_at": h["filed_at"].isoformat()} for h in sorted(h90, key=lambda x: x["filed_at"], reverse=True)[:6]]},
    }


# ── network ─────────────────────────────────────────────────────────────────
class _Blocked(Exception):
    pass


def _get(session: requests.Session, url: str):
    time.sleep(cfg.SEC_PAUSE)
    r = session.get(url, timeout=60)
    if r.status_code == 404:
        return None
    if r.status_code in (403, 429):
        return "blocked" if r.status_code == 429 else None  # EDGAR answers 403 for files that do not exist
    r.raise_for_status()
    return r


def _latest_scored(store) -> tuple[dict[str, str], dt.date | None]:
    """Tickers scored in the latest run -> (ticker -> as_of date)."""
    last = store.select("scores", {"select": "as_of", "order": "as_of.desc", "limit": "1"})
    if not last:
        return {}, None
    as_of = str(last[0]["as_of"])[:10]
    rows = store.select("scores", {"select": "ticker", "as_of": f"eq.{as_of}"})
    return {r["ticker"]: as_of for r in rows}, dt.date.fromisoformat(as_of)


def run_smart(store, today: dt.date | None = None) -> dict:
    from . import universe

    today = today or dt.date.today()
    scored, as_of = _latest_scored(store)
    if not scored:
        raise RuntimeError("No scored tickers yet: run the public stage first.")
    uni = universe.get_universe()
    cik_of = {t: str(int(c)) for t, c in zip(uni["ticker"], uni["cik"]) if t in scored and c == c}
    ticker_of = {c: t for t, c in cik_of.items()}
    ciks = set(ticker_of)

    s = requests.Session()
    s.headers.update(cfg.sec_headers())
    stats = {"days_ok": 0, "listed": 0, "fetched": 0, "form4": 0, "trades": 0, "holders": 0, "failed": 0, "deferred": 0}

    cutoff = (today - dt.timedelta(days=cfg.SMART_DAYS_BACK + 7)).isoformat()
    known = {r["accession"] for r in store.select("insider_trades", {"select": "accession", "filed_at": f"gte.{cutoff}"})}
    known |= {r["accession"] for r in store.select("holder_filings", {"select": "accession", "filed_at": f"gte.{cutoff}"})}
    known |= {r["accession"] for r in store.select("smart_seen", {"select": "accession", "filed_at": f"gte.{cutoff}"})}

    filings: list[dict] = []
    for back in range(cfg.SMART_DAYS_BACK):
        day = today - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        r = _get(s, _daily_index_url(day))
        if r is None or r == "blocked":
            continue
        stats["days_ok"] += 1
        filings += parse_index(r.text, ciks)
    if stats["days_ok"] == 0:
        raise RuntimeError("EDGAR daily index unreachable for every day (blocked or User-Agent rejected?)")
    stats["listed"] = len(filings)

    uniq: dict[str, dict] = {}
    for f in filings:  # one filing can be listed several times (one line per filer / subject company)
        uniq.setdefault(f["accession"], f)
    todo = sorted((f for f in uniq.values() if f["accession"] not in known), key=lambda f: f["filed_at"] or today, reverse=True)
    if len(todo) > cfg.MAX_SMART_FETCH_PER_RUN:
        stats["deferred"] = len(todo) - cfg.MAX_SMART_FETCH_PER_RUN  # picked up by the next runs, newest first
        todo = todo[: cfg.MAX_SMART_FETCH_PER_RUN]

    trade_rows, holder_rows, seen_rows = [], [], []
    for f in todo:
        ticker = ticker_of.get(f["cik"])
        try:
            r = _get(s, f"https://www.sec.gov/Archives/{f['path']}")
            if r == "blocked":
                print("  SEC rate-limited us (429): stopping early, the rest waits for the next run")
                break
            if r is None:
                stats["failed"] += 1
                continue
            stats["fetched"] += 1
            if f["form"] in FORM4:
                p = parse_form4(r.text)
                if p:
                    stats["form4"] += 1
                    for i, row in enumerate(p["rows"]):
                        trade_rows.append({
                            "accession": f["accession"], "line": i, "ticker": ticker, "cik": f["cik"],
                            "filed_at": f["filed_at"], "tx_date": row["tx_date"], "owner": p["owner"], "title": p["title"],
                            "is_officer": p["is_officer"], "is_director": p["is_director"], "is_ten_pct": p["is_ten_pct"],
                            "code": row["code"], "shares": row["shares"], "price": row["price"], "value": row["value"]})
                        stats["trades"] += 1
                seen_rows.append({"accession": f["accession"], "filed_at": f["filed_at"]})
            else:
                p = parse_13dg(r.text)
                holder_rows.append({"accession": f["accession"], "ticker": ticker, "cik": f["cik"], "filed_at": f["filed_at"],
                                    "form_type": f["form"], **(p or {"holder": None, "shares": None, "pct": None})})
                stats["holders"] += 1
        except Exception as e:  # noqa: BLE001
            stats["failed"] += 1
            print(f"  {f['form']} {f['accession']} failed: {e!r}")

    if trade_rows:
        store.upsert("insider_trades", trade_rows, "accession,line")
    if holder_rows:
        store.upsert("holder_filings", holder_rows, "accession")
    if seen_rows:  # Form 4s with no P/S rows, remembered so they are not downloaded again
        store.upsert("smart_seen", seen_rows, "accession")

    # recompute signals for every scored ticker from what is stored
    lo = (today - dt.timedelta(days=90)).isoformat()
    all_trades = store.select("insider_trades", {"select": "*", "filed_at": f"gte.{lo}"})
    all_holders = store.select("holder_filings", {"select": "*", "filed_at": f"gte.{lo}"})
    by_t: dict[str, list] = {}
    by_h: dict[str, list] = {}
    for t in all_trades:
        t["filed_at"] = _to_date(str(t["filed_at"])[:10]) if not isinstance(t["filed_at"], dt.date) else t["filed_at"]
        by_t.setdefault(t["ticker"], []).append(t)
    for h in all_holders:
        h["filed_at"] = _to_date(str(h["filed_at"])[:10]) if not isinstance(h["filed_at"], dt.date) else h["filed_at"]
        by_h.setdefault(h["ticker"], []).append(h)
    existing = {r["ticker"] for r in store.select("smart_money", {"select": "ticker"})}
    out = []
    for t in (set(by_t) | set(by_h) | existing) & set(scored):
        sig = compute_signals(by_t.get(t, []), by_h.get(t, []), today)
        if sig["score"] or sig["sellers_30d"] or t in existing:  # keep zeroing tickers whose signal has expired
            out.append({"ticker": t, "as_of": as_of.isoformat(), "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), **sig})
    if out:
        store.upsert("smart_money", out, "ticker")
    stats["signals"] = len(out)
    print(f"  smart money: {stats}")
    return stats
