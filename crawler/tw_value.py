"""Relative valuation for Taiwan stocks: "growth plus cheap" (成長加便宜).

Backtest (backtest/results/tw_valuation.json, 2021-2026): ranking stocks by the average of
(cheap = low market cap / trailing-12-month revenue) and (growth = latest 3-month revenue YoY) gave a weak but
consistent signal (3-month rank IC about 0.04, top-minus-bottom quintile about 2.4%). This is a position among peers,
NOT a target price, and it does not change the score. Limits: survivorship bias, today's share count.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MIN_PEERS = 50


def add_relative_value(df: pd.DataFrame) -> pd.DataFrame:
    """Append ps (price-to-sales, market cap / TTM revenue) and rel_val (0-100, higher = cheaper for its growth)."""
    out = df.copy()
    out["ps"] = np.nan
    out["rel_val"] = np.nan
    if not {"mkt_cap", "rev_ttm", "rev_3m_yoy"} <= set(out.columns):
        return out
    rev = pd.to_numeric(out["rev_ttm"], errors="coerce") * 1000.0  # thousand TWD -> TWD
    cap = pd.to_numeric(out["mkt_cap"], errors="coerce")
    ps = cap / rev.where(rev > 0)
    out["ps"] = ps.where(np.isfinite(ps) & (ps > 0))
    g = pd.to_numeric(out["rev_3m_yoy"], errors="coerce")
    ok = out["ps"].notna() & g.notna()
    if ok.sum() < MIN_PEERS:
        return out
    cheap_rank = (-np.log(out.loc[ok, "ps"])).rank(pct=True)
    growth_rank = g[ok].rank(pct=True)
    out.loc[ok, "rel_val"] = 100.0 * (cheap_rank + growth_rank) / 2.0
    return out
