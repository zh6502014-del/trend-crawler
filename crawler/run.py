"""Daily pipeline.  python -m crawler.run [--only public|formc] [--dry-run]

Each stage runs on its own: if one source breaks, the other still writes its data, the run is marked
'partial', and the process exits non-zero so GitHub Actions opens a failure issue.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import traceback

import numpy as np
import pandas as pd

from . import attention, formc, fundamentals, digest, industry, prices, report, score, smartmoney, universe
from . import config as cfg
from .store import MemoryStore, Supabase, utcnow


def _int(v):
    """Postgres integer columns reject '3.0': send real ints (or None)."""
    return None if v is None or pd.isna(v) else int(round(float(v)))


_NUMERIC = ["mkt_cap", "shares_out", "analyst_count", "inst_pct", "gross_margin", "profit_margin",
            "debt_to_equity", "rev_yoy", "rev_streak", "quarters", "runway_months"]


def _prior_shares(store, as_of: dt.date) -> dict[str, float]:
    """Share counts from ~6 months ago (our own history), to detect dilution. Empty until history exists."""
    lo = (as_of - dt.timedelta(days=cfg.DILUTION_LOOKBACK_DAYS + 30)).isoformat()
    hi = (as_of - dt.timedelta(days=cfg.DILUTION_LOOKBACK_DAYS - 10)).isoformat()
    try:
        rows = store.select("signals", {"select": "ticker,shares_out,as_of", "as_of": f"gte.{lo}",
                                        "and": f"(as_of.lte.{hi})", "order": "ticker,as_of.desc"})
    except Exception:
        return {}
    out: dict[str, float] = {}
    for r in rows:
        if r.get("shares_out"):
            out.setdefault(r["ticker"], float(r["shares_out"]))
    return out


def run_public(store) -> dict:
    stats: dict = {}
    uni = universe.get_universe()
    stats["universe"] = len(uni)
    print(f"universe: {len(uni)} tickers")

    px, closes, as_of, _ = prices.load_prices(list(uni["ticker"]), store)
    stats["priced"] = len(px)
    stats["as_of"] = as_of.isoformat()

    gate = px[(px["price"] >= cfg.MIN_PRICE) & px["dollar_vol"].between(cfg.DV_MIN_FETCH, cfg.DV_MAX_FETCH)]
    stats["gated"] = len(gate)
    print(f"gated by price/volume: {len(gate)}")

    ciks = dict(zip(uni["ticker"], uni["cik"])) if "cik" in uni else {}
    fund, fstats = fundamentals.refresh_cache(store, list(gate.index), ciks=ciks)
    stats["fundamentals"] = {**fstats, "usable": len(fund)}
    print(f"fundamentals: {stats['fundamentals']}")

    f = pd.DataFrame.from_dict(fund, orient="index")
    if f.empty:
        raise RuntimeError("No usable fundamentals yet (first run, or the SEC is rate-limiting). Try again later.")
    df = gate.join(f, how="inner")
    shares = pd.to_numeric(df["shares_out"], errors="coerce") if "shares_out" in df else pd.Series(np.nan, index=df.index)
    cap = df["price"] * shares  # market cap = today's price x shares on the latest filing cover
    if "mkt_cap" in df:
        cap = cap.fillna(pd.to_numeric(df["mkt_cap"], errors="coerce"))
    df["mkt_cap"] = cap
    for c in _NUMERIC:  # a column that is entirely missing arrives as object dtype; make it numeric
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
    df = score.scorable(df)
    stats["scorable"] = len(df)
    if df.empty:
        raise RuntimeError("Nothing scorable after joining prices and fundamentals.")

    uni_names = dict(zip(uni["ticker"], uni["name"]))
    names = {t: (n if isinstance(n, str) and n else uni_names.get(t)) for t, n in df["name"].items()}
    hn = attention.fetch_all({t: n for t, n in names.items() if n})
    df["hn_mentions"] = pd.Series(hn, dtype="float64").reindex(df.index)
    stats["hn_failed"] = int(df["hn_mentions"].isna().sum())

    prior = _prior_shares(store, as_of)
    df["dilution"] = [
        (s / prior[t] - 1) if (t in prior and prior[t] and pd.notna(s)) else np.nan
        for t, s in zip(df.index, df["shares_out"])
    ]

    scored = score.compute_scores(df)
    stats["main"] = int((scored["board"] == "main").sum())
    stats["watch"] = int((scored["board"] == "watch").sum())

    # ── write ──
    now = utcnow().isoformat()
    ex = dict(zip(uni["ticker"], uni["exchange"])) if "exchange" in uni else {}
    ind = {}
    try:
        ind = industry.fill(store, list(scored.index), ciks)
    except Exception as e:  # noqa: BLE001 - labels are optional
        print(f"  industry skipped: {e!r}")
    store.upsert("entities", [
        {"ticker": t, "name": names.get(t), "sector": ind.get(t, {}).get("sector") or r.get("sector"),
         "industry": ind.get(t, {}).get("industry") or r.get("industry"),
         "exchange": ex.get(t), "updated_at": now}
        for t, r in scored.iterrows()
    ], "ticker")

    sig_cols = ["price", "mkt_cap", "dollar_vol", "ret_1m", "ret_3m", "ret_6m", "rs_6m", "dist_high", "rev_yoy",
                "rev_streak", "gross_margin", "analyst_count", "inst_pct", "hn_mentions", "runway_months", "shares_out"]
    int_cols = {"rev_streak", "analyst_count", "hn_mentions"}
    store.upsert("signals", [
        {"ticker": t, "as_of": as_of,
         **{c: (_int(r.get(c)) if c in int_cols else r.get(c)) for c in sig_cols}}
        for t, r in scored.iterrows()
    ], "ticker,as_of")

    store.upsert("scores", [
        {"ticker": t, "as_of": as_of, "board": r["board"], "rank": int(r["rank"]), "score": r["score"],
         "growth": r["growth"], "validated": r["validated"], "accessibility": r["accessibility"],
         "attention": r["attention"], "flags": list(r["flags"])}
        for t, r in scored.iterrows()
    ], "ticker,as_of")

    top = scored.sort_values("score", ascending=False).head(cfg.PRICE_SERIES_TOP_N).index
    store.upsert("price_series", [
        {"ticker": t, "updated_at": now,
         "series": [[d.date().isoformat(), round(float(c), 4)] for d, c in closes[t].iloc[-130:].items()]}
        for t in top if t in closes
    ], "ticker")
    print(f"wrote {len(scored)} scores ({stats['main']} main, {stats['watch']} watch)")
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["public", "formc", "smart", "report", "digest"], default=os.getenv("ONLY") or None)
    ap.add_argument("--dry-run", action="store_true", help="run everything against an in-memory store")
    args = ap.parse_args(argv)

    store = MemoryStore() if args.dry_run else Supabase()
    run = store.insert("crawl_runs", {"status": "running"})
    stats: dict = {}
    errors: dict = {}
    as_of = None

    stages = [("public", run_public), ("formc", formc.run_formc), ("smart", smartmoney.run_smart), ("report", report.run_report), ("digest", digest.run_digest)]
    for name, fn in stages:
        if args.only and args.only != name:
            continue
        print(f"── {name} ──")
        try:
            stats[name] = fn(store)
            if name == "public":
                as_of = stats[name].get("as_of")
        except Exception as e:
            traceback.print_exc()
            errors[name] = f"{type(e).__name__}: {e}"[:500]

    ran = [n for n, _ in stages if not args.only or args.only == n]
    status = "ok" if not errors else ("failed" if len(errors) == len(ran) else "partial")
    store.update("crawl_runs", {"id": run["id"]},
                 {"finished_at": utcnow().isoformat(), "status": status, "as_of": as_of,
                  "stats": stats, "errors": errors or None})
    print(f"run finished: {status}")
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
