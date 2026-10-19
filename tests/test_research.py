import datetime as dt

import pandas as pd
import pytest

from crawler import tw, tw_revenue as rev
from crawler.store import MemoryStore

TODAY = dt.date(2026, 10, 18)
END = dt.date(2026, 9, 1)


def history(pairs):
    return {('TWSE', rev.shift(END, -i).isoformat()): {'bars': {'1234': pair}, 'fetched_at': '2026-10-16T00:00:00Z'}
            for i, pair in enumerate(pairs)}


def test_actual_growth_uses_aggregate_amounts_not_mean_of_percentages():
    h = history([[200, 100], [100, 100], [300, 200], [110, 100], [110, 100], [110, 100]])
    m = rev.metrics('1234', 'TWSE', '11509', h, TODAY)
    assert m['rev_3m_yoy'] == .5
    assert m['rev_prev_3m_yoy'] == pytest.approx(.1)
    assert m['rev_accel'] == pytest.approx(.4)
    assert m['revenue_streak_months'] == 1  # Flat growth breaks the streak.
    assert m['revenue_months'] == 6 and m['revenue_history_status'] == 'complete'


def test_missing_month_never_bridged_or_zero_filled():
    h = history([[120, 100]] * 8)
    del h[('TWSE', '2026-08-01')]
    m = rev.metrics('1234', 'TWSE', '2026-09', h, TODAY)
    assert m['revenue_months'] == 1 and m['revenue_streak_months'] == 1
    assert m['rev_3m_yoy'] is None and m['rev_accel'] is None
    assert m['revenue_history_status'] == 'partial'


def test_zero_base_unknown_stale_and_future_data():
    h = history([[120, 0]] * 6)
    m = rev.metrics('1234', 'TWSE', '11509', h, TODAY)
    assert m['rev_3m_yoy'] is None and m['revenue_streak_months'] is None
    assert rev.metrics('1234', 'TWSE', '11510', h, TODAY)['revenue_months'] == 0
    assert rev.metrics('1234', 'TWSE', '11509', history([[120, 100]] * 6), dt.date(2027, 1, 1))['revenue_history_status'] == 'stale'
    assert rev.month('11513') is None and rev.month(None) is None
    assert rev.shift(dt.date(2026, 1, 1), -1) == dt.date(2025, 12, 1)


def test_fetch_failure_retries_next_run_and_preserves_cached_exchange(monkeypatch):
    st = MemoryStore()
    st.upsert('tw_revenue_months', [{'exchange':'TWSE', 'ym':'2026-09-01', 'fetched_at':'2026-10-18', 'bars':{'1234':[120,100]}}], 'exchange,ym')
    monkeypatch.setattr(rev, 'MONTHS', 1)
    monkeypatch.setattr(rev.time, 'sleep', lambda _: None)
    calls = []
    def failed(day, exchange, session):
        calls.append(exchange)
        raise ValueError('invalid response')
    monkeypatch.setattr(rev, 'fetch_month', failed)
    for _ in range(2):
        h, status = rev.load_history(st, pd.DataFrame(), TODAY)
        assert status['status'] == 'partial'
        assert h[('TWSE', '2026-09-01')]['bars']['1234'] == [120,100]
    assert calls == ['TPEx', 'TPEx']
    assert len(st.select('tw_revenue_months')) == 1


def test_no_legacy_proxy_can_enter_main_board():
    px = pd.DataFrame([{'price':50, 'dollar_vol':20e6, 'rs_6m':0, 'shares_issued':5e8}], index=['1234'])
    raw = pd.DataFrame([{'rev_yoy':.3, 'rev_cum_yoy':.4, 'ym':'11509', 'exchange':'TWSE'}], index=['1234'])
    old = tw.build_universe(px, raw, {})
    assert pd.isna(old.loc['1234','rev_streak']) and pd.isna(old.loc['1234','quarters'])
    result = tw.compute_tw_scores(old)
    assert result.loc['1234','board'] == 'tw_watch'
    assert 'revenue_history_short' in result.loc['1234','flags']
    enriched = rev.enrich(raw, history([[120,100]] * 6), TODAY)
    result = tw.compute_tw_scores(tw.build_universe(px, enriched, {}))
    assert result.loc['1234','board'] == 'tw_main'
    assert result.loc['1234','rev_streak'] == 6


def test_latest_official_feed_overlays_only_known_amounts(monkeypatch):
    st = MemoryStore()
    monkeypatch.setattr(rev, 'MONTHS', 1)
    monkeypatch.setattr(rev.time, 'sleep', lambda _: None)
    monkeypatch.setattr(rev, 'fetch_month', lambda *args: {'1234':[120,100]})
    raw = pd.DataFrame([{'exchange':'TWSE','ym':'11509','rev_month':150.,'rev_prior':100.}], index=['1234'])
    h, status = rev.load_history(st, raw, TODAY)
    assert h[('TWSE','2026-09-01')]['bars']['1234'] == [150,100]
    assert h[('TPEx','2026-09-01')]['bars']['1234'] == [120,100]
    assert status['status'] == 'ok'
