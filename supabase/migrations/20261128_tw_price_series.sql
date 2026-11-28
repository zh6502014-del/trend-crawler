-- Last ~130 closes per Taiwan name for the detail chart (like public.price_series for the US).
-- Overwritten every run; not a history table. Safe to re-run.
create table if not exists public.tw_price_series (
  ticker     text primary key,
  updated_at timestamptz not null default now(),
  series     jsonb not null           -- [["2026-10-14", 612.5], ...]
);
alter table public.tw_price_series enable row level security;
drop policy if exists read_authenticated on public.tw_price_series;
create policy read_authenticated on public.tw_price_series for select to authenticated using (true);
grant select on public.tw_price_series to authenticated;
grant all on public.tw_price_series to service_role;
