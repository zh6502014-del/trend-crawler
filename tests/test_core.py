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


def test_parse_fundamentals_growth_and_streak():
    q = _qis([100, 110, 125, 140, 170], gp=[40, 45, 52, 60, 80])
    p = fundamentals.parse_fundamentals(
        {"marketCap": 500e6, "totalCash": 30e6, "freeCashflow": -60e6, "numberOfAnalystOpinions": 3}, q
    )
    assert p["ok"] and math.isclose(p["rev_yoy"], 0.70)
    assert p["rev_streak"] == 4 and p["quarters"] == 5
    assert math.isclose(p["gross_margin"], 80 / 170)
    assert math.isclose(p["runway_months"], 6.0)


def test_parse_fundamentals_falls_back_to_info():
    p = fundamentals.parse_fundamentals({"marketCap": 1e9, "revenueGrowth": 0.3, "grossMargins": 0.5}, None)
    assert p["rev_yoy"] == 0.3 and p["gross_margin"] == 0.5 and p["quarters"] == 0 and p["runway_months"] is None
    assert fundamentals.parse_fundamentals({}, None)["ok"] is False


# ── attention ──────────────────────────────────────────────────────────────
def test_clean_name():
    assert attention.clean_name("Acme Robotics, Inc.") == "Acme Robotics"
    assert attention.clean_name("Foo Holdings Corp Class A") == "Foo"
    assert attention.clean_name("AB") is None and attention.clean_name(None) is None


# ── Form C ─────────────────────────────────────────────────────────────────
SAMPLE_XML = b"""<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/formc">
  <formData>
    <issuerInformation>
      <issuerInfo><nameOfIssuer>Acme Rockets, Inc.</nameOfIssuer><issuerWebsite>https://acme.example</issuerWebsite></issuerInfo>
      <companyName>Example Funding Portal LLC</companyName>
      <securityOfferedType>Common Stock</securityOfferedType>
      <price>1.25</price>
      <offeringAmount>50,000.00</offeringAmount>
      <maximumOfferingAmount>1,235,000.00</maximumOfferingAmount>
      <deadlineDate>12-31-2026</deadlineDate>
    </issuerInformation>
    <annualReportDisclosureRequirements>
      <currentEmployees>12</currentEmployees>
      <totalAssetMostRecentFiscalYear>800000.00</totalAssetMostRecentFiscalYear>
      <cashEquiMostRecentFiscalYear>150000.00</cashEquiMostRecentFiscalYear>
      <longTermDebtMostRecentFiscalYear>20000.00</longTermDebtMostRecentFiscalYear>
      <revenueMostRecentFiscalYear>900000.00</revenueMostRecentFiscalYear>
      <revenuePriorFiscalYear>450000.00</revenuePriorFiscalYear>
      <netIncomeMostRecentFiscalYear>(120000.00)</netIncomeMostRecentFiscalYear>
      <netIncomePriorFiscalYear>-200000.00</netIncomePriorFiscalYear>
    </annualReportDisclosureRequirements>
  </formData>
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
    monkeypatch.setattr(run.prices, "load_prices", lambda tk: (px, closes, dt.date(2026, 10, 13), 0.05))
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
