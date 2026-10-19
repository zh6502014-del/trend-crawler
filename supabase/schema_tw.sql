-- Taiwan market (TWSE + TPEx). Separate tables so the US tables and views are untouched. Safe to re-run.

create table if not exists public.tw_entities (
  ticker text primary key, name text, sector text, exchange text, updated_at timestamptz
);
create table if not exists public.tw_signals (
  ticker text not null, as_of date not null,
  price numeric, mkt_cap numeric, dollar_vol numeric,          -- TWD; dollar_vol = 20-day average traded value
  ret_1m numeric, ret_3m numeric, ret_6m numeric, rs_6m numeric, dist_high numeric,
  rev_yoy numeric, rev_cum_yoy numeric, rev_streak integer, ym text, shares_out numeric,
  primary key (ticker, as_of)
);
create table if not exists public.tw_scores (
  ticker text not null, as_of date not null,
  board text not null check (board in ('tw_main','tw_watch')),
  rank integer, score numeric, growth numeric, validated numeric, accessibility numeric, attention numeric,
  flags text[] not null default '{}',
  primary key (ticker, as_of)
);
create index if not exists tw_scores_asof_board_idx on public.tw_scores (as_of, board, rank);
create table if not exists public.tw_price_days (day date primary key, bars jsonb not null);

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


alter table public.tw_entities   enable row level security;
alter table public.tw_signals    enable row level security;
alter table public.tw_scores     enable row level security;
alter table public.tw_price_days enable row level security;
do $$
declare t text;
begin
  foreach t in array array['tw_entities','tw_signals','tw_scores'] loop
    execute format('drop policy if exists read_authenticated on public.%I', t);
    execute format('create policy read_authenticated on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
grant select on public.tw_entities, public.tw_signals, public.tw_scores to authenticated;
grant all on public.tw_entities, public.tw_signals, public.tw_scores, public.tw_price_days to service_role;

-- Report card for the Taiwan board (benchmark = TWSE weighted index; spy_ret holds the index return)
create table if not exists public.tw_report_card (as_of date not null, horizon int not null, n int, avg_ret numeric, spy_ret numeric, excess numeric, hit_rate numeric, best text, best_ret numeric, worst text, worst_ret numeric, exit_day date, top10_ret numeric, board_ret numeric, edge_board numeric, primary key (as_of, horizon));
alter table public.tw_report_card enable row level security;
drop policy if exists read_authenticated on public.tw_report_card;
create policy read_authenticated on public.tw_report_card for select to authenticated using (true);
grant select on public.tw_report_card to authenticated;
grant all on public.tw_report_card to service_role;


-- Big-money signals (institutional flows, director pledging). Run after the section above; safe to re-run.
create table if not exists public.tw_inst_days (day date primary key, bars jsonb not null);
alter table public.tw_inst_days enable row level security;
grant all on public.tw_inst_days to service_role;
alter table public.tw_signals add column if not exists inst_5d numeric;
alter table public.tw_signals add column if not exists inst_20d numeric;
alter table public.tw_signals add column if not exists foreign_20d numeric;
alter table public.tw_signals add column if not exists trust_20d numeric;
alter table public.tw_signals add column if not exists pledge_ratio numeric;
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
