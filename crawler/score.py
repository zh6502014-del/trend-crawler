"""The scoring logic. Pure pandas: no network, fully unit-testable.

    score = 100 × geometric_mean(growth, validated, accessibility) × (1 − CROWD_WEIGHT × attention)

growth        how fast revenue and relative price strength are rising (percentile within today's universe)
validated     is the growth real? consecutive quarters of revenue growth + gross margin
              (financials, which report no gross profit, use net margin ranked among financials instead)
accessibility can a small account actually buy it? liquidity + market-cap sweet spot
attention     how crowded is the name? analysts, institutions, Hacker News. HIGH = crowded = penalised
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as cfg

REQUIRED = ["price", "mkt_cap", "dollar_vol", "rev_yoy", "rs_6m"]


def _pct(s: pd.Series, method: str = "average") -> pd.Series:
    return pd.to_numeric(s, errors="coerce").rank(pct=True, method=method)


def _wmean(frame: pd.DataFrame, weights: dict) -> pd.Series:
    """Weighted mean that ignores missing cells instead of treating them as zero."""
    w = pd.Series(weights).reindex(frame.columns)
    num = frame.fillna(0).mul(w, axis=1).sum(axis=1)
    den = frame.notna().mul(w, axis=1).sum(axis=1)
    return (num / den).where(den > 0)


def cap_score(cap: pd.Series) -> pd.Series:
    """1.0 up to CAP_SWEET_MAX, decaying (log scale) to 0 at MAIN_CAP_MAX; micro caps get 0.3; unknown 0.5."""
    cap = pd.to_numeric(cap, errors="coerce")
    s = pd.Series(1.0, index=cap.index)
    over = cap > cfg.CAP_SWEET_MAX
    s[over] = 1 - np.log(cap[over] / cfg.CAP_SWEET_MAX) / np.log(cfg.MAIN_CAP_MAX / cfg.CAP_SWEET_MAX)
    s[cap < cfg.MAIN_CAP_MIN] = 0.3
    s[cap.isna()] = 0.5
    return s.clip(0, 1)


def is_financial(sector) -> bool:
    return isinstance(sector, str) and sector == cfg.FINANCIAL_SECTOR


def quality_margin(r: pd.Series):
    """The margin that backs 'validated': gross margin normally, net margin for financials."""
    return r.get("profit_margin") if is_financial(r.get("sector")) else r.get("gross_margin")


def build_flags(r: pd.Series) -> list[str]:
    f: list[str] = []
    if pd.notna(r.get("runway_months")) and r["runway_months"] < cfg.RUNWAY_MONTHS_WARN:
        f.append("short_runway")
    if pd.notna(r.get("profit_margin")) and r["profit_margin"] < cfg.DEEP_LOSS_MARGIN:
        f.append("deep_loss")
    if pd.notna(r.get("debt_to_equity")) and r["debt_to_equity"] > cfg.HIGH_DEBT_TO_EQUITY:
        f.append("high_debt")
    if pd.notna(r.get("dilution")) and r["dilution"] > cfg.DILUTION_WARN:
        f.append("dilution")
    if r["dollar_vol"] < cfg.MIN_DOLLAR_VOL:
        f.append("thin_volume")
    if r["mkt_cap"] < cfg.MAIN_CAP_MIN:
        f.append("micro_cap")
    if r["attention"] >= cfg.CROWDED_ATTENTION:
        f.append("crowded")
    q = r.get("quarters")
    if pd.isna(q) or q < 4 or pd.isna(quality_margin(r)):
        f.append("data_thin")
    return f


def compute_scores(df: pd.DataFrame) -> pd.DataFrame:
    """df needs REQUIRED columns plus optional rev_streak, gross_margin, analyst_count, inst_pct,
    hn_mentions, runway_months, profit_margin, debt_to_equity, dilution, quarters. Returns df + score columns (0-100)."""
    d = df.copy()
    if d.empty:
        return d
    for col in ("rev_streak", "gross_margin", "analyst_count", "inst_pct", "hn_mentions", "runway_months",
                "profit_margin", "debt_to_equity", "dilution", "quarters"):
        if col not in d:
            d[col] = np.nan
    if "sector" not in d:
        d["sector"] = None
    fin = d["sector"].map(is_financial).astype(bool)
    miss = cfg.MISSING_PCT

    growth = _wmean(
        pd.DataFrame({"rev_yoy": _pct(d["rev_yoy"]).fillna(miss), "rs_6m": _pct(d["rs_6m"]).fillna(miss)}),
        cfg.GROWTH_W,
    )
    streak = (pd.to_numeric(d["rev_streak"], errors="coerce").clip(0, 4) / 4).fillna(0)
    margin = pd.Series(np.nan, index=d.index)  # percentile of gross margin (financials: net margin), within each group
    for mask, col in ((~fin, "gross_margin"), (fin, "profit_margin")):
        if mask.any():
            margin[mask] = _pct(d.loc[mask, col])
    validated = _wmean(
        pd.DataFrame({"streak": streak, "gross_margin": margin.fillna(miss)}),
        cfg.VALIDATED_W,
    )
    liq = (np.log10(d["dollar_vol"].clip(lower=1) / cfg.MIN_DOLLAR_VOL) / 2).clip(0, 1)
    access = 0.5 * liq + 0.5 * cap_score(d["mkt_cap"])

    attention = _wmean(
        pd.DataFrame(
            {
                "analyst_count": _pct(pd.to_numeric(d["analyst_count"], errors="coerce").fillna(0), "min"),
                "inst_pct": _pct(d["inst_pct"], "min"),
                "hn_mentions": _pct(np.log1p(pd.to_numeric(d["hn_mentions"], errors="coerce")), "min"),
                "dollar_vol": _pct(d["dollar_vol"], "min"),
            }
        ),
        cfg.ATTENTION_W,
    ).fillna(0.5)

    pillars = {"growth": growth, "validated": validated, "accessibility": access}
    wsum = sum(cfg.PILLAR_W.values())
    log_mean = sum(cfg.PILLAR_W[k] * np.log(v.clip(lower=cfg.FLOOR)) for k, v in pillars.items()) / wsum
    score = 100 * np.exp(log_mean) * (1 - cfg.CROWD_WEIGHT * attention)

    d["growth"] = (growth * 100).round(1)
    d["validated"] = (validated * 100).round(1)
    d["accessibility"] = (access * 100).round(1)
    d["attention"] = (attention * 100).round(1)
    d["score"] = score.round(2)

    d["flags"] = d.apply(build_flags, axis=1)
    main = (
        d["mkt_cap"].between(cfg.MAIN_CAP_MIN, cfg.MAIN_CAP_MAX)
        & (d["dollar_vol"] >= cfg.MIN_DOLLAR_VOL)
        & (d["price"] >= cfg.MIN_PRICE)
        & ~d["flags"].map(lambda f: "data_thin" in f)
    )
    if cfg.MAIN_MAX_NAMES and main.sum() > cfg.MAIN_MAX_NAMES:  # keep only the best-scoring gate-passers
        main = main & (d["score"].where(main).rank(ascending=False, method="first") <= cfg.MAIN_MAX_NAMES)
    d["board"] = np.where(main, "main", "watch")
    d["rank"] = d.groupby("board")["score"].rank(ascending=False, method="first").astype(int)
    return d


def scorable(df: pd.DataFrame) -> pd.DataFrame:
    """Keep rows that have the required data and a market cap inside the scoring band."""
    ok = df[REQUIRED].notna().all(axis=1) & df["mkt_cap"].between(cfg.SCORE_CAP_MIN, cfg.SCORE_CAP_MAX)
    return df[ok]
