"""Tiny storage layer. Talks to Supabase's REST API with plain `requests` (no heavy SDK).

`MemoryStore` has the same interface, so the whole pipeline can be dry-run or unit-tested with no database.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import time
import copy
import uuid

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


def publication(as_of, entities, signals, scores, series, metadata):
    batch_id = str(uuid.uuid4())
    groups = [{r["ticker"]: clean(r) for r in rows} for rows in (entities, signals, scores, series)]
    ent, sig, sc, px = groups
    if not sc or set(ent) != set(sc) or set(sig) != set(sc) or not set(px) <= set(sc):
        raise ValueError("Publication requires matching entities, signals and scores")
    if any(len(group) != len(rows) for group, rows in zip(groups, (entities, signals, scores, series))):
        raise ValueError("Duplicate ticker in publication")
    day = clean(as_of)
    if any(r["as_of"] != day for r in [*sig.values(), *sc.values()]):
        raise ValueError("Publication dates do not match")
    batch = {"id": batch_id, "as_of": day, "row_count": len(sc), "metadata": metadata,
             "created_at": utcnow().isoformat(), "status": "staging"}
    rows = [{"batch_id": batch_id, "ticker": t, "entity": ent[t], "signal": sig[t],
             "score": {**sc[t], "batch_id": batch_id}, "prices": px.get(t)} for t in sc]
    return clean(batch), rows


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

    def delete(self, table, params):
        if not params:
            raise ValueError("A delete filter is required")
        self._req("DELETE", f"/{table}", params=params)

    def publish_public(self, as_of, entities, signals, scores, series, metadata):
        batch, rows = publication(as_of, entities, signals, scores, series, metadata)
        self.upsert("publication_batches", [batch], "id")
        self.upsert("publication_rows", rows, "batch_id,ticker", chunk=100)
        # Retries use the same batch ID; the database function is idempotent.
        self._req("POST", "/rpc/publish_public_batch", data=json.dumps({"p_batch_id": batch["id"]}))
        return batch["id"]
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
        rows = list(self.tables.get(table, {}).values())
        params = params or {}
        for key, value in params.items():
            if key in ("select", "order", "limit", "and"):
                continue
            rows = [r for r in rows if self._matches(r.get(key), value)]
        if "and" in params:
            for condition in params["and"].strip("()").split(","):
                key, condition = condition.split(".", 1)
                rows = [r for r in rows if self._matches(r.get(key), condition)]
        if params.get("order"):
            for order in reversed(params["order"].split(",")):
                key, _, direction = order.partition(".")
                rows.sort(key=lambda r: (r.get(key) is None, r.get(key)), reverse=direction == "desc")
        if "limit" in params:
            rows = rows[:int(params["limit"])]
        return copy.deepcopy(rows)

    @staticmethod
    def _matches(value, condition):
        op, _, other = str(condition).partition(".")
        if value is None:
            return False
        value = str(value)
        return {"eq": value == other, "gte": value >= other, "lte": value <= other,
                "gt": value > other, "lt": value < other}.get(op, False)

    def delete(self, table, params):
        if not params:
            raise ValueError("A delete filter is required")
        self.tables[table] = {k: r for k, r in self.tables.get(table, {}).items()
                              if not all(self._matches(r.get(col), value) for col, value in params.items())}

    def publish_public(self, as_of, entities, signals, scores, series, metadata):
        batch, rows = publication(as_of, entities, signals, scores, series, metadata)
        # Construct the entire replacement before swapping state, like the SQL transaction.
        published = self.select("publication_batches", {"status": "eq.published"})
        if published and batch["as_of"] < max(r["as_of"] for r in published):
            raise ValueError("Price date is older than the current published board")
        staged = MemoryStore()
        staged.tables = copy.deepcopy(self.tables)
        staged.delete("signals", {"as_of": f"eq.{batch['as_of']}"})
        staged.delete("scores", {"as_of": f"eq.{batch['as_of']}"})
        staged.upsert("entities", entities, "ticker")
        staged.upsert("signals", signals, "ticker,as_of")
        staged.upsert("scores", [r["score"] for r in rows], "ticker,as_of")
        staged.upsert("price_series", series, "ticker")
        staged.upsert("publication_batches", [{**batch, "status": "published", "published_at": utcnow().isoformat()}], "id")
        self.tables = staged.tables
        return batch["id"]

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
