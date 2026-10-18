import datetime as dt
from types import SimpleNamespace

import pandas as pd
import pytest
import requests

from crawler import attention, config as cfg, formc, fundamentals, massive_prices, run, score
from crawler.health import StageFailure
from crawler.store import MemoryStore, Supabase
from tests.test_core import make_universe

NOW = dt.datetime(2026, 10, 18, tzinfo=dt.timezone.utc)


@pytest.fixture
def cache(monkeypatch):
    monkeypatch.setattr(cfg, "REQUEST_PAUSE", 0)
    monkeypatch.setattr(cfg, "FULL_REFRESH", False)
    st = MemoryStore()
    for ticker, age in [('FRESH', 1), ('STALE', 10), ('OLD', 90)]:
        st.upsert('fundamentals_cache', [{'ticker': ticker, 'fetched_at': (NOW - dt.timedelta(days=age)).isoformat(),
                                        'data': {'ok': True, 'mkt_cap': 1e8}}], 'ticker')
    return st


def test_expired_cache_is_excluded_and_stale_data_is_labelled(cache, monkeypatch):
    monkeypatch.setattr(fundamentals, 'fetch_fundamentals', lambda _: {'ok': False, 'error': 'ConnectionError'})
    result, stats = fundamentals.refresh_cache(cache, ['FRESH', 'STALE', 'OLD'], now=NOW)
    assert set(result) == {'FRESH', 'STALE'}
    assert result['STALE']['fundamentals_age_days'] == 10
    assert result['STALE']['fundamentals_stale'] is True
    assert stats['expired'] == 1 and stats['failed'] == 2
    d = make_universe(10)
    d['fundamentals_stale'] = True
    assert all('stale_fundamentals' in flags for flags in score.compute_scores(d)['flags'])


def test_full_refresh_actually_refreshes_fresh_rows(cache, monkeypatch):
    monkeypatch.setattr(cfg, 'FULL_REFRESH', True)
    calls = []
    monkeypatch.setattr(fundamentals, 'fetch_fundamentals', lambda t: (calls.append(t), {'ok': True})[1])
    fundamentals.refresh_cache(cache, ['FRESH'], now=NOW)
    assert calls == ['FRESH']


def test_attention_cache_reuses_success_but_retries_failures(monkeypatch):
    st = MemoryStore()
    calls = []
    monkeypatch.setattr(attention, 'fetch_all', lambda names: (calls.append(set(names)), {'A': 0, 'B': None})[1])
    names = {'A': 'Alpha Robotics', 'B': 'Beta Robotics', 'X': 'AB'}
    values, _, stats = attention.fetch_cached(st, names, NOW)
    assert values == {'X': None, 'A': 0, 'B': None}
    assert stats['failed'] == 1 and stats['unsearchable'] == 1
    _, _, stats = attention.fetch_cached(st, names, NOW + dt.timedelta(hours=1))
    assert calls == [{'A', 'B'}, {'B'}] and stats['cached'] == 1
    attention.fetch_cached(st, {'A': 'Different Company'}, NOW + dt.timedelta(hours=1))
    assert calls[-1] == {'A'}


def test_formc_all_filings_failed_is_a_failed_run(monkeypatch):
    st = MemoryStore()
    index = '-----\n1234567|Example|C|20261013|edgar/data/1234567/0001234567-26-000012.txt\n'
    monkeypatch.setattr(cfg, 'FORMC_DAYS_BACK', 1)
    monkeypatch.setattr(cfg, 'sec_headers', lambda: {})
    monkeypatch.setattr(formc, '_get', lambda s, url: None if url.endswith('.xml') else SimpleNamespace(text=index))
    actual = formc.run_formc
    monkeypatch.setattr(formc, 'run_formc', lambda store: actual(store, dt.date(2026, 10, 13)))
    monkeypatch.setattr(run, 'Supabase', lambda: st)
    assert run.main(['--only', 'formc']) == 1
    result = st.select('crawl_runs')[0]
    assert result['status'] == 'failed'
    assert result['stats']['formc']['failed'] == 1


def test_all_index_requests_failing_preserves_diagnostics(monkeypatch):
    monkeypatch.setattr(cfg, 'FORMC_DAYS_BACK', 1)
    monkeypatch.setattr(cfg, 'sec_headers', lambda: {})
    def fail(*args):
        raise requests.ConnectionError()
    monkeypatch.setattr(formc, '_get', fail)
    with pytest.raises(StageFailure) as e:
        formc.run_formc(MemoryStore(), dt.date(2026, 10, 13))
    assert e.value.stats['days_failed'] == 1


def test_no_new_filings_is_success(monkeypatch):
    monkeypatch.setattr(cfg, 'FORMC_DAYS_BACK', 1)
    monkeypatch.setattr(cfg, 'sec_headers', lambda: {})
    monkeypatch.setattr(formc, '_get', lambda *args: SimpleNamespace(text='-----\n'))
    assert not formc.run_formc(MemoryStore(), dt.date(2026, 10, 13))['warnings']


def test_warning_and_other_source_failure_are_partial(monkeypatch):
    st = MemoryStore()
    monkeypatch.setattr(run, 'Supabase', lambda: st)
    monkeypatch.setattr(run, 'run_public', lambda _: {'as_of': '2026-10-13', 'published': True, 'warnings': ['HN failed']})
    def fail(_):
        raise StageFailure('SEC unavailable', {'days_failed': 2})
    monkeypatch.setattr(formc, 'run_formc', fail)
    for module, name in [(run.smartmoney, 'run_smart'), (run.report, 'run_report'), (run.digest, 'run_digest')]:
        monkeypatch.setattr(module, name, lambda _: {})
    assert run.main([]) == 1
    result = st.select('crawl_runs')[0]
    assert result['status'] == 'partial' and result['as_of'] == '2026-10-13'
    assert result['stats']['public']['status'] == 'partial'
    assert result['stats']['formc']['status'] == 'failed'


def payload(tickers, day='2026-10-13'):
    entities = [{'ticker': t, 'name': t} for t in tickers]
    signals = [{'ticker': t, 'as_of': day, 'price': 1} for t in tickers]
    scores = [{'ticker': t, 'as_of': day, 'score': 10, 'board': 'main', 'rank': i + 1} for i, t in enumerate(tickers)]
    return day, entities, signals, scores, [], {'scoring_version': 'test'}


def test_partial_upload_never_writes_live_tables():
    st = Supabase(url='https://offline.invalid', key='dummy')
    calls = []
    def request(method, path, **kwargs):
        calls.append(path)
        if path.startswith('/publication_rows') and len(calls) == 3:
            raise RuntimeError('second upload chunk failed')
        return SimpleNamespace(json=lambda: [])
    st._req = request
    with pytest.raises(RuntimeError):
        st.publish_public(*payload([f'T{i}' for i in range(250)]))
    assert len(calls) == 3
    assert not any('/rpc/' in p or p.startswith('/scores') or p.startswith('/signals') for p in calls)


def test_same_day_rerun_removes_disqualified_names_and_records_version():
    st = MemoryStore()
    st.publish_public(*payload(['A', 'B']))
    batch_id = st.publish_public(*payload(['A']))
    assert [r['ticker'] for r in st.select('scores')] == ['A']
    assert [r['ticker'] for r in st.select('signals')] == ['A']
    assert st.select('scores')[0]['batch_id'] == batch_id
    assert st.select('publication_batches')[-1]['metadata']['scoring_version'] == 'test'


def test_incomplete_publication_is_rejected_before_upload():
    args = list(payload(['A']))
    args[2] = []
    with pytest.raises(ValueError):
        MemoryStore().publish_public(*args)


def test_supabase_pagination_reads_every_page():
    st = Supabase(url='https://offline.invalid', key='dummy')
    seen = []
    def request(method, path, **kw):
        seen.append(kw['headers']['Range'])
        start = int(seen[-1].split('-')[0])
        return SimpleNamespace(json=lambda: [{'ticker': str(i)} for i in range(start, min(start + 2, 5))])
    st._req = request
    assert len(st.select('entities', {'order': 'ticker'}, page=2)) == 5
    assert seen == ['0-1', '2-3', '4-5']


def test_massive_split_adjustment_keeps_raw_cache_intact():
    days = {dt.date(2026, 10, 12): {'ABC': [100, 10]}, dt.date(2026, 10, 13): {'ABC': [50, 20]}}
    splits = [{'id': 'one', 'ticker': 'ABC', 'execution_date': '2026-10-13', 'split_from': 1, 'split_to': 2}]
    close, vol = massive_prices.frames_from_bars(days, ['ABC'], splits + splits)
    assert list(close['ABC']) == [50, 50] and list(vol['ABC']) == [20, 20]
    assert days[dt.date(2026, 10, 12)]['ABC'][0] == 100


def test_massive_rejects_adjusted_payload_in_raw_cache():
    with pytest.raises(massive_prices.PriceSourceError):
        massive_prices.parse_grouped({'adjusted': True, 'results': [{'T': 'ABC', 'c': 10, 'v': 1}]})
    assert massive_prices.parse_grouped({'status': 'OK', 'resultsCount': 0}) == {}


def test_massive_incremental_cache_avoids_daily_refetch(monkeypatch):
    monkeypatch.setenv('MASSIVE_API_KEY', 'offline')
    monkeypatch.setattr(cfg, 'PRICE_HISTORY_DAYS', 220)
    monkeypatch.setattr(cfg, 'FULL_REFRESH', False)
    calls = []
    def get(self, url, params=None, allow_pending=False):
        calls.append(url)
        if '/splits' in url:
            return {'status': 'OK', 'results': []}
        return {'status': 'OK', 'adjusted': False, 'results': [
            {'T': 'SPY', 'c': 100, 'v': 1000}, {'T': 'ABC', 'c': 10, 'v': 10000},
            {'T': 'NEW', 'c': 20, 'v': 20000}]}
    monkeypatch.setattr(massive_prices.Client, 'get', get)
    st = MemoryStore()
    first, _, _, _ = massive_prices.load_prices(['ABC'], st)
    before = len(calls)
    second, _, _, _ = massive_prices.load_prices(['ABC', 'NEW'], st)
    assert len(calls) == before + 1  # only split events; all raw market bars were already cached
    assert set(second.index) == {'ABC', 'NEW'}
    assert first.loc['ABC', 'price'] == 10


def test_massive_auth_errors_do_not_leak_key_or_retry(monkeypatch):
    client = massive_prices.Client('sensitive-key')
    monkeypatch.setattr(client.session, 'get', lambda *a, **k: SimpleNamespace(status_code=401, ok=False, text='sensitive-key'))
    with pytest.raises(massive_prices.PriceSourceError) as e:
        client.get(massive_prices.BASE + '/test')
    assert 'sensitive-key' not in str(e.value)


def test_pending_market_day_is_retried_without_refetching_history(monkeypatch):
    monkeypatch.setenv('MASSIVE_API_KEY', 'offline')
    monkeypatch.setattr(cfg, 'PRICE_HISTORY_DAYS', 220)
    monkeypatch.setattr(cfg, 'FULL_REFRESH', False)
    calls, pending = [], []
    def get(self, url, params=None, allow_pending=False):
        calls.append(url)
        if '/splits' in url:
            return {'status': 'OK', 'results': []}
        if allow_pending:
            pending.append(url.rsplit('/', 1)[-1])
            return None
        return {'status': 'OK', 'adjusted': False, 'results': [
            {'T': 'SPY', 'c': 100, 'v': 1000}, {'T': 'ABC', 'c': 10, 'v': 10000}]}
    monkeypatch.setattr(massive_prices.Client, 'get', get)
    st = MemoryStore()
    massive_prices.load_prices(['ABC'], st)
    before = len(calls)
    assert pending[0] not in {r['day'] for r in st.select('price_days')}
    massive_prices.load_prices(['ABC'], st)
    assert len(calls) == before + 2 and pending[0] == pending[1]


def test_report_adjusts_splits_in_raw_cache(monkeypatch):
    from crawler import report
    monkeypatch.setenv('MASSIVE_API_KEY', 'offline')
    monkeypatch.setattr(massive_prices, 'fetch_splits', lambda *a: [
        {'id': 'split', 'ticker': 'A', 'execution_date': '2026-10-13', 'split_from': 1, 'split_to': 2}])
    st = MemoryStore()
    days = pd.bdate_range('2026-10-12', periods=6)
    st.upsert('scores', [{'ticker': t, 'as_of': days[0].date(), 'rank': i + 1, 'board': 'main'}
                        for i, t in enumerate(['A', 'B', 'C'])], 'ticker,as_of')
    st.upsert('price_days', [{'day': day.date(), 'format': 'massive_raw_v1', 'bars': {
        'SPY': [100, 1], 'A': [100 if i == 0 else 50, 1], 'B': [10, 1], 'C': [10, 1]}}
        for i, day in enumerate(days)], 'day')
    result = report.run_report(st, dt.date(2026, 10, 20))
    assert result['rows'] == 1
    assert st.select('report_card')[0]['avg_ret'] == 0
    # An interrupted migration must preserve the last complete report.
    st.upsert('price_days', [{'day': days[0].date(), 'format': 'legacy_adjusted'}], 'day')
    result = report.run_report(st, dt.date(2026, 10, 20))
    assert result['warnings'] and result['rows'] == 0
    assert st.select('report_card')[0]['avg_ret'] == 0
