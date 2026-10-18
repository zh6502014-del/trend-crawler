"""Every tunable lives here. Change numbers here, not in pipeline code."""
import os

# ── Universe ────────────────────────────────────────────────────────────────
# sec : SEC's official ticker list (Nasdaq + NYSE), then filtered by price/volume. Default.
# csv : your own list in universe.csv (columns: ticker[,name]).
UNIVERSE_SOURCE = os.getenv("UNIVERSE_SOURCE", "sec")
UNIVERSE_CSV = os.getenv("UNIVERSE_CSV", "universe.csv")

# ── Cheap pre-filter (from price data only, before any slow per-ticker call) ─
MIN_PRICE = 1.0
DV_MIN_FETCH = 100_000        # 20-day avg $ volume below this: not worth fetching fundamentals
DV_MAX_FETCH = 80_000_000     # above this the name is already a crowd favourite

# ── Board gates ─────────────────────────────────────────────────────────────
# A name is scored if market cap is within SCORE_CAP_*; it lands on the MAIN board only if it also
# passes the stricter MAIN_* / liquidity / data gates. Everything else scored goes to the WATCH board.
SCORE_CAP_MIN = 20e6
SCORE_CAP_MAX = 20e9
MAIN_CAP_MIN = 50e6
MAIN_CAP_MAX = 10e9
CAP_SWEET_MAX = 2e9           # full "accessibility" marks up to here, decaying to 0 at MAIN_CAP_MAX
MAIN_MAX_NAMES = int(os.getenv("MAIN_MAX_NAMES", "150"))  # main board keeps only the best-scoring names that pass the gates
MIN_DOLLAR_VOL = 300_000      # liquidity gate for the main board (and the 0-point of the liquidity score)

# ── Fetch budget ────────────────────────────────────────────────────────────
FUNDAMENTALS_TTL_DAYS = 7
MAX_REFRESH_PER_RUN = int(os.getenv("MAX_REFRESH_PER_RUN", "400"))
if os.getenv("FULL_REFRESH") == "1":
    MAX_REFRESH_PER_RUN = 5000
REQUEST_PAUSE = 0.15           # seconds between per-company SEC calls (SEC allows 10 req/s)
PRICE_PAUSE = 12.5             # seconds between price-API calls (free plan: 5 calls/minute)
RATE_LIMIT_ABORT_AFTER = 15    # consecutive failures before we stop hammering the source
PRICE_CHUNK = 150
PRICE_SERIES_TOP_N = 250       # tickers per run that get a stored price series for the detail chart

# ── Scoring ─────────────────────────────────────────────────────────────────
# score = 100 × geometric_mean(growth, validated, accessibility) × (1 − CROWD_WEIGHT × attention)
# Geometric mean = multiplicative: a near-zero pillar drags the whole score down (power-law logic).
GROWTH_W = {"rev_yoy": 0.6, "rs_6m": 0.4}
VALIDATED_W = {"streak": 0.6, "gross_margin": 0.4}
# Banks, insurers and other financials report no gross profit, so "gross_margin" would always be missing for them.
# For rows whose sector equals FINANCIAL_SECTOR (the label industry.py gives SIC 6000-6499 and 6700-6799, SPACs excluded),
# net margin (profit_margin) takes gross margin's place in the "validated" pillar, ranked only against other financials.
FINANCIAL_SECTOR = "金融與保險"
PILLAR_W = {"growth": 1.0, "validated": 1.0, "accessibility": 1.0}
# analyst_count / inst_pct are not available from SEC data (weight 0). Crowding = Hacker News + trading activity.
ATTENTION_W = {"analyst_count": 0.0, "inst_pct": 0.0, "hn_mentions": 0.5, "dollar_vol": 0.5}
CROWD_WEIGHT = 0.6            # 0 = ignore attention, 1 = fully-crowded names score zero
MISSING_PCT = 0.25            # percentile assigned to a missing growth/quality metric (missing is not neutral)
FLOOR = 0.02                  # keeps log() finite

# ── Flags ───────────────────────────────────────────────────────────────────
RUNWAY_MONTHS_WARN = 12
DEEP_LOSS_MARGIN = -0.5       # net margin below -50%
HIGH_DEBT_TO_EQUITY = 200     # long-term debt / equity, as a percentage
DILUTION_WARN = 0.15          # share count up >15% vs ~6 months ago
CROWDED_ATTENTION = 80        # attention score (0-100) at/above this
DILUTION_LOOKBACK_DAYS = 180

# ── Hacker News attention ───────────────────────────────────────────────────
HN_WINDOW_DAYS = 30
HN_PAUSE = 0.12

# ── SEC EDGAR / Form C ──────────────────────────────────────────────────────
FORMC_DAYS_BACK = int(os.getenv("FORMC_DAYS_BACK", "21"))
SEC_PAUSE = 0.15               # SEC allows 10 req/s; stay well below

# ── Big-money signals (Form 4 + Schedule 13D/G) ─────────────────────────────
SMART_DAYS_BACK = int(os.getenv("SMART_DAYS_BACK", "30"))
MAX_SMART_FETCH_PER_RUN = int(os.getenv("MAX_SMART_FETCH_PER_RUN", "3000"))


def sec_headers() -> dict:
    """SEC rejects anonymous clients. Set SEC_USER_AGENT to 'Your Name you@example.com'."""
    ua = os.getenv("SEC_USER_AGENT", "").strip()
    if not ua or "@" not in ua:
        raise RuntimeError(
            "SEC_USER_AGENT is not set. Use the form 'Your Name your@email.com' "
            "(the SEC requires a contact address in the User-Agent)."
        )
    return {"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}
