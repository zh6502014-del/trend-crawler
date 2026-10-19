const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261018_reliable_publication.sql'), 'utf8');
const usabilityMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261018_usability_profit_margin.sql'), 'utf8');
let db;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;');
  await db.exec(schema);
});
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('reset role; truncate public.entities, public.signals, public.scores, public.price_series, public.publication_batches cascade;');
});
async function stage(tickers, day = '2026-10-13', options = {}) {
  const id = randomUUID();
  await db.query(`insert into public.publication_batches(id,as_of,row_count,metadata,created_at)
    values ($1,$2,$3,$4,$5)`, [id, day, options.expected || tickers.length,
    JSON.stringify({ scoring_version: 'test' }), options.created || new Date().toISOString()]);
  for (const [i, ticker] of tickers.entries()) {
    const entity = { ticker, name: options.name || ticker, updated_at: new Date().toISOString() };
    const signal = { ticker, as_of: day, price: 10, fundamentals_age_days: 1, ...options.signal };
    const score = { ticker, as_of: day, batch_id: id, rank: i + 1, board: options.board || 'main', score: 50, flags: [] };
    await db.query(`insert into public.publication_rows(batch_id,ticker,entity,signal,score)
      values ($1,$2,$3,$4,$5)`, [id, ticker, JSON.stringify(entity), JSON.stringify(signal), JSON.stringify(score)]);
  }
  return id;
}
const publish = (id) => db.query('select public.publish_public_batch($1)', [id]);
const board = async () => (await db.query('select ticker,batch_id from public.latest_board order by ticker')).rows;

test('fresh schema and migration can both be run repeatedly', async () => {
  await db.exec(schema);
  await db.exec(migration);
  await db.exec(usabilityMigration);
  await db.exec(usabilityMigration);
  assert.ok(schema.endsWith(migration), 'fresh schema must contain the exact migration');
});

test('profit margin upgrades existing boards without losing rows or dependent views', async () => {
  const id = await stage(['BANK'], '2026-10-13', { signal: { gross_margin: null, profit_margin: 0.25 } });
  await publish(id);
  // Reproduce the previous view, which did not expose profit_margin.
  await db.exec('drop view public.latest_board');
  const view = migration.slice(migration.indexOf('create or replace view public.latest_board'), migration.indexOf('\ncommit;'));
  await db.exec(view.replace(', g.profit_margin', ''));
  await db.exec('create view public.board_consumer as select ticker from public.latest_board');
  await db.exec(usabilityMigration);
  const result = await db.query('select ticker, gross_margin, profit_margin from public.latest_board');
  assert.equal(result.rows[0].ticker, 'BANK');
  assert.equal(result.rows[0].gross_margin, null);
  assert.equal(Number(result.rows[0].profit_margin), 0.25);
  assert.equal((await db.query('select ticker from public.board_consumer')).rows[0].ticker, 'BANK');
  await db.exec('drop view public.board_consumer');
  await db.exec('set role anon');
  assert.deepEqual(await board(), []);
  await db.exec('set role authenticated');
  assert.equal((await board()).length, 1);
});

test('partial staged upload leaves the previous complete board visible', async () => {
  const old = await stage(['OLD'], '2026-10-12');
  await publish(old);
  const pending = await stage(['NEW'], '2026-10-13', { expected: 2 });
  await assert.rejects(publish(pending), /Incomplete batch/);
  assert.deepEqual(await board(), [{ ticker: 'OLD', batch_id: old }]);
  assert.equal((await db.query('select count(*)::int n from public.signals')).rows[0].n, 1);
});

test('constraint failure rolls back deletes, inserts and entity changes together', async () => {
  const old = await stage(['ABC', 'DEF']);
  await publish(old);
  const broken = await stage(['ABC'], '2026-10-13', { board: 'invalid', name: 'Changed' });
  await assert.rejects(publish(broken), /check constraint/);
  assert.deepEqual(await board(), [{ ticker: 'ABC', batch_id: old }, { ticker: 'DEF', batch_id: old }]);
  assert.equal((await db.query("select name from public.entities where ticker='ABC'")).rows[0].name, 'ABC');
  assert.equal((await db.query('select status from public.publication_batches where id=$1', [broken])).rows[0].status, 'staging');
});

test('same-day rerun replaces the cohort and late RPC retries cannot restore an old batch', async () => {
  const first = await stage(['ABC', 'DEF']); await publish(first);
  const second = await stage(['ABC']); await publish(second);
  await publish(first); await publish(second);
  assert.deepEqual(await board(), [{ ticker: 'ABC', batch_id: second }]);
  assert.equal((await db.query('select count(*)::int n from public.signals')).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from public.publication_rows')).rows[0].n, 0);
});

test('an older concurrent batch cannot replace a newer publication for the same date', async () => {
  const older = await stage(['OLD'], '2026-10-13', { created: '2026-10-18T00:00:00Z' });
  const newer = await stage(['NEW'], '2026-10-13', { created: '2026-10-18T01:00:00Z' });
  await publish(newer);
  await assert.rejects(publish(older), /newer batch/);
  assert.deepEqual(await board(), [{ ticker: 'NEW', batch_id: newer }]);
});

test('private RLS permits signed-in reading but denies staging reads and publication', async () => {
  const id = await stage(['ABC']); await publish(id);
  await db.exec('set role anon');
  assert.deepEqual(await board(), []);
  await assert.rejects(publish(id), /permission denied/);
  await db.exec('set role authenticated');
  assert.equal((await board()).length, 1);
  await assert.rejects(db.query('select * from public.publication_rows'), /permission denied/);
  await assert.rejects(publish(id), /permission denied/);
  await db.exec('set role service_role');
  await publish(id);
});

test('regressed price dates cannot overwrite current entity or price data', async () => {
  const current = await stage(['ABC'], '2026-10-13'); await publish(current);
  const older = await stage(['ABC'], '2026-10-12', { name: 'Old name' });
  await assert.rejects(publish(older), /older than the current/);
  assert.deepEqual(await board(), [{ ticker: 'ABC', batch_id: current }]);
  assert.equal((await db.query("select name from public.entities where ticker='ABC'")).rows[0].name, 'ABC');
});

test('migration preserves legacy history without presenting it as a verified batch', async () => {
  await db.exec("insert into public.entities(ticker) values ('LEGACY'); insert into public.scores(ticker,as_of,board) values ('LEGACY','2026-10-10','main');");
  await db.exec(migration);
  assert.deepEqual(await board(), []);
  assert.equal((await db.query('select count(*)::int n from public.scores')).rows[0].n, 1);
});
