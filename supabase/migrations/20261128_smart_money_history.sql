-- Daily snapshot of the US smart-money signal, so it can be evaluated against later returns (report-review 2026-11-16).
-- Only tickers with some activity are stored; a ticker missing on a day had no signal that day. Safe to re-run.
create table if not exists public.smart_money_history (
  as_of date not null,
  ticker text not null,
  score numeric default 0,
  tags jsonb default '[]'::jsonb,
  buyers_30d int, buy_value_30d numeric, officer_buyers_30d int,
  sellers_30d int, sell_value_30d numeric,
  n_13d_90d int, n_13g_90d int,
  primary key (as_of, ticker)
);
alter table public.smart_money_history enable row level security;
revoke all on public.smart_money_history from anon, authenticated;
grant all on public.smart_money_history to service_role;
