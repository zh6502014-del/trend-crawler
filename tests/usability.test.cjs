const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = require('./fixtures/usability.cjs');
const repo = path.join(__dirname, '..');
const rows = '#tbl-stock .tabulator-row';
const tasks = [];
const task = (id,title,expected,steps,opts,run) => tasks.push({id,title,expected,steps,opts,run});
const title = p => p.locator('#drawer-title').innerText();
const text = (p,s) => p.locator(s).innerText();
const count = p => p.locator(rows).count();
const settle = p => p.waitForTimeout(180);
async function search(p,q){await p.locator('#f-q').fill(q);await settle(p);}
async function stock(p,t){await search(p,t);await p.locator(rows).first().click();await p.locator('#drawer.open').waitFor();}
async function reload(p){await p.reload();await p.locator(rows).first().waitFor();await settle(p);}

task('U01','登入前隔離與寄信回饋','登入前不讀取榜單；送出後顯示已寄出；模擬登入後顯示榜單',['開啟登入頁','填入 Email 並寄送','模擬登入成功'],{login:true},async(p,o)=>{
  assert.equal(await p.locator('#app').isVisible(),false);assert.equal(await p.evaluate(()=>__calls.length),0);
  await p.locator('#login-email').fill('reader@example.test');await p.locator('#login-form button').click();await p.waitForFunction(()=>document.querySelector('#login-msg').textContent.includes('已寄出'));
  assert.equal(await p.evaluate(()=>__otpArgs.options.shouldCreateUser),false);
  await p.evaluate(()=>{__signedIn=true;__auth('SIGNED_IN');});await p.locator(rows).first().waitFor();o.rows=await count(p);assert.ok(o.rows>0);
});
task('U02','登入等待時避免重複寄送','請求進行中停用寄送按鈕，只有一次請求',['輸入 Email','送出後立即檢查按鈕狀態','若仍可按，再按一次'],{login:true,slowLogin:true},async(p,o)=>{
  await p.locator('#login-email').fill('reader@example.test');await p.locator('#login-form button').click();
  o.disabled=await p.locator('#login-form button').isDisabled();if(!o.disabled)await p.locator('#login-form button').click();
  o.requests=await p.evaluate(()=>__otp);assert.ok(o.disabled&&o.requests===1,`按鈕停用=${o.disabled}，寄送請求=${o.requests}`);
});
task('U03','登入斷線後可辨識錯誤並重試','失敗後有明確錯誤；網路恢復後可再次送出',['模擬寄信網路例外','檢查提示','恢復連線後重試'],{login:true,loginFail:true},async(p,o)=>{
  await p.locator('#login-email').fill('reader@example.test');await p.locator('#login-form button').click();await p.waitForTimeout(250);
  o.message=await text(p,'#login-msg');assert.match(o.message,/失敗|無法|連線|重試/,'網路例外未轉成可理解的錯誤提示');
  await p.evaluate(()=>{__loginFail=false;});await p.locator('#login-form button').click();await p.waitForFunction(()=>document.querySelector('#login-msg').textContent.includes('已寄出'));
});
task('U04','搜尋股票、開啟詳情與返回','搜尋正確結果；詳情代號正確；Escape 返回原列',['搜尋 ROBT','開啟詳情','按 Escape'],{},async(p,o)=>{
  await stock(p,'ROBT');assert.equal(await title(p),'ROBT');await p.keyboard.press('Escape');
  assert.equal(await p.locator('#drawer').getAttribute('aria-hidden'),'true');o.focus=await p.evaluate(()=>document.activeElement.textContent);assert.match(o.focus,/ROBT/);
});
task('U05','零結果後清除篩選','零結果有提示；點全部可恢復主榜',['搜尋不存在的代號','讀取空結果提示','點全部'],{},async(p,o)=>{
  await search(p,'NO_SUCH_STOCK');assert.equal(await count(p),0);o.empty=await text(p,'#tbl-stock');assert.match(o.empty,/沒有符合條件/);
  await p.locator('[data-view=all]').click();await settle(p);o.restored=await count(p);assert.equal(o.restored,9);assert.equal(await p.locator('#f-q').inputValue(),'');
});
task('U06','最低分數與風險篩選','所有可見列達到門檻，並移除高風險樣本 MDTX',['最低分數設為 65','勾選隱藏高風險','核對結果'],{},async(p,o)=>{
  await p.locator('#f-min').fill('65');await p.locator('#f-risk').check();await settle(p);o.table=await text(p,'#tbl-stock');
  assert.equal(await count(p),3);assert.doesNotMatch(o.table,/MDTX/);assert.match(o.table,/FINB/);assert.match(o.table,/ROBT/);assert.match(o.table,/CLOUD/);
});
task('U07','儲存與重用自訂條件','自訂視圖重載後仍可套用相同條件',['搜尋 ROBT 並勾選大戶','儲存條件','重載後清除條件','再次套用自訂視圖'],{},async(p,o)=>{
  assert.equal(await p.locator('label[for=view-name]').innerText(), '條件組名稱');
  assert.match(await text(p, '#view-help'), /目前篩選.*此瀏覽器/);
  await p.locator('#view-save').click();
  assert.match(await text(p, '#view-msg'), /請先輸入/);
  await search(p,'ROBT');await p.locator('#f-smart').check();await p.locator('#view-name').fill('我的研究');await p.locator('#view-save').click();
  assert.match(await text(p, '#view-msg'), /已儲存「我的研究」/);
  await reload(p);await p.locator('[data-view=all]').click();await p.locator('[data-view=s0]').click();await settle(p);
  assert.equal(await p.locator('#f-q').inputValue(),'ROBT');assert.ok(await p.locator('#f-smart').isChecked());assert.equal(await count(p),1);o.saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('tc_views')));
});
task('U08','加入自選與筆記儲存','新增自選後可輸入筆記；失焦儲存後重載仍保留',['開啟 FINB','加入自選','填寫筆記並移開焦點','重載後查看'],{},async(p,o)=>{
  await stock(p,'FINB');await p.locator('#w-toggle').click();await p.locator('#w-note').waitFor({state:'visible'});
  await p.locator('#w-note').fill('觀察下一季營收');await p.locator('#drawer-title').click();await p.waitForFunction(()=>document.querySelector('#w-msg').textContent==='已儲存');
  await reload(p);await stock(p,'FINB');o.note=await p.locator('#w-note').inputValue();assert.equal(o.note,'觀察下一季營收');o.writes=await p.evaluate(()=>__data.user_watch);
});
task('U09','移除自選後清單即時更新','移除唯一自選後，可見筆數立即歸零',['勾選只看自選','開啟 ROBT','移除自選','關閉詳情'],{},async(p,o)=>{
  await p.locator('#f-watch').check();await settle(p);assert.equal(await count(p),1);await p.locator(rows).first().click();await p.locator('#w-toggle').click();await settle(p);await p.keyboard.press('Escape');
  o.count=await text(p,'#count');assert.equal(await count(p),0);assert.match(o.count,/顯示 0 檔/);
});
task('U10','鍵盤進入筆記欄位','從自選按鈕按 Tab 可到筆記欄位',['開啟已有筆記的 ROBT','將焦點放到自選按鈕','按 Tab'],{},async(p,o)=>{
  await stock(p,'ROBT');await p.locator('#w-toggle').focus();await p.keyboard.press('Tab');o.focus=await p.evaluate(()=>document.activeElement.id);assert.equal(o.focus,'w-note','焦點循環跳過了筆記輸入框');
});
task('U11','金融業評分說明','金融業說明使用淨利率，不宣稱毛利率缺漏導致預設評分',['搜尋金融業樣本 FINB','開啟詳情','閱讀驗證項目'],{},async(p,o)=>{
  await stock(p,'FINB');o.explanation=await p.locator('#drawer-body .pillar').nth(1).innerText();assert.match(o.explanation,/淨利率/,'金融業說明沒有呈現實際使用的指標');assert.doesNotMatch(o.explanation,/偏低的預設值/);
});
task('U12','切換台股後判讀資料日期','台股顯示 2026-10-16，不沿用美股 2026-10-09 或美股來源',['載入日期較舊的美股','切換台股','核對日期與來源'],{oldUs:true},async(p,o)=>{
  await p.locator('[data-market=tw]').click();await p.locator('#tbl-tw .tabulator-row').first().waitFor();o.status=await text(p,'#status-text');o.sources=await text(p,'#source-status');
  assert.match(o.status,/2026-10-16/,'台股日期仍顯示美股日期');assert.doesNotMatch(o.sources,/Hacker News|SEC 募資/);
});
task('U13','從 LINE 連結開啟台股','2330 開啟台股詳情，使用新台幣、台股來源及主榜標籤',['開啟帶有 ?t=2330 的網址','核對詳情頁'],{link:'?t=2330'},async(p,o)=>{
  await p.locator('#drawer.open').waitFor();o.detail=await text(p,'#drawer-body');assert.equal(await title(p),'2330');assert.match(o.detail,/NT\$/,'台股使用了美元格式');assert.match(o.detail,/主榜第 1/);assert.doesNotMatch(o.detail,/SEC 申報|相對 SPY/);
});
task('U14','慢速網路下切換成績單','停留台股成績單時，較晚完成的美股請求不能覆蓋內容',['開啟回應較慢的美股成績單','立即切台股成績單','等待兩個請求完成'],{slowReports:true},async(p,o)=>{
  await p.locator('[data-tab=report]').click();await p.locator('[data-market=tw]').click();await p.locator('[data-tab=twreport]').click();await p.waitForTimeout(1100);
  o.report=await text(p,'#report-body');assert.equal(await p.locator('[data-tab=twreport]').getAttribute('aria-selected'),'true');assert.match(o.report,/加權指數/,'台股成績單被美股回應覆蓋');assert.doesNotMatch(o.report,/SPY/);
});
task('U15','單一來源失敗後重新載入','募資失敗不阻擋股票；恢復來源後能載入募資',['模擬募資來源失敗','確認股票可用','恢復來源並重新載入','切換募資頁'],{errors:['latest_fundraises']},async(p,o)=>{
  assert.ok(await count(p)>0);assert.match(await text(p,'#banner'),/募資資料載入失敗/);await p.evaluate(()=>{__errors=[];});await p.locator('#reload').click();await p.waitForFunction(()=>!document.querySelector('#reload').disabled);
  await p.locator('[data-tab=raise]').click();await p.locator('#tbl-raise .tabulator-row').first().waitFor();o.raise=await text(p,'#tbl-raise');assert.match(o.raise,/New Robotics Labs/);
});
task('U16','手機找到股票並閱讀風險','390px 螢幕能搜尋、開啟股票並讀取風險；另外記錄首屏阻力',['檢查初始榜單位置','搜尋 MDTX','開啟詳情閱讀風險','關閉詳情'],{width:390,height:844},async(p,o)=>{
  o.initial=await p.evaluate(()=>({firstRowTop:document.querySelector('#tbl-stock .tabulator-row').getBoundingClientRect().top,height:innerHeight,width:innerWidth,pageWidth:document.documentElement.scrollWidth}));
  await stock(p,'MDTX');assert.match(await text(p,'#drawer-body'),/現金跑道短/);await p.keyboard.press('Escape');assert.equal(await p.locator('#drawer').getAttribute('aria-hidden'),'true');
  if(o.initial.firstRowTop>=o.initial.height)o.friction='初始畫面看不到第一筆股票，需先捲動超過一個畫面。';
});
task('U17','小螢幕深色模式閱讀榜單','320px 深色模式可搜尋並開啟詳情；頁面不產生整體橫向溢出',['以 320px 深色模式開啟','搜尋 ROBT','閱讀詳情'],{width:320,height:720,dark:true},async(p,o)=>{
  o.layout=await p.evaluate(()=>({pageWidth:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(o.layout.pageWidth<=o.layout.viewport,'頁面有整體橫向溢出');
  await stock(p,'ROBT');assert.equal(await title(p),'ROBT');
});
task('U18','進階篩選重新整理後保留','大戶與自選勾選狀態及結果在重載後保持一致',['勾選只看大戶與只看自選','重新整理','比較條件與筆數'],{},async(p,o)=>{
  await p.locator('#f-smart').check();await p.locator('#f-watch').check();await settle(p);o.before=await count(p);await reload(p);
  o.after=await count(p);o.smart=await p.locator('#f-smart').isChecked();o.watch=await p.locator('#f-watch').isChecked();assert.ok(o.smart&&o.watch&&o.before===o.after,'重新整理後遺失進階篩選');
});
task('U19','台股列表直接開啟詳情','從台股列表點選時呈現台股來源、新台幣與正確榜單',['切換台股','搜尋 2330','點選股票列'],{},async(p,o)=>{
  await p.locator('[data-market=tw]').click();await p.locator('#t-q').fill('2330');await settle(p);
  await p.locator('#tbl-tw .tabulator-row').first().locator('[tabulator-field=score]').click();await p.locator('#drawer.open').waitFor();o.detail=await text(p,'#drawer-body');
  assert.equal(await title(p),'2330');assert.match(o.detail,/NT\$/);assert.match(o.detail,/主榜第 1/);assert.doesNotMatch(o.detail,/SEC 申報/);
});
task('U20','搜尋募資案與查看詳情','可找到募資案，看到截止日、目標金額與缺少進度的提示',['切換未上市募資','搜尋 Robotics','開啟募資案'],{},async(p,o)=>{
  await p.locator('[data-tab=raise]').click();await p.locator('#r-q').fill('Robotics');await settle(p);await p.locator('#tbl-raise .tabulator-row').first().click();await p.locator('#drawer.open').waitFor();await settle(p);
  o.detail=await text(p,'#drawer-body');assert.match(o.detail,/New Robotics Labs/);assert.match(o.detail,/2099-11-20/);assert.match(o.detail,/500(?:\.0)?K/);assert.match(o.detail,/尚無|還沒有|未找到|沒有/);
});

task('U21','手機收合篩選仍可調整與辨識','展開後可操作篩選，重載後保留條件並顯示數量',['展開篩選','選大戶與自選','重載並檢查數量','展開來源詳情'],{width:390,height:844},async(p)=>{
  assert.equal(await p.locator('#f-smart').isVisible(), false);
  await p.locator('#filter-toggle').click();
  await p.locator('#f-smart').check();await p.locator('#f-watch').check();
  await reload(p);
  assert.match(await text(p, '#filter-toggle'), /展開篩選（2）/);
  assert.equal(await count(p), 1);
  await p.locator('#filter-toggle').click();
  assert.ok(await p.locator('#f-smart').isChecked());assert.ok(await p.locator('#f-watch').isChecked());
  await p.locator('#filter-toggle').click();
  assert.equal(await p.locator('#source-status').isVisible(), false);
  await p.locator('#source-details summary').click();
  assert.ok(await p.locator('#source-status').isVisible());
});
task('U22','台股篩選與市場重新整理後保留','仍停留台股，維持法人篩選與台股日期',['切換台股','只看法人買超','重新整理'],{oldUs:true},async(p)=>{
  await p.locator('[data-market=tw]').click();await p.locator('#t-inst').check();
  await p.reload();await p.locator('#tbl-tw .tabulator-row').first().waitFor();
  assert.equal(await p.locator('[data-market=tw]').getAttribute('aria-selected'), 'true');
  assert.ok(await p.locator('#t-inst').isChecked());
  assert.equal(await p.locator('#tbl-tw .tabulator-row').count(), 1);
  assert.match(await text(p, '#status-text'), /台股.*2026-10-16/);
  await p.locator('[data-market=us]').click();
  assert.match(await text(p, '#status-text'), /美股.*2026-10-09/);
});
task('U23','鍵盤在詳情兩端循環','筆記欄位可輸入，Tab 與 Shift+Tab 留在對話框',['從最後欄位 Tab 到關閉按鈕','反向回筆記欄位','Escape 返回'],{},async(p)=>{
  await stock(p,'ROBT');await p.locator('#w-note').focus();await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(()=>document.activeElement.id), 'drawer-close');
  await p.keyboard.press('Shift+Tab');
  assert.equal(await p.evaluate(()=>document.activeElement.id), 'w-note');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('#drawer').evaluate(el=>el.inert), true);
});

// These scenarios run the production table and chart libraries. Only Supabase is simulated.
task('U24','瀏覽器拒絕儲存條件時提供重試提示','儲存失敗不能顯示成功，也不建立無法保留的按鈕',['模擬瀏覽器拒絕儲存','命名並儲存條件'],{},async(p)=>{
  await p.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'tc_views') throw new Error('Storage unavailable');
      return original.call(this, key, value);
    };
  });
  await p.locator('#view-name').fill('重要條件');await p.locator('#view-save').click();
  assert.match(await text(p, '#view-msg'), /儲存失敗.*重試/);
  assert.equal(await p.locator('[data-view=s0]').count(), 0);
});

let browser;
const assets = new Map();
before(async () => {
  const dir = process.env.USABILITY_ASSETS;
  const tableDir = dir || path.dirname(require.resolve('tabulator-tables'));
  const chartDir = dir || path.dirname(require.resolve('chart.js'));
  const sources = [
    ['https://cdn.jsdelivr.net/npm/tabulator-tables@6.3.0/dist/js/tabulator.min.js', path.join(tableDir, 'tabulator.min.js')],
    ['https://cdn.jsdelivr.net/npm/tabulator-tables@6.3.0/dist/css/tabulator_simple.min.css', dir ? path.join(dir, 'tabulator_simple.min.css') : path.join(tableDir, '../css/tabulator_simple.min.css')],
    ['https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.js', path.join(chartDir, 'chart.umd.js')],
  ];
  for (const [url, file] of sources) assets.set(url, fs.readFileSync(file));
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); });

for (const t of tasks) test(`${t.id}: ${t.title}`, async () => {
  const opts = t.opts;
  const context = await browser.newContext({ viewport: { width: opts.width || 1440, height: opts.height || 1000 }, colorScheme: opts.dark ? 'dark' : 'light' });
  try {
    const p = await context.newPage();
    p.setDefaultTimeout(5000);
    await p.clock.setFixedTime(new Date('2026-10-18T15:50:00Z'));
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(fixture, opts);
    await p.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (assets.has(url.href)) return route.fulfill({ body: assets.get(url.href), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      if (url.hostname !== 'usability.test') return route.fulfill({ body: '', contentType: 'text/javascript' });
      const file = url.pathname.slice(1) || 'index.html';
      if (file === 'config.js') return route.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={SUPABASE_URL:'https://offline.invalid',SUPABASE_ANON_KEY:'dummy',REQUIRE_LOGIN:true};" });
      return route.fulfill({ body: fs.readFileSync(path.join(repo, 'docs', file)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await p.goto('https://usability.test/' + (opts.link || ''));
    if (opts.login) await p.locator('#login').waitFor({ state: 'visible' });
    else if (opts.link) await p.locator('#drawer.open').waitFor();
    else await p.locator(rows).first().waitFor();
    await settle(p);
    const observed = {};
    await t.run(p, observed);
    assert.ok(!observed.friction, observed.friction);
    assert.deepEqual(errors, [], 'Unhandled browser exceptions');
  } finally {
    await context.close();
  }
});
