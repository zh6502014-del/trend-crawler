const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');

test('first-publication cutover keeps legacy data labeled and isolated, then selects only a complete batch', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;');
    const read = p => fs.readFileSync(path.join(__dirname, '../supabase', p), 'utf8');
    await db.exec(read('schema.sql'));
    await db.exec("insert into entities(ticker) values ('LEGACY'); insert into scores(ticker,as_of,board) values ('LEGACY','2026-10-15','main');");
    await db.exec(read('migrations/20261019_first_publication_cutover.sql'));
    await db.exec(read('migrations/20261019_first_publication_cutover.sql'));
    const board = async () => (await db.query('select ticker,scoring_version,batch_id from latest_board')).rows;
    await db.exec('set role anon');
    assert.deepEqual(await board(), []);
    await db.exec('set role authenticated');
    assert.deepEqual(await board(), [{ticker:'LEGACY',scoring_version:'legacy-unverified',batch_id:null}]);
    await db.exec('reset role');
    const id = '00000000-0000-0000-0000-000000000003';
    await db.query("insert into publication_batches(id,as_of,row_count,metadata) values ($1,'2026-10-16',1,'{\"scoring_version\":\"new-version\"}')", [id]);
    await assert.rejects(db.query('select publish_public_batch($1)', [id]), /Incomplete batch/);
    assert.equal((await board())[0].ticker, 'LEGACY');
    await db.query('insert into publication_rows(batch_id,ticker,entity,signal,score) values ($1,$2,$3,$4,$5)', [id,'NEW',
      JSON.stringify({ticker:'NEW',updated_at:'2026-10-19T00:00:00Z'}), JSON.stringify({ticker:'NEW',as_of:'2026-10-16'}),
      JSON.stringify({ticker:'NEW',as_of:'2026-10-16',board:'main',rank:1,batch_id:id,flags:[]})]);
    await db.query('select publish_public_batch($1)', [id]);
    assert.deepEqual(await board(), [{ticker:'NEW',scoring_version:'new-version',batch_id:id}]);
    // A later unverified writer cannot displace an already certified cohort.
    await db.exec("insert into scores(ticker,as_of,board) values ('LEGACY','2026-10-19','main'); set role authenticated;");
    assert.deepEqual(await board(), [{ticker:'NEW',scoring_version:'new-version',batch_id:id}]);
    await db.exec('set role anon');
    assert.deepEqual(await board(), []);
  } finally { await db.close(); }
});
