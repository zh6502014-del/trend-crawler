import datetime as dt

import numpy as np
import pandas as pd

from crawler import backtest as bt


def test_month_ends():
    d = bt.month_ends(dt.date(2024, 11, 1), dt.date(2025, 2, 28))
    assert d == [dt.date(2024, 11, 30), dt.date(2024, 12, 31), dt.date(2025, 1, 31), dt.date(2025, 2, 28)]


def test_evaluate_finds_a_planted_signal():
    rng = np.random.default_rng(1)
    rows = []
    for k in range(6):
        d = dt.date(2025, 1 + k, 28)
        ps = rng.uniform(0.5, 10, 200)
        growth = rng.uniform(-0.2, 0.8, 200)
        rows.append(pd.DataFrame({"date": d, "ticker": [str(i) for i in range(200)], "ps": ps, "growth": growth,
                                  "fwd_1m": -0.02 * np.log(ps) + rng.normal(0, 0.01, 200)}))   # cheap names do better
    panel = pd.concat([bt.add_factors(g) for _, g in pd.concat(rows).groupby("date")])
    res = bt.evaluate(panel, horizons=(1,))
    assert res["cheap_1m"]["ic_mean"] > 0.5 and res["cheap_1m"]["spread_q5_q1"] > 0
    assert abs(res["growth_1m"]["ic_mean"]) < 0.2


def test_parse_mops_month():
    html = ("<tr><td>2330</td><td>台積電</td><td>1,000</td><td>900</td><td>800</td><td>11.1</td><td>25.0</td></tr>"
            "<tr><td>合計</td><td></td><td>5</td><td>5</td><td>5</td></tr><tr><td>00919</td><td>x</td><td>1</td><td>1</td><td>1</td></tr>")
    assert bt.parse_mops_month(html) == {"2330": (1000.0, 800.0)}


def test_tw_panel_uses_only_published_months():
    d = dt.date(2025, 6, 30)
    rev = {}
    for k in range(1, 14):
        mm = 6 - k
        yy = 2025 + (mm - 1) // 12
        mm = (mm - 1) % 12 + 1
        rev[(yy, mm)] = {"2330": (100.0, 80.0)}
    rev[(2025, 6)] = {"2330": (1e9, 1.0)}          # June is not public yet at June 30: must be ignored
    bars = {d: {"2330": [100.0, 1e6, 1e8, None], "_TAIEX": [1.0, 0, 0, None]}}
    panel, _ = bt.tw_panel(rev, bars, {"2330": 1e9}, [d])
    r = panel.iloc[0]
    assert abs(r["ps"] - (100.0 * 1e9) / (1200 * 1000.0)) < 1e-6 and abs(r["growth"] - 0.25) < 1e-9


def test_us_point_is_point_in_time():
    q = [(dt.date(2024, 3, 31), dt.date(2024, 5, 5), 10.0), (dt.date(2024, 6, 30), dt.date(2024, 8, 5), 11.0),
         (dt.date(2024, 9, 30), dt.date(2024, 11, 5), 12.0), (dt.date(2024, 12, 31), dt.date(2025, 2, 5), 13.0),
         (dt.date(2025, 3, 31), dt.date(2025, 5, 5), 15.0)]
    sh = [(dt.date(2024, 5, 5), 1000.0), (dt.date(2025, 5, 5), 2000.0)]
    assert bt.us_point(q, sh, dt.date(2025, 5, 1)) is None            # the Q1-2025 report is not filed yet: not enough history
    ttm, g, shares = bt.us_point(q, sh, dt.date(2025, 5, 31))
    assert ttm == 11 + 12 + 13 + 15 and abs(g - 0.5) < 1e-9 and shares == 2000.0
