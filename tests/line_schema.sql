-- Run after schema_line.sql on an isolated test database only.
begin;
do $$
declare a line_deliveries; b line_deliveries; n int;
begin
  assert claim_line_event('event-1') = true;
  assert claim_line_event('event-1') = false;
  assert claim_line_event('') = false;
  select * into a from prepare_line_delivery('test-1','U1','original','[1,2]');
  select * into b from prepare_line_delivery('test-1','U1','changed','[3]');
  assert a.retry_key = b.retry_key;
  assert b.body = 'original' and b.alert_ids = '[1,2]'::jsonb;
  assert claim_line_ai('zero',0) = 'limited';
  assert claim_line_ai('null',null) = 'limited';
  assert claim_line_ai('first',2) = 'claimed';
  assert claim_line_ai('first',2) = 'existing';
  assert claim_line_ai('second',2) = 'claimed';
  assert claim_line_ai('third',2) = 'limited';
  select calls into n from line_ai_usage where day = (now() at time zone 'Asia/Taipei')::date;
  assert n = 2;
  assert not exists (select 1 from line_ai_cache where cache_key = 'third');
  assert not has_function_privilege('anon','claim_line_ai(text,integer)','execute');
  assert not has_table_privilege('authenticated','line_sessions','select');
  assert has_function_privilege('service_role','claim_line_event(text)','execute');
  insert into line_sessions(user_id,market,updated_at) values('00000000-0000-0000-0000-000000000001','tw',now());
  update line_sessions set market='us', updated_at=now()-interval '1 minute';
  assert (select market from line_sessions where user_id='00000000-0000-0000-0000-000000000001') = 'tw';
end $$;
rollback;
