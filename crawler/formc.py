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


def parse_master_idx(text: str) -> list[dict]:
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
        if form not in OFFERING_FORMS:
            continue
        m = re.search(r"/(\d{10}-\d{2}-\d{6})\.txt$", fname)
        if not m:
            continue
        rows.append({"cik": str(int(cik)), "company": company, "form_type": form,
                     "filed_at": _to_date(date), "accession": m.group(1)})
    return rows


def _daily_index_url(day: dt.date) -> str:
    q = (day.month - 1) // 3 + 1
    return f"{ARCHIVES}/daily-index/{day.year}/QTR{q}/master.{day:%Y%m%d}.idx"


def _get(session: requests.Session, url: str):
    time.sleep(cfg.SEC_PAUSE)
    r = session.get(url, timeout=60)
    if r.status_code == 404:
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
        filings += parse_master_idx(r.text)
    stats["listed"] = len(filings)

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
    print(f"  form C: {stats}")
    return stats
