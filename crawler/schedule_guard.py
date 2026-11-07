"""Duplicate-run guard for the timed crawls.

The crawls are started on time by Supabase pg_cron (workflow_dispatch with from_cron=true, see
supabase/migrations/20261107_cron_dispatch.sql). GitHub's own schedules stay as a backup, but they run hours late
or not at all. Every timed run (cron dispatch or GitHub schedule) asks this module whether the work is already done
and skips if it is. Manual runs never consult it. Any doubt (no credentials, network error) means "crawl".

python -m crawler.schedule_guard tw|us   → prints skip=true|false and appends it to $GITHUB_OUTPUT
"""
from __future__ import annotations

import datetime as dt
import os
import sys

TAIPEI = dt.timezone(dt.timedelta(hours=8))


def taipei_today(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(TAIPEI).date()


TW_CLOSE_SETTLED = dt.time(14, 0)  # TWSE closes 13:30 Taipei; after 14:00 today's session counts


def expected_session(now: dt.datetime | None = None) -> dt.date:
    """The latest weekday session that has closed by `now` (Taipei).

    GitHub often delays the scheduled runs by hours, so the backup can land after midnight;
    comparing against the calendar date then would re-crawl a board that is already in."""
    local = (now or dt.datetime.now(dt.timezone.utc)).astimezone(TAIPEI)
    day = local.date() if local.time() >= TW_CLOSE_SETTLED else local.date() - dt.timedelta(days=1)
    while day.weekday() >= 5:
        day -= dt.timedelta(days=1)
    return day


def tw_done(store, session: dt.date) -> bool:
    """True when the Taiwan main board already has a score row for `session` or later."""
    rows = store.select("tw_scores", {"select": "as_of", "as_of": f"gte.{session.isoformat()}", "board": "eq.tw_main", "rank": "eq.1"})
    return bool(rows)


US_RECENT = dt.timedelta(hours=14)  # a full US crawl that succeeded this recently covers today's slot


def us_done(store, now: dt.datetime | None = None) -> bool:
    """True when a full US crawl (it has the 'public' stage) finished OK within US_RECENT.

    Runs with only one stage (e.g. a manual digest) don't count, and 'partial' runs don't either:
    re-running after a partial run is how a rate-limited day gets repaired."""
    since = (now or dt.datetime.now(dt.timezone.utc)) - US_RECENT
    rows = store.select("crawl_runs", {"select": "id,finished_at,stats", "status": "eq.ok",
                                       "finished_at": f"gte.{since.isoformat()}"})
    return any(isinstance(r.get("stats"), dict) and r["stats"].get("public") for r in rows)


def decide(market: str, store=None, now: dt.datetime | None = None) -> bool:
    if market not in ("tw", "us"):
        return False
    try:
        if store is None:
            from .store import Supabase
            store = Supabase()
        return us_done(store, now) if market == "us" else tw_done(store, expected_session(now))
    except Exception as e:  # noqa: BLE001 - never skip because the check itself failed
        print(f"  guard: check failed ({str(e)[:120]}), crawling anyway")
        return False


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    skip = decide(args[0] if args else "tw")
    line = f"skip={'true' if skip else 'false'}"
    print(line + ("  (this slot's crawl already ran)" if skip else ""))
    out = os.getenv("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
