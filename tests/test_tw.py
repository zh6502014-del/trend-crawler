import datetime as dt
import numpy as np
import pandas as pd


def _twse_payload(rows, index=46969.87):
    return {"stat": "OK", "tables": [
        {"title": "115年10月15日 價格指數(臺灣證券交易所)", "fields": ["指數", "收盤指數", "漲跌(+/-)", "漲跌點數", "漲跌百分比(%)", "特殊處理註記"],
         "data": [["發行量加權股價指數", f"{index:,.2f}", "<p>-</p>", "1.0", "-3.4", ""]]},
        {"title": "115年10月15日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))",
         "fields": ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"],
         "data": rows}]}


def test_parse_twse_day_filters_codes_and_reads_index():
    from crawler import tw
    p = _twse_payload([["2330", "台積電", "1,000", "10", "1,200,000", "1", "1", "1", "1,200.00", "", ""],
                       ["0050", "ETF", "1", "1", "1", "1", "1", "1", "50.00", "", ""],
                       ["1101", "台泥", "5", "1", "5", "1", "1", "1", "--", "", ""]])
    out = tw.parse_twse_day(p)
    assert set(out) == {"2330", tw.BENCH} and out["2330"][0] == 1200.0 and out["2330"][2] == 1_200_000
    assert abs(out[tw.BENCH][0] - 46969.87) < 1e-6
    assert tw.parse_twse_day({"stat": "很抱歉，沒有符合條件的資料!", "tables": []}) is None


def test_parse_tpex_day():
    from crawler import tw
    p = {"tables": [{"fields": ["代號", "名稱", "收盤 ", "漲跌", "成交股數  ", " 成交金額(元)", "發行股數 "],
                     "data": [["1240", "茂生農經", "92.5", "+1", "100,000", "9,250,000", "46,443,992"], ["00679B", "ETF", "25", "0", "1", "1", "1"]]}]}
    out = tw.parse_tpex_day(p)
    assert list(out) == ["1240"] and out["1240"] == [92.5, 100000, 9250000, 46443992]
    assert tw.parse_tpex_day({"tables": []}) is None


def test_revenue_and_shares_parsing():
    from crawler import tw
    rows = [{"出表日期": "1151015", "資料年月": "11509", "公司代號": "1101", "公司名稱": "台泥", "產業別": "水泥工業",
             "營業收入-當月營收": "14321556", "營業收入-去年同月增減(%)": "7.62", "累計營業收入-前期比較增減(%)": "3.29"},
            {"公司代號": "00400A", "公司名稱": "x"}]
    df = tw.parse_revenue(rows)
    assert list(df.index) == ["1101"] and abs(df.loc["1101", "rev_yoy"] - 0.0762) < 1e-9
    assert tw.revenue_streak(0.1, 0.03) == 4 and tw.revenue_streak(0.1, -0.1) == 2 and tw.revenue_streak(np.nan, np.nan) == 0
    sh = tw.parse_shares([{"公司代號": "1101", "已發行普通股數或TDR原股發行股數": "7,000,000,000"},
                          {"SecuritiesCompanyCode": "1240", "Paidin.Capital.NTDollars": "464439920"}])
    assert sh["1101"] == 7e9 and sh["1240"] == 46443992


def test_load_json_list_salvages_truncated_payload():
    from crawler import tw
    txt = '[{"a":1},{"a":2},{"a":"cut'
    assert tw.load_json_list(txt) == [{"a": 1}, {"a": 2}]
    assert tw.load_json_list('[{"a":1}]') == [{"a": 1}]


def _history(n_days=150, n_codes=60):
    rng = np.random.default_rng(1)
    base = dt.date(2026, 3, 2)
    days = []
    d = base
    while len(days) < n_days:
        if d.weekday() < 5:
            days.append(d)
        d += dt.timedelta(days=1)
    hist = {}
    drift = {f"{1000 + i * 7}": 0.0004 * (i - n_codes / 2) / 10 for i in range(n_codes)}
    price = {c: 50.0 for c in drift}
    idx = 20000.0
    for dd in days:
        idx *= 1.0002
        bars = {tw_b: [idx, 0, 0, None] for tw_b in ("_TAIEX",)}
        for c in drift:
            price[c] *= 1 + drift[c] + rng.normal(0, 0.01)
            bars[c] = [round(price[c], 2), 2_000_000, round(price[c] * 2_000_000), 500_000_000]
        hist[dd] = bars
    return hist


def test_price_frame_and_scoring_end_to_end():
    from crawler import tw
    hist = _history()
    px = tw.price_frame(hist)
    assert len(px) == 60 and px["rs_6m"].notna().all() and px.attrs["as_of"] == max(hist)
    rng = np.random.default_rng(2)
    rev = pd.DataFrame({"name": [f"公司{c}" for c in px.index], "exchange": "TWSE", "sector": "電子零組件業", "ym": "11509",
                        "rev_month": 1e6, "rev_yoy": rng.normal(0.1, 0.3, len(px)), "rev_cum_yoy": rng.normal(0.1, 0.2, len(px))}, index=px.index)
    shares = {c: 5e8 for c in px.index}
    df = tw.build_universe(px, rev, shares)
    assert (df["mkt_cap"] > 0).all()
    out = tw.compute_tw_scores(df, max_main=10)
    assert set(out["board"]) <= {"tw_main", "tw_watch"}
    assert (out["board"] == "tw_main").sum() <= 10
    assert out["score"].between(0, 100).all()
    top = out[out.board == "tw_main"].sort_values("rank")
    assert list(top["rank"]) == list(range(1, len(top) + 1))
    assert not any("data_thin" in f for f in out["flags"])
    # thresholds are restored after scoring
    from crawler import config as cfg
    assert cfg.MIN_PRICE == 1.0 and cfg.MIN_DOLLAR_VOL == 300_000


def test_run_tw_writes_tables(monkeypatch):
    from crawler import tw
    from crawler.store import MemoryStore
    hist = _history()
    monkeypatch.setattr(tw, "load_prices", lambda store, today=None, **k: hist)
    rng = np.random.default_rng(3)
    codes = [c for c in hist[max(hist)] if c != "_TAIEX"]
    rev = pd.DataFrame({"name": codes, "exchange": "TPEx", "sector": "x", "ym": "11509", "rev_month": 1e6,
                        "rev_yoy": rng.normal(0.1, 0.3, len(codes)), "rev_cum_yoy": 0.05}, index=codes)
    monkeypatch.setattr(tw, "load_fundamentals", lambda session=None: (rev, {}, {}))
    st = MemoryStore()
    stats = tw.run_tw(st)
    assert stats["scorable"] == 60
    assert len(st.select("tw_scores")) == 60 and len(st.select("tw_signals")) == 60 and len(st.select("tw_entities")) == 60


def test_report_uses_taiex_benchmark():
    from crawler.report import compute_report
    d0, d1 = dt.date(2026, 10, 1), dt.date(2026, 10, 2)
    closes = {d0: {"_TAIEX": 100.0, **{f"{i}": 10.0 for i in range(30)}},
              d1: {"_TAIEX": 110.0, **{f"{i}": 12.0 for i in range(30)}}}
    cohorts = {d0: [str(i) for i in range(10)]}
    out = compute_report(cohorts, closes, horizons=(1,), boards={d0: [str(i) for i in range(30)]}, bench="_TAIEX")
    assert len(out) == 1 and out[0]["spy_ret"] == 0.1 and out[0]["avg_ret"] == 0.2 and out[0]["excess"] == 0.1
    assert compute_report(cohorts, closes, horizons=(1,)) == []  # default benchmark SPY is absent
