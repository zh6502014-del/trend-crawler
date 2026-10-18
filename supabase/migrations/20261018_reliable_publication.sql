-- Existing installations: run this whole file once before deploying the new crawler.
-- Existing history and read policies are preserved. The board becomes visible after
-- the first complete publication by the new crawler; legacy batches are not certified.
begin;

create table if not exists public.price_days (
  day date primary key,
  bars jsonb not null,
  format text not null default 'massive_raw_v1'
);
alter table public.price_days add column if not exists format text not null default 'legacy_adjusted';

create table if not exists public.attention_cache (
  ticker text primary key,
  query text not null,
  window_days integer not null,
  mentions integer not null check (mentions >= 0),
  fetched_at timestamptz not null
);

create table if not exists public.publication_batches (
  id uuid primary key,
  as_of date not null,
  row_count integer not null check (row_count > 0),
  status text not null default 'staging' check (status in ('staging', 'published')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists publication_latest_idx
  on public.publication_batches (as_of desc, published_at desc) where status = 'published';

create table if not exists public.publication_rows (
  batch_id uuid not null references public.publication_batches(id) on delete cascade,
  ticker text not null,
  entity jsonb not null,
  signal jsonb not null,
  score jsonb not null,
  prices jsonb,
  primary key (batch_id, ticker)
);

alter table public.signals add column if not exists quarters integer;
alter table public.signals add column if not exists profit_margin numeric;
alter table public.signals add column if not exists debt_to_equity numeric;
alter table public.signals add column if not exists dilution numeric;
alter table public.signals add column if not exists fundamentals_fetched_at timestamptz;
alter table public.signals add column if not exists fundamentals_age_days integer;
alter table public.signals add column if not exists fundamentals_source text;
alter table public.signals add column if not exists price_source text;
alter table public.signals add column if not exists hn_fetched_at timestamptz;
alter table public.scores add column if not exists batch_id uuid references public.publication_batches(id);

alter table public.price_days enable row level security;
alter table public.attention_cache enable row level security;
alter table public.publication_batches enable row level security;
alter table public.publication_rows enable row level security;
revoke all on public.price_days, public.attention_cache, public.publication_rows from anon, authenticated;
grant all on public.price_days, public.attention_cache, public.publication_batches, public.publication_rows to service_role;
grant select on public.publication_batches to anon, authenticated;
drop policy if exists read_published_authenticated on public.publication_batches;
create policy read_published_authenticated on public.publication_batches
  for select to authenticated using (status = 'published');
-- Match the existing project's public/private choice; never turn public reads on by default.
drop policy if exists read_published_public on public.publication_batches;
do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'scores'
             and policyname = 'read_public') then
    create policy read_published_public on public.publication_batches
      for select to anon using (status = 'published');
  end if;
end $$;

create or replace function public.publish_public_batch(p_batch_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  b public.publication_batches;
  actual integer;
begin
  -- Serialize publications, including two runs for the same date.
  perform pg_catalog.pg_advisory_xact_lock(72683211);
  select * into b from public.publication_batches where id = p_batch_id for update;
  if not found then raise exception 'Unknown publication batch'; end if;
  if b.status = 'published' then return b.row_count; end if;
  select count(*) into actual from public.publication_rows where batch_id = p_batch_id;
  if actual <> b.row_count then raise exception 'Incomplete batch: expected %, got %', b.row_count, actual; end if;
  if exists (
    select 1 from public.publication_rows r where r.batch_id = p_batch_id and (
      r.entity->>'ticker' is distinct from r.ticker or
      r.signal->>'ticker' is distinct from r.ticker or
      r.score->>'ticker' is distinct from r.ticker or
      (r.signal->>'as_of')::date is distinct from b.as_of or
      (r.score->>'as_of')::date is distinct from b.as_of or
      (r.score->>'batch_id')::uuid is distinct from b.id or
      (r.prices is not null and r.prices->>'ticker' is distinct from r.ticker)
    )
  ) then raise exception 'Batch payload identifiers do not match'; end if;
  if exists (
    select 1 from public.publication_rows where batch_id = p_batch_id
    group by score->>'board', score->>'rank' having count(*) > 1
  ) then raise exception 'Duplicate rank in batch'; end if;
  if exists (
    select 1 from public.publication_batches where status = 'published' and as_of = b.as_of
    and created_at > b.created_at
  ) then raise exception 'A newer batch for this date is already published'; end if;
  if b.as_of < (select max(as_of) from public.publication_batches where status = 'published') then
    raise exception 'Price date is older than the current published board';
  end if;

  insert into public.entities
    select e.* from public.publication_rows r
    cross join lateral pg_catalog.jsonb_populate_record(null::public.entities, r.entity) e
    where r.batch_id = p_batch_id
    on conflict (ticker) do update set name = excluded.name, sector = excluded.sector,
      industry = excluded.industry, exchange = excluded.exchange, updated_at = excluded.updated_at;

  -- Same-day reruns replace the entire cohort, including names no longer qualifying.
  -- All deletes, inserts and the publication marker share this one transaction.
  delete from public.scores where as_of = b.as_of;
  delete from public.signals where as_of = b.as_of;
  insert into public.signals
    select s.* from public.publication_rows r
    cross join lateral pg_catalog.jsonb_populate_record(null::public.signals, r.signal) s
    where r.batch_id = p_batch_id;
  insert into public.scores
    select s.* from public.publication_rows r
    cross join lateral pg_catalog.jsonb_populate_record(null::public.scores, r.score) s
    where r.batch_id = p_batch_id;
  insert into public.price_series
    select p.* from public.publication_rows r
    cross join lateral pg_catalog.jsonb_populate_record(null::public.price_series, r.prices) p
    where r.batch_id = p_batch_id and r.prices is not null
    on conflict (ticker) do update set series = excluded.series, updated_at = excluded.updated_at;
  update public.publication_batches set status = 'published', published_at = clock_timestamp() where id = b.id;
  delete from public.publication_rows where batch_id = b.id;
  delete from public.publication_batches where status = 'staging' and created_at < now() - interval '7 days';
  return actual;
end $$;
revoke all on function public.publish_public_batch(uuid) from public, anon, authenticated;
grant execute on function public.publish_public_batch(uuid) to service_role;

create or replace view public.latest_board with (security_invoker = true) as
select
  s.as_of, s.ticker, e.name, e.sector, e.industry,
  s.board, s.rank, s.score, s.growth, s.validated, s.accessibility, s.attention, s.flags,
  g.price, g.mkt_cap, g.dollar_vol, g.ret_1m, g.ret_3m, g.ret_6m, g.rs_6m, g.dist_high,
  g.rev_yoy, g.rev_streak, g.gross_margin, g.analyst_count, g.inst_pct, g.hn_mentions, g.runway_months,
  prev.score as score_7d, prev.rank as rank_7d,
  s.batch_id, b.published_at, b.metadata->>'scoring_version' as scoring_version,
  g.fundamentals_fetched_at, g.fundamentals_age_days, g.fundamentals_source, g.price_source, g.hn_fetched_at
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
