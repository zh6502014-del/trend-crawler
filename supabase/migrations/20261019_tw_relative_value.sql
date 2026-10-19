-- Taiwan relative valuation (price-to-sales and growth-plus-cheap percentile). Safe to re-run.
alter table public.tw_signals add column if not exists ps numeric;
alter table public.tw_signals add column if not exists rel_val numeric;

create or replace view public.tw_latest_board with (security_invoker = true) as
select
  s.as_of, s.ticker, e.name, e.sector, e.exchange,
  s.board, s.rank, s.score, s.growth, s.validated, s.accessibility, s.attention, s.flags,
  g.price, g.mkt_cap, g.dollar_vol, g.ret_1m, g.ret_3m, g.ret_6m, g.rs_6m, g.dist_high,
  g.rev_yoy, g.rev_cum_yoy, g.rev_streak, g.ym,
  prev.score as score_7d, prev.rank as rank_7d,
  g.inst_5d, g.inst_20d, g.foreign_20d, g.trust_20d, g.pledge_ratio,
  g.rev_3m_yoy, g.rev_prev_3m_yoy, g.rev_accel, g.revenue_months, g.revenue_streak_months,
  g.revenue_as_of, g.revenue_observed_at, g.revenue_history_status, g.scoring_version,
  g.ps, g.rel_val
from public.tw_scores s
join public.tw_entities e on e.ticker = s.ticker
left join public.tw_signals g on g.ticker = s.ticker and g.as_of = s.as_of
left join lateral (
  select p.score, p.rank from public.tw_scores p
  where p.ticker = s.ticker and p.as_of <= s.as_of - 7
    and exists (select 1 from public.tw_signals pg where pg.ticker = p.ticker
                and pg.as_of = p.as_of and pg.scoring_version = g.scoring_version)
  order by p.as_of desc limit 1
) prev on true
where s.as_of = (select max(as_of) from public.tw_scores);

grant select on public.tw_latest_board to authenticated;
