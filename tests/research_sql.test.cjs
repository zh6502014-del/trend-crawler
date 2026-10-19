const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'../supabase',p),'utf8');
let db;
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await db.exec(read('schema.sql'));await db.exec(read('schema_tw.sql'));
});
after(async()=>await db.close());
test('research migration is repeatable and preserves Taiwan board dependencies',async()=>{
  await db.exec('create view public.tw_consumer as select ticker from public.tw_latest_board');
  await db.exec(read('migrations/20261018_research_radar.sql'));
  await db.exec(read('migrations/20261018_research_radar.sql'));
  await db.exec(read('schema_tw.sql'));
  await db.exec(`insert into tw_entities(ticker,name) values ('1234','Example');
    insert into tw_scores(ticker,as_of,board) values ('1234','2026-10-16','tw_main');
    insert into tw_signals(ticker,as_of,rev_3m_yoy,revenue_streak_months,scoring_version)
      values ('1234','2026-10-16',.3,5,'tw-revenue-v3');`);
  const r=(await db.query('select * from tw_latest_board')).rows[0];
  assert.equal(r.revenue_streak_months,5);assert.equal(r.scoring_version,'tw-revenue-v3');
  assert.equal((await db.query('select * from tw_consumer')).rows.length,1);
  await db.exec(`insert into tw_scores(ticker,as_of,board,score,rank) values ('1234','2026-10-01','tw_main',88,1);
    insert into tw_signals(ticker,as_of) values ('1234','2026-10-01');`);
  assert.equal((await db.query('select score_7d from tw_latest_board')).rows[0].score_7d,null);
  await db.exec("update tw_signals set scoring_version='tw-revenue-v3' where as_of='2026-10-01'");
  assert.equal(Number((await db.query('select score_7d from tw_latest_board')).rows[0].score_7d),88);
});
test('private cards isolate users and markets; anon and cache access denied',async()=>{
  const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002';
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${a}';
    insert into research_cards(market,ticker,thesis) values ('us','1234','Private US'),('tw','1234','Private TW');`);
  assert.equal((await db.query('select * from research_cards')).rows.length,2);
  await db.exec(`set request.jwt.claim.sub='${b}'`);
  assert.equal((await db.query('select * from research_cards')).rows.length,0);
  await assert.rejects(db.query("insert into research_cards(user_id,market,ticker) values ($1,'us','OTHER')",[a]),/row-level security/);
  await db.exec("update research_cards set thesis='Overwrite'");
  await db.exec(`set request.jwt.claim.sub='${a}'`);
  assert.equal((await db.query("select thesis from research_cards where market='us'")).rows[0].thesis,'Private US');
  await assert.rejects(db.query('select * from tw_revenue_months'),/permission denied/);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from research_cards'),/permission denied/);
  await db.exec('reset role');
});
