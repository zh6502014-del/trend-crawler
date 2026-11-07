-- Start the crawls on time.
--
-- GitHub's own scheduled runs start hours late (the Taiwan crawl at 15:40 Taipei typically ran around 23:20),
-- so the LINE digests arrived at night. Here Supabase pg_cron asks GitHub to run the workflow
-- (workflow_dispatch) at the intended time. GitHub's schedules stay in the workflows as a backup; every timed
-- run calls crawler/schedule_guard.py, which skips when the work is already done, and the digest's delivery key
-- prevents a second push for the same snapshot.
--
-- Before running this file:
--   1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
--      Repository access: only zh6502014-del/trend-crawler; Permissions → Actions: Read and write. Nothing else.
--   2. Supabase SQL Editor (replace the placeholder; the token is stored encrypted in Vault, never in this file):
--        select vault.create_secret('github_pat_...', 'github_dispatch_token', 'workflow_dispatch for trend-crawler');
--      To rotate later:
--        select vault.update_secret((select id from vault.secrets where name = 'github_dispatch_token'), 'github_pat_new...');
-- Then run this whole file. Safe to re-run.
--
-- pg_cron uses UTC.  Taiwan: 07:45 UTC = 15:45 Taipei, Mon–Fri.
--                    US:     21:35 UTC Mon–Fri = after the US close (16:00 ET is 20:00 UTC in summer, 21:00 in winter).
--
-- Check it works (the next weekday, or call public.dispatch_workflow by hand once):
--   select jobname, schedule, active from cron.job where jobname like 'dispatch-%';
--   select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d
--     join cron.job j using (jobid) where j.jobname like 'dispatch-%' order by d.start_time desc limit 10;
--   select id, status_code, left(content::text, 200) as body, created from net._http_response order by created desc limit 5;
--   -- status_code 204 = GitHub accepted the run; 401/403 = token missing, wrong or without Actions write; 404 = repo/workflow name.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.dispatch_workflow(workflow text, inputs jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token text;
  request_id bigint;
begin
  -- Only these two workflows can be started from here.
  if workflow not in ('tw-crawl.yml', 'daily.yml') then
    raise exception 'workflow % is not allowed', workflow;
  end if;
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if token is null or token = '' then
    raise exception 'Vault secret github_dispatch_token is missing; see the top of 20261107_cron_dispatch.sql';
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/zh6502014-del/trend-crawler/actions/workflows/' || workflow || '/dispatches',
    body := jsonb_build_object('ref', 'main', 'inputs', coalesce(inputs, '{}'::jsonb)),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'trend-crawler-pg-cron',
      'Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  ) into request_id;
  return request_id;
end;
$$;

-- Not callable through the public API: only the database owner (and so pg_cron) runs it.
revoke all on function public.dispatch_workflow(text, jsonb) from public;
revoke all on function public.dispatch_workflow(text, jsonb) from anon, authenticated, service_role;

-- cron.schedule with an existing job name replaces that job, so re-running this file is safe.
-- workflow_dispatch inputs are sent as strings; GitHub reads "true" as a boolean input.
select cron.schedule('dispatch-tw-crawl', '45 7 * * 1-5',
  $job$select public.dispatch_workflow('tw-crawl.yml', '{"from_cron": "true"}'::jsonb)$job$);
select cron.schedule('dispatch-us-crawl', '35 21 * * 1-5',
  $job$select public.dispatch_workflow('daily.yml', '{"from_cron": "true"}'::jsonb)$job$);

-- To pause:   select cron.unschedule('dispatch-tw-crawl'); select cron.unschedule('dispatch-us-crawl');
