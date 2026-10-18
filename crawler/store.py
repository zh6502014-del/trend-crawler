"""Tiny storage layer. Talks to Supabase's REST API with plain `requests` (no heavy SDK).

`MemoryStore` has the same interface, so the whole pipeline can be dry-run or unit-tested with no database.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import time

import requests


def clean(v):
    """Make anything JSON-safe: NaN/inf → None, numpy → python, dates → ISO strings."""
    if v is None:
        return None
    if isinstance(v, (str, bool, int)):
        return v
    if hasattr(v, "item") and not isinstance(v, (list, tuple, dict)):
        try:  # numpy scalar
            v = v.item()
        except Exception:
            pass
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, (str, bool, int)):
        return v
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [clean(x) for x in v]
    return str(v)


def _normalise(rows: list[dict]) -> list[dict]:
    """PostgREST bulk upserts want every object to carry the same keys."""
    rows = [clean(r) for r in rows]
    keys: list[str] = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    return [{k: r.get(k) for k in keys} for r in rows]


class Supabase:
    def __init__(self, url: str | None = None, key: str | None = None):
        url = url or os.environ.get("SUPABASE_URL")
        key = key or os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        self.base = url.rstrip("/") + "/rest/v1"
        self.s = requests.Session()
        self.s.headers.update(
            {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        )

    def _req(self, method: str, path: str, **kw):
        last = None
        for attempt in range(4):
            try:
                r = self.s.request(method, self.base + path, timeout=60, **kw)
            except requests.RequestException as e:
                last = e
                time.sleep(2**attempt)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                last = RuntimeError(f"{r.status_code}: {r.text[:200]}")
                time.sleep(2**attempt)
                continue
            if not r.ok:
                raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:400]}")
            return r
        raise RuntimeError(f"{method} {path} failed after retries: {last}")

    def upsert(self, table: str, rows: list[dict], on_conflict: str, chunk: int = 500) -> int:
        rows = _normalise(rows)
        for i in range(0, len(rows), chunk):
            self._req(
                "POST",
                f"/{table}?on_conflict={on_conflict}",
                data=json.dumps(rows[i : i + chunk], allow_nan=False),
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            )
        return len(rows)

    def select(self, table: str, params: dict | None = None, page: int = 1000) -> list[dict]:
        out: list[dict] = []
        start = 0
        while True:
            r = self._req(
                "GET",
                f"/{table}",
                params=params or {},
                headers={"Range-Unit": "items", "Range": f"{start}-{start + page - 1}"},
            )
            batch = r.json()
            out.extend(batch)
            if len(batch) < page:
                return out
            start += page

    def insert(self, table: str, row: dict) -> dict:
        r = self._req(
            "POST",
            f"/{table}",
            data=json.dumps(clean(row), allow_nan=False),
            headers={"Prefer": "return=representation"},
        )
        return r.json()[0]

    def update(self, table: str, match: dict, values: dict) -> None:
        params = {k: f"eq.{v}" for k, v in match.items()}
        self._req("PATCH", f"/{table}", params=params, data=json.dumps(clean(values), allow_nan=False))

    def owner_id(self) -> str:
        if os.getenv("OWNER_UID"):
            return os.environ["OWNER_UID"]
        response = self.s.get(self.base.removesuffix('/rest/v1') + '/auth/v1/admin/users', params={'per_page': 2}, timeout=15)
        response.raise_for_status()
        users = response.json().get('users', [])
        if len(users) != 1:
            raise RuntimeError('Set OWNER_UID when the dashboard does not have exactly one user')
        return users[0]['id']

    def prepare_delivery(self, key: str, recipient: str, body: str, alert_ids: list) -> dict:
        return self._req('POST', '/rpc/prepare_line_delivery', json={
            'p_key': key, 'p_recipient': recipient, 'p_body': body, 'p_alert_ids': alert_ids,
        }).json()[0]


class MemoryStore:
    """Same interface, no network. Used by --dry-run and the tests."""

    def __init__(self):
        self.tables: dict[str, dict] = {}
        self._id = 0

    def upsert(self, table, rows, on_conflict, chunk=500):
        keys = on_conflict.split(",")
        t = self.tables.setdefault(table, {})
        for r in _normalise(rows):
            t[tuple(r[k] for k in keys)] = {**t.get(tuple(r[k] for k in keys), {}), **r}
        return len(rows)

    def select(self, table, params=None, page=1000):
        return list(self.tables.get(table, {}).values())

    def insert(self, table, row):
        self._id += 1
        row = {**clean(row), "id": self._id}
        self.tables.setdefault(table, {})[(self._id,)] = row
        return row

    def update(self, table, match, values):
        for r in self.tables.get(table, {}).values():
            if all(str(r.get(k)) == str(v) for k, v in match.items()):
                r.update(clean(values))


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)
