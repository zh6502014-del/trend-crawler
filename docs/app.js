/* 趨勢爬蟲 dashboard. Plain JS, no build step.
   Libraries (all MIT): supabase-js, Tabulator, Chart.js. Everything from the database goes through esc()
   before it touches innerHTML, because company names come from third-party sources. */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── formatting ──────────────────────────────────────────────────────────
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nf = (v, d = 0) => (isNum(v) ? v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const compact = (v) => {
    if (!isNum(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toFixed(0);
  };
  const usd = (v) => (isNum(v) ? (v < 0 ? '−$' : '$') + compact(Math.abs(v)) : '—');
  const pct = (v, d = 0) => (isNum(v) ? (v * 100).toFixed(d) + '%' : '—');
  const spct = (v, d = 0) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d) + '%' : '—');
  const tone = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? 'up' : 'down');
  const clamp = (v) => Math.max(0, Math.min(100, isNum(v) ? v : 0));
  const safeUrl = (u) => {
    if (!u) return null;
    try {
      const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
    } catch { return null; }
  };
  const daysSince = (isoDate) => Math.floor((Date.now() - new Date(isoDate + 'T00:00:00Z').getTime()) / 86400000);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const daysUntil = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayStr() + 'T00:00:00Z')) / 86400000);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: views just won't persist */ } },
  };

  const FLAGS = {
    short_runway: { label: '現金跑道短', tone: 'bad', help: '最近一季淨利為負，若虧損持續，以現有現金估計撐不到一年。' },
    deep_loss: { label: '虧損深', tone: 'bad', help: '淨利率遠低於零，每賺一塊錢營收就虧很多。' },
    high_debt: { label: '負債高', tone: 'warn', help: '負債權益比偏高，景氣或利率變差時更脆弱。' },
    dilution: { label: '股本稀釋', tone: 'warn', help: '流通股數比約半年前增加不少，既有股東的比例被攤薄。' },
    thin_volume: { label: '成交薄', tone: 'warn', help: '日均成交額偏低，小額也可能買貴、賣不掉。' },
    micro_cap: { label: '市值極小', tone: 'warn', help: '市值很小，價格波動與資訊落差都會放大。' },
    crowded: { label: '已擁擠', tone: '', help: 'Hacker News 提及與成交額都偏高，已經有不少人注意到，資訊落差變小。' },
    data_thin: { label: '資料不足', tone: '', help: '季度財報不足四季或缺毛利率（金融業看淨利率），這個分數可信度較低。' },
  };
  const RISK = new Set(['short_runway', 'deep_loss', 'high_debt', 'dilution']);

  const state = {
    sb: null, started: false, rows: [], raises: [], run: null,
    watch: new Map(), tab: 'main', q: '', sector: '', minScore: 0, hideRisk: false, rq: '', ropen: true,
    maxCap: 0, minStreak: 0, onlyNew: false, smartOnly: false, watchOnly: false, portal: '', soon: false, view: 'all', saved: [],
    stockTable: null, raiseTable: null, stockReady: false, raiseReady: false,
    charts: [], current: null, lastFocus: null,
  };

  // ── small UI helpers ────────────────────────────────────────────────────
  function showNotice(html) {
    const n = $('#notice');
    n.innerHTML = html;
    n.hidden = false;
  }
  const hideNotice = () => { $('#notice').hidden = true; };

  function explain(e) {
    const m = String(e?.message || e);
    if (/relation .* does not exist|schema cache|Could not find the table/i.test(m)) return '資料表還不存在。先到 Supabase 的 SQL Editor 執行 supabase/schema.sql。';
    if (/permission denied|row-level security|42501/i.test(m)) return '沒有讀取權限。確認已執行 schema.sql；私有模式下也要先登入。';
    if (/Invalid API key|JWT/i.test(m)) return 'API key 不正確。確認 config.js 放的是 anon key，不是 service_role key。';
    if (/Failed to fetch|NetworkError/i.test(m)) return '連不上 Supabase。確認 config.js 的 SUPABASE_URL，以及網路連線。';
    return '';
  }

  function showError(e, title = '讀不到資料') {
    const hint = explain(e);
    showNotice(`<h2>${esc(title)}</h2>${hint ? `<p>${esc(hint)}</p>` : ''}<pre>${esc(e?.message || e)}</pre>`);
  }

  // ── boot & auth ─────────────────────────────────────────────────────────
  function boot() {
    const ready = window.supabase && window.Tabulator && window.Chart;
    if (!ready) { showNotice('<h2>程式庫載入失敗</h2><p>無法從 CDN 載入 Supabase、Tabulator 或 Chart.js。請檢查網路，或是否被廣告攔截器擋下。</p>'); return; }
    if (!CFG.SUPABASE_URL || /YOUR-PROJECT/.test(CFG.SUPABASE_URL) || !CFG.SUPABASE_ANON_KEY || /YOUR-ANON/.test(CFG.SUPABASE_ANON_KEY)) {
      showNotice('<h2>還沒設定連線</h2><p>打開 <b>docs/config.js</b>，填入 Supabase 的 Project URL 與 anon key（Project Settings → API）。</p>');
      return;
    }
    state.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

    $('#signout').addEventListener('click', async () => { await state.sb.auth.signOut(); location.reload(); });
    $('#login-form').addEventListener('submit', onLogin);

    if (!CFG.REQUIRE_LOGIN) return start();

    state.sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_IN') start(); });
    state.sb.auth.getSession().then(({ data }) => {
      if (data.session) start(); else $('#login').hidden = false;
    });
  }

  async function onLogin(ev) {
    ev.preventDefault();
    const email = $('#login-email').value.trim();
    const msg = $('#login-msg');
    msg.textContent = '寄送中…';
    const { error } = await state.sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    msg.textContent = error
      ? '寄送失敗：' + error.message + '（這個 Email 需要先在 Supabase 的 Authentication → Users 建立。）'
      : '已寄出。到信箱點開連結就會回到這個頁面。';
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function pageAll(make) {
    const size = 1000;
    const out = [];
    for (let from = 0; ; from += size) {
      const { data, error } = await make(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) return out;
    }
  }

  async function start() {
    if (state.started) return;
    state.started = true;
    $('#login').hidden = true;
    hideNotice();
    if (CFG.REQUIRE_LOGIN) $('#signout').hidden = false;
    $('#app').hidden = false;
    $('#tbl-stock').innerHTML = '<p class="muted" style="padding:28px">載入中…</p>';

    try {
      const sb = state.sb;
      const [rows, raises, runRes] = await Promise.all([
        pageAll((a, b) => sb.from('latest_board').select('*').order('rank').range(a, b)),
        pageAll((a, b) => sb.from('latest_fundraises').select('*').order('filed_at', { ascending: false }).range(a, b)),
        sb.from('crawl_runs').select('status,started_at,finished_at,as_of,errors').order('started_at', { ascending: false }).limit(1),
      ]);
      state.rows = rows;
      try {
        const sm = await pageAll((a, b) => sb.from('smart_money').select('*').gt('score', 0).range(a, b));
        const by = new Map(sm.map((x) => [x.ticker, x]));
        rows.forEach((r) => { r.smart = by.get(r.ticker) || null; r.smart_score = r.smart ? r.smart.score : 0; });
      } catch (e) { rows.forEach((r) => { r.smart = null; r.smart_score = 0; }); }
      try {
        const w = await pageAll((a, b) => sb.from('user_watch').select('ticker,note').range(a, b));
        state.watch = new Map(w.map((x) => [x.ticker, x.note || '']));
      } catch (e) { state.watch = new Map(); }
      state.raises = raises;
      try {
        state.tw = await pageAll((a, b) => sb.from('tw_latest_board').select('*').order('rank').range(a, b));
      } catch (e) { state.tw = []; }
      state.run = runRes.data?.[0] || null;
    } catch (e) {
      state.started = false;
      $('#app').hidden = true;
      showError(e);
      return;
    }

    renderStatus();
    renderQuality();
    fillSectors();
    fillPortals();
    wireControls();
    renderViews();
    buildStockTable();
    setTab('main');
  }

  function renderStatus() {
    const pill = $('#status');
    const banner = $('#banner');
    const asOf = state.rows[0]?.as_of;
    const run = state.run;
    const msgs = [];
    let level = '';

    if (!asOf) {
      msgs.push('還沒有分數資料。到 GitHub 的 Actions 頁籤，選 daily-crawl，按 Run workflow，勾選 full_refresh，第一次大約需要 15 到 40 分鐘。');
      level = 'warn';
    } else {
      const age = daysSince(asOf);
      const rel = run?.finished_at ? new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' }).format(-Math.round((Date.now() - new Date(run.finished_at)) / 3600000), 'hour') : '';
      $('#status-text').textContent = `資料日期 ${asOf}${rel ? '，' + rel + '更新' : ''}`;
      const stale = age > (CFG.STALE_AFTER_DAYS ?? 4);
      pill.className = 'pill' + (stale ? (age > 2 * (CFG.STALE_AFTER_DAYS ?? 4) ? ' bad' : ' warn') : '');
      pill.hidden = false;
      if (stale) { msgs.push(`資料已經 ${age} 天沒有更新。到 GitHub 的 Actions 頁籤看 daily-crawl 有沒有失敗。`); level = age > 2 * (CFG.STALE_AFTER_DAYS ?? 4) ? 'bad' : 'warn'; }
    }
    if (run && (run.status === 'partial' || run.status === 'failed')) {
      const errs = run.errors ? Object.entries(run.errors).map(([k, v]) => `${k}：${v}`).join('；') : '';
      msgs.push(`最近一次執行${run.status === 'failed' ? '失敗' : '只有部分成功'}。${errs}`);
      level = run.status === 'failed' ? 'bad' : level || 'warn';
    }
    if (msgs.length) {
      banner.className = 'banner' + (level === 'bad' ? ' bad' : '');
      banner.innerHTML = msgs.map(esc).join('<br>');
      banner.hidden = false;
    } else banner.hidden = true;
  }

  function renderQuality() {
    const rows = state.rows;
    const n = rows.length;
    if (!n) return;
    const noGm = rows.filter((r) => !isNum(r.gross_margin)).length;
    const thin = rows.filter((r) => (r.flags || []).includes('data_thin')).length;
    $('#quality').textContent = `共評分 ${nf(n)} 檔；${nf(noGm)} 檔（${Math.round((noGm / n) * 100)}%）沒有毛利率資料，${nf(thin)} 檔被標為資料不足，這些分數可信度較低。擁擠度目前只含 Hacker News 與成交額，沒有分析師與法人資料。`;
  }

  function fillPortals() {
    const sel = $('#r-portal');
    const portals = [...new Set(state.raises.map((r) => r.portal).filter(Boolean))].sort();
    sel.insertAdjacentHTML('beforeend', portals.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join(''));
  }

  // ── quick views (built-in + saved in this browser) ──────────────────────
  const BASE = { q: '', sector: '', minScore: 0, hideRisk: false, maxCap: 0, minStreak: 0, onlyNew: false, smartOnly: false, watchOnly: false };
  const PRESETS = [
    { id: 'all', label: '全部', f: {} },
    { id: 'streak', label: '連續 3 季以上成長', f: { minStreak: 3 } },
    { id: 'small', label: '小型且低風險', f: { maxCap: 5e8, hideRisk: true } },
    { id: 'new', label: '近 7 天新進榜', f: { onlyNew: true } },
    { id: 'smart', label: '大戶進場', f: { smartOnly: true } },
  ];

  function applyView(id, f) {
    Object.assign(state, BASE, f);
    state.view = id;
    $('#f-q').value = state.q;
    $('#f-sector').value = state.sector;
    $('#f-min').value = state.minScore;
    $('#f-min-out').textContent = state.minScore;
    $('#f-risk').checked = state.hideRisk;
    $('#f-smart').checked = state.smartOnly;
    $('#f-watch').checked = state.watchOnly;
    renderViews();
    applyFilters();
  }

  function renderViews() {
    const box = $('#views');
    state.saved = store.get('tc_views') || [];
    const hasHistory = state.rows.some((r) => isNum(r.score_7d));
    const presets = PRESETS.filter((p) => p.id !== 'new' || hasHistory);
    const btn = (id, label, extra = '') => `<button type="button" class="vbtn" data-view="${esc(id)}" aria-pressed="${state.view === id}">${esc(label)}</button>${extra}`;
    const extras = [];
    if (state.maxCap) extras.push('市值低於 $' + compact(state.maxCap));
    if (state.minStreak) extras.push('連續季增至少 ' + state.minStreak + ' 季');
    box.innerHTML =
      presets.map((p) => btn(p.id, p.label)).join('') +
      state.saved.map((v, i) => btn('s' + i, v.label, `<button type="button" class="vdel" data-del="${i}" aria-label="刪除視圖 ${esc(v.label)}">✕</button>`)).join('') +
      '<input id="view-name" type="text" maxlength="20" placeholder="視圖名稱" aria-label="視圖名稱"><button type="button" class="vbtn" id="view-save">儲存目前條件</button>' +
      (extras.length ? `<span class="vnote">額外條件：${esc(extras.join('、'))}</span>` : '');
  }

  function wireViews() {
    $('#views').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.view) {
        const id = t.dataset.view;
        const p = PRESETS.find((x) => x.id === id);
        const s = id[0] === 's' ? state.saved[+id.slice(1)] : null;
        if (p) applyView(id, p.f); else if (s) applyView(id, s.f);
      } else if (t.dataset.del !== undefined) {
        const list = store.get('tc_views') || [];
        list.splice(+t.dataset.del, 1);
        store.set('tc_views', list);
        state.view = 'all';
        renderViews();
      } else if (t.id === 'view-save') {
        const name = $('#view-name').value.trim();
        if (!name) { $('#view-name').focus(); return; }
        const list = store.get('tc_views') || [];
        list.push({ label: name, f: { q: state.q, sector: state.sector, minScore: state.minScore, hideRisk: state.hideRisk, maxCap: state.maxCap, minStreak: state.minStreak, onlyNew: state.onlyNew, smartOnly: state.smartOnly, watchOnly: state.watchOnly } });
        store.set('tc_views', list.slice(-8));
        state.view = 's' + (Math.min(list.length, 8) - 1);
        renderViews();
      }
    });
  }

  function fillSectors() {
    const sel = $('#f-sector');
    const sectors = [...new Set(state.rows.map((r) => r.sector).filter(Boolean))].sort();
    if (!sectors.length) sel.hidden = true;  // SEC data has no sector: hide an empty filter
    sel.insertAdjacentHTML('beforeend', sectors.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join(''));
  }

  // ── controls ────────────────────────────────────────────────────────────
  function wireControls() {
    const tabs = $$('#tabs-us button');
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); setTab(next.dataset.tab);
      });
    });
    $$('#market button').forEach((b) => b.addEventListener('click', () => setMarket(b.dataset.market)));
    wireViews();
    $('#r-portal').addEventListener('change', (e) => { state.portal = e.target.value; applyFilters(); });
    $('#r-soon').addEventListener('change', (e) => { state.soon = e.target.checked; applyFilters(); });
    $('#f-q').addEventListener('input', (e) => { state.q = e.target.value; applyFilters(); });
    $('#f-sector').addEventListener('change', (e) => { state.sector = e.target.value; applyFilters(); });
    $('#f-min').addEventListener('input', (e) => { state.minScore = +e.target.value; $('#f-min-out').textContent = e.target.value; applyFilters(); });
    $('#f-risk').addEventListener('change', (e) => { state.hideRisk = e.target.checked; applyFilters(); });
    $('#f-smart').addEventListener('change', (e) => { state.smartOnly = e.target.checked; applyFilters(); });
    $('#f-watch').addEventListener('change', (e) => { state.watchOnly = e.target.checked; applyFilters(); });
    $('#r-q').addEventListener('input', (e) => { state.rq = e.target.value; applyFilters(); });
    $('#r-open').addEventListener('change', (e) => { state.ropen = e.target.checked; applyFilters(); });

    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => {
      const h = tableHeight();
      if (state.stockReady) state.stockTable.setHeight(h);
      if (state.raiseReady) state.raiseTable.setHeight(h);
    });
  }

  function setMarket(m) {
    state.market = m;
    $$('#market button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.market === m)));
    $('#tabs-us').hidden = m === 'tw';
    if (m === 'tw') { if (state.tab !== 'tw') state.lastUs = state.tab; setTab('tw'); } else setTab(state.lastUs || 'main');
  }

  function setTab(tab) {
    state.tab = tab;
    $$('#tabs-us button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const rep = tab === 'report' || tab === 'heat';
    const raise = tab === 'raise';
    const tw = tab === 'tw';
    $('#report').hidden = tab !== 'report';
    $('#heat').hidden = tab !== 'heat';
    $('.board').hidden = rep;
    $('#count').hidden = rep;
    if (rep) {
      ['#filters-stock', '#filters-raise', '#views', '#quality', '#legend-stock', '#legend-raise', '#legend-tw', '#tbl-tw'].forEach((q) => { $(q).hidden = true; });
      if (tab === 'report') loadReport(); else renderHeat();
      return;
    }
    $('#tbl-tw').hidden = !tw;
    $('#legend-tw').hidden = !tw;
    if (tw) {
      ['#tbl-stock', '#tbl-raise', '#filters-stock', '#filters-raise', '#views', '#quality', '#legend-stock', '#legend-raise'].forEach((q) => { $(q).hidden = true; });
      $('#count').hidden = false;
      buildTwTable();
      return;
    }
    $('#tbl-stock').hidden = raise;
    $('#tbl-raise').hidden = !raise;
    $('#filters-stock').hidden = raise;
    $('#filters-raise').hidden = !raise;
    $('#views').hidden = raise;
    $('#quality').hidden = raise;
    $('#legend-stock').hidden = raise;
    $('#legend-raise').hidden = !raise;
    $('#count').hidden = false;
    // Tabulator builds asynchronously: only touch a table once its 'tableBuilt' event has fired.
    if (raise) { buildRaiseTable(); if (state.raiseReady) state.raiseTable.redraw(true); }
    else if (state.stockReady) state.stockTable.redraw(true);
    applyFilters();
  }

  // ── pillar heatmap ──────────────────────────────────────────────────────
  function renderHeat() {
    const top = state.rows.filter((r) => r.board === 'main').sort((a, b) => a.rank - b.rank).slice(0, 40);
    const cols = [['growth', '成長'], ['validated', '驗證'], ['accessibility', '進場'], ['cool', '冷門度'], ['smart_score', '大戶']];
    const val = (d, k) => (k === 'cool' ? (isNum(d.attention) ? 100 - d.attention : null) : d[k]);
    const cell = (v) => (isNum(v)
      ? `<td style="background:color-mix(in srgb, var(--valid) ${Math.round(clamp(v) * 0.85)}%, transparent)">${Math.round(v)}</td>`
      : '<td class="muted">—</td>');
    const rows = top.map((d) => `<tr data-t="${esc(d.ticker)}" tabindex="0"><th>${nf(d.rank)}</th><th class="l"><b>${esc(d.ticker)}</b> <span class="muted">${esc((d.name || '').slice(0, 22))}</span></th>${cols.map(([k]) => cell(val(d, k))).join('')}<td><b>${nf(d.score, 1)}</b></td></tr>`).join('');
    $('#heat-body').innerHTML = `<h3>前 40 名的四個面向</h3><p class="muted">顏色越深，這一項越強。「冷門度」是擁擠的反面，越高代表越少人注意。點任一列看詳情。</p>
      <div class="heat-scroll"><table class="heat"><thead><tr><th>#</th><th class="l">股票</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}<th>總分</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $$('#heat-body tbody tr').forEach((tr) => {
      const open = () => { const d = state.rows.find((r) => r.ticker === tr.dataset.t); if (d) openStock(d); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  // ── report card ─────────────────────────────────────────────────────────
  const pct1 = (v) => (isNum(v) ? (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%' : '—');
  async function loadReport() {
    const box = $('#report-body');
    if (state.reportLoaded) return;
    let rows = [];
    try {
      rows = await pageAll((a, b) => state.sb.from('report_card').select('*').order('as_of', { ascending: false }).range(a, b));
    } catch (e) { rows = null; }
    state.reportLoaded = true;
    if (rows === null) { box.innerHTML = '<p class="muted">成績單的資料表還不存在，請先在 Supabase 執行最新的 schema.sql。</p>'; return; }
    if (!rows.length) {
      box.innerHTML = '<h3>歷史成績單</h3><p class="muted">還在累積中。每天收盤後記錄主榜前 20 名，滿 5 個與 20 個交易日後，這裡會顯示它們的平均報酬、對比 SPY 的超額報酬，以及打敗 SPY 的比例。第一筆大約要等一週。</p>';
      return;
    }
    const cards = [5, 20].map((hz) => {
      const r = rows.filter((x) => x.horizon === hz);
      if (!r.length) return `<div class="rc-card"><h4>${hz} 個交易日後</h4><p class="muted">尚無足夠資料</p></div>`;
      const avg = (k) => r.reduce((s, x) => s + Number(x[k]), 0) / r.length;
      const win = r.filter((x) => Number(x.excess) > 0).length / r.length;
      return `<div class="rc-card"><h4>${hz} 個交易日後</h4>
        <div class="rc-big ${avg('excess') >= 0 ? 'up' : 'down'}">${pct1(avg('excess'))}</div>
        <div class="muted">平均超額報酬（對比 SPY）</div>
        <ul><li>平均報酬 ${pct1(avg('avg_ret'))}，SPY ${pct1(avg('spy_ret'))}</li>
        ${r.some((x) => x.edge_board != null) ? `<li>對比整個主榜平均（等於隨機選股）：${pct1(r.filter((x) => x.edge_board != null).reduce((a, x) => a + Number(x.edge_board), 0) / r.filter((x) => x.edge_board != null).length)}</li>` : ''}
        ${r.some((x) => x.top10_ret != null) ? `<li>前 10 名平均報酬 ${pct1(r.filter((x) => x.top10_ret != null).reduce((a, x) => a + Number(x.top10_ret), 0) / r.filter((x) => x.top10_ret != null).length)}</li>` : ''}
        <li>${r.length} 份榜單中，${Math.round(win * 100)}% 贏過 SPY</li>
        <li>平均每份榜單有 ${Math.round(avg('hit_rate') * 100)}% 的股票贏過 SPY</li></ul></div>`;
    }).join('');
    const recent = rows.filter((x) => x.horizon === 20).concat(rows.filter((x) => x.horizon === 5)).slice(0, 40);
    const tr = recent.map((x) => `<tr><td>${esc(x.as_of)}</td><td>${x.horizon} 日</td><td>${pct1(Number(x.avg_ret))}</td><td>${pct1(Number(x.spy_ret))}</td><td class="${Number(x.excess) >= 0 ? 'up' : 'down'}">${pct1(Number(x.excess))}</td><td>${Math.round(Number(x.hit_rate) * 100)}%</td><td>${esc(x.best)} ${pct1(Number(x.best_ret))}<br><span class="muted">${esc(x.worst)} ${pct1(Number(x.worst_ret))}</span></td></tr>`).join('');
    box.innerHTML = `<h3>歷史成績單</h3><p class="muted">每天主榜前 20 名在之後的表現。這是即時紀錄，不是回測：榜單當天就存下，之後不改。樣本少時請別當成結論。</p>
      <div class="rc-grid">${cards}</div>
      <div class="chart-wrap"><canvas id="rc-chart" height="160"></canvas></div>
      <table class="mini"><thead><tr><th>榜單日</th><th>期間</th><th>平均報酬</th><th>SPY</th><th>超額</th><th>勝率</th><th>最佳 / 最差</th></tr></thead><tbody>${tr}</tbody></table>`;
    const r20 = rows.filter((x) => x.horizon === 20).slice().reverse();
    const use = r20.length >= 3 ? r20 : rows.filter((x) => x.horizon === 5).slice().reverse();
    if (state.repChart) state.repChart.destroy();
    state.repChart = new Chart($('#rc-chart'), {
      type: 'bar',
      data: { labels: use.map((x) => x.as_of.slice(5)), datasets: [{ label: `超額報酬（${use === r20 ? 20 : 5} 日）`, data: use.map((x) => Number(x.excess) * 100), backgroundColor: use.map((x) => (Number(x.excess) >= 0 ? 'rgba(52,168,120,.75)' : 'rgba(214,84,84,.75)')) }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => v + '%' } } } },
    });
  }

  const tableHeight = () => Math.max(480, window.innerHeight - 290);

  function applyFilters() {
    if (state.tab === 'raise') {
      if (!state.raiseReady) return;
      const q = state.rq.trim().toLowerCase();
      const today = todayStr();
      state.raiseTable.setFilter((d) =>
        (!q || (d.issuer || '').toLowerCase().includes(q) || (d.portal || '').toLowerCase().includes(q)) &&
        (!state.portal || d.portal === state.portal) &&
        (!state.ropen || (d.deadline && d.deadline >= today)) &&
        (!state.soon || (d.deadline && d.deadline >= today && daysUntil(d.deadline) <= 14)));
      $('#count').textContent = `顯示 ${state.raiseTable.getDataCount('active')} 筆，共 ${state.raises.length} 筆`;
      return;
    }
    if (!state.stockReady) return;
    const q = state.q.trim().toLowerCase();
    state.stockTable.setFilter((d) =>
      d.board === state.tab &&
      (!q || d.ticker.toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q)) &&
      (!state.sector || d.sector === state.sector) &&
      (d.score ?? 0) >= state.minScore &&
      (!state.hideRisk || !(d.flags || []).some((f) => RISK.has(f))) &&
      (!state.maxCap || (isNum(d.mkt_cap) && d.mkt_cap <= state.maxCap)) &&
      (!state.minStreak || (d.rev_streak ?? 0) >= state.minStreak) &&
      (!state.onlyNew || (isNum(d.rank_7d) === false && isNum(d.score_7d) === false)) &&
      (!state.smartOnly || d.smart_score > 0) &&
      (!state.watchOnly || state.watch.has(d.ticker)));
    const total = state.rows.filter((r) => r.board === state.tab).length;
    $('#count').textContent = `顯示 ${state.stockTable.getDataCount('active')} 檔，共 ${total} 檔`;
  }

  // ── big-money signals ───────────────────────────────────────────────────
  const SMART = {
    insider_cluster: { label: '內部人群買', tone: 'ok', help: '近 30 天有兩位以上的高層或董事在公開市場買進自家股票。' },
    insider_buy: { label: '內部人買進', tone: 'ok', help: '近 30 天有內部人在公開市場買進，金額不小。' },
    activist_13d: { label: '13D 積極持有', tone: 'warn', help: '近 90 天有人申報 Schedule 13D：持股超過 5%，而且可能想影響公司決策。' },
    new_5pct: { label: '新增 5% 持有人', tone: 'ok', help: '近 90 天有人申報 Schedule 13G：被動持股超過 5%。' },
  };
  const smartChips = (d) => {
    const t = (d.smart?.tags || []).filter((x) => SMART[x]);
    return t.length ? `<div class="chips">${t.map((x) => `<span class="chip ${SMART[x].tone}" title="${esc(SMART[x].help)}">${esc(SMART[x].label)}</span>`).join('')}</div>` : '<span class="muted">—</span>';
  };

  // ── stock table ─────────────────────────────────────────────────────────
  function glyph(d) {
    const vals = [d.growth, d.validated, d.accessibility, d.attention];
    const names = ['成長', '驗證', '進場', '擁擠'];
    const bars = vals.map((v, i) => {
      const h = Math.max(2, Math.round((clamp(v) / 100) * 28));
      return `<rect class="bar g${i}" x="${i * 8}" y="${30 - h}" width="5" height="${h}" rx="1.5"/>`;
    }).join('');
    const label = names.map((n, i) => `${n} ${nf(vals[i], 0)}`).join('，');
    return `<svg class="glyph" viewBox="0 0 29 30" width="29" height="30" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${bars}</svg>`;
  }

  function chips(flags, max = 3) {
    const f = (flags || []).filter((x) => FLAGS[x]);
    if (!f.length) return '<span class="muted">—</span>';
    const shown = f.slice(0, max).map((x) => `<span class="chip ${FLAGS[x].tone}" title="${esc(FLAGS[x].help)}">${esc(FLAGS[x].label)}</span>`).join('');
    const rest = f.length > max ? `<span class="chip" title="${esc(f.slice(max).map((x) => FLAGS[x].label).join('、'))}">+${f.length - max}</span>` : '';
    return `<div class="chips">${shown}${rest}</div>`;
  }

  function buildStockTable() {
    if (state.stockTable) return;
    const t = new Tabulator('#tbl-stock', {
      data: state.rows,
      index: 'ticker',
      layout: 'fitColumns',
      height: tableHeight(),
      responsiveLayout: 'hide',
      placeholder: state.rows.length ? '沒有符合條件的股票' : '還沒有資料',
      initialSort: [{ column: 'score', dir: 'desc' }],
      rowFormatter(row) {
        const el = row.getElement();
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStock(row.getData()); } };
      },
      columns: [
        { title: '#', field: 'rank', width: 72, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 0 },
        { title: '股票', field: 'ticker', minWidth: 170, widthGrow: 3, sorter: 'string', responsive: 0,
          formatter: (c) => { const d = c.getData(); return `<div class="cell-name"><b>${esc(d.ticker)}</b><span>${esc(d.name || '')}</span></div>`; } },
        { title: '分數', field: 'score', width: 124, sorter: 'number', responsive: 0,
          formatter: (c) => {
            const d = c.getData();
            const diff = isNum(d.score_7d) ? d.score - d.score_7d : null;
            const delta = diff !== null && Math.abs(diff) >= 0.5
              ? `<span class="delta ${diff > 0 ? 'up' : 'down'}" title="與約 7 天前相比">${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}</span>` : '';
            return `<div class="cell-score"><b>${nf(d.score, 1)}</b>${delta}</div>`;
          } },
        { title: '結構', field: 'growth', width: 80, headerSort: false, responsive: 1, formatter: (c) => glyph(c.getData()) },
        { title: '營收年增', field: 'rev_yoy', width: 124, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 2,
          formatter: (c) => `<span class="${tone(c.getValue())}">${spct(c.getValue())}</span>` },
        { title: '6 個月強度', field: 'rs_6m', width: 136, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 3,
          headerTooltip: '6 個月報酬減去 SPY 的 6 個月報酬',
          formatter: (c) => `<span class="${tone(c.getValue())}">${spct(c.getValue())}</span>` },
        { title: '市值', field: 'mkt_cap', width: 104, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 4, formatter: (c) => usd(c.getValue()) },
        { title: '日成交額', field: 'dollar_vol', width: 116, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 5,
          headerTooltip: '20 日平均成交金額', formatter: (c) => usd(c.getValue()) },
        { title: '自選', field: 'ticker', width: 64, headerSort: false, hozAlign: 'center',
          formatter: (c) => (state.watch.has(c.getValue()) ? '<span class="star on" title="已加入自選">★</span>' : '<span class="star">☆</span>') },
        { title: '產業', field: 'sector', width: 140, responsive: 5, formatter: (c) => esc(c.getValue() || '—') },
        { title: '大戶', field: 'smart_score', width: 150, sorter: 'number', responsive: 4,
          headerTooltip: '內部人買進（Form 4）與新增 5% 持有人（13D/13G），資料來自 SEC，分數 0 到 100',
          formatter: (c) => smartChips(c.getData()) },
        { title: '風險標記', field: 'flags', minWidth: 170, widthGrow: 2, headerSort: false, responsive: 6, formatter: (c) => chips(c.getValue()) },
      ],
    });
    t.on('tableBuilt', () => { state.stockReady = true; applyFilters(); openFromLink(); });
    t.on('rowClick', (_e, row) => openStock(row.getData()));
    state.stockTable = t;
  }

  // ── Taiwan table ────────────────────────────────────────────────────────
  const twd = (v) => (isNum(v) ? (v < 0 ? '−NT$' : 'NT$') + compact(Math.abs(v)) : '—');
  function buildTwTable() {
    const rows = (state.tw || []).filter((r) => r.board === 'tw_main');
    $('#count').textContent = rows.length ? `台股主榜 ${rows.length} 檔` : '台股還沒有資料';
    if (state.twTable) { state.twTable.redraw(true); return; }
    state.twTable = new Tabulator('#tbl-tw', {
      data: rows,
      index: 'ticker',
      layout: 'fitColumns',
      height: tableHeight(),
      responsiveLayout: 'hide',
      placeholder: '台股還沒有資料',
      initialSort: [{ column: 'score', dir: 'desc' }],
      columns: [
        { title: '#', field: 'rank', width: 72, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 0 },
        { title: '股票', field: 'ticker', minWidth: 170, widthGrow: 3, responsive: 0,
          formatter: (c) => { const d = c.getData(); return `<div class="cell-name"><a href="https://tw.stock.yahoo.com/quote/${encodeURIComponent(d.ticker)}" target="_blank" rel="noopener noreferrer"><b>${esc(d.ticker)}</b></a><span>${esc(d.name || '')}${d.exchange ? '，' + esc(d.exchange) : ''}</span></div>`; } },
        { title: '分數', field: 'score', width: 124, sorter: 'number', responsive: 0,
          formatter: (c) => {
            const d = c.getData();
            const diff = isNum(d.score_7d) ? d.score - d.score_7d : null;
            const delta = diff !== null && Math.abs(diff) >= 0.5
              ? `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}</span>` : '';
            return `<div class="cell-score"><b>${nf(d.score, 1)}</b>${delta}</div>`;
          } },
        { title: '結構', field: 'growth', width: 80, headerSort: false, responsive: 1, formatter: (c) => glyph(c.getData()) },
        { title: '營收年增', field: 'rev_yoy', width: 124, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 2,
          formatter: (c) => `<span class="${tone(c.getValue())}">${spct(c.getValue())}</span>` },
        { title: '累計年增', field: 'rev_cum_yoy', width: 124, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 3,
          formatter: (c) => `<span class="${tone(c.getValue())}">${spct(c.getValue())}</span>` },
        { title: '6 個月強度', field: 'rs_6m', width: 136, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 3,
          headerTooltip: '6 個月報酬減去加權指數的 6 個月報酬',
          formatter: (c) => `<span class="${tone(c.getValue())}">${spct(c.getValue())}</span>` },
        { title: '市值', field: 'mkt_cap', width: 120, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 4, formatter: (c) => twd(c.getValue()) },
        { title: '日成交值', field: 'dollar_vol', width: 124, hozAlign: 'right', headerHozAlign: 'right', sorter: 'number', responsive: 5,
          headerTooltip: '20 日平均成交值', formatter: (c) => twd(c.getValue()) },
        { title: '產業', field: 'sector', width: 140, responsive: 5, formatter: (c) => esc(c.getValue() || '—') },
      ],
    });
  }

  // ── Reg CF table ────────────────────────────────────────────────────────
  const growthOf = (d) => (isNum(d.revenue) && isNum(d.revenue_prior) && d.revenue_prior > 0 ? d.revenue / d.revenue_prior - 1 : null);

  function buildRaiseTable() {
    if (state.raiseTable) return;
    const t = new Tabulator('#tbl-raise', {
      data: state.raises,
      index: 'accession',
      layout: 'fitColumns',
      height: tableHeight(),
      responsiveLayout: 'hide',
      placeholder: state.raises.length ? '沒有符合條件的募資案' : '還沒有 Form C 資料',
      initialSort: [{ column: 'filed_at', dir: 'desc' }],
      rowFormatter(row) {
        const el = row.getElement();
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRaise(row.getData()); } };
      },
      columns: [
        { title: '公司', field: 'issuer', minWidth: 190, widthGrow: 3, sorter: 'string', responsive: 0,
          formatter: (c) => { const d = c.getData(); return `<div class="cell-name"><b>${esc(d.issuer || '')}</b><span>${esc(d.portal || '')}</span></div>`; } },
        { title: '狀態', field: 'deadline', width: 128, sorter: 'string', responsive: 0,
          formatter: (c) => {
            const dl = c.getValue();
            if (!dl) return '<span class="chip">未載明截止日</span>';
            if (dl < todayStr()) return '<span class="chip">已截止</span>';
            const left = daysUntil(dl);
            return `<span class="chip ${left <= 7 ? 'warn' : 'ok'}">募資中，剩 ${left} 天</span>`;
          } },
        { title: '申報日', field: 'filed_at', width: 108, sorter: 'string', responsive: 3 },
        { title: '募資額', field: 'target_amount', width: 150, sorter: 'number', hozAlign: 'right', headerHozAlign: 'right', responsive: 2,
          headerTooltip: '目標金額至上限金額',
          formatter: (c) => { const d = c.getData(); return isNum(d.max_amount) && d.max_amount !== d.target_amount ? `${usd(d.target_amount)} 至 ${usd(d.max_amount)}` : usd(d.target_amount); } },
        { title: '營收', field: 'revenue', width: 130, sorter: 'number', hozAlign: 'right', headerHozAlign: 'right', responsive: 1,
          formatter: (c) => { const g = growthOf(c.getData()); return `${usd(c.getValue())}${g === null ? '' : ` <span class="${tone(g)}">${spct(g)}</span>`}`; } },
        { title: '淨利', field: 'net_income', width: 100, sorter: 'number', hozAlign: 'right', headerHozAlign: 'right', responsive: 4,
          formatter: (c) => `<span class="${tone(c.getValue())}">${usd(c.getValue())}</span>` },
        { title: '現金', field: 'cash', width: 96, sorter: 'number', hozAlign: 'right', headerHozAlign: 'right', responsive: 5, formatter: (c) => usd(c.getValue()) },
        { title: '證券', field: 'security_type', minWidth: 120, widthGrow: 1, sorter: 'string', responsive: 6, formatter: (c) => esc(c.getValue() || '—') },
      ],
    });
    t.on('tableBuilt', () => { state.raiseReady = true; applyFilters(); });
    t.on('rowClick', (_e, row) => openRaise(row.getData()));
    state.raiseTable = t;
  }

  // ── drawer ──────────────────────────────────────────────────────────────
  function showDrawer() {
    const dr = $('#drawer');
    state.lastFocus = document.activeElement;
    $('#scrim').hidden = false;
    dr.inert = false;
    dr.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { $('#scrim').classList.add('show'); dr.classList.add('open'); });
    $('#drawer-close').focus();
  }

  function closeDrawer() {
    const dr = $('#drawer');
    if (!dr.classList.contains('open')) return;
    dr.classList.remove('open');
    $('#scrim').classList.remove('show');
    dr.setAttribute('aria-hidden', 'true');
    dr.inert = true;
    state.current = null;
    destroyCharts();
    setTimeout(() => { if (!dr.classList.contains('open')) $('#scrim').hidden = true; }, 240);
    state.lastFocus?.focus?.();
  }

  function onKey(e) {
    const dr = $('#drawer');
    if (!dr.classList.contains('open')) return;
    if (e.key === 'Escape') { closeDrawer(); return; }
    if (e.key === 'Tab') {  // keep focus inside the drawer while it is open
      const f = $$('a[href],button:not([disabled])', dr);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  const destroyCharts = () => { state.charts.forEach((c) => c.destroy()); state.charts = []; };
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function pillar(i, label, val, text, why = '') {
    return `<div class="pillar"><div class="pillar-top"><i class="sw g${i}"></i><b>${label}</b><span class="val">${nf(val, 0)}</span></div>
      <div class="meter g${i}"><i style="width:${clamp(val)}%"></i></div><p>${text}</p>${why ? `<p class="why">${why}</p>` : ''}</div>`;
  }
  const beats = (v) => (isNum(v) ? `在今天被評分的股票裡，約贏過 ${Math.round(clamp(v))}% 的同類。` : '');

  // Deep link from the LINE bot: index.html#t=NRXS opens that stock's drawer once the table is ready.
  function openFromLink() {
    const m = /(?:^|[#&])t=([A-Za-z0-9.\-]{1,8})/.exec(location.hash || '');
    if (!m || state.linkDone) return;
    state.linkDone = true;
    const d = (state.rows || []).find((r) => r.ticker === m[1].toUpperCase());
    if (d) openStock(d);
  }

  function openStock(d) {
    state.current = d.ticker;
    const diff = isNum(d.score_7d) ? d.score - d.score_7d : null;
    const f = (d.flags || []).filter((x) => FLAGS[x]);
    const yahoo = `https://finance.yahoo.com/quote/${encodeURIComponent(d.ticker)}`;
    const sec = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(d.ticker)}&type=10-&dateb=&owner=include&count=40`;
    const boardName = d.board === 'main' ? '主榜' : '觀察清單';

    $('#drawer-body').innerHTML = `
      <div class="d-head">
        <h2 id="drawer-title">${esc(d.ticker)}</h2>
        <p class="muted">${esc(d.name || '')}${d.industry ? '，' + esc(d.industry) : ''}</p>
        <div class="d-links">
          <a href="${esc(yahoo)}" target="_blank" rel="noopener noreferrer">Yahoo Finance</a>
          <a href="${esc(sec)}" target="_blank" rel="noopener noreferrer">SEC 申報</a>
        </div>
      </div>
      <div class="d-score">
        <span class="big">${nf(d.score, 1)}</span>
        <span class="meta">${boardName}第 ${nf(d.rank)} 名${diff !== null ? `，比約 7 天前${diff >= 0 ? '高' : '低'} ${Math.abs(diff).toFixed(1)}` : ''}</span>
      </div>
      <div class="d-section radar-wrap"><canvas id="radar" height="220" aria-label="四個面向雷達圖"></canvas><p class="chart-note">藍色是這檔，灰色是主榜的中位數。冷門度是擁擠的反面。</p></div>
      ${pillar(0, '成長', d.growth, `營收年增 ${spct(d.rev_yoy)}，6 個月相對強度 ${spct(d.rs_6m)}（相對 SPY）。`, beats(d.growth))}
      ${pillar(1, '驗證', d.validated, `連續 ${nf(d.rev_streak)} 季營收季增，毛利率 ${pct(d.gross_margin)}。`, isNum(d.gross_margin) ? beats(d.validated) : '這檔沒有毛利率資料，這一項是以偏低的預設值估算，可信度較低。')}
      ${pillar(2, '進場', d.accessibility, `市值 ${usd(d.mkt_cap)}，20 日平均成交額 ${usd(d.dollar_vol)}，股價 $${nf(d.price, 2)}。`)}
      ${pillar(3, '擁擠', d.attention, `Hacker News 近 30 天 ${isNum(d.hn_mentions) ? nf(d.hn_mentions) + ' 則' : '沒有資料'}，20 日平均成交額 ${usd(d.dollar_vol)}。這一項越高，總分被扣得越多。`, isNum(d.attention) ? `比約 ${Math.round(clamp(d.attention))}% 的股票更擁擠。目前沒有分析師與法人資料。` : '')}
      <div class="d-section"><h3>我的筆記</h3><div id="watch-box"></div></div>
      <div class="d-section"><h3>大戶動向</h3><div id="smart-box"><p class="chart-note">載入中…</p></div></div>
      <div class="d-section"><h3>風險標記</h3>${f.length
        ? `<ul class="flag-list">${f.map((x) => `<li><span class="chip ${FLAGS[x].tone}">${esc(FLAGS[x].label)}</span><span>${esc(FLAGS[x].help)}</span></li>`).join('')}</ul>`
        : '<p class="chart-note">沒有觸發任何標記，不代表沒有風險。</p>'}</div>
      <div class="d-section"><h3>分數走勢</h3><div id="chart-score" class="chart-box"><p class="chart-note">載入中…</p></div></div>
      <div class="d-section"><h3>近半年股價</h3><div id="chart-price" class="chart-box"><p class="chart-note">載入中…</p></div></div>
      <div class="d-section"><h3>資料來源</h3>
        <p class="chart-note">營收、毛利、淨利、現金與流通股數：SEC EDGAR 的公開財報資料（以最近一次申報為準，通常比實際晚一到三個月）。股價與成交額：Massive 的收盤資料。市值是股價乘以最近申報封面上的股數，所以可能與市場報價略有差距。點上方「SEC 申報」可以對照原文。</p>
      </div>
      <div class="d-section"><h3>其他數字</h3>
        <dl class="facts">
          <div><dt>近 1 個月</dt><dd class="${tone(d.ret_1m)}">${spct(d.ret_1m, 1)}</dd></div>
          <div><dt>近 3 個月</dt><dd class="${tone(d.ret_3m)}">${spct(d.ret_3m, 1)}</dd></div>
          <div><dt>近 6 個月</dt><dd class="${tone(d.ret_6m)}">${spct(d.ret_6m, 1)}</dd></div>
          <div><dt>距 52 週高點</dt><dd>${spct(d.dist_high, 1)}</dd></div>
          <div><dt>現金可撐（虧損中才有）</dt><dd>${isNum(d.runway_months) ? nf(d.runway_months, 0) + ' 個月' : '—'}</dd></div>
          <div><dt>產業</dt><dd>${esc(d.sector || '—')}</dd></div>
        </dl>
      </div>`;
    showDrawer();
    drawRadar(d);
    renderWatch(d);
    loadSmart(d);
    loadStockCharts(d.ticker);
  }

  function renderWatch(d) {
    const box = $('#watch-box');
    const on = state.watch.has(d.ticker);
    box.innerHTML = `<button type="button" class="btn-star" id="w-toggle" aria-pressed="${on}">${on ? '★ 已加入自選' : '☆ 加入自選'}</button>
      <textarea id="w-note" class="field glass" rows="3" maxlength="1000" placeholder="記下你為什麼關注它（只有你看得到）"${on ? '' : ' hidden'}>${esc(state.watch.get(d.ticker) || '')}</textarea>
      <p class="chart-note" id="w-msg"></p>`;
    const msg = (t) => { const m = $('#w-msg'); if (m) m.textContent = t; };
    const refresh = () => { if (state.stockReady) state.stockTable.redraw(true); };
    const save = async (note) => {
      const { error } = await state.sb.from('user_watch').upsert({ ticker: d.ticker, note, updated_at: new Date().toISOString() }, { onConflict: 'user_id,ticker' });
      if (error) { msg(/user_watch|schema cache|does not exist/i.test(error.message) ? '自選功能的資料表還不存在，請先執行最新的 schema.sql。' : /row-level|null value|JWT/i.test(error.message) ? '請先登入才能使用自選與筆記。' : '儲存失敗：' + error.message); return false; }
      return true;
    };
    $('#w-toggle').addEventListener('click', async () => {
      if (state.watch.has(d.ticker)) {
        const { error } = await state.sb.from('user_watch').delete().eq('ticker', d.ticker);
        if (error) { msg('移除失敗：' + error.message); return; }
        state.watch.delete(d.ticker);
      } else {
        if (!(await save(''))) return;
        state.watch.set(d.ticker, '');
      }
      renderWatch(d); refresh(); if (state.watchOnly) applyFilters();
    });
    const ta = $('#w-note');
    ta.addEventListener('blur', async () => {
      if (!state.watch.has(d.ticker) || ta.value === state.watch.get(d.ticker)) return;
      if (await save(ta.value)) { state.watch.set(d.ticker, ta.value); msg('已儲存'); }
    });
  }

  function drawRadar(d) {
    const cv = $('#radar');
    if (!cv || typeof Chart === 'undefined') return;
    const med = (k) => {
      const v = state.rows.filter((r) => r.board === 'main' && isNum(r[k])).map((r) => r[k]).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    };
    const cool = (x) => (isNum(x) ? 100 - x : 0);
    state.charts.push(new Chart(cv, {
      type: 'radar',
      data: {
        labels: ['成長', '驗證', '進場', '冷門度'],
        datasets: [
          { label: d.ticker, data: [d.growth, d.validated, d.accessibility, cool(d.attention)], borderColor: '#4766ea', backgroundColor: 'rgba(71,102,234,.25)' },
          { label: '主榜中位數', data: [med('growth'), med('validated'), med('accessibility'), cool(med('attention'))], borderColor: '#9ca3af', backgroundColor: 'rgba(156,163,175,.12)', borderDash: [4, 4] },
        ],
      },
      options: { scales: { r: { min: 0, max: 100, ticks: { display: false } } }, plugins: { legend: { position: 'bottom' } } },
    }));
  }

  async function loadSmart(d) {
    const box = $('#smart-box');
    const sm = d.smart;
    let trades = [], holders = [];
    try {
      const [t, h] = await Promise.all([
        state.sb.from('insider_trades').select('filed_at,owner,title,code,shares,price,value').eq('ticker', d.ticker).order('filed_at', { ascending: false }).limit(10),
        state.sb.from('holder_filings').select('filed_at,form_type,holder,pct').eq('ticker', d.ticker).order('filed_at', { ascending: false }).limit(5),
      ]);
      trades = t.data || []; holders = h.data || [];
    } catch (e) { /* tables not created yet */ }
    if (state.current !== d.ticker) return;
    if (!sm && !trades.length && !holders.length) {
      box.innerHTML = '<p class="chart-note">近期沒有偵測到內部人買進或新增 5% 持有人。資料來自 SEC 的 Form 4 與 13D/13G，只涵蓋已評分的公司。</p>';
      return;
    }
    const tags = (sm?.tags || []).filter((x) => SMART[x]);
    const head = tags.length
      ? `<ul class="flag-list">${tags.map((x) => `<li><span class="chip ${SMART[x].tone}">${esc(SMART[x].label)}</span><span>${esc(SMART[x].help)}</span></li>`).join('')}</ul>`
      : '<p class="chart-note">沒有達到訊號門檻，以下是近期申報。</p>';
    const tr = trades.length
      ? `<table class="mini"><thead><tr><th>申報日</th><th>人員</th><th>買/賣</th><th>金額</th></tr></thead><tbody>${trades.map((x) =>
          `<tr><td>${esc(x.filed_at)}</td><td>${esc(x.owner || '')}${x.title ? `<br><span class="muted">${esc(x.title)}</span>` : ''}</td><td class="${x.code === 'P' ? 'up' : 'down'}">${x.code === 'P' ? '買進' : '賣出'}</td><td>${isNum(x.value) ? usd(x.value) : '—'}</td></tr>`).join('')}</tbody></table>`
      : '';
    const hd = holders.length
      ? `<table class="mini"><thead><tr><th>申報日</th><th>持有人</th><th>表單</th><th>持股</th></tr></thead><tbody>${holders.map((x) =>
          `<tr><td>${esc(x.filed_at)}</td><td>${esc(x.holder || '—')}</td><td>${esc(x.form_type)}</td><td>${isNum(x.pct) ? nf(x.pct, 1) + '%' : '—'}</td></tr>`).join('')}</tbody></table>`
      : '';
    box.innerHTML = head + tr + hd + '<p class="chart-note">內部人買賣是公開申報，不等於看好；多人同時買進比單人買進更有參考價值。</p>';
  }

  async function loadStockCharts(ticker) {
    const sb = state.sb;
    const [hist, px] = await Promise.all([
      sb.from('scores').select('as_of,score,growth,validated,accessibility,attention').eq('ticker', ticker).order('as_of').limit(600),
      sb.from('price_series').select('series').eq('ticker', ticker).maybeSingle(),
    ]);
    if (state.current !== ticker) return;  // the user already opened something else

    const muted = css('--muted'), hair = css('--hair');
    const baseScales = (extra = {}) => ({
      x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 5, maxRotation: 0 } },
      y: { grid: { color: hair }, ticks: { color: muted }, ...extra },
    });

    const sbox = $('#chart-score');
    const h = hist.data || [];
    if (hist.error) sbox.innerHTML = `<p class="chart-note">${esc(hist.error.message)}</p>`;
    else if (h.length < 2) sbox.innerHTML = `<p class="chart-note">歷史資料還在累積，目前只有 ${h.length} 天。</p>`;
    else {
      sbox.innerHTML = '<canvas aria-label="分數走勢圖" role="img"></canvas>';
      const line = (label, key, color, w, dash) => ({ label, data: h.map((r) => r[key]), borderColor: color, borderWidth: w, borderDash: dash || [], pointRadius: 0, tension: 0.25 });
      state.charts.push(new Chart($('canvas', sbox), {
        type: 'line',
        data: {
          labels: h.map((r) => r.as_of),
          datasets: [
            line('分數', 'score', css('--ink'), 2.6),
            line('成長', 'growth', css('--growth'), 1.2),
            line('驗證', 'validated', css('--valid'), 1.2),
            line('進場', 'accessibility', css('--access'), 1.2),
            line('擁擠', 'attention', css('--crowd'), 1.2, [4, 3]),
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: baseScales({ min: 0, max: 100 }),
          plugins: { legend: { position: 'bottom', labels: { color: muted, boxWidth: 10, boxHeight: 10, usePointStyle: true } } },
        },
      }));
    }

    const pbox = $('#chart-price');
    const series = px.data?.series;
    if (!series || series.length < 2) pbox.innerHTML = '<p class="chart-note">沒有價格走勢。只會保存分數前 250 名的走勢。</p>';
    else {
      pbox.innerHTML = '<canvas aria-label="股價走勢圖" role="img"></canvas>';
      state.charts.push(new Chart($('canvas', pbox), {
        type: 'line',
        data: { labels: series.map((p) => p[0]), datasets: [{ label: '收盤價', data: series.map((p) => p[1]), borderColor: css('--valid'), backgroundColor: css('--valid') + '22', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.15 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, scales: baseScales(), plugins: { legend: { display: false } } },
      }));
    }
  }

  // Form C has no industry field, so the yardstick is the main board's median (listed small caps), not "same industry".
  function compareBox(d, g, margin) {
    const med = (arr) => { const v = arr.filter(isNum).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const main = state.rows.filter((r) => r.board === 'main');
    const mg = med(main.map((r) => r.rev_yoy));
    if (!main.length || (g === null && margin === null)) return '';
    return `<div class="compare"><b>和上市小型股比一比</b>
      <p>營收成長：這家 ${g === null ? '—' : spct(g)}，主榜中位數 ${mg === null ? '—' : spct(mg)}。${g !== null && mg !== null ? (g > mg ? '高於' : '低於') + '主榜中位數。' : ''}</p>
      <p class="chart-note">主榜是已評分的美國上市小型股。Form C 沒有產業欄位，所以這裡不是同產業比較，只當作成長速度的參考線。</p></div>`;
  }

  async function loadProgress(d) {
    const box = $('#progress-box');
    let u = [];
    try {
      const r = await state.sb.from('fundraise_updates').select('filed_at,form_type,raised').eq('cik', d.cik).order('filed_at', { ascending: false }).limit(3);
      u = r.data || [];
    } catch (e) { /* table not created yet */ }
    if (state.current !== d.accession || !box) return;
    const last = u.find((x) => isNum(Number(x.raised)) && x.raised !== null);
    if (!last) {
      box.innerHTML = '<p class="chart-note">還沒有看到這家公司的進度更新（Form C-U）。公司在募資過程中達到里程碑時才會申報，沒有申報不代表沒有進展。</p>';
      return;
    }
    const goal = isNum(d.max_amount) && d.max_amount > 0 ? d.max_amount : d.target_amount;
    const target = d.target_amount;
    const p = isNum(goal) && goal > 0 ? Math.min(100, (Number(last.raised) / goal) * 100) : null;
    box.innerHTML = `<p>已募得約 <b>${usd(Number(last.raised))}</b>（${esc(last.filed_at)} 的 ${esc(last.form_type)}）${isNum(target) && Number(last.raised) >= target ? '，已超過目標金額' : ''}。</p>
      ${p === null ? '' : `<div class="meter g0"><i style="width:${p.toFixed(0)}%"></i></div><p class="chart-note">約達上限金額的 ${p.toFixed(0)}%。進度只到最近一次申報當天，之後可能已有變化。</p>`}`;
  }

  function openRaise(d) {
    state.current = d.accession;
    const g = growthOf(d);
    const margin = isNum(d.revenue) && d.revenue > 0 && isNum(d.net_income) ? d.net_income / d.revenue : null;
    const months = isNum(d.cash) && isNum(d.net_income) && d.net_income < 0 ? d.cash / (-d.net_income / 12) : null;
    const web = safeUrl(d.website);
    const filing = safeUrl(d.filing_url);
    const open = d.deadline && d.deadline >= todayStr();
    const left = d.deadline ? Math.round((new Date(d.deadline) - new Date(todayStr())) / 86400000) : null;

    $('#drawer-body').innerHTML = `
      <div class="d-head">
        <h2 id="drawer-title">${esc(d.issuer || '')}</h2>
        <p class="muted">${esc(d.portal ? '募資平台：' + d.portal : '募資平台未載明')}</p>
        <div class="d-links">
          ${filing ? `<a href="${esc(filing)}" target="_blank" rel="noopener noreferrer">SEC 申報原文</a>` : ''}
          ${web ? `<a href="${esc(web)}" target="_blank" rel="noopener noreferrer">公司網站</a>` : ''}
        </div>
      </div>
      <div class="d-score">
        <span class="chip ${open ? 'ok' : ''}">${open ? '募資中' : d.deadline ? '已截止' : '未載明截止日'}</span>
        <span class="meta">${esc(d.form_type || 'C')} 申報於 ${esc(d.filed_at || '—')}${d.deadline ? '，截止 ' + esc(d.deadline) : ''}${left === null ? '' : open ? `，還剩 ${left} 天` : ''}</span>
      </div>
      <div class="d-section"><h3>募資進度</h3><div id="progress-box"><p class="chart-note">載入中…</p></div></div>
      <div class="d-section"><h3>這一輪</h3>
        <dl class="facts">
          <div><dt>目標金額</dt><dd>${usd(d.target_amount)}</dd></div>
          <div><dt>上限金額</dt><dd>${usd(d.max_amount)}</dd></div>
          <div><dt>證券類型</dt><dd>${esc(d.security_type || '—')}</dd></div>
          <div><dt>每單位價格</dt><dd>${isNum(d.price) ? '$' + nf(d.price, 2) : '—'}</dd></div>
        </dl>
      </div>
      <div class="d-section"><h3>公司自己申報的財務（最近一個完整會計年度）</h3>
        <dl class="facts">
          <div><dt>營收</dt><dd>${usd(d.revenue)}${g === null ? '' : ` <span class="${tone(g)}">${spct(g)}</span>`}</dd></div>
          <div><dt>淨利</dt><dd class="${tone(d.net_income)}">${usd(d.net_income)}${margin === null ? '' : `（${pct(margin)}）`}</dd></div>
          <div><dt>現金</dt><dd>${usd(d.cash)}</dd></div>
          <div><dt>總資產</dt><dd>${usd(d.total_assets)}</dd></div>
          <div><dt>長期負債</dt><dd>${usd(d.debt)}</dd></div>
          <div><dt>員工數</dt><dd>${nf(d.employees)}</dd></div>
          <div><dt>以去年虧損粗估現金可撐</dt><dd>${months === null ? '—' : nf(months, 0) + ' 個月'}</dd></div>
        </dl>
        ${compareBox(d, g, margin)}
        <p class="chart-note">這些數字由公司自行申報。財報的查核程度依募資金額而定：小額募資可由公司主管自行認證，金額較大才需要會計師核閱或查核。投資前請讀完整申報與募資平台頁面。</p>
      </div>`;
    showDrawer();
    loadProgress(d);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
