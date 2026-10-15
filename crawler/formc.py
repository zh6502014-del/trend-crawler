"""Reg CF offerings from SEC EDGAR Form C filings: free, official, structured XML.

Flow: daily-index/master.YYYYMMDD.idx → rows with form type C or C/A → each filing's primary_doc.xml → fundraises.

The XML tag names are matched loosely (regex on the local tag name) because SEC has tweaked the schema over
the years. Run it once and eyeball the `fundraises` table; if a column is empty, adjust FIELD_PATTERNS below.
"""
from __future__ import annotations

import datetime as dt
import re
import time
import xml.etree.ElementTree as ET

import requests

from . import config as cfg

ARCHIVES = "https://www.sec.gov/Archives/edgar"
OFFERING_FORMS = {"C", "C/A"}
UPDATE_FORMS = {"C-U", "C-U/A"}   # progress updates: how much has been raised so far

# our column → regexes tried against each XML element's local tag name (case-insensitive, first match wins)
FIELD_PATTERNS = {
    "issuer": [r"^nameOfIssuer$"],
    "portal": [r"^companyName$"],
    "website": [r"^issuerWebsite$"],
    "security_type": [r"^securityOfferedType$"],
    "price": [r"^price$"],
    "target_amount": [r"^offeringAmount$"],
    "max_amount": [r"^maximumOfferingAmount$"],
    "deadline": [r"^deadlineDate$"],
    "employees": [r"^currentEmployees$"],
    "total_assets": [r"^totalAsset.*Most"],
    "cash": [r"^cash.*Most"],
    "debt": [r"^longTermDebt.*Most"],
    "revenue": [r"^revenue.*Most"],
    "revenue_prior": [r"^revenue.*Prior"],
    "net_income": [r"^netIncome.*Most"],
    "net_income_prior": [r"^netIncome.*Prior"],
}
_NUMERIC = {"price", "target_amount", "max_amount", "employees", "total_assets", "cash", "debt",
            "revenue", "revenue_prior", "net_income", "net_income_prior"}


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _to_num(s: str | None):
    if s is None:
        return None
    s = s.strip().replace(",", "").replace("$", "")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def _to_date(s: str | None):
    if not s:
        return None
    for fmt in ("%m-%d-%Y", "%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    return None


def parse_form_c(xml_bytes: bytes) -> dict:
    """Pure function: Form C primary_doc.xml → flat dict of the fields we keep."""
    root = ET.fromstring(xml_bytes)
    elems = [(_local(e.tag), (e.text or "").strip()) for e in root.iter() if (e.text or "").strip()]
    out: dict = {}
    for col, patterns in FIELD_PATTERNS.items():
        val = None
        for pat in patterns:
            rx = re.compile(pat, re.I)
            val = next((text for tag, text in elems if rx.search(tag)), None)
            if val is not None:
                break
        if col in _NUMERIC:
            val = _to_num(val)
            if col == "employees" and val is not None:
                val = int(val)
        elif col == "deadline":
            val = _to_date(val)
        out[col] = val
    return out


def parse_master_idx(text: str, include_updates: bool = False) -> list[dict]:
    """master.idx is pipe-delimited: CIK|Company|Form|Date|Filename, after a dashed separator line."""
    rows = []
    started = False
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
        if form not in OFFERING_FORMS and not (include_updates and form in UPDATE_FORMS):
            continue
        m = re.search(r"/(\d{10}-\d{2}-\d{6})\.txt$", fname)
        if not m:
            continue
        rows.append({"cik": str(int(cik)), "company": company, "form_type": form,
                     "filed_at": _to_date(date), "accession": m.group(1)})
    return rows


_RAISED_RX = re.compile(r"(raised|sold|proceeds|amount)", re.I)


def parse_form_cu(xml_bytes: bytes) -> dict:
    """Form C-U: pull the amount raised so far. Tag names are matched loosely; every numeric tag is kept in
    `raw` so the matching can be tightened after looking at real filings."""
    root = ET.fromstring(xml_bytes)
    nums = {}
    for e in root.iter():
        t = (e.text or "").strip()
        if not t:
            continue
        v = _to_num(t)
        if v is not None and not re.fullmatch(r"\d{4}-?\d{2}-?\d{2}", t):
            nums.setdefault(_local(e.tag), v)
    # Real C-U filings carry no "raised" tag. Checked against stored filings: `offeringAmount` is the amount sold so far
    # (≈ noOfSecurityOffered × price), while costGoodsSold* must never be mistaken for it ("...GoodsSOLD").
    explicit = next((v for k, v in nums.items() if "costgoods" not in k.lower()
                     and re.search(r"(amount|total|proceeds).*(sold|raised)|(sold|raised).*(amount|total)", k, re.I)), None)
    raised = explicit if explicit is not None else nums.get("offeringAmount")
    return {"raised": raised, "raw": {k: v for k, v in list(nums.items())[:25]}}


def _daily_index_url(day: dt.date) -> str:
    q = (day.month - 1) // 3 + 1
    return f"{ARCHIVES}/daily-index/{day.year}/QTR{q}/master.{day:%Y%m%d}.idx"


def _get(session: requests.Session, url: str):
    time.sleep(cfg.SEC_PAUSE)
    r = session.get(url, timeout=60)
    if r.status_code in (403, 404):  # EDGAR answers 403 for files that do not exist (e.g. today's index before it is built)
        return None
    r.raise_for_status()
    return r


def run_formc(store, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    s = requests.Session()
    s.headers.update(cfg.sec_headers())
    stats = {"days_ok": 0, "days_missing": 0, "listed": 0, "new": 0, "parsed": 0, "failed": 0}

    cutoff = (today - dt.timedelta(days=cfg.FORMC_DAYS_BACK + 7)).isoformat()
    known = {r["accession"] for r in store.select("fundraises", {"select": "accession", "filed_at": f"gte.{cutoff}"})}

    filings: list[dict] = []
    for back in range(cfg.FORMC_DAYS_BACK):
        day = today - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        r = _get(s, _daily_index_url(day))
        if r is None:  # holiday, or EDGAR hasn't published that day yet
            stats["days_missing"] += 1
            continue
        stats["days_ok"] += 1
        filings += parse_master_idx(r.text, include_updates=True)
    updates = [f for f in filings if f["form_type"] in UPDATE_FORMS]
    filings = [f for f in filings if f["form_type"] in OFFERING_FORMS]
    stats["listed"] = len(filings)
    if stats["days_ok"] == 0:
        raise RuntimeError("EDGAR daily index unreachable for every day (blocked or User-Agent rejected?)")

    rows = []
    for f in filings:
        if f["accession"] in known:
            continue
        stats["new"] += 1
        nodash = f["accession"].replace("-", "")
        base = f"{ARCHIVES}/data/{f['cik']}/{nodash}"
        try:
            r = _get(s, f"{base}/primary_doc.xml")
            if r is None:
                stats["failed"] += 1
                continue
            p = parse_form_c(r.content)
        except Exception as e:
            stats["failed"] += 1
            print(f"  form C {f['accession']} failed: {e!r}")
            continue
        rows.append({**p, "accession": f["accession"], "cik": f["cik"], "form_type": f["form_type"],
                     "filed_at": f["filed_at"], "issuer": p.get("issuer") or f["company"],
                     "filing_url": f"{base}/"})
        stats["parsed"] += 1
        if len(rows) >= 100:
            store.upsert("fundraises", rows, "accession")
            rows = []
    if rows:
        store.upsert("fundraises", rows, "accession")
    stats.update(_run_updates(store, s, updates, cutoff))
    print(f"  form C: {stats}")
    return stats


def _run_updates(store, session, updates: list[dict], cutoff: str) -> dict:
    """Fetch Form C-U filings of issuers we already track and store the amount raised."""
    out = {"cu_listed": len(updates), "cu_parsed": 0, "cu_failed": 0}
    if not updates:
        return out
    try:
        ciks = {r["cik"] for r in store.select("fundraises", {"select": "cik"})}
        known = {r["accession"] for r in store.select("fundraise_updates", {"select": "accession", "filed_at": f"gte.{cutoff}"})}
    except Exception as e:  # noqa: BLE001 - table may not exist yet; offerings must not fail because of it
        print(f"  form C-U skipped ({str(e)[:100]})")
        return out
    rows = []
    for f in updates:
        if f["cik"] not in ciks or f["accession"] in known:
            continue
        base = f"{ARCHIVES}/data/{f['cik']}/{f['accession'].replace('-', '')}"
        try:
            r = _get(session, f"{base}/primary_doc.xml")
            if r is None:
                out["cu_failed"] += 1
                continue
            p = parse_form_cu(r.content)
        except Exception as e:  # noqa: BLE001
            out["cu_failed"] += 1
            print(f"  form C-U {f['accession']} failed: {e!r}")
            continue
        rows.append({"accession": f["accession"], "cik": f["cik"], "form_type": f["form_type"],
                     "filed_at": f["filed_at"], "raised": p["raised"], "raw": p["raw"]})
        out["cu_parsed"] += 1
    if rows:
        store.upsert("fundraise_updates", rows, "accession")
    return out
