"""Free LINE/digest optimizations (2026-11-28): revenue announcements, revenue new-high flag, smart-money history."""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import digest, smartmoney, tw_revenue  # noqa: E402


def test_revenue_lines_only_for_a_new_month_watchlist_first():
    cur = {"2330": {"ym": "11510", "rev_yoy": 0.45, "revenue_streak_months": 6},
           "2454": {"ym": "11509", "rev_yoy": 0.20, "revenue_streak_months": 1},   # same month as before: not an announcement
           "3008": {"ym": "11510", "rev_yoy": 0.90, "revenue_streak_months": 2}}
    prev = {"2330": {"ym": "11509"}, "2454": {"ym": "11509"}, "3008": {"ym": "11509"}}
    out = digest.revenue_lines(cur, prev, {"2330": ["rev_high"]}, {"2330": "台積電", "3008": "大立光"}, watch={"2330"})
    assert len(out) == 2
    assert out[0] == "2330台積電　10月年增 +45%，創12個月新高，連6月成長"  # watchlist name first despite lower growth
    assert out[1].startswith("3008大立光　10月年增 +90%") and "創12個月新高" not in out[1] and "連" not in out[1]


def test_revenue_lines_empty_without_previous_snapshot_or_yoy():
    assert digest.revenue_lines({"2330": {"ym": "11510", "rev_yoy": 0.4}}, {}, {}, {}, set()) == []
    assert digest.revenue_lines({"2330": {"ym": "11510", "rev_yoy": None}}, {"2330": {"ym": "11509"}}, {}, {}, set()) == []


def test_tw_lines_puts_revenue_section_after_watchlist():
    rows = [{"ticker": "2330", "board": "tw_main", "rank": 1, "score": 80, "flags": [], "name": "台積電"}]
    out = digest.tw_lines(rows, rows, ["2330　分數 70→80"], ["2330台積電　10月年增 +45%"])
    assert out[0].startswith("自選異動：") and out[1].startswith("營收公告：")


def test_revenue_new_high_needs_twelve_months_and_beats_prior_eleven():
    today = dt.date(2026, 11, 20)
    ym = "11510"  # October 2026 (ROC 115)
    end = dt.date(2026, 10, 1)

    def hist(values):  # values[0] = latest month
        return {("TWSE", tw_revenue.shift(end, -n).isoformat()): {"bars": {"2330": [v, 100.0]}, "fetched_at": "2026-11-01T00:00:00+00:00"}
                for n, v in enumerate(values)}

    high = tw_revenue.metrics("2330", "TWSE", ym, hist([200] + [150] * 11), today)
    assert high["rev_new_high"] is True
    not_high = tw_revenue.metrics("2330", "TWSE", ym, hist([140] + [150] * 11), today)
    assert not_high["rev_new_high"] is False
    short = tw_revenue.metrics("2330", "TWSE", ym, hist([200] * 8), today)
    assert short["rev_new_high"] is False


class FakeStore:
    def __init__(self, fail=False):
        self.rows, self.fail = None, fail

    def upsert(self, table, rows, conflict):
        if self.fail:
            raise RuntimeError("relation does not exist")
        self.rows = (table, rows, conflict)


def test_smart_money_history_keeps_only_active_tickers():
    rows = [{"ticker": "AAA", "score": 40, "tags": ["insider_buy"], "buyers_30d": 2},
            {"ticker": "BBB", "score": 0, "sellers_30d": 0, "buyers_30d": 0, "n_13d_90d": 0, "n_13g_90d": 0},
            {"ticker": "CCC", "score": 0, "sellers_30d": 3}]
    s = FakeStore()
    assert smartmoney.snapshot_history(s, rows, dt.date(2026, 11, 27)) == 2
    table, saved, conflict = s.rows
    assert table == "smart_money_history" and conflict == "as_of,ticker"
    assert [r["ticker"] for r in saved] == ["AAA", "CCC"] and saved[0]["as_of"] == "2026-11-27" and saved[0]["tags"] == ["insider_buy"]


def test_smart_money_history_never_breaks_the_crawl_before_the_migration():
    assert smartmoney.snapshot_history(FakeStore(fail=True), [{"ticker": "AAA", "score": 40}], dt.date(2026, 11, 27)) == 0


# ── multi-signal flag and "new light" events ────────────────────────────────

def test_confluence_needs_three_of_four_lights():
    from crawler import tw
    base = {"growth": 80.0, "validated": 75.0, "flags": []}
    assert tw.confluence_lights(base) == ["growth", "validated"]
    assert tw.confluence_lights({**base, "flags": ["rev_high"]}) == ["growth", "validated", "rev_high"]
    assert tw.confluence_lights({"growth": 69.9, "validated": float("nan"), "flags": ["inst_buy"]}) == ["inst_buy"]
    assert tw.confluence_lights({"growth": None, "validated": None, "flags": None}) == []


def test_add_confluence_flags_only_qualifying_rows():
    import pandas as pd
    from crawler import tw
    df = pd.DataFrame({
        "growth": [80, 80, 50], "validated": [75, 40, 40],
        "flags": [["rev_high"], ["inst_buy"], ["rev_high", "inst_buy"]],
    }, index=["2330", "2317", "2454"])
    out = tw.add_confluence(df)
    assert out.loc["2330", "flags"] == ["rev_high", "multi_signal"]   # growth + validated + rev_high
    assert out.loc["2317", "flags"] == ["inst_buy"]                   # growth + inst_buy only
    assert out.loc["2454", "flags"] == ["rev_high", "inst_buy"]       # only two lights
    assert df.loc["2330", "flags"] == ["rev_high"]                    # input untouched
    again = tw.add_confluence(out)
    assert again.loc["2330", "flags"].count("multi_signal") == 1


def test_watch_lines_report_new_lights_only():
    from crawler import digest
    today = {"2330": {"score": 70, "board": "tw_main", "flags": ["inst_buy", "rev_high"]},
             "2317": {"score": 60, "board": "tw_main", "flags": ["inst_buy"]},
             "2454": {"score": 60, "board": "tw_main", "flags": ["inst_buy"]},
             "2412": {"score": 60, "board": "tw_main", "flags": None}}
    prev = {"2330": {"score": 70, "board": "tw_main", "flags": ["inst_buy"]},
            "2317": {"score": 60, "board": "tw_main", "flags": ["inst_buy"]},
            "2412": {"score": 60, "board": "tw_main", "flags": ["inst_buy"]}}
    lines = digest.watch_lines(["2330", "2317", "2454", "2412"], today, prev, {})
    assert lines == ["2330　新亮燈：營收創高"]  # 2317 unchanged, 2454 has no previous row, 2412 has no flags today


def test_tw_lines_list_multi_signal_names_in_top20():
    from crawler import digest
    rows = [{"ticker": "2330", "name": "台積電", "board": "tw_main", "rank": 1, "score": 80, "flags": ["multi_signal"]},
            {"ticker": "2317", "name": "鴻海", "board": "tw_main", "rank": 2, "score": 70, "flags": []}]
    out = digest.tw_lines(rows, rows)
    assert "前 20 名多訊號共振：2330台積電" in out


# ── Taiwan price series for the detail chart ────────────────────────────────

def _tw_hist(n=140):
    import datetime as dt
    days = [dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(n)]
    return {d: {"2330": [600 + i, 0, 1e9], "2317": [100.0, 0, 1e9], "_TAIEX": [20000 + i, 0, 0]} for i, d in enumerate(days)}


def test_price_series_keeps_last_130_closes():
    from crawler import tw
    hist = _tw_hist()
    rows = tw.price_series(hist, ["2330", "9999"])
    assert [r["ticker"] for r in rows] == ["2330"]          # a code with no prices is skipped
    s = rows[0]["series"]
    assert len(s) == tw.PRICE_SERIES_DAYS == 130
    assert s[-1] == ["2026-05-20", 739.0] and s[0][0] < s[-1][0]


def test_price_series_skips_days_without_the_ticker():
    import datetime as dt
    from crawler import tw
    hist = {dt.date(2026, 5, 1): {"2330": [10.0, 0, 1]}, dt.date(2026, 5, 2): {}, dt.date(2026, 5, 3): {"2330": [11.0, 0, 1]}}
    assert tw.price_series(hist, ["2330"])[0]["series"] == [["2026-05-01", 10.0], ["2026-05-03", 11.0]]
    assert tw.price_series({dt.date(2026, 5, 1): {"2330": [10.0, 0, 1]}}, ["2330"]) == []  # one point is not a chart


def test_save_price_series_covers_main_board_and_is_fail_soft():
    import pandas as pd
    from crawler import tw
    from crawler.store import MemoryStore
    scored = pd.DataFrame({"score": [90.0, 10.0], "board": ["tw_watch", "tw_main"]}, index=["2330", "2317"])
    st = MemoryStore()
    assert tw.save_price_series(st, _tw_hist(), scored) == 2
    assert {k[0] for k in st.tables["tw_price_series"]} == {"2330", "2317"}

    class Broken(MemoryStore):
        def upsert(self, table, rows, on_conflict, chunk=500):
            raise RuntimeError('relation "tw_price_series" does not exist')
    assert tw.save_price_series(Broken(), _tw_hist(), scored) == 0   # table not created yet: the crawl goes on
