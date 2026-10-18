const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); });

function mocks(options) {
  window.__errors = { ...(options.errors || {}) };
  window.__signedIn = !options.login;
  window.__queries = [];
  window.__chartOrders = [];
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);
  const base = { ticker: 'ABC', name: '<Company>', board: 'main', rank: 1, score: 70,
    batch_id: 'published-one', as_of: day, published_at: stamp, sector: 'Technology', flags: ['stale_fundamentals'],
    fundamentals_age_days: 10, price_source: 'yahoo', hn_mentions: null, scoring_version: '2' };
  window.__rows = [base, { ...base, ticker: 'DEF', name: 'Different', board: 'watch', rank: 1, score: 30 }];
  window.__batchReadCount = 0;
  const tables = {
    latest_board: window.__rows,
    latest_fundraises: [{ accession: 'one', cik: '1', issuer: 'Rocket Lab', deadline: '2099-01-01', filed_at: day }],
    crawl_runs: [{ status: 'partial', finished_at: stamp, stats: {
      public: { status: 'partial', fundamentals: { expired: 2 }, attention: { failed: 2 } },
      formc: { status: 'ok' } } }],
    scores: [{ as_of: '2026-10-12', score: 45 }, { as_of: '2026-10-13', score: 50 }],
    price_series: [],
    tw_latest_board: [{ ticker: '2330', name: '台積電', board: 'tw_main', rank: 1, score: 80, flags: [] }],
    smart_money: [{ ticker: 'ABC', score: 30 }],
    user_watch: [{ ticker: 'ABC', note: '保留自選' }],
  };
  window.__tables = tables;
  class Query {
    constructor(table) { this.table = table; this.orders = []; this.start = 0; this.end = Infinity; }
    select(columns) { this.columns = columns; return this; }
    order(key, options = {}) { this.orders.push([key, options.ascending !== false]); return this; }
    eq() { return this; }
    gt() { return this; }
    range(a, b) { this.start = a; this.end = b + 1; return this; }
    limit(n) { this.end = n; return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve, reject) {
      window.__queries.push(this.table);
      if (window.__errors[this.table]) return Promise.resolve({ data: null, error: { message: 'Simulated source outage' } }).then(resolve, reject);
      let data = [...(tables[this.table] || [])];
      if (this.table === 'latest_board' && options.changingBatch && this.columns === 'batch_id') {
        window.__batchReadCount++;
        if (window.__batchReadCount === 1) {
          window.__rows.forEach(r => { r.batch_id = 'published-two'; });
          data = [{ batch_id: 'published-two' }];
        }
      }
      for (const [key, asc] of [...this.orders].reverse()) data.sort((a, b) => ((a[key] > b[key]) - (a[key] < b[key])) * (asc ? 1 : -1));
      data = data.slice(this.start, this.end).map(r => ({ ...r }));
      if (this.table === 'scores') window.__chartOrders = this.orders;
      return Promise.resolve({ data: this.single ? data[0] || null : data, error: null }).then(resolve, reject);
    }
  }
  window.supabase = { createClient: () => ({ from: table => new Query(table), auth: {
    onAuthStateChange: cb => { window.__authCallback = cb; },
    getSession: async () => ({ data: { session: window.__signedIn ? {} : null } }),
    signInWithOtp: async args => { window.__otpArgs = args; return { error: null }; },
    signOut: async () => ({ error: null }),
  } }) };
  window.Tabulator = class {
    constructor(selector, options) {
      this.element = document.querySelector(selector); this.options = options; this.events = {}; this.active = options.data;
      setTimeout(() => this.events.tableBuilt?.(), 0);
    }
    on(event, cb) { this.events[event] = cb; }
    setFilter(fn) {
      this.active = this.options.data.filter(fn);
      this.element.innerHTML = '';
      for (const row of this.active) {
        const element = document.createElement('button');
        element.textContent = row.ticker || row.issuer;
        element.onclick = () => this.events.rowClick?.({}, { getData: () => row });
        this.element.appendChild(element);
      }
    }
    getDataCount() { return this.active.length; }
    destroy() { this.element.innerHTML = ''; }
    redraw() {} setHeight() {}
  };
  window.Chart = class { destroy() {} };
}

async function open(options = {}, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(mocks, options);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dashboard.test') return route.fulfill({ body: '', contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    let name = url.pathname.slice(1) || 'index.html';
    if (name === 'config.js') return route.fulfill({ contentType: 'text/javascript', body:
      `window.APP_CONFIG={SUPABASE_URL:'https://offline.invalid',SUPABASE_ANON_KEY:'dummy',REQUIRE_LOGIN:${!!options.login}};` });
    const file = path.join(__dirname, '../docs', name);
    await route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('https://dashboard.test/');
  return { page, context, errors };
}

test('login requires a session and email flow disables account creation', async () => {
  const { page, context, errors } = await open({ login: true });
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#app').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__queries), []);
  await page.locator('#login-email').fill('reader@example.test');
  await page.locator('#login-form button').click();
  assert.equal(await page.evaluate(() => window.__otpArgs.options.shouldCreateUser), false);
  await page.evaluate(() => { window.__signedIn = true; window.__authCallback('SIGNED_IN'); });
  await page.locator('#tbl-stock button').waitFor();
  assert.match(await page.locator('#source-status').innerText(), /2 檔過期排除/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('one source outage leaves the stock board usable and retry restores fundraises', async () => {
  const { page, context, errors } = await open({ errors: { latest_fundraises: true } });
  await page.locator('#tbl-stock button').waitFor();
  assert.match(await page.locator('#banner').innerText(), /募資資料載入失敗/);
  await page.evaluate(() => { window.__errors = {}; });
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await page.locator('[data-tab="raise"]').click();
  await page.locator('#tbl-raise button').waitFor();
  assert.equal(await page.locator('#tbl-raise button').innerText(), 'Rocket Lab');
  assert.deepEqual(errors, []);
  await context.close();
});

test('saved filters and tab survive page reload on a narrow screen', async () => {
  const { page, context, errors } = await open({}, 390);
  await page.locator('#tbl-stock button').waitFor();
  await page.locator('[data-tab="watch"]').click();
  await page.locator('#f-q').fill('DEF');
  await page.reload();
  await page.locator('#tbl-stock button').waitFor();
  assert.equal(await page.locator('#f-q').inputValue(), 'DEF');
  assert.equal(await page.locator('[data-tab="watch"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#tbl-stock button').innerText(), 'DEF');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await context.close();
});

test('publication changes trigger a fresh load instead of showing mixed batches', async () => {
  const { page, context, errors } = await open({ changingBatch: true });
  await page.locator('#tbl-stock button').waitFor();
  assert.equal(await page.evaluate(() => window.__batchReadCount), 2);
  await page.locator('#tbl-stock button').click();
  await page.waitForFunction(() => window.__chartOrders.length);
  assert.deepEqual(await page.evaluate(() => window.__chartOrders), [['as_of', false]]);
  assert.equal(await page.locator('#drawer-title').innerText(), 'ABC');
  assert.match(await page.locator('#drawer-body').innerText(), /<Company>/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('reload refreshes Taiwan data and preserves the smart-money and watchlist filters', async () => {
  const { page, context, errors } = await open();
  await page.locator('#tbl-stock button').waitFor();
  await page.locator('#f-smart').check();
  await page.locator('#f-watch').check();
  assert.equal(await page.locator('#tbl-stock button').innerText(), 'ABC');
  await page.locator('[data-market="tw"]').click();
  await page.locator('#tbl-tw button').waitFor();
  assert.equal(await page.locator('#tbl-tw button').innerText(), '2330');
  await page.evaluate(() => { window.__tables.tw_latest_board = [
    { ticker: '2317', name: '鴻海', board: 'tw_main', rank: 1, score: 75, flags: [] }]; });
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await page.locator('#tbl-tw button').waitFor();
  assert.equal(await page.locator('#tbl-tw button').innerText(), '2317');
  assert.deepEqual(errors, []);
  await context.close();
});
