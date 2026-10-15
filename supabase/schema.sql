-- 趨勢爬蟲 / Supabase schema
-- Run once in Supabase → SQL Editor. Safe to re-run (idempotent).
--
-- Writes come ONLY from the crawler, using the service_role key (bypasses RLS).
-- The dashboard uses the anon key and can only SELECT, according to the policies at the bottom.

-- ───────────────────────── Tables ─────────────────────────

create table if not exists public.entities (
  ticker      text primary key,
  name        text,
  sector      text,
  industry    text,
  exchange    text,
  updated_at  timestamptz not null default now()
);

-- One row per ticker per trading day. This is the history you will backtest on: never delete it casually.
create table if not exists public.signals (
  ticker         text not null,
  as_of          date not null,
  price          numeric,
  mkt_cap        numeric,
  dollar_vol     numeric,      -- 20-day average dollar volume
  ret_1m         numeric,
  ret_3m         numeric,
  ret_6m         numeric,
  rs_6m          numeric,      -- 6-month return minus SPY's
  dist_high      numeric,      -- distance from 52-week high (<= 0)
  rev_yoy        numeric,
  rev_streak     integer,      -- consecutive quarters of sequential revenue growth
  gross_margin   numeric,
  analyst_count  integer,
  inst_pct       numeric,
  hn_mentions    integer,      -- Hacker News story titles in the last 30 days
  runway_months  numeric,      -- only when free cash flow is negative
  shares_out     numeric,
  primary key (ticker, as_of)
);
create index if not exists signals_asof_idx on public.signals (as_of);

create table if not exists public.scores (
  ticker         text not null,
  as_of          date not null,
  board          text not null check (board in ('main','watch')),
  rank           integer,
  score          numeric,      -- 0-100
  growth         numeric,      -- 0-100 pillar
  validated      numeric,      -- 0-100 pillar
  accessibility  numeric,      -- 0-100 pillar
  attention      numeric,      -- 0-100, HIGH = crowded (lowers the score)
  flags          text[] not null default '{}',
  primary key (ticker, as_of)
);
create index if not exists scores_asof_board_idx on public.scores (as_of, board, rank);

-- Last ~130 closes for the detail chart. Overwritten every run (not a history table).
create table if not exists public.price_series (
  ticker      text primary key,
  updated_at  timestamptz not null default now(),
  series      jsonb not null           -- [["2026-10-14", 12.34], ...]
);

-- Reg CF (Form C) offerings parsed from SEC EDGAR.
create table if not exists public.fundraises (
  accession      text primary key,
  cik            text not null,
  issuer         text,
  form_type      text,
  filed_at       date,
  deadline       date,
  target_amount  numeric,
  max_amount     numeric,
  security_type  text,
  price          numeric,
  revenue        numeric,           -- most recent fiscal year
  revenue_prior  numeric,
  net_income     numeric,
  net_income_prior numeric,
  total_assets   numeric,
  cash           numeric,
  debt           numeric,
  employees      integer,
  website        text,
  portal         text,              -- funding portal / intermediary
  filing_url     text,
  first_seen     timestamptz not null default now()
);
create index if not exists fundraises_filed_idx on public.fundraises (filed_at desc);
create index if not exists fundraises_cik_idx on public.fundraises (cik, filed_at desc);

-- Heartbeat of the crawler. The dashboard reads the newest row to show data freshness.
create table if not exists public.crawl_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','partial','failed')),
  as_of        date,
  stats        jsonb,
  errors       jsonb
);
create index if not exists crawl_runs_started_idx on public.crawl_runs (started_at desc);

-- Crawler-only cache so slow per-ticker calls are refreshed weekly instead of daily. No policies = invisible to the browser.
create table if not exists public.fundamentals_cache (
  ticker      text primary key,
  fetched_at  timestamptz not null default now(),
  data        jsonb not null
);

-- Crawler-only cache of daily closes/volumes (one row per trading day), so each run fetches only the days it is missing.
create table if not exists public.price_days (
  day   date primary key,
  bars  jsonb not null
);

-- ───────────────────────── Views ─────────────────────────

-- Everything the dashboard table needs, for the latest scoring day.
create or replace view public.latest_board with (security_invoker = true) as
select
  s.as_of, s.ticker, e.name, e.sector, e.industry,
  s.board, s.rank, s.score, s.growth, s.validated, s.accessibility, s.attention, s.flags,
  g.price, g.mkt_cap, g.dollar_vol, g.ret_1m, g.ret_3m, g.ret_6m, g.rs_6m, g.dist_high,
  g.rev_yoy, g.rev_streak, g.gross_margin, g.analyst_count, g.inst_pct, g.hn_mentions, g.runway_months,
  prev.score as score_7d,
  prev.rank  as rank_7d
from public.scores s
join public.entities e on e.ticker = s.ticker
left join public.signals g on g.ticker = s.ticker and g.as_of = s.as_of
left join lateral (
  select p.score, p.rank
  from public.scores p
  where p.ticker = s.ticker and p.as_of <= s.as_of - 7
  order by p.as_of desc
  limit 1
) prev on true
where s.as_of = (select max(as_of) from public.scores);

-- Newest filing per issuer.
create or replace view public.latest_fundraises with (security_invoker = true) as
select distinct on (cik) *
from public.fundraises
order by cik, filed_at desc, first_seen desc;

-- ───────────────────────── Row Level Security ─────────────────────────

alter table public.entities           enable row level security;
alter table public.signals            enable row level security;
alter table public.scores             enable row level security;
alter table public.price_series       enable row level security;
alter table public.fundraises         enable row level security;
alter table public.crawl_runs         enable row level security;
alter table public.fundamentals_cache enable row level security;
alter table public.price_days         enable row level security;

-- Start clean so re-running this file never stacks duplicate policies.
do $$
declare t text;
begin
  foreach t in array array['entities','signals','scores','price_series','fundraises','crawl_runs'] loop
    execute format('drop policy if exists read_authenticated on public.%I', t);
    execute format('drop policy if exists read_public on public.%I', t);
  end loop;
end $$;

-- ── OPTION A (default): private. Only signed-in users can read. ──
-- Pair with docs/config.js → REQUIRE_LOGIN: true, and in Supabase → Authentication → turn OFF
-- "Allow new users to sign up", then invite yourself (Authentication → Users → Add user).
do $$
declare t text;
begin
  foreach t in array array['entities','signals','scores','price_series','fundraises','crawl_runs'] loop
    execute format('create policy read_authenticated on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ── OPTION B: public read (anyone with the page URL can read the data). ──
-- To switch: comment out the Option A block, uncomment this one, re-run the whole file, and set REQUIRE_LOGIN: false.
-- Think twice: the numbers are derived from Stooq price data, whose terms are written for personal use.
--
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['entities','signals','scores','price_series','fundraises','crawl_runs'] loop
--     execute format('create policy read_public on public.%I for select to anon, authenticated using (true)', t);
--   end loop;
-- end $$;

-- Explicit grants. Newer Supabase projects may not auto-grant table access to the API roles,
-- so spell it out (harmless where it is already granted). RLS above still decides who sees which rows.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.entities, public.signals, public.scores, public.price_series,
                public.fundraises, public.crawl_runs, public.latest_board, public.latest_fundraises
  to anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── Big-money layer (Form 4 insider trades, 13D/13G holders) ──
create table if not exists public.insider_trades (accession text not null, line int not null, ticker text not null, cik text, filed_at date not null, tx_date date, owner text, title text, is_officer boolean, is_director boolean, is_ten_pct boolean, code text, shares numeric, price numeric, value numeric, primary key (accession, line));
create table if not exists public.holder_filings (accession text primary key, ticker text not null, cik text, filed_at date not null, form_type text, holder text, shares numeric, pct numeric);
create table if not exists public.smart_seen (accession text primary key, filed_at date not null);
create table if not exists public.smart_money (ticker text primary key, as_of date, updated_at timestamptz, score numeric default 0, tags jsonb default '[]'::jsonb, buyers_30d int, buy_value_30d numeric, officer_buyers_30d int, sellers_30d int, sell_value_30d numeric, n_13d_90d int, n_13g_90d int, detail jsonb);
create index if not exists insider_trades_ticker on public.insider_trades (ticker, filed_at desc);
create index if not exists holder_filings_ticker on public.holder_filings (ticker, filed_at desc);
alter table public.insider_trades enable row level security;
alter table public.holder_filings enable row level security;
alter table public.smart_seen enable row level security;
alter table public.smart_money enable row level security;
drop policy if exists read_authenticated on public.insider_trades;
create policy read_authenticated on public.insider_trades for select to authenticated using (true);
drop policy if exists read_authenticated on public.holder_filings;
create policy read_authenticated on public.holder_filings for select to authenticated using (true);
drop policy if exists read_authenticated on public.smart_money;
create policy read_authenticated on public.smart_money for select to authenticated using (true);
grant select on public.insider_trades, public.holder_filings, public.smart_money to authenticated;
grant all on public.insider_trades, public.holder_filings, public.smart_seen, public.smart_money to service_role;

-- ── Report card (how past top-20 lists did vs SPY) ──
create table if not exists public.report_card (as_of date not null, horizon int not null, n int, avg_ret numeric, spy_ret numeric, excess numeric, hit_rate numeric, best text, best_ret numeric, worst text, worst_ret numeric, exit_day date, primary key (as_of, horizon));
alter table public.report_card enable row level security;
drop policy if exists read_authenticated on public.report_card;
create policy read_authenticated on public.report_card for select to authenticated using (true);
grant select on public.report_card to authenticated;
grant all on public.report_card to service_role;

-- ── Personal watchlist + notes (each signed-in user sees only their own rows) ──
create table if not exists public.user_watch (user_id uuid not null default auth.uid(), ticker text not null, note text default '', updated_at timestamptz default now(), primary key (user_id, ticker));
alter table public.user_watch enable row level security;
drop policy if exists own_rows on public.user_watch;
create policy own_rows on public.user_watch for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.user_watch to authenticated;

-- ── Reg CF progress updates (Form C-U) ──
create table if not exists public.fundraise_updates (accession text primary key, cik text not null, form_type text, filed_at date, raised numeric, raw jsonb);
create index if not exists fundraise_updates_cik on public.fundraise_updates (cik, filed_at desc);
alter table public.fundraise_updates enable row level security;
drop policy if exists read_authenticated on public.fundraise_updates;
create policy read_authenticated on public.fundraise_updates for select to authenticated using (true);
grant select on public.fundraise_updates to authenticated;
grant all on public.fundraise_updates to service_role;
