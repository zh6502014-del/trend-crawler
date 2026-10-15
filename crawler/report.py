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


def compute_report(cohorts: dict, closes: dict, horizons=HORIZONS) -> list[dict]:
    """cohorts: {as_of: [ticker, ...]}; closes: {day: {ticker: close}} (must include 'SPY').

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
            if not c0.get("SPY") or not c1.get("SPY"):
                continue
            spy = c1["SPY"] / c0["SPY"] - 1
            rets = {t: c1[t] / c0[t] - 1 for t in tickers if c0.get(t) and c1.get(t)}
            if len(rets) < max(3, len(tickers) // 2):
                continue
            avg = sum(rets.values()) / len(rets)
            best = max(rets, key=rets.get)
            worst = min(rets, key=rets.get)
            out.append({
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
    rows = store.select("scores", {"select": "ticker,as_of,rank", "board": "eq.main", "rank": f"lte.{TOP_N}",
                                   "as_of": f"gte.{lo}"})
    cohorts: dict[dt.date, list[str]] = {}
    for r in rows:
        cohorts.setdefault(_d(r["as_of"]), []).append(r["ticker"])
    if not cohorts:
        print("  report: no score history yet")
        return {"cohorts": 0, "rows": 0}
    pd_rows = store.select("price_days", {"select": "day,bars", "day": f"gte.{min(cohorts).isoformat()}"}, page=10)
    closes = {_d(r["day"]): {t: v[0] for t, v in (r["bars"] or {}).items() if v and v[0] is not None} for r in pd_rows}
    out = compute_report(cohorts, closes)
    if out:
        store.upsert("report_card", out, "as_of,horizon")
    print(f"  report: {len(cohorts)} cohorts, {len(out)} rows")
    return {"cohorts": len(cohorts), "rows": len(out)}
