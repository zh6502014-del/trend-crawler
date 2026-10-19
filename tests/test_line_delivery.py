"""Delivery regressions: no real LINE, Telegram or Supabase requests."""
import datetime as dt
import uuid

import pytest
import requests

from crawler import digest
from tests.test_core import FilterStore

DAY = dt.date(2026, 10, 19)


class LedgerStore(FilterStore):
    def __init__(self, tables):
        super().__init__(tables)
        self.tables['line_deliveries'] = []

    def owner_id(self):
        return 'owner'

    def prepare_delivery(self, key, recipient, body, alert_ids):
        rows = self.tables['line_deliveries']
        row = next((r for r in rows if r['delivery_key'] == key), None)
        if row is None:
            row = dict(delivery_key=key, recipient=recipient, body=body, alert_ids=alert_ids,
                       retry_key=str(uuid.uuid4()), sent_at=None,
                       created_at=dt.datetime.now(dt.timezone.utc).isoformat())
            rows.append(row)
        return dict(row)

    def update(self, table, match, values):
        super().update(table, match, values)
        for row in self.tables.get(table, []):
            if all(row.get(k) == v for k, v in match.items()):
                row.update(values)


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv('LINE_CHANNEL_TOKEN', 'fake')
    monkeypatch.setenv('LINE_USER_ID', 'recipient')
    monkeypatch.delenv('TELEGRAM_BOT_TOKEN', raising=False)
    monkeypatch.delenv('TELEGRAM_CHAT_ID', raising=False)
    monkeypatch.setattr(digest, 'line_budget_ok', lambda _: (True, 'ok'))
    sent = []
    monkeypatch.setattr(digest, 'send_line', lambda body, token, to, key=None: sent.append((body, to, key)))
    tables = {
        'scores': [dict(ticker='AAA', as_of=day, board='main', rank=1, score=score)
                   for day, score in [('2026-10-19', 90), ('2026-10-16', 70)]],
        'user_watch': [dict(ticker='AAA', user_id='owner')],
        'user_alerts': [dict(id=i, ticker='AAA', metric='score', op='>', value=70+i, user_id='owner') for i in range(7)],
    }
    return LedgerStore(tables), sent


def test_all_seven_alerts_visible_and_same_snapshot_not_resent(setup):
    store, sent = setup
    assert digest.run_digest(store, DAY, 'us')['sent']
    assert len(sent) == 1
    for i in range(7):
        assert f'分數>{70+i}' in sent[0][0]
        assert store.tables['user_alerts'][i]['fired_at']
    assert not digest.run_digest(store, DAY, 'us')['sent']
    assert len(sent) == 1


def test_timeout_retry_freezes_body_and_retry_key(setup, monkeypatch):
    store, sent = setup
    attempts = []
    def send(body, token, to, key):
        attempts.append((body, key))
        if len(attempts) == 1:
            raise requests.Timeout('response lost')
    monkeypatch.setattr(digest, 'send_line', send)
    assert not digest.run_digest(store, DAY, 'us')['sent']
    assert all(not a.get('fired_at') for a in store.tables['user_alerts'])
    store.tables['scores'][0]['score'] = 99
    assert digest.run_digest(store, DAY, 'us')['sent']
    assert attempts[0] == attempts[1]


def test_sent_delivery_recovers_failed_alert_ack_without_resend(setup, monkeypatch):
    store, sent = setup
    update = store.update
    def fail_ack(table, match, values):
        if table == 'user_alerts':
            raise RuntimeError('database unavailable after send')
        update(table, match, values)
    monkeypatch.setattr(store, 'update', fail_ack)
    digest.run_digest(store, DAY, 'us')
    assert len(sent) == 1
    monkeypatch.setattr(store, 'update', update)
    digest.run_digest(store, DAY, 'us')
    assert len(sent) == 1
    assert all(a.get('fired_at') for a in store.tables['user_alerts'])


def test_telegram_success_does_not_consume_failed_line_alerts(setup, monkeypatch):
    store, sent = setup
    monkeypatch.setenv('TELEGRAM_BOT_TOKEN', 'fake')
    monkeypatch.setenv('TELEGRAM_CHAT_ID', 'chat')
    monkeypatch.setattr(digest, 'send_line', lambda *args: (_ for _ in ()).throw(requests.Timeout()))
    monkeypatch.setattr(digest, 'send_telegram', lambda *args: None)
    assert digest.run_digest(store, DAY, 'us')['channels'] == ['telegram']
    assert all(not a.get('fired_at') for a in store.tables['user_alerts'])


def test_chunks_preserve_unicode_and_reject_overflow_before_send(monkeypatch):
    text = '🙂' * 7000 + '中文' * 1000
    chunks = digest.line_messages(text)
    assert ''.join(c['text'] for c in chunks) == text
    assert len(chunks) <= 5
    assert all(len(c['text'].encode('utf-16-le')) // 2 <= 4900 for c in chunks)
    requests_made = []
    monkeypatch.setattr(digest.requests, 'post', lambda *a, **kw: requests_made.append(kw))
    with pytest.raises(ValueError):
        digest.send_line('x' * 24501, 'fake', 'recipient')
    assert not requests_made


def test_line_accepted_retry_is_success_but_other_conflict_is_error(monkeypatch):
    response = requests.Response()
    response.status_code = 409
    response.headers['x-line-accepted-request-id'] = 'accepted'
    calls = []
    def post(*args, **kw):
        calls.append(kw)
        return response
    monkeypatch.setattr(digest.requests, 'post', post)
    digest.send_line('message', 'fake', 'recipient', 'persisted-key')
    assert calls[0]['headers']['X-Line-Retry-Key'] == 'persisted-key'
    response.headers.clear()
    with pytest.raises(requests.HTTPError):
        digest.send_line('message', 'fake', 'recipient', 'persisted-key')


def test_budget_failure_or_expired_retry_does_not_ack(setup, monkeypatch):
    store, sent = setup
    monkeypatch.setattr(digest, 'line_budget_ok', lambda _: (False, 'quota unavailable'))
    assert not digest.run_digest(store, DAY, 'us')['sent']
    monkeypatch.setattr(digest, 'line_budget_ok', lambda _: (True, 'ok'))
    store.tables['line_deliveries'][0]['created_at'] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)).isoformat()
    assert not digest.run_digest(store, DAY, 'us')['sent']
    assert not sent and all(not a.get('fired_at') for a in store.tables['user_alerts'])


def test_markets_are_independent_and_owner_data_is_scoped(setup):
    store, sent = setup
    store.tables['tw_scores'] = [dict(ticker='2330', as_of=day, board='tw_main', rank=1, score=score)
                                 for day, score in [('2026-10-19', 90), ('2026-10-16', 70)]]
    store.tables['user_alerts'].append(dict(id=99, ticker='AAA', metric='score', op='>', value=1, user_id='someone-else'))
    assert digest.run_digest(store, DAY, 'us')['sent']
    assert '2330' not in sent[-1][0]
    store.tables['scores'] = []
    assert digest.run_digest(store, DAY, 'tw')['sent']
    assert '2330' in sent[-1][0] and 'AAA' not in sent[-1][0]
    assert not store.tables['user_alerts'][-1].get('fired_at')
    assert not digest.run_digest(store, DAY, 'tw')['sent']


def test_us_uses_previous_snapshot_across_long_holiday_and_skips_stale(setup):
    store, sent = setup
    store.tables['scores'][1]['as_of'] = '2026-10-13'
    assert digest.run_digest(store, DAY, 'us')['sent']
    assert 'AAA +20' in sent[0][0]
    assert not digest.run_digest(store, DAY + dt.timedelta(days=3), 'us')['sent']
