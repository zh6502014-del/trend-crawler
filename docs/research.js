/* Evidence-led research. No model-generated facts or return predictions. */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const pct = v => num(v) ? `${(v * 100).toFixed(1)}%` : '未知';
  const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(new Date());
  const dateAge = (day, now) => /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? (Date.parse(now) - Date.parse(day)) / 86400000 : Infinity;
  const risks = {short_runway:'現金跑道不足一年',deep_loss:'虧損深',high_debt:'負債高',dilution:'股本稀釋',high_pledge:'董監設質高',thin_volume:'成交薄'};
  const statuses = {researching:'研究中',watching:'持續觀察',rejected:'論點不成立'};

  function assess(d, market, now = today()) {
    const clues = [], concerns = [], gaps = [];
    for (const flag of d.flags || []) if (risks[flag]) concerns.push(risks[flag]);
    if (num(d.runway_months) && d.runway_months < 12 && !concerns.includes(risks.short_runway)) concerns.push(risks.short_runway);
    if (!num(d.rev_yoy)) gaps.push('缺營收年增');
    if (!num(d.rs_6m)) gaps.push('缺相對股價表現');
    if (dateAge(d.as_of, now) > 7 || dateAge(d.as_of, now) < 0) gaps.push('行情日期缺漏或待更新');
    if ((d.flags || []).includes('data_thin')) gaps.push('財報資料不足');
    if ((d.flags || []).includes('stale_fundamentals') || (num(d.fundamentals_age_days) && d.fundamentals_age_days > 7)) gaps.push('基本面待更新');
    if (market === 'us' && !d.fundamentals_fetched_at) gaps.push('基本面取得日期未記錄');
    if (market === 'tw') {
      if (d.revenue_history_status !== 'complete' || !num(d.revenue_months) || d.revenue_months < 6) gaps.push('需補足連續六個月營收');
      if (!d.revenue_as_of || dateAge(d.revenue_as_of, now) > 95) gaps.push('營收月份待核對');
      if (num(d.rev_3m_yoy) && d.rev_3m_yoy >= .15 && num(d.rev_accel) && d.rev_accel >= .05)
        clues.push({title:'營收成長加速',detail:`近三個月合計年增 ${pct(d.rev_3m_yoy)}，比前三個月提高 ${(d.rev_accel * 100).toFixed(1)} 個百分點。`});
      if (d.revenue_history_status === 'complete' && num(d.revenue_streak_months) && d.revenue_streak_months >= 3)
        clues.push({title:'月營收持續成長',detail:`連續 ${d.revenue_streak_months} 個月營收年增為正；需排除低基期。`});
    } else {
      if (num(d.rev_yoy) && d.rev_yoy >= .15 && num(d.rev_streak) && d.rev_streak >= 3)
        clues.push({title:'營收持續成長',detail:`營收年增 ${pct(d.rev_yoy)}，連續 ${d.rev_streak} 季季增；尚未排除季節性。`});
    }
    const growth = market === 'tw' ? d.rev_3m_yoy : d.rev_yoy;
    if (num(growth) && growth >= .15 && num(d.rs_6m) && d.rs_6m <= 0)
      clues.push({title:'成長與股價落差',detail:`營收年增 ${pct(growth)}，六個月相對${market === 'tw' ? '加權指數' : 'SPY'}表現 ${pct(d.rs_6m)}；待查落後原因。`});
    const bucket = gaps.length ? 'incomplete' : concerns.length ? 'risk' : clues.length >= 2 ? 'priority' : 'observe';
    const next = gaps.length ? '補齊並核對來源日期，再判斷經營趨勢。' : concerns.length
      ? '先核對現金、融資與稀釋風險，確認能否撐到下一個里程碑。'
      : '核對成長來源、客戶集中度與現金流，寫下能推翻論點的條件。';
    return {clues,concerns,gaps,bucket,next};
  }

  function renderRadar(el, rows, market, open, loadError, sb) {
    let category = 'priority';
    const entries = rows.map(d => ({d,a:assess(d,market)}));
    const labels = {priority:'優先研究',risk:'風險待查',incomplete:'資料待補',observe:'持續觀察'};
    el.innerHTML = `<div class="research-heading"><div><p class="eyebrow">${market === 'tw' ? '台股' : '美股'} · 研究雷達</p><h2>從線索開始，讓證據決定下一步</h2><p class="muted">以已載入的股票池篩選。先看經營訊號與風險，再建立自己的投資論點。</p></div></div>
      <div class="research-tabs" role="group" aria-label="研究分類">${Object.entries(labels).map(([k,v])=>`<button class="btn ghost" data-category="${k}" aria-pressed="${k===category}">${v} <span>${entries.filter(x=>x.a.bucket===k).length}</span></button>`).join('')}</div>
      <p class="chart-note">至少兩項線索且無已知重大風險、資料缺漏，才列入優先研究。線索可能相關；順序依線索數、代號排列，不使用原總分或冷門度。</p>
      <div class="research-results" aria-live="polite"></div>
      <details class="research-saved" open><summary>我的研究與驗證日期</summary><div class="research-saved-body"><p class="chart-note">載入中…</p></div></details>
      <details class="research-method"><summary>判斷條件與資料限制</summary><p>營收門檻：年增至少 15%；台股加速門檻：近三個月合計年增比前三個月提高至少 5 個百分點。股價落差：六個月相對指數報酬不高於 0。持續成長：至少連續三期，美股為季增、台股為月營收年增。</p><p>這些門檻尚未經報酬驗證。台股缺少毛利率與現金流趨勢，美股此版本不判斷成長加速；護城河、估值及融資需求皆需另行核實。無風險標記不表示已完成風險審查。</p></details>`;
    const result = el.querySelector('.research-results');
    function draw() {
      const all = entries.filter(x=>x.a.bucket===category).sort((x,y)=>y.a.clues.length-x.a.clues.length || x.d.ticker.localeCompare(y.d.ticker));
      const shown = all.slice(0,12);
      result.innerHTML = loadError ? '<p class="research-empty">榜單載入失敗，請使用上方「重新載入」重試。</p>' : !shown.length
        ? `<p class="research-empty">目前沒有「${labels[category]}」標的。可以查看其他分類，核對缺少的資料。</p>`
        : `<p class="muted">顯示 ${shown.length} / ${all.length} 檔${all.length > 12 ? '；先聚焦前 12 檔' : ''}</p><div class="research-grid">${shown.map(({d,a})=>`<article class="research-candidate"><div class="candidate-head"><div><h3>${esc(d.ticker)}</h3><p>${esc(d.name)}</p></div><span class="chip">${esc(labels[a.bucket])}</span></div><p class="chart-note">行情 ${esc(d.as_of || '未知')} · ${market === 'tw' ? '營收 '+esc(d.revenue_as_of?.slice(0,7)||'未知') : '基本面取得 '+esc(d.fundamentals_fetched_at?.slice(0,10)||'未知')}</p>${a.clues.map(c=>`<p><strong>${esc(c.title)}</strong><br>${esc(c.detail)}</p>`).join('') || '<p>目前沒有足夠的經營線索。</p>'}${[...a.concerns,...a.gaps].length ? `<p class="research-caution">${esc([...a.concerns,...a.gaps].join('、'))}</p>` : ''}<p class="chart-note">下一步：${esc(a.next)}</p><button type="button" class="btn primary" data-research-ticker="${esc(d.ticker)}">開啟研究卡</button></article>`).join('')}</div>`;
      result.querySelectorAll('[data-research-ticker]').forEach(b=>b.onclick=()=>open(rows.find(d=>d.ticker===b.dataset.researchTicker)));
    }
    el.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{category=b.dataset.category;el.querySelectorAll('[data-category]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw();});
    draw();
    const savedHost = el.querySelector('.research-saved-body');
    async function loadSaved() {
      try {
        const auth=await sb.auth.getSession();
        if(auth.error)throw auth.error;
        if(!auth.data?.session){savedHost.innerHTML='<p class="chart-note">登入後可查看私人研究卡。</p>';return;}
        const {data,error}=await sb.from('research_cards').select('ticker,status,thesis,review_on,updated_at').eq('market',market).order('review_on',{ascending:true,nullsFirst:false}).limit(200);
        if(error)throw error;
        if(!savedHost.isConnected)return;
        const cards=data || [];
        cards.sort((a,b)=>Number(b.status!=='rejected' && !!b.review_on && b.review_on<=today())-Number(a.status!=='rejected' && !!a.review_on && a.review_on<=today()) || (a.review_on || '9999').localeCompare(b.review_on || '9999'));
        savedHost.innerHTML=cards.length ? `<p class="chart-note">${cards.length>=200?'顯示最早的 200 張研究卡。':'已儲存 '+cards.length+' 張研究卡。'}到期的驗證優先顯示。</p><div class="research-saved-list">${cards.map(c=>`<button type="button" class="research-saved-card" data-saved-ticker="${esc(c.ticker)}"><strong>${esc(c.ticker)} · ${esc(statuses[c.status] || '研究中')}</strong><span>${esc(c.thesis?.slice(0,160) || '尚未填寫論點')}</span><small class="${c.review_on && c.review_on<=today() && c.status!=='rejected'?'research-due':''}">${c.review_on ? `${c.review_on<=today() && c.status!=='rejected'?'已到驗證日期':'驗證日期'} ${esc(c.review_on)}`:'尚未設定驗證日期'}${rows.some(d=>d.ticker===c.ticker)?'':' · 本次榜單未收錄'}</small></button>`).join('')}</div>` : '<p class="chart-note">尚無研究卡。開啟任一股票，展開「編輯研究卡」即可建立。</p>';
        savedHost.querySelectorAll('[data-saved-ticker]').forEach(b=>b.onclick=()=>open(rows.find(d=>d.ticker===b.dataset.savedTicker) || {ticker:b.dataset.savedTicker,name:'本次榜單未收錄，請重新核對行情與財報。',board:market==='tw'?'tw_watch':'watch',flags:['data_thin']}));
      } catch(e) {
        if(!savedHost.isConnected)return;
        savedHost.innerHTML='<p class="chart-note">私人研究卡暫時無法載入，股票研究線索仍可使用。</p><button class="btn ghost" type="button">重試研究卡</button>';
        savedHost.querySelector('button').onclick=loadSaved;
      }
    }
    if(sb)loadSaved();else savedHost.textContent='尚未連線。';
  }

  const fields = [
    ['thesis','投資論點','公司如何創造並保留價值？'],
    ['moat','護城河假設','客戶為何難以替換它？競爭者為何難以複製？尚未確認請寫「待查」。'],
    ['variant','市場可能忽略什麼','市場普遍怎麼看？你的不同判斷依據是什麼？'],
    ['evidence','支持證據','列出已確認的事實；附原文連結、文件日期與段落。'],
    ['counter_evidence','反面證據','有哪些事實不支持論點？附來源與日期。'],
    ['invalidation','論點失效條件','哪個可觀察的結果會讓你放棄這個論點？'],
    ['next_step','下一步驗證','要查哪份文件、哪個指標或哪個里程碑？'],
  ];
  const drafts = new Map();
  const pending = new Set();
  function hasDrafts() { return drafts.size > 0; }
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', e=>{if(hasDrafts()){e.preventDefault();e.returnValue='';}});

  function mountCard(el, d, market, sb) {
    const a = assess(d,market), key = `${market}:${d.ticker}`;
    el.innerHTML = `<h3>投資研究卡</h3><p class="chart-note">${esc(a.clues.map(c=>c.title).join('、') || '尚無足夠線索')}。護城河與估值尚待驗證。</p><details class="research-editor"><summary>編輯研究卡</summary><div class="research-form-host"></div></details>`;
    const details = el.querySelector('details'), host = el.querySelector('.research-form-host');
    let loaded = false;
    details.addEventListener('toggle', async()=>{
      if (!details.open || loaded) return;
      loaded = true;
      host.innerHTML = '<p role="status">載入研究卡…</p>';
      try {
        const auth = await sb.auth.getSession();
        if (auth.error) throw auth.error;
        if (!auth.data?.session) { host.innerHTML='<p>請先登入，才能儲存私人研究卡。</p>';loaded=false;return; }
        if (pending.has(key)) { host.innerHTML='<p role="status">此研究卡正在儲存，請稍後收合再開啟。</p>';loaded=false;return; }
        const {data,error} = await sb.from('research_cards').select('*').eq('market',market).eq('ticker',d.ticker).maybeSingle();
        if (error) throw error;
        if (!host.isConnected) return;
        renderForm(drafts.get(key) || data || {});
      } catch(e) {
        if (!host.isConnected) return;
        host.innerHTML='<p role="status">研究卡暫時無法載入；請確認已登入並稍後重試。若持續失敗，請聯絡管理者。</p><button class="btn ghost" type="button">重試</button>';
        host.querySelector('button').onclick=()=>{loaded=false;details.open=false;requestAnimationFrame(()=>{details.open=true;});};
      }
    });
    function renderForm(data) {
      host.innerHTML = `<form class="research-form">
        <p class="chart-note">只有你能讀取這張卡。文字是你的研究假設；請保留可核對的原文與日期。</p>
        <label for="rc-status">研究狀態</label><select id="rc-status" name="status" class="field glass">${Object.entries(statuses).map(([k,v])=>`<option value="${k}" ${data.status===k?'selected':''}>${v}</option>`).join('')}</select>
        ${fields.map(([id,label,hint])=>`<label for="rc-${id}">${label}</label><textarea id="rc-${id}" name="${id}" rows="3" maxlength="${id.includes('evidence')?8000:4000}" class="field glass" placeholder="${esc(hint)}">${esc(data[id] || '')}</textarea>`).join('')}
        <label for="rc-review_on">下次驗證日期</label><input id="rc-review_on" name="review_on" type="date" class="field glass" value="${esc(data.review_on || '')}">
        <p class="chart-note">到期時在這張卡顯示提醒；不會自動傳送訊息。</p>
        <div class="research-actions"><button type="submit" class="btn primary">儲存研究卡</button><button type="button" class="btn ghost" data-discard>還原未儲存內容</button></div>
        <p class="chart-note research-save-status" role="status">${drafts.has(key)?'尚未儲存；關閉詳情後，本次瀏覽仍保留草稿。':data.updated_at?'已儲存 · '+esc(data.updated_at.slice(0,10)):'尚未建立研究卡'}</p>
        <p class="research-due" role="status"></p>
      </form>`;
      const form = host.querySelector('form'), message = host.querySelector('.research-save-status');
      const read = ()=>Object.fromEntries(new FormData(form).entries());
      const due = ()=>{const v=form.elements.review_on.value;host.querySelector('.research-due').textContent=v && v<=today() && form.elements.status.value!=='rejected' ? '已到驗證日期：請核對新資料與反證。':'';};
      due();
      form.oninput = ()=>{drafts.set(key,read());message.textContent='尚未儲存；關閉詳情後，本次瀏覽仍保留草稿。';due();};
      form.querySelector('[data-discard]').onclick=()=>{drafts.delete(key);loaded=false;details.open=false;requestAnimationFrame(()=>{details.open=true;});};
      form.onsubmit = async e=>{
        e.preventDefault();
        if(pending.has(key))return;
        const values=read();
        const payload={...values,review_on:values.review_on||null,market,ticker:d.ticker,updated_at:new Date().toISOString()};
        drafts.set(key,values);pending.add(key);
        const controls=[...form.elements];controls.forEach(x=>x.disabled=true);message.textContent='儲存中…';
        try {
          const {error}=await sb.from('research_cards').upsert(payload,{onConflict:'user_id,market,ticker'});
          if(error)throw error;
          drafts.delete(key);message.textContent='已儲存研究卡';
        } catch(e) { message.textContent='儲存失敗，草稿仍保留。請重試。'; }
        finally {pending.delete(key);controls.forEach(x=>x.disabled=false);}
      };
    }
  }
  globalThis.Research={assess,renderRadar,mountCard,hasDrafts};
})();
