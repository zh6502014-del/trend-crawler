-- Run after schema.sql and schema_tw.sql. Additive, safe to re-run.
begin;

-- Private research cards. Distinct from user_watch; existing notes are untouched.
create table if not exists public.research_cards (
  user_id uuid not null default auth.uid(),
  market text not null check (market in ('us', 'tw')),
  ticker text not null check (length(ticker) between 1 and 30),
  thesis text not null default '' check (length(thesis) <= 4000),
  moat text not null default '' check (length(moat) <= 4000),
  variant text not null default '' check (length(variant) <= 4000),
  evidence text not null default '' check (length(evidence) <= 8000),
  counter_evidence text not null default '' check (length(counter_evidence) <= 8000),
  invalidation text not null default '' check (length(invalidation) <= 4000),
  next_step text not null default '' check (length(next_step) <= 4000),
  review_on date,
  status text not null default 'researching' check (status in ('researching', 'watching', 'rejected')),
  updated_at timestamptz not null default now(),
  primary key (user_id, market, ticker)
);
alter table public.research_cards enable row level security;
drop policy if exists own_rows on public.research_cards;
create policy own_rows on public.research_cards for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.research_cards from anon;
grant select, insert, update, delete on public.research_cards to authenticated;

-- Server-only cache; observation time is not historical filing time.
create table if not exists public.tw_revenue_months (
  exchange text not null check (exchange in ('TWSE', 'TPEx')),
  ym date not null,
  bars jsonb not null,
  fetched_at timestamptz not null,
  primary key (exchange, ym)
);
alter table public.tw_revenue_months enable row level security;
grant all on public.tw_revenue_months to service_role;
alter table public.tw_signals add column if not exists rev_3m_yoy numeric;
alter table public.tw_signals add column if not exists rev_prev_3m_yoy numeric;
alter table public.tw_signals add column if not exists rev_accel numeric;
alter table public.tw_signals add column if not exists revenue_months integer;
alter table public.tw_signals add column if not exists revenue_streak_months integer;
alter table public.tw_signals add column if not exists revenue_as_of date;
alter table public.tw_signals add column if not exists revenue_observed_at timestamptz;
alter table public.tw_signals add column if not exists revenue_history_status text;
alter table public.tw_signals add column if not exists scoring_version text;
-- Preserve valuation columns when this migration is re-run after 20261019.
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

commit;
