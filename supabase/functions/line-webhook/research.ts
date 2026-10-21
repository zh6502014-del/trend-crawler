// Keep assessment rules aligned with docs/research.js; parity is checked in line_research tests.
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const pct = v => num(v) ? `${(v * 100).toFixed(1)}%` : '未知';
  const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(new Date());
  const dateAge = (day, now) => /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? (Date.parse(now) - Date.parse(day)) / 86400000 : Infinity;
  const risks = {short_runway:'現金跑道不足一年',deep_loss:'虧損深',high_debt:'負債高',dilution:'股本稀釋',high_pledge:'董監設質高',thin_volume:'成交薄'};
  const statuses = {researching:'研究中',watching:'持續觀察',rejected:'論點不成立'};

  export function assess(d, market, now = today()) {
    const clues = [], concerns = [], gaps = [];
    for (const flag of d.flags || []) if (risks[flag]) concerns.push(risks[flag]);
    if (num(d.runway_months) && d.runway_months < 12 && !concerns.includes(risks.short_runway)) concerns.push(risks.short_runway);
    if (!num(d.rev_yoy)) gaps.push('缺營收年增');
    if (!num(d.rs_6m)) gaps.push('缺相對股價表現');
    if (dateAge(d.as_of, now) > 7 || dateAge(d.as_of, now) < 0) gaps.push('行情日期缺漏或待更新');
    if ((d.flags || []).includes('data_thin')) gaps.push('財報資料不足');
    if (d.scoring_version === 'legacy-unverified') gaps.push('舊版榜單尚未完成批次驗證');
    if ((d.flags || []).includes('stale_fundamentals') || (num(d.fundamentals_age_days) && d.fundamentals_age_days > 7)
      || (market === 'us' && d.fundamentals_fetched_at && dateAge(d.fundamentals_fetched_at.slice(0,10),now) > 7)) gaps.push('基本面待更新');
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

const labels = {priority:'優先研究',risk:'風險待查',incomplete:'資料待補',observe:'持續觀察'};
const text = (value, choices = []) => [{type:'text',text:value, ...(choices.length ? {quickReply:{items:choices.slice(0,13).map(([label,command])=>({type:'action',action:{type:'message',label:label.slice(0,20),text:command}}))}} : {})}];
const board = tw => tw ? 'tw_latest_board' : 'latest_board';
const marketLabel = tw => tw ? '台股' : '美股';
export async function research(cmd, db, ctx = {}) {
  const tw = !!cmd.tw, market = tw ? 'tw' : 'us', prefix = marketLabel(tw);
  const now = ctx.today || today();
  if (cmd.cmd === 'researchcards') {
    const uid = await db.ownerId();
    const rows = await db.get(`research_cards?user_id=eq.${uid}&market=eq.${market}&select=ticker,status,thesis,review_on&order=review_on.asc.nullslast,ticker.asc&limit=30`);
    rows.sort((a,b)=>Number(b.status!=='rejected' && b.review_on && b.review_on<=now)-Number(a.status!=='rejected' && a.review_on && a.review_on<=now));
    const shown=rows.slice(0,8);
    return text(`${prefix}我的研究（最早驗證的 30 張內，顯示 ${shown.length} 張）\n`+(shown.length ? shown.map(r=>`${r.ticker} · ${statuses[r.status] || '研究中'}${r.review_on ? `\n${r.review_on<=now && r.status!=='rejected'?'已到驗證日期':'驗證日期'} ${r.review_on}`:''}\n${String(r.thesis || '尚未填寫論點').slice(0,160)}`).join('\n\n') : '還沒有研究卡，開啟網頁個股頁即可建立。'),shown.map(r=>[r.ticker+' 研究卡','儀表板 '+r.ticker]));
  }
  if (cmd.cmd === 'researchstock') {
    const rows=await db.get(`${board(tw)}?ticker=eq.${encodeURIComponent(cmd.ticker)}&limit=1`);
    if (!rows.length) return text(`找不到 ${cmd.ticker} 的研究資料。`);
    const d=rows[0], a=assess(d,market,now);
    return text(`${d.ticker} ${d.name || ''} · ${labels[a.bucket]}\n資料截至 ${d.as_of || '未知'}\n\n`+
      a.clues.map(c=>`${c.title}：${c.detail}`).join('\n')+`\n風險：${a.concerns.join('、') || '尚無已標記風險'}\n資料缺口：${a.gaps.join('、') || '未發現上述欄位缺口'}\n下一步：${a.next}\n研究線索不代表買進建議。`,[[cmd.ticker+' 個股',cmd.ticker],['私人研究卡','儀表板 '+cmd.ticker],['研究雷達',prefix+'研究雷達']]);
  }
  if (cmd.cmd === 'value') {
    if (!tw) return text('成長估值篩選目前提供台股。相對估值是股票池內的比較分數，並非合理股價。',[['台股成長估值','台股成長估值']]);
    // Null values cannot qualify. The server may still run the pre-valuation schema.
    const pool=await db.get('tw_latest_board?board=eq.tw_main&order=rank.asc&limit=500');
    const selected=pool.filter(r=>num(r.growth)&&r.growth>=60&&num(r.rel_val)&&r.rel_val>=60)
      .sort((a,b)=>b.rel_val-a.rel_val || a.ticker.localeCompare(b.ticker)).slice(0,8);
    const body=selected.map(r=>`${r.ticker} ${r.name || ''}｜成長 ${r.growth.toFixed(0)}／相對估值 ${r.rel_val.toFixed(0)}\n${r.as_of || '日期未知'} · ${labels[assess(r,'tw',now).bucket]}`).join('\n\n');
    return text('台股成長估值\n範圍：主榜前 500 檔；成長與相對估值皆 ≥60，按相對估值排序。\n相對估值越高表示在目前股票池內成長與便宜程度較高，不是絕對低估。\n\n'+(body || (pool.some(r=>num(r.rel_val))?'目前沒有符合門檻的股票。':'目前缺少相對估值資料，待資料更新後再試。')),selected.map(r=>[r.ticker+' 研究','研究 '+r.ticker]));
  }
  const rows=await db.get(`${board(tw)}?board=eq.${tw?'tw_main':'main'}&order=rank.asc&limit=500`);
  const category=labels[cmd.category] ? cmd.category : 'priority';
  const all=rows.map(d=>({d,a:assess(d,market,now)})).filter(x=>x.a.bucket===category)
    .sort((a,b)=>b.a.clues.length-a.a.clues.length || a.d.ticker.localeCompare(b.d.ticker));
  const shown=all.slice(0,8);
  return text(`${prefix}研究雷達 · ${labels[category]}\n範圍：主榜前 500 檔；符合 ${all.length} 檔，顯示 ${shown.length} 檔。\n`+
    (shown.map(({d,a})=>`\n${d.ticker} ${d.name || ''}（${d.as_of || '日期未知'}）\n${[...a.clues.map(c=>c.title),...a.concerns,...a.gaps].join('、') || '待觀察'}`).join('\n') || '\n目前沒有符合這個分類的股票。')+
    '\n\n優先研究須至少兩項線索且無已標記風險或資料缺口；門檻尚未經報酬驗證。',
    [...shown.map(({d})=>[d.ticker+' 研究','研究 '+d.ticker]),...Object.entries(labels).filter(([k])=>k!==category).map(([,v])=>[v,prefix+'研究雷達 '+v])]);
}
