import numpy as np
import pandas as pd

from crawler import tw_revenue, tw_value


def test_rel_val_ranks_cheap_and_growing_highest():
    n = 80
    idx = [str(1000 + i) for i in range(n)]
    df = pd.DataFrame({"mkt_cap": np.linspace(1e9, 8e9, n), "rev_ttm": np.full(n, 1e6),  # thousand TWD -> 1e9 TWD
                       "rev_3m_yoy": np.linspace(-0.2, 0.6, n)}, index=idx)
    out = tw_value.add_relative_value(df)
    assert out["ps"].iloc[0] == 1.0 and out["ps"].iloc[-1] == 8.0
    # cheapest stock has the weakest growth, priciest the strongest; a cheap+fast one beats both
    df.loc["fast_cheap"] = [1e9, 1e6, 0.6]
    out = tw_value.add_relative_value(df)
    assert out.loc["fast_cheap", "rel_val"] == out["rel_val"].max()


def test_rel_val_needs_enough_peers_and_valid_inputs():
    df = pd.DataFrame({"mkt_cap": [1e9, 2e9], "rev_ttm": [1e6, 0], "rev_3m_yoy": [0.1, 0.2]}, index=["a", "b"])
    out = tw_value.add_relative_value(df)
    assert out["rel_val"].isna().all() and np.isnan(out.loc["b", "ps"])


def test_rev_ttm_needs_twelve_consecutive_months():
    end = tw_revenue.month("11509")  # 2026-09
    hist = {("TWSE", tw_revenue.shift(end, -n).isoformat()): {"bars": {"2330": [100.0, 80.0]}, "fetched_at": "2026-10-01T00:00:00+00:00"}
            for n in range(12)}
    out = tw_revenue.metrics("2330", "TWSE", "11509", hist, today=tw_revenue.month("11510"))
    assert out["rev_ttm"] == 1200.0
    del hist[("TWSE", tw_revenue.shift(end, -11).isoformat())]
    assert tw_revenue.metrics("2330", "TWSE", "11509", hist, today=tw_revenue.month("11510")).get("rev_ttm") is None
