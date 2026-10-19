"""Backup-schedule guard.

GitHub may delay or drop a scheduled workflow run under load (the Taiwan crawl's first scheduled run never fired).
So the workflow also fires a later backup run; the backup asks this module whether today's data is already in and
skips the crawl if it is. Manual runs never consult it. Any doubt (no credentials, network error) means "crawl".

python -m crawler.schedule_guard tw     → prints skip=true|false and appends it to $GITHUB_OUTPUT
"""
from __future__ import annotations

import datetime as dt
import os
import sys

TAIPEI = dt.timezone(dt.timedelta(hours=8))


def taipei_today(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(TAIPEI).date()


def tw_done(store, today: dt.date) -> bool:
    """True when the Taiwan main board already has a score row dated `today` (Taipei)."""
    rows = store.select("tw_scores", {"select": "as_of", "as_of": f"eq.{today.isoformat()}", "board": "eq.tw_main", "rank": "eq.1"})
    return bool(rows)


def decide(market: str, store=None, now: dt.datetime | None = None) -> bool:
    if market != "tw":
        return False
    try:
        if store is None:
            from .store import Supabase
            store = Supabase()
        return tw_done(store, taipei_today(now))
    except Exception as e:  # noqa: BLE001 - never skip because the check itself failed
        print(f"  guard: check failed ({str(e)[:120]}), crawling anyway")
        return False


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    skip = decide(args[0] if args else "tw")
    line = f"skip={'true' if skip else 'false'}"
    print(line + ("  (today's Taiwan board is already in)" if skip else ""))
    out = os.getenv("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
