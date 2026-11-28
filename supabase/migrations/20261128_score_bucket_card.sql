-- Report card by score bucket: for each list date, horizon and score bucket of the main board, the equal-weight
-- return of its names versus the benchmark (SPY for the US, the TWSE weighted index for Taiwan).
-- Recomputed by the crawler every run (upsert). Safe to re-run.
create table if not exists public.score_bucket_card (
  market     text not null check (market in ('us', 'tw')),
  as_of      date not null,
  horizon    int  not null,
  bucket     text not null,
  n          int  not null,
  avg_ret    numeric,
  bench_ret  numeric,
  hit_rate   numeric,
  primary key (market, as_of, horizon, bucket)
);
alter table public.score_bucket_card enable row level security;
drop policy if exists read_authenticated on public.score_bucket_card;
create policy read_authenticated on public.score_bucket_card for select to authenticated using (true);
grant select on public.score_bucket_card to authenticated;
grant all on public.score_bucket_card to service_role;
