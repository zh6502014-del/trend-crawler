-- Idempotent migration: apply before deploying the updated LINE function/crawlers.
begin;
create table if not exists public.line_sessions (
  user_id uuid primary key, market text not null default 'us' check (market in ('us','tw')),
  ticker text, page int not null default 1, updated_at timestamptz not null default now()
);
create table if not exists public.line_events (
  event_id text primary key, created_at timestamptz not null default now()
);
create table if not exists public.line_deliveries (
  delivery_key text primary key, retry_key uuid not null, recipient text not null,
  body text not null, alert_ids jsonb not null default '[]',
  sent_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.line_ai_cache (
  cache_key text primary key, status text not null default 'pending', answer text,
  updated_at timestamptz not null default now()
);
create table if not exists public.line_ai_usage (
  day date primary key, calls int not null default 0
);
alter table public.line_sessions enable row level security;
alter table public.line_events enable row level security;
alter table public.line_deliveries enable row level security;
alter table public.line_ai_cache enable row level security;
alter table public.line_ai_usage enable row level security;
revoke all on public.line_sessions, public.line_events, public.line_deliveries,
  public.line_ai_cache, public.line_ai_usage from anon, authenticated;
grant all on public.line_sessions, public.line_events, public.line_deliveries,
  public.line_ai_cache, public.line_ai_usage to service_role;

-- A slow older lookup must not overwrite a more recent menu/stock selection.
create or replace function public.keep_newer_line_session() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.updated_at < old.updated_at then return null; end if;
  return new;
end $$;
drop trigger if exists keep_newer_line_session on public.line_sessions;
create trigger keep_newer_line_session before update on public.line_sessions
  for each row execute function public.keep_newer_line_session();
revoke all on function public.keep_newer_line_session() from public,anon,authenticated;

create or replace function public.claim_line_event(p_event_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_event_id is null or length(p_event_id) = 0 then return false; end if;
  delete from line_events where created_at < now() - interval '7 days';
  insert into line_events(event_id) values(p_event_id) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Freeze message contents AND retry key before the first request. Concurrent runs
-- receive the same row, so retries never produce another copy within LINE's 24h window.
create or replace function public.prepare_line_delivery(
  p_key text, p_recipient text, p_body text, p_alert_ids jsonb
) returns setof public.line_deliveries
language plpgsql security definer set search_path = public as $$
begin
  insert into line_deliveries(delivery_key,retry_key,recipient,body,alert_ids)
    values(p_key,gen_random_uuid(),p_recipient,p_body,p_alert_ids) on conflict do nothing;
  return query select * from line_deliveries where delivery_key = p_key;
end $$;

create or replace function public.claim_line_ai(p_key text,p_limit int) returns text
language plpgsql security definer set search_path = public as $$
declare n int; d date := (now() at time zone 'Asia/Taipei')::date;
begin
  if p_limit is null or p_limit <= 0 then return 'limited'; end if;
  delete from line_ai_cache where updated_at < now() - interval '7 days';
  delete from line_ai_usage where day < d - 7;
  insert into line_ai_cache(cache_key) values(p_key) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return 'existing'; end if;
  insert into line_ai_usage(day,calls) values(d,1)
    on conflict(day) do update set calls = line_ai_usage.calls + 1
    where line_ai_usage.calls < least(greatest(p_limit,0),20);
  get diagnostics n = row_count;
  if n = 0 or p_limit <= 0 then
    delete from line_ai_cache where cache_key = p_key;
    return 'limited';
  end if;
  return 'claimed';
end $$;
revoke all on function public.claim_line_event(text),
  public.prepare_line_delivery(text,text,text,jsonb), public.claim_line_ai(text,int) from public,anon,authenticated;
grant execute on function public.claim_line_event(text),
  public.prepare_line_delivery(text,text,text,jsonb), public.claim_line_ai(text,int) to service_role;

-- Keep this revision in sync with scripts/apply_line_schema.py after any SQL change.
-- Created last, in the same transaction: only a complete migration publishes it.
create or replace function public.line_schema_version() returns text
language sql stable set search_path = '' as $$ select '2026-10-18.1'::text $$;
revoke all on function public.line_schema_version() from public,anon,authenticated;
grant execute on function public.line_schema_version() to service_role;
commit;
