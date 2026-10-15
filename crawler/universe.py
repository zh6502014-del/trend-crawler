"""Which tickers do we look at? Official sources only."""
from __future__ import annotations

import os
import re

import pandas as pd
import requests

from . import config as cfg

SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json"
_TICKER_OK = re.compile(r"^[A-Z]{1,5}$")
# Names that are not operating companies: warrants, units, preferred, funds, blank-check shells.
_NAME_BAD = re.compile(
    r"\b(warrants?|units?|rights?|preferred|depositary|etf|etn|fund|acquisition corp|acquisition co)\b", re.I
)


def _tidy(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ticker"] = df["ticker"].astype(str).str.strip().str.upper()
    df = df[df["ticker"].map(lambda t: bool(_TICKER_OK.match(t)))]
    if "name" not in df:
        df["name"] = df["ticker"]
    df["name"] = df["name"].fillna(df["ticker"]).astype(str)
    df = df[~df["name"].map(lambda n: bool(_NAME_BAD.search(n)))]
    return df.drop_duplicates("ticker").reset_index(drop=True)


def from_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    if "ticker" not in df:
        raise ValueError(f"{path} needs a 'ticker' column")
    return _tidy(df[[c for c in ("ticker", "name", "exchange") if c in df]])


def from_sec() -> pd.DataFrame:
    r = requests.get(SEC_TICKERS_URL, headers=cfg.sec_headers(), timeout=60)
    r.raise_for_status()
    j = r.json()
    df = pd.DataFrame(j["data"], columns=j["fields"])  # cik, name, ticker, exchange
    ex = df["exchange"].fillna("").str.lower()
    keep = (ex == "nasdaq") | (ex.str.startswith("nyse") & ~ex.str.contains("arca"))
    return _tidy(df[keep][["ticker", "name", "exchange"]])


def get_universe() -> pd.DataFrame:
    """DataFrame[ticker, name, (exchange)]. UNIVERSE_SOURCE=csv reads universe.csv instead of the SEC list."""
    if cfg.UNIVERSE_SOURCE == "csv":
        if not os.path.exists(cfg.UNIVERSE_CSV):
            raise FileNotFoundError(f"UNIVERSE_SOURCE=csv but {cfg.UNIVERSE_CSV} does not exist")
        return from_csv(cfg.UNIVERSE_CSV)
    return from_sec()
