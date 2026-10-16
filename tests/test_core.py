"""Offline tests. No network, no database.   python -m pytest -q   (or: python tests/test_core.py)"""
import datetime as dt
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import attention, formc, fundamentals, prices, run, score, store  # noqa: E402
from crawler import config as cfg  # noqa: E402


# ── helpers ────────────────────────────────────────────────────────────────
def make_universe(n=300, seed=1):
    rng = np.random.default_rng(seed)
    idx = [f"T{i:03d}" for i in range(n)]
    return pd.DataFrame(
        {
            "price": rng.uniform(2, 40, n),
            "mkt_cap": rng.uniform(60e6, 4e9, n),
            "dollar_vol": rng.uniform(4e5, 2e7, n),
            "rev_yoy": rng.normal(0.15, 0.4, n),
            "rs_6m": rng.normal(0.0, 0.3, n),
            "rev_streak": rng.integers(0, 5, n),
            "gross_margin": rng.uniform(0.1, 0.8, n),
            "analyst_count": rng.integers(0, 15, n),
            "inst_pct": rng.uniform(0, 0.9, n),
            "hn_mentions": rng.integers(0, 20, n).astype(float),
            "quarters": 5,
        },
        index=idx,
    )


# ── scoring ────────────────────────────────────────────────────────────────
def test_scores_are_bounded_and_ranked():
    out = score.compute_scores(make_universe())
    assert out["score"].between(0, 100).all()
    assert not out[["score", "growth", "validated", "accessibility", "attention"]].isna().any().any()
    for board, g in out.groupby("board"):
        assert sorted(g["rank"]) == list(range(1, len(g) + 1)), board
    assert (out["board"] == "main").sum() > 0


def test_crowding_lowers_score_all_else_equal():
    base = make_universe()
    a, b = base.copy(), base.copy()
    a.loc["T000", ["analyst_count", "inst_pct", "hn_mentions"]] = [0, 0.01, 0]
    b.loc["T000", ["analyst_count", "inst_pct", "hn_mentions"]] = [30, 0.95, 50]
    assert score.compute_scores(a).loc["T000", "score"] > score.compute_scores(b).loc["T000", "score"]


def test_multiplicative_pillars_punish_a_zero():
    base = make_universe()
    weak = base.copy()
    weak.loc["T001", ["rev_streak", "gross_margin"]] = [0, 0.0]  # nothing validated
    strong = base.copy()
    strong.loc["T001", ["rev_streak", "gross_margin"]] = [4, 0.95]
    assert score.compute_scores(strong).loc["T001", "score"] > score.compute_scores(weak).loc["T001", "score"]


def test_gates_send_names_to_watch():
    d = make_universe(50)
    d.loc["T000", "dollar_vol"] = 50_000      # too thin
    d.loc["T001", "mkt_cap"] = 15e9           # too big for the main board
    d.loc["T002", "quarters"] = 2             # not enough history
    out = score.compute_scores(d)
    assert out.loc["T000", "board"] == "watch" and "thin_volume" in out.loc["T000", "flags"]
    assert out.loc["T001", "board"] == "watch"
    assert out.loc["T002", "board"] == "watch" and "data_thin" in out.loc["T002", "flags"]


def test_flags_runway_loss_debt_dilution():
    d = make_universe(30)
    d.loc["T000", "runway_months"] = 5
    d.loc["T001", "profit_margin"] = -0.9
    d.loc["T002", "debt_to_equity"] = 350
    d.loc["T003", "dilution"] = 0.4
    out = score.compute_scores(d)
    assert "short_runway" in out.loc["T000", "flags"]
    assert "deep_loss" in out.loc["T001", "flags"]
    assert "high_debt" in out.loc["T002", "flags"]
    assert "dilution" in out.loc["T003", "flags"]


def test_missing_optional_columns_do_not_crash():
    d = make_universe(40)[["price", "mkt_cap", "dollar_vol", "rev_yoy", "rs_6m"]]
    out = score.compute_scores(d)
    assert len(out) == 40 and out["score"].notna().all()


def test_scorable_filters_incomplete_rows():
    d = make_universe(10)
    d.loc["T000", "rev_yoy"] = np.nan
    d.loc["T001", "mkt_cap"] = 50e9
    assert list(score.scorable(d).index) == [f"T{i:03d}" for i in range(2, 10)]


def test_cap_score_shape():
    s = score.cap_score(pd.Series([10e6, 100e6, 1e9, 5e9, 20e9, np.nan]))
    assert s.iloc[0] == 0.3 and s.iloc[1] == 1.0 and s.iloc[2] == 1.0
    assert 0 < s.iloc[3] < 1 and s.iloc[4] == 0 and s.iloc[5] == 0.5


# ── prices ─────────────────────────────────────────────────────────────────
def test_price_metrics():
    idx = pd.bdate_range("2025-10-01", periods=260)
    close = pd.Series(np.linspace(10, 20, 260), index=idx)
    vol = pd.Series(100_000.0, index=idx)
    m = prices.price_metrics(close, vol)
    assert math.isclose(m["price"], 20.0)
    assert m["ret_6m"] > m["ret_3m"] > m["ret_1m"] > 0
    assert math.isclose(m["dist_high"], 0.0, abs_tol=1e-9)
    assert m["dollar_vol"] > 1_000_000
    assert prices.price_metrics(close.iloc[:100], vol.iloc[:100]) is None


# ── fundamentals ───────────────────────────────────────────────────────────
def _qis(rev, gp=None):
    cols = pd.to_datetime(["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"])[: len(rev)]
    rows = {"Total Revenue": list(reversed(rev))}  # yfinance puts newest first
    if gp:
        rows["Gross Profit"] = list(reversed(gp))
    return pd.DataFrame(rows, index=cols).T


def _cf(rev_pairs, ni=None, cash=5e6, shares=1e7):
    """Synthetic SEC companyfacts: rev_pairs = [(start, end, val)]."""
    def rows(pairs):
        return [{"start": a, "end": b, "val": v, "filed": b} for a, b, v in pairs]
    us = {"Revenues": {"units": {"USD": rows(rev_pairs)}},
          "CashAndCashEquivalentsAtCarryingValue": {"units": {"USD": [{"end": "2026-06-30", "val": cash, "filed": "2026-08-01"}]}}}
    if ni:
        us["NetIncomeLoss"] = {"units": {"USD": rows(ni)}}
    return {"entityName": "X", "facts": {"us-gaap": us, "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
        {"end": "2026-07-20", "val": shares, "filed": "2026-08-01"}]}}}}}


def test_parse_companyfacts_growth_streak_runway():
    import datetime as dt
    qs = [("2025-04-01", "2025-06-30", 100), ("2025-07-01", "2025-09-30", 110),
          ("2025-10-01", "2025-12-31", 125), ("2026-01-01", "2026-03-31", 140), ("2026-04-01", "2026-06-30", 200)]
    ni = [("2026-04-01", "2026-06-30", -3e6)]
    p = fundamentals.parse_companyfacts(_cf(qs, ni), today=dt.date(2026, 9, 1))
    assert p["ok"] and p["shares_out"] == 1e7
    assert abs(p["rev_yoy"] - 1.0) < 1e-9
    assert p["rev_streak"] == 4
    assert abs(p["runway_months"] - 5.0) < 1e-9


def test_parse_companyfacts_derives_q4_and_rejects_stale():
    import datetime as dt
    pairs = [("2025-01-01", "2025-03-31", 10), ("2025-01-01", "2025-09-30", 40), ("2025-01-01", "2025-12-31", 60)]
    cf = _cf(pairs)
    p = fundamentals.parse_companyfacts(cf, today=dt.date(2026, 2, 1))
    assert p["ok"] and p["quarters"] == 2
    assert not fundamentals.parse_companyfacts(cf, today=dt.date(2028, 1, 1))["ok"]

SAMPLE_XML = """<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/formc">
  <issuerInformation><issuerInfo><nameOfIssuer>Acme Rockets, Inc.</nameOfIssuer>
    <issuerWebsite>https://acme.example</issuerWebsite></issuerInfo>
    <securityOfferedType>Common Stock</securityOfferedType><price>1.25</price>
    <offeringAmount>50000</offeringAmount><maximumOfferingAmount>1235000</maximumOfferingAmount>
    <deadlineDate>12-31-2026</deadlineDate></issuerInformation>
  <intermediaryCompanyName>x</intermediaryCompanyName>
  <companyName>Example Funding Portal LLC</companyName>
  <annualReportDisclosureRequirements><currentEmployees>12</currentEmployees>
    <totalAssetMostRecentFiscalYear>800000</totalAssetMostRecentFiscalYear>
    <cashAndCashEquivalentMostRecentFiscalYear>150000</cashAndCashEquivalentMostRecentFiscalYear>
    <longTermDebtMostRecentFiscalYear>20000</longTermDebtMostRecentFiscalYear>
    <revenueMostRecentFiscalYear>900000</revenueMostRecentFiscalYear>
    <revenuePriorFiscalYear>450000</revenuePriorFiscalYear>
    <netIncomeMostRecentFiscalYear>-120000</netIncomeMostRecentFiscalYear>
    <netIncomePriorFiscalYear>-200000</netIncomePriorFiscalYear>
  </annualReportDisclosureRequirements>
</edgarSubmission>"""


def test_parse_form_c():
    p = formc.parse_form_c(SAMPLE_XML)
    assert p["issuer"] == "Acme Rockets, Inc." and p["portal"] == "Example Funding Portal LLC"
    assert p["target_amount"] == 50000 and p["max_amount"] == 1235000 and p["price"] == 1.25
    assert p["deadline"] == dt.date(2026, 12, 31) and p["employees"] == 12
    assert p["revenue"] == 900000 and p["revenue_prior"] == 450000
    assert p["net_income"] == -120000 and p["net_income_prior"] == -200000
    assert p["cash"] == 150000 and p["debt"] == 20000 and p["total_assets"] == 800000


def test_parse_master_idx_keeps_only_offerings():
    text = (
        "Description: Master Index\nLast Data Received: x\n\nCIK|Company Name|Form Type|Date Filed|Filename\n"
        "------------------------------------------------------------------\n"
        "1234567|ACME ROCKETS INC|C|20261013|edgar/data/1234567/0001234567-26-000012.txt\n"
        "1234567|ACME ROCKETS INC|C-AR|20261013|edgar/data/1234567/0001234567-26-000013.txt\n"
        "7654321|BETA LABS|C/A|20261012|edgar/data/7654321/0007654321-26-000003.txt\n"
        "1111111|BIG CO|10-K|20261012|edgar/data/1111111/0001111111-26-000001.txt\n"
    )
    rows = formc.parse_master_idx(text)
    assert [r["accession"] for r in rows] == ["0001234567-26-000012", "0007654321-26-000003"]
    assert rows[0]["cik"] == "1234567" and rows[1]["form_type"] == "C/A"
    assert rows[0]["filed_at"] == dt.date(2026, 10, 13)


# ── store ──────────────────────────────────────────────────────────────────
def test_clean_makes_json_safe():
    import json

    blob = store.clean({"a": float("nan"), "b": np.float64(1.5), "c": np.int64(3), "d": dt.date(2026, 1, 2),
                        "e": [np.nan, 1], "f": pd.Timestamp("2026-01-02"), "g": np.bool_(True)})
    json.dumps(blob, allow_nan=False)
    assert blob["a"] is None and blob["b"] == 1.5 and blob["c"] == 3 and blob["d"] == "2026-01-02" and blob["g"] is True


# ── end to end, offline ────────────────────────────────────────────────────
def test_full_dry_run_pipeline(monkeypatch):
    n = 120
    tickers = [f"T{i:03d}" for i in range(n)]
    rng = np.random.default_rng(7)
    idx = pd.bdate_range(end="2026-10-13", periods=260)

    uni = pd.DataFrame({"ticker": tickers, "name": [f"Company {i} Robotics Inc" for i in range(n)],
                        "exchange": "Nasdaq"})
    px = pd.DataFrame({
        "price": rng.uniform(3, 30, n), "ret_1m": rng.normal(0, .1, n), "ret_3m": rng.normal(0, .2, n),
        "ret_6m": rng.normal(.05, .3, n), "dist_high": -rng.uniform(0, .5, n),
        "dollar_vol": rng.uniform(5e5, 3e7, n), "last_date": dt.date(2026, 10, 13),
    }, index=tickers)
    px["rs_6m"] = px["ret_6m"] - 0.05
    closes = {t: pd.Series(np.linspace(5, 9, 260), index=idx) for t in tickers}

    def fake_fund(t):
        i = int(t[1:])
        return {"ok": True, "name": f"Company {i} Robotics Inc", "sector": "Technology", "industry": "Robotics",
                "mkt_cap": float(rng.uniform(80e6, 3e9)), "shares_out": 1e7, "analyst_count": i % 9,
                "inst_pct": float(rng.uniform(0, .8)), "gross_margin": float(rng.uniform(.1, .7)),
                "profit_margin": -0.1, "debt_to_equity": 40.0, "rev_yoy": float(rng.normal(.2, .3)),
                "rev_streak": i % 5, "quarters": 5, "runway_months": None}

    monkeypatch.setattr(run.universe, "get_universe", lambda: uni)
    monkeypatch.setattr(run.prices, "load_prices", lambda tk, store=None: (px, closes, dt.date(2026, 10, 13), 0.05))
    monkeypatch.setattr(fundamentals, "fetch_fundamentals", fake_fund)
    monkeypatch.setattr(cfg, "REQUEST_PAUSE", 0)
    monkeypatch.setattr(run.attention, "fetch_all", lambda names: {t: (hash(t) % 5) for t in names})

    st = store.MemoryStore()
    stats = run.run_public(st)
    assert stats["scorable"] == n and stats["main"] > 0
    assert len(st.tables["scores"]) == n and len(st.tables["signals"]) == n
    assert len(st.tables["fundamentals_cache"]) == n
    assert len(st.tables["entities"]) == n and len(st.tables["price_series"]) == min(n, cfg.PRICE_SERIES_TOP_N)
    row = next(iter(st.tables["scores"].values()))
    assert isinstance(row["flags"], list) and row["as_of"] == "2026-10-13"
    assert isinstance(row["rank"], int)
    for sig in st.tables["signals"].values():  # Postgres integer columns must get ints, never 3.0
        for c in ("rev_streak", "analyst_count", "hn_mentions"):
            assert sig[c] is None or type(sig[c]) is int, (c, sig[c])

    # second run the same day is idempotent (same primary keys → no duplicates) and uses the cache
    stats2 = run.run_public(st)
    assert stats2["fundamentals"]["refreshed"] == 0
    assert len(st.tables["scores"]) == n


def test_refresh_budget_is_respected(monkeypatch):
    calls = []
    monkeypatch.setattr(fundamentals, "fetch_fundamentals", lambda t: (calls.append(t), {"ok": True})[1])
    monkeypatch.setattr(cfg, "MAX_REFRESH_PER_RUN", 10)
    monkeypatch.setattr(cfg, "REQUEST_PAUSE", 0)
    st = store.MemoryStore()
    fundamentals.refresh_cache(st, [f"T{i}" for i in range(50)])
    assert len(calls) == 10


def test_rate_limit_aborts_and_keeps_progress(monkeypatch):
    seq = {"n": 0}

    def flaky(t):
        seq["n"] += 1
        if seq["n"] > 3:
            raise fundamentals.RateLimited("429")
        return {"ok": True}

    monkeypatch.setattr(fundamentals, "fetch_fundamentals", flaky)
    monkeypatch.setattr(cfg, "REQUEST_PAUSE", 0)
    monkeypatch.setattr(cfg, "RATE_LIMIT_ABORT_AFTER", 3)
    monkeypatch.setattr(fundamentals.time, "sleep", lambda s: None)
    st = store.MemoryStore()
    _, stats = fundamentals.refresh_cache(st, [f"T{i}" for i in range(40)])
    assert stats["aborted_rate_limit"] and stats["refreshed"] == 3
    assert len(st.tables["fundamentals_cache"]) == 3


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-q"]))


def test_transient_fetch_error_is_not_cached(monkeypatch):
    from crawler import fundamentals as fu
    from crawler.store import MemoryStore
    monkeypatch.setattr(fu.time, "sleep", lambda *_: None)
    monkeypatch.setattr(fu, "fetch_fundamentals",
                        lambda t: {"ok": False, "error": "ConnectionError"} if t == "BAD" else {"ok": True, "mkt_cap": 1e8})
    st = MemoryStore()
    out, stats = fu.refresh_cache(st, ["BAD", "GOOD"])
    cached = {r["ticker"] for r in st.select("fundamentals_cache")}
    assert cached == {"GOOD"} and "GOOD" in out and stats["failed"] == 1 and stats["refreshed"] == 1


def test_grouped_daily_to_frames():
    from crawler import prices
    p = {"results": [{"T": "AAA", "c": 2.0, "v": 1000}, {"T": "SPY", "c": 500.0, "v": 9}, {"T": "ZZZ", "c": 1.0, "v": 1}]}
    assert prices.parse_grouped(p)[0] == {"T": "AAA", "c": 2.0, "v": 1000}
    assert prices.parse_grouped({"results": None}) == []
    d1, d2 = dt.date(2026, 10, 12), dt.date(2026, 10, 13)
    c, v = prices.frames_from_bars({d1: prices.parse_grouped(p), d2: []}, ["AAA"])
    assert list(c.columns) == ["AAA", "SPY"] and len(c) == 1 and v["AAA"].iloc[0] == 1000


def test_price_days_cache_roundtrip(monkeypatch):
    """Second run reads cached days from the store and only fetches what is missing."""
    from crawler import prices
    from crawler.store import MemoryStore

    class D(dt.date):
        @classmethod
        def today(cls):
            return cls(2026, 10, 14)

    monkeypatch.setattr(prices.dt, "date", D)
    monkeypatch.setenv("MASSIVE_API_KEY", "x")
    monkeypatch.delenv("FULL_REFRESH", raising=False)
    monkeypatch.setattr(prices.time, "sleep", lambda s: None)
    calls = []

    def fake(session, day, key):
        calls.append(day)
        if day == dt.date(2026, 10, 13):
            return None  # not published yet
        px = 100 + len(calls) * 0.01
        return [{"T": "SPY", "c": px, "v": 1e6}, {"T": "AAA", "c": px * 2, "v": 5e5}, {"T": "ZZZ", "c": 9.0, "v": 1.0}]

    monkeypatch.setattr(prices, "_fetch_day", fake)
    store = MemoryStore()
    df, closes, as_of, _ = prices.load_prices(["AAA"], store)
    first = len(calls)
    assert as_of == dt.date(2026, 10, 12) and "AAA" in df.index
    cached_days = len(store.tables["price_days"])
    assert cached_days == first - 1                       # the unpublished day is never cached
    assert "ZZZ" not in next(iter(store.tables["price_days"].values()))["bars"]  # only wanted tickers stored
    calls.clear()
    prices.load_prices(["AAA"], store)
    assert calls == [dt.date(2026, 10, 13)]               # only the unpublished day is retried


# ── big-money signals ────────────────────────────────────────────────────────
FORM4_TXT = """<SEC-DOCUMENT>0001234567-26-000123.txt
<DOCUMENT><TYPE>4<XML>
<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerCik>0000111222</issuerCik><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>true</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-09</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>12.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-09</value></transactionDate>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>500</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
</XML></DOCUMENT></SEC-DOCUMENT>"""

SCHED13D_TXT = """<XML><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D">
<formData><reportingPersons><reportingPersonInfo>
<reportingPersonName>BIG FUND LP</reportingPersonName>
<reportingPersonBeneficiallyOwnedAggregateNumberOfShares>1,250,000</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
<classPercent>6.2</classPercent>
</reportingPersonInfo></reportingPersons></formData></edgarSubmission></XML>"""


def test_parse_form4_keeps_only_open_market_trades():
    from crawler import smartmoney as sm
    p = sm.parse_form4(FORM4_TXT)
    assert p["owner"] == "DOE JANE" and p["title"] == "CEO" and p["is_officer"] and p["is_director"]
    assert len(p["rows"]) == 1  # the grant (code A) is dropped
    r = p["rows"][0]
    assert r["code"] == "P" and r["shares"] == 10000 and r["price"] == 12.5 and r["value"] == 125000
    assert str(r["tx_date"]) == "2026-10-09"
    assert sm.parse_form4("nothing here") is None


def test_parse_13dg_and_index():
    from crawler import smartmoney as sm
    p = sm.parse_13dg(SCHED13D_TXT)
    assert p == {"holder": "BIG FUND LP", "shares": 1250000.0, "pct": 6.2}
    idx = "header\n-----\n111222|ACME INC|4|20261012|edgar/data/111222/0001234567-26-000123.txt\n" \
          "999|OTHER|4|20261012|edgar/data/999/0001234567-26-000124.txt\n" \
          "111222|ACME INC|SCHEDULE 13D|20261012|edgar/data/111222/0001234567-26-000125.txt\n" \
          "111222|ACME INC|10-Q|20261012|edgar/data/111222/0001234567-26-000126.txt\n"
    rows = sm.parse_index(idx, {"111222"})
    assert [r["form"] for r in rows] == ["4", "SCHEDULE 13D"]


def test_compute_signals_cluster_and_activist():
    from crawler import smartmoney as sm
    today = dt.date(2026, 10, 14)
    d = lambda n: today - dt.timedelta(days=n)  # noqa: E731
    trades = [
        {"code": "P", "owner": "A", "value": 60_000, "filed_at": d(3), "is_officer": True, "is_director": False},
        {"code": "P", "owner": "B", "value": 70_000, "filed_at": d(5), "is_officer": False, "is_director": True},
        {"code": "P", "owner": "C", "value": 200_000, "filed_at": d(40)},   # outside 30 days
        {"code": "S", "owner": "D", "value": 1_000_000, "filed_at": d(2)},
    ]
    holders = [{"form_type": "SCHEDULE 13D", "holder": "X", "pct": 6.0, "filed_at": d(10)},
               {"form_type": "SCHEDULE 13D/A", "holder": "Y", "pct": 7.0, "filed_at": d(4)}]
    s = sm.compute_signals(trades, holders, today)
    assert s["tags"] == ["insider_cluster", "activist_13d"]
    assert s["buyers_30d"] == 2 and s["buy_value_30d"] == 130_000 and s["sellers_30d"] == 1
    assert s["n_13d_90d"] == 1                      # the amendment does not count as a new holder
    assert s["score"] == 50 + 15 + 35
    quiet = sm.compute_signals([{"code": "P", "owner": "A", "value": 5_000, "filed_at": d(1)}], [], today)
    assert quiet["tags"] == [] and quiet["score"] == 0


def test_run_smart_end_to_end(monkeypatch):
    import pandas as pd
    from crawler import smartmoney as sm, universe
    from crawler.store import MemoryStore

    class D(dt.date):
        @classmethod
        def today(cls):
            return cls(2026, 10, 14)

    store = MemoryStore()
    store.upsert("scores", [{"ticker": "ACME", "as_of": "2026-10-13"}], "ticker,as_of")
    monkeypatch.setattr(universe, "get_universe", lambda: pd.DataFrame({"ticker": ["ACME"], "cik": [111222]}))
    monkeypatch.setenv("SEC_USER_AGENT", "Test t@example.com")
    monkeypatch.setattr(sm.time, "sleep", lambda s: None)

    class R:
        def __init__(self, text):
            self.text, self.status_code = text, 200

        def raise_for_status(self):
            pass

    day_idx = "h\n-----\n111222|ACME INC|4|20261013|edgar/data/111222/0001234567-26-000123.txt\n" \
              "111222|ACME INC|SCHEDULE 13D|20261013|edgar/data/111222/0001234567-26-000125.txt\n"

    def fake_get(self, url, timeout=60):
        if "daily-index" in url:
            return R(day_idx) if "20261013" in url else R("h\n-----\n")
        return R(FORM4_TXT if "000123" in url else SCHED13D_TXT)

    monkeypatch.setattr(sm.requests.Session, "get", fake_get)
    stats = sm.run_smart(store, today=dt.date(2026, 10, 14))
    assert stats["form4"] == 1 and stats["trades"] == 1 and stats["holders"] == 1
    row = store.tables["smart_money"][("ACME",)]
    assert "activist_13d" in row["tags"] and row["buyers_30d"] == 1
    stats2 = sm.run_smart(store, today=dt.date(2026, 10, 14))
    assert stats2["fetched"] == 0                    # already known: nothing downloaded twice


def test_report_card_excess_vs_spy():
    import datetime as dt
    from crawler import report
    d = [dt.date(2026, 10, 1) + dt.timedelta(days=i) for i in range(8)]
    closes = {x: {"SPY": 100 + i, "A": 10 * (1 + 0.02 * i), "B": 10 * (1 - 0.01 * i), "C": 10.0} for i, x in enumerate(d)}
    out = report.compute_report({d[0]: ["A", "B", "C"]}, closes, horizons=(5,))
    assert len(out) == 1
    r = out[0]
    assert r["n"] == 3 and r["spy_ret"] == 0.05
    assert abs(r["avg_ret"] - (0.1 - 0.05 + 0) / 3) < 1e-3
    assert r["best"] == "A" and r["worst"] == "B" and r["hit_rate"] == round(1 / 3, 4)
    assert report.compute_report({d[0]: ["A", "B", "C"]}, closes, horizons=(9,)) == []


def test_run_report_end_to_end():
    import datetime as dt
    from crawler import report
    from crawler.store import MemoryStore
    st = MemoryStore()
    base = dt.date(2026, 9, 1)
    days = [base + dt.timedelta(days=i) for i in range(30)]
    st.upsert("scores", [{"ticker": t, "as_of": base.isoformat(), "board": "main", "rank": i + 1} for i, t in enumerate("ABC")], "ticker,as_of")
    st.upsert("price_days", [{"day": x.isoformat(), "bars": {"SPY": [100, 1], "A": [10 + i, 1], "B": [10, 1], "C": [10, 1]}} for i, x in enumerate(days)], "day")
    stats = report.run_report(st, today=dt.date(2026, 10, 1))
    assert stats["rows"] == 2
    rows = st.select("report_card")
    assert {r["horizon"] for r in rows} == {5, 20}


def test_form_cu_parse_and_index():
    from crawler import formc
    xml = b"<edgarSubmission><x><currentAmountRaised>45,000</currentAmountRaised><deadlineDate>12-31-2026</deadlineDate></x></edgarSubmission>"
    p = formc.parse_form_cu(xml)
    assert p["raised"] == 45000.0 and "deadlineDate" not in p["raw"]
    text = "x\n-----\n123|ACME INC|C-U|20261012|edgar/data/123/0001234567-26-000001.txt\n123|ACME INC|C|20261012|edgar/data/123/0001234567-26-000002.txt\n"
    assert [r["form_type"] for r in formc.parse_master_idx(text)] == ["C"]
    assert [r["form_type"] for r in formc.parse_master_idx(text, include_updates=True)] == ["C-U", "C"]


def test_digest_compose_and_skip():
    from crawler import digest
    prev = [{"ticker": t, "board": "main", "rank": i + 1, "score": 60 - i} for i, t in enumerate(["A", "B", "C"])]
    cur = [{"ticker": "D", "board": "main", "rank": 1, "score": 70}, {"ticker": "A", "board": "main", "rank": 2, "score": 61},
           {"ticker": "B", "board": "main", "rank": 3, "score": 59}, {"ticker": "C", "board": "main", "rank": 25, "score": 40}]
    smart = {"D": {"score": 80, "tags": ["insider_cluster"]}}
    msg = digest.compose(cur, prev, smart, [{"issuer": "Acme"}], "2026-10-14")
    assert "新進前 20 名：D" in msg and "內部人群買" in msg and "Acme" in msg
    assert digest.compose(prev, prev, {}, [], "2026-10-14") is None


def test_run_digest_skips_without_secrets(monkeypatch):
    from crawler import digest
    from crawler.store import MemoryStore
    for k in ("TELEGRAM_BOT_TOKEN", "LINE_CHANNEL_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert digest.run_digest(MemoryStore())["sent"] is False


def test_industry_sector_and_fill():
    from crawler import industry
    from crawler.store import MemoryStore
    assert industry.sector_of(2834) == "生技與製藥" and industry.sector_of("7372") == "軟體與資訊服務"
    assert industry.sector_of(3674) == "半導體與電子" and industry.sector_of(None) is None
    assert industry.sector_of(7389) == "商業服務" and industry.sector_of(2000) == "食品與飲料" and industry.sector_of(3590) == "工業機械"
    p = industry.parse_submissions({"sic": "2834", "sicDescription": "Pharmaceutical Preparations"})
    assert p["sector"] == "生技與製藥" and p["industry"] == "Pharmaceutical Preparations"
    st = MemoryStore()
    st.upsert("entities", [{"ticker": "AAA", "sector": "能源", "industry": "Crude Petroleum"}], "ticker")
    out = industry.fill(st, ["AAA"], {"AAA": 1}, budget=0)
    assert out["AAA"]["sector"] == "能源"


def test_run_smart_dedupes_accessions_listed_twice():
    import datetime as dt
    from crawler import smartmoney
    text = "x\n-----\n111|ACME|SC 13D|20261012|edgar/data/111/0000000001-26-000001.txt\n222|HOLDER LP|SC 13D|20261012|edgar/data/111/0000000001-26-000001.txt\n"
    rows = smartmoney.parse_index(text, {"111", "222"})
    assert len({r["accession"] for r in rows}) == 1 and len(rows) == 2


def test_line_budget_fails_closed_and_respects_ceiling():
    from crawler import digest

    class R:
        def __init__(self, data, bad=False):
            self.data, self.bad = data, bad
        def raise_for_status(self):
            if self.bad:
                raise RuntimeError("boom")
        def json(self):
            return self.data

    def sess(quota, used, bad=False):
        class S:
            def get(self, url, **kw):
                return R(quota if url.endswith("/quota") else used, bad)
        return S()

    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 200}, {"totalUsage": 10}))[0] is True
    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 200}, {"totalUsage": 99}))[0] is True
    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 200}, {"totalUsage": 100}))[0] is False   # our cap of 100
    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 110}, {"totalUsage": 90}))[0] is False    # limit - reserve = 90
    assert digest.line_budget_ok("t", sess({"type": "none"}, {"totalUsage": 0}))[0] is False                       # unlimited/paid plan
    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 200}, {"totalUsage": 1}, bad=True))[0] is False
    assert digest.line_budget_ok("t", sess({"type": "limited", "value": 200}, {}))[0] is False                    # missing usage


def test_main_board_is_capped_to_best_scores(monkeypatch):
    monkeypatch.setattr(cfg, "MAIN_MAX_NAMES", 3)
    out = score.compute_scores(make_universe())
    main = out[out["board"] == "main"]
    assert len(main) <= 3
    rest = out[(out["board"] == "watch")]
    if len(main) == 3 and not rest.empty:
        eligible = rest[~rest["flags"].map(lambda f: "data_thin" in f) & rest["mkt_cap"].between(cfg.MAIN_CAP_MIN, cfg.MAIN_CAP_MAX)
                        & (rest["dollar_vol"] >= cfg.MIN_DOLLAR_VOL) & (rest["price"] >= cfg.MIN_PRICE)]
        assert (eligible["score"] <= main["score"].min()).all()


def test_holder_under_five_percent_is_not_a_signal():
    from crawler import smartmoney as sm
    today = dt.date(2026, 10, 14)
    mk = lambda form, pct: {"form_type": form, "filed_at": today, "pct": pct, "holder": "X"}
    assert sm.compute_signals([], [mk("SCHEDULE 13D", 0.7), mk("SCHEDULE 13G", 1.2)], today)["tags"] == []
    sig = sm.compute_signals([], [mk("SCHEDULE 13D", 8.7), mk("SCHEDULE 13G", 5.2)], today)
    assert "activist_13d" in sig["tags"] and "new_5pct" in sig["tags"]


def test_form_cu_real_shape_does_not_use_cost_of_goods_sold():
    from crawler import formc
    xml = (b"<edgarSubmission><offeringInformation><offeringAmount>9995.64</offeringAmount><maximumOfferingAmount>5000000</maximumOfferingAmount>"
           b"<noOfSecurityOffered>9333</noOfSecurityOffered><price>1.05</price></offeringInformation>"
           b"<costGoodsSoldMostRecentFiscalYear>2386338</costGoodsSoldMostRecentFiscalYear></edgarSubmission>")
    assert formc.parse_form_cu(xml)["raised"] == 9995.64


def test_digest_watchlist_and_alerts():
    from crawler import digest
    today = {"AAA": {"ticker": "AAA", "board": "main", "rank": 5, "score": 74.0}, "BBB": {"ticker": "BBB", "board": "watch", "rank": 90, "score": 50.0},
             "CCC": {"ticker": "CCC", "board": "main", "rank": 3, "score": 61.0}}
    prev = {"AAA": {"ticker": "AAA", "board": "main", "score": 66.0}, "BBB": {"ticker": "BBB", "board": "main", "score": 51.0},
            "CCC": {"ticker": "CCC", "board": "main", "score": 60.0}}
    lines = digest.watch_lines(["AAA", "BBB", "CCC", "ZZZ"], today, prev, {"CCC": {"score": 40, "tags": ["insider_buy"]}})
    assert any(x.startswith("AAA") and "66→74" in x for x in lines)
    assert any(x.startswith("BBB") and "掉出主榜" in x for x in lines)
    assert any(x.startswith("CCC") and "內部人買進" in x for x in lines) and not any(x.startswith("ZZZ") for x in lines)
    al = [{"id": 1, "ticker": "AAA", "metric": "score", "op": ">", "value": 70}, {"id": 2, "ticker": "AAA", "metric": "rank", "op": "<=", "value": 3},
          {"id": 3, "ticker": "AAA", "metric": "score", "op": ">", "value": 70, "fired_at": "x"}, {"id": 4, "ticker": "NOPE", "metric": "score", "op": ">", "value": 1}]
    assert [a["id"] for a in digest.check_alerts(al, today)] == [1]
    fired = digest.check_alerts(al, today)
    msg = digest.compose([], [], {}, [], "2026-10-14", digest.watch_lines(["AAA"], today, prev, {}), fired)
    assert "你設的提醒：AAA 分數>70" in msg and "自選異動" in msg
