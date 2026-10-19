"""Backup-schedule guard: skip only when today's Taiwan board is provably in."""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import schedule_guard as g  # noqa: E402


class Store:
    def __init__(self, rows=None, fail=False):
        self.rows, self.fail, self.asked = rows or [], fail, []

    def select(self, table, params=None, page=1000):
        self.asked.append((table, params))
        if self.fail:
            raise RuntimeError("network down")
        want = (params or {}).get("as_of", "")[3:]
        return [r for r in self.rows if r["as_of"] == want]


def test_taipei_date_rolls_over_at_16_utc():
    assert g.taipei_today(dt.datetime(2026, 10, 19, 15, 59, tzinfo=dt.timezone.utc)) == dt.date(2026, 10, 19)
    assert g.taipei_today(dt.datetime(2026, 10, 19, 16, 1, tzinfo=dt.timezone.utc)) == dt.date(2026, 10, 20)


def test_skip_only_when_today_is_in():
    at = dt.datetime(2026, 10, 19, 10, 10, tzinfo=dt.timezone.utc)   # the 18:10 Taipei backup
    assert g.decide("tw", Store([{"as_of": "2026-10-19"}]), at) is True
    assert g.decide("tw", Store([{"as_of": "2026-10-16"}]), at) is False   # 15:40 run was dropped: crawl now
    st = Store()
    g.decide("tw", st, at)
    assert st.asked[0][0] == "tw_scores" and st.asked[0][1]["board"] == "eq.tw_main"


def test_doubt_means_crawl():
    at = dt.datetime(2026, 10, 19, 10, 10, tzinfo=dt.timezone.utc)
    assert g.decide("tw", Store(fail=True), at) is False
    assert g.decide("us", Store([{"as_of": "2026-10-19"}]), at) is False


def test_main_writes_github_output(tmp_path, monkeypatch):
    out = tmp_path / "out.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(g, "decide", lambda market: True)
    assert g.main(["tw"]) == 0
    assert out.read_text() == "skip=true\n"
