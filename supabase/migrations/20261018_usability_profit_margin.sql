-- Expose the financial-sector profitability metric without changing existing view columns or permissions.
-- Apply after reliable_publication on existing installations. Safe to repeat.
begin;

create or replace view public.latest_board with (security_invoker = true) as
select
  s.as_of, s.ticker, e.name, e.sector, e.industry,
  s.board, s.rank, s.score, s.growth, s.validated, s.accessibility, s.attention, s.flags,
  g.price, g.mkt_cap, g.dollar_vol, g.ret_1m, g.ret_3m, g.ret_6m, g.rs_6m, g.dist_high,
  g.rev_yoy, g.rev_streak, g.gross_margin, g.analyst_count, g.inst_pct, g.hn_mentions, g.runway_months,
  prev.score as score_7d, prev.rank as rank_7d,
  s.batch_id, b.published_at, b.metadata->>'scoring_version' as scoring_version,
  g.fundamentals_fetched_at, g.fundamentals_age_days, g.fundamentals_source, g.price_source, g.hn_fetched_at, g.profit_margin
from public.scores s
join public.publication_batches b on b.id = s.batch_id
join public.entities e on e.ticker = s.ticker
left join public.signals g on g.ticker = s.ticker and g.as_of = s.as_of
left join lateral (
  select p.score, p.rank from public.scores p
  where p.ticker = s.ticker and p.as_of <= s.as_of - 7
  order by p.as_of desc limit 1
) prev on true
where s.batch_id = (select id from public.publication_batches where status = 'published'
                    order by as_of desc, published_at desc, id desc limit 1);

grant select on public.latest_board to anon, authenticated;

commit;
