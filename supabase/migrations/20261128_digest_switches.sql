-- Per-market on/off switches for the LINE daily digest (owner changes them from the chat).
alter table public.line_preferences add column if not exists digest_us boolean not null default true;
alter table public.line_preferences add column if not exists digest_tw boolean not null default true;
