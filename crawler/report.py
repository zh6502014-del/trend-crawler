"""Report card: how did past top-N lists do afterwards, compared with SPY?

Each daily top-N list of the main board is a "cohort". For each cohort and horizon (trading days) we
look up the close on the list date and the close `horizon` price-days later, and write the average
return, SPY's return, the excess and the share of names that beat SPY.
Read-only inputs: scores (history of the lists) and price_days (the cached daily closes, incl. SPY).
"""
from __future__ import annotations

import datetime as dt

TOP_N = 20
HORIZONS = (5, 20)
LOOKBACK_DAYS = 150


def _d(v) -> dt.date:
    return v if isinstance(v, dt.date) else dt.date.fromisoformat(str(v)[:10])


def compute_report(cohorts: dict, closes: dict, horizons=HORIZONS, boards: dict | None = None, bench: str = "SPY") -> list[dict]:
    """cohorts: {as_of: [ticker, ...]}; closes: {day: {ticker: close}} (must include 'SPY').

    boards: optional {as_of: [every main-board ticker]}. Its equal-weight return is the "random pick" baseline
    (the expected result of choosing names from the board without any ranking) → board_ret / edge_board.
    Returns one row per (as_of, horizon) that has enough later price days. Names without both prices are skipped.
    """
    days = sorted(closes)
    out = []
    for as_of, tickers in sorted(cohorts.items()):
        if as_of not in closes:
            continue
        i = days.index(as_of)
        for h in horizons:
            if i + h >= len(days):
                continue
            c0, c1 = closes[as_of], closes[days[i + h]]
            if not c0.get(bench) or not c1.get(bench):
                continue
            spy = c1[bench] / c0[bench] - 1
            rets = {t: c1[t] / c0[t] - 1 for t in tickers if c0.get(t) and c1.get(t)}
            if len(rets) < max(3, len(tickers) // 2):
                continue
            avg = sum(rets.values()) / len(rets)
            best = max(rets, key=rets.get)
            worst = min(rets, key=rets.get)
            top10 = [t for t in tickers[:10] if t in rets]
            extra = {}
            if top10:
                extra["top10_ret"] = round(sum(rets[t] for t in top10) / len(top10), 4)
            allb = [c1[t] / c0[t] - 1 for t in (boards or {}).get(as_of, []) if c0.get(t) and c1.get(t)]
            if len(allb) >= 20:
                bret = sum(allb) / len(allb)
                extra["board_ret"] = round(bret, 4)
                extra["edge_board"] = round(avg - bret, 4)
            out.append({**extra,
                "as_of": as_of.isoformat(), "horizon": h, "n": len(rets), "avg_ret": round(avg, 4),
                "spy_ret": round(spy, 4), "excess": round(avg - spy, 4),
                "hit_rate": round(sum(1 for r in rets.values() if r > spy) / len(rets), 4),
                "best": best, "best_ret": round(rets[best], 4), "worst": worst, "worst_ret": round(rets[worst], 4),
                "exit_day": days[i + h].isoformat(),
            })
    return out


def run_report(store, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    lo = (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    rows = store.select("scores", {"select": "ticker,as_of,rank", "board": "eq.main", "as_of": f"gte.{lo}"})
    rows.sort(key=lambda r: (str(r["as_of"]), r["rank"]))
    cohorts: dict[dt.date, list[str]] = {}
    boards: dict[dt.date, list[str]] = {}
    for r in rows:
        d = _d(r["as_of"])
        boards.setdefault(d, []).append(r["ticker"])
        if r["rank"] <= TOP_N:
            cohorts.setdefault(d, []).append(r["ticker"])
    if not cohorts:
        print("  report: no score history yet")
        return {"cohorts": 0, "rows": 0}
    pd_rows = store.select("price_days", {"select": "day,bars", "day": f"gte.{min(cohorts).isoformat()}"}, page=10)
    closes = {_d(r["day"]): {t: v[0] for t, v in (r["bars"] or {}).items() if v and v[0] is not None} for r in pd_rows}
    out = compute_report(cohorts, closes, boards=boards)
    if out:
        try:
            store.upsert("report_card", out, "as_of,horizon")
        except Exception as e:  # new columns not created yet → keep the original report working
            print(f"  report: new columns missing ({str(e)[:80]}); saving basic fields. Run the latest schema.sql.")
            base = ("as_of", "horizon", "n", "avg_ret", "spy_ret", "excess", "hit_rate", "best", "best_ret", "worst", "worst_ret", "exit_day")
            store.upsert("report_card", [{k: r[k] for k in base} for r in out], "as_of,horizon")
    print(f"  report: {len(cohorts)} cohorts, {len(out)} rows")
    return {"cohorts": len(cohorts), "rows": len(out)}


def run_tw_report(store, today: dt.date | None = None) -> dict:
    """Same report for the Taiwan board: tw_scores (tw_main) + tw_price_days, benchmark = the TWSE weighted index."""
    from .tw import BENCH
    today = today or dt.date.today()
    lo = (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    rows = store.select("tw_scores", {"select": "ticker,as_of,rank", "board": "eq.tw_main", "as_of": f"gte.{lo}"})
    rows.sort(key=lambda r: (str(r["as_of"]), r["rank"]))
    cohorts: dict[dt.date, list[str]] = {}
    boards: dict[dt.date, list[str]] = {}
    for r in rows:
        d = _d(r["as_of"])
        boards.setdefault(d, []).append(r["ticker"])
        if r["rank"] <= TOP_N:
            cohorts.setdefault(d, []).append(r["ticker"])
    if not cohorts:
        print("  tw report: no score history yet")
        return {"cohorts": 0, "rows": 0}
    pd_rows = store.select("tw_price_days", {"select": "day,bars", "day": f"gte.{min(cohorts).isoformat()}"}, page=10)
    closes = {_d(r["day"]): {t: v[0] for t, v in (r["bars"] or {}).items() if v and v[0] is not None} for r in pd_rows}
    out = compute_report(cohorts, closes, boards=boards, bench=BENCH)
    if out:
        store.upsert("tw_report_card", out, "as_of,horizon")
    print(f"  tw report: {len(cohorts)} cohorts, {len(out)} rows")
    return {"cohorts": len(cohorts), "rows": len(out)}
