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

-- Delivery state survives webhook redelivery; operations are never executed twice.
-- Legacy claims remain terminal when upgrading an already-running bot.
alter table public.line_events add column if not exists status text not null default 'legacy';
alter table public.line_events add column if not exists attempt uuid;
alter table public.line_events add column if not exists attempts int not null default 0;
alter table public.line_events add column if not exists reply_messages jsonb;
alter table public.line_events add column if not exists error_code text;
alter table public.line_events add column if not exists updated_at timestamptz not null default now();
alter table public.line_deliveries add column if not exists status text not null default 'pending';
alter table public.line_deliveries add column if not exists last_error text;
alter table public.line_deliveries add column if not exists attempted_at timestamptz;
create table if not exists public.line_preferences (
  user_id uuid primary key,
  market text not null default 'us' check (market in ('us','tw')),
  focus_ticker text check (focus_ticker is null or focus_ticker ~ '^([A-Z][A-Z.\-]{0,5}|[0-9]{4,6}[A-Z]?)$'),
  updated_at timestamptz not null default now()
);
alter table public.line_preferences enable row level security;
revoke all on public.line_preferences from anon, authenticated;
grant all on public.line_preferences to service_role;
drop trigger if exists keep_newer_line_preferences on public.line_preferences;
create trigger keep_newer_line_preferences before update on public.line_preferences
  for each row execute function public.keep_newer_line_session();

create or replace function public.begin_line_event(p_event_id text, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r line_events; n int;
begin
  if p_event_id is null or length(p_event_id) = 0 or p_attempt is null then
    raise exception 'invalid event claim';
  end if;
  delete from line_events where created_at < now() - interval '7 days';
  -- Reply payloads can include private notes. Retain only for the short retry window.
  update line_events set reply_messages = null
    where reply_messages is not null and created_at < now() - interval '20 minutes';
  insert into line_events(event_id,status,attempt,attempts) values(p_event_id,'processing',p_attempt,1)
    on conflict do nothing;
  get diagnostics n = row_count;
  if n = 1 then return jsonb_build_object('action','execute'); end if;
  select * into r from line_events where event_id = p_event_id for update;
  if r.status in ('legacy','replied','failed') then return jsonb_build_object('action','done'); end if;
  if r.status in ('processing','replying') and r.updated_at > now() - interval '45 seconds' then
    return jsonb_build_object('action','busy');
  end if;
  if r.attempts >= 3 or r.created_at < now() - interval '20 minutes' then
    update line_events set status='failed',reply_messages=null,error_code=coalesce(error_code,'retry_expired'),updated_at=now()
      where event_id=p_event_id;
    return jsonb_build_object('action','done');
  end if;
  if r.status = 'processing' then
    -- An interrupted write may have committed. Never replay its command.
    r.reply_messages := '[{"type":"text","text":"上次操作中斷，無法確認是否完成。請先查看自選、筆記、提醒清單或我的設定，再決定是否重新操作。輸入「系統狀態」可查異常。"}]'::jsonb;
    r.error_code := 'operation_uncertain';
  end if;
  if r.reply_messages is null then
    update line_events set status='failed',error_code='reply_missing',updated_at=now() where event_id=p_event_id;
    return jsonb_build_object('action','done');
  end if;
  update line_events set status='replying',attempt=p_attempt,attempts=attempts+1,
    reply_messages=r.reply_messages,error_code=r.error_code,updated_at=now() where event_id=p_event_id;
  return jsonb_build_object('action','reply','messages',r.reply_messages);
end $$;

create or replace function public.prepare_line_reply(p_event_id text,p_attempt uuid,p_messages jsonb,p_error text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) > 5 then
    raise exception 'invalid reply';
  end if;
  update line_events set status='replying',reply_messages=p_messages,error_code=p_error,updated_at=now()
    where event_id=p_event_id and attempt=p_attempt and status='processing';
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.finish_line_reply(p_event_id text,p_attempt uuid,p_status text,p_error text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_status not in ('replied','retry','failed') then raise exception 'invalid reply status'; end if;
  update line_events set status=p_status,error_code=coalesce(p_error,error_code),updated_at=now(),
    reply_messages=case when p_status='retry' then reply_messages else null end
    where event_id=p_event_id and attempt=p_attempt and status='replying';
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.begin_line_event(text,uuid),public.prepare_line_reply(text,uuid,jsonb,text),
  public.finish_line_reply(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.begin_line_event(text,uuid),public.prepare_line_reply(text,uuid,jsonb,text),
  public.finish_line_reply(text,uuid,text,text) to service_role;

-- Keep this revision in sync with scripts/apply_line_schema.py after any SQL change.
-- Created last, in the same transaction: only a complete migration publishes it.
create or replace function public.line_schema_version() returns text
language sql stable set search_path = '' as $$ select '2026-10-21.1'::text $$;
revoke all on function public.line_schema_version() from public,anon,authenticated;
grant execute on function public.line_schema_version() to service_role;
commit;
