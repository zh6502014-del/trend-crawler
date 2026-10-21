// Conversation state contains navigation only; no transcript or private notes are sent to AI.
const taiwan = (t) => /^\d{4,6}[A-Z]?$/.test(t || '');
const symbol = (t) => /^(?:[A-Z][A-Z.\-]{0,5}|\d{4,6}[A-Z]?)$/.test(t);
const message = (text) => ({ cmd: 'message', text });
export const cleanName = (text) => String(text || '').normalize('NFKC').replace(/[*%,()\\]/g, '').trim().slice(0, 30);

export async function resolveInput(raw, parse, db, session = {}, aliases = {}) {
  let text = String(raw || '').normalize('NFKC').trim();
  // Strip only polite wrappers, never a note body or a destructive verb.
  text = text.replace(/^(?:請幫我|幫我|麻煩幫我|請)\s*/, '');
  if (!/^(筆記|note\b)/i.test(text)) text = text.replace(/[？?！!。]+$/, '').trim();
  if (/^(?:不要|先不要|別|不想)/.test(text)) return message('沒有執行變更。需要操作時，請明確輸入股票與指令。');
  let market = session.market || 'us';
  const explicit = text.match(/^(美股|台股|us|tw)\s*(.*)$/i);
  if (explicit) market = /台股|tw/i.test(explicit[1]) ? 'tw' : 'us';
  const subject = explicit ? explicit[2].trim() : text;
  if (/^(?:我的設定|個人偏好|偏好設定)$/.test(text)) return {cmd:'preferences'};
  if (/^(?:清除偏好|忘記偏好)$/.test(text)) return {cmd:'forgetpreferences'};
  const preference = text.match(/^(?:預設|以後預設|我主要看)\s*(台股|美股)$/);
  if (preference) return {cmd:'setpreference',tw:preference[1]==='台股'};
  if (/^(?:記住這檔|記住目前股票)$/.test(text)) return session.ticker
    ? {cmd:'remember',ticker:session.ticker} : message('先查詢一檔股票，再傳送「記住這檔」。');
  if (/^(?:系統狀態|送達狀態|機器人狀態)$/.test(text)) return {cmd:'status'};
  const radar = subject.match(/^(?:研究雷達|找研究機會|有哪些值得研究的股票)(?:\s*(優先研究|風險待查|資料待補|持續觀察))?$/);
  if (radar) return {cmd:'radar',tw:market==='tw',category:({'優先研究':'priority','風險待查':'risk','資料待補':'incomplete','持續觀察':'observe'})[radar[1]] || 'priority'};
  if (/^(?:成長估值|成長與估值|找成長又便宜的股票)$/.test(subject)) return {cmd:'value',tw:market==='tw'};
  if (/^(?:我的研究|研究卡|到期研究)$/.test(subject)) return {cmd:'researchcards',tw:market==='tw'};
  if (/^(?:今天有什麼變化|今天怎麼樣|今天重點)$/.test(subject)) return {cmd:'today',tw:market==='tw'};
  if (/^(?:看看我的自選|我的自選股|看自選清單)$/.test(subject)) return {cmd:'watch'};
  const naturalStock = subject.match(/^(?:看看|查一下|查詢|查看)\s*(.+?)(?:的資料)?$/) || subject.match(/^(.+?)(?:怎麼樣|的研究重點|值得研究嗎)$/);
  if (naturalStock && !/^查看解讀/.test(subject) && !['自選','筆記','提醒','研究','結果','解讀'].includes(naturalStock[1])) {
    return resolveInput((/研究/.test(subject)?'研究 ':'')+naturalStock[1],parse,db,session,aliases);
  }
  if (/^(?:新話題|重設對話)$/.test(text)) return { cmd: 'reset' };
  if (/^(?:下一頁|next|更多)$/i.test(text)) return { cmd: 'top', tw: market === 'tw', page: Math.min(15, (session.page || 1) + 1) };
  if (/^(?:上一頁|previous)$/i.test(text)) return { cmd: 'top', tw: market === 'tw', page: Math.max(1, (session.page || 1) - 1) };
  if (/^(?:筆記|我的筆記|筆記列表)$/.test(text)) return { cmd: 'notes', q: '' };
  const search = text.match(/^(?:搜尋筆記|查筆記)\s+(.+)$/);
  if (search) return { cmd: 'notes', q: cleanName(search[1]) };

  const currentActions = {
    '加入自選': 'add', '把它加入自選': 'add', '把這檔加入自選': 'add',
    '移出自選': 'del', '把它移出自選': 'del', '設提醒': 'alertmenu',
    '提醒這檔': 'alertmenu', '取消提醒': 'delalert', '看筆記': 'readnote',
    '法人': 'smart', '看法人': 'smart', '這檔': 'stock',
    '解讀': 'explain', '個股解讀': 'explain', '解釋這檔': 'explain', '這檔為什麼分數變高': 'explain',
    '查看解讀': 'explanation', '查看結果': 'explanation', '研究這檔':'researchstock',
  };
  if (currentActions[text]) return session.ticker
    ? { cmd: currentActions[text], ticker: session.ticker }
    : currentActions[text] === 'explain' ? { cmd: 'explainhelp' } : message('先輸入股票代號或名稱，再選擇這個操作。');

  let action, query;
  const namedAdd = text.match(/^(?:把|將)?\s*(.+?)\s*(加入|加到|移出|移除)(?:我的)?自選(?:清單)?$/);
  const namedPrefix = text.match(/^(加|新增|刪|刪除|解讀|查看解讀|讀筆記|清除筆記|研究)\s+([^\s,，、]+)$/);
  if (namedAdd) { action = /加入|加到/.test(namedAdd[2]) ? 'add' : 'del'; query = namedAdd[1]; }
  else if (namedPrefix) {
    action = ({ 加: 'add', 新增: 'add', 刪: 'del', 刪除: 'del', 解讀: 'explain', 查看解讀: 'explanation', 讀筆記: 'readnote', 清除筆記: 'clearnote', 研究:'researchstock' })[namedPrefix[1]];
    query = namedPrefix[2];
  }
  if (query) {
    const q = cleanName(query), upper = q.toUpperCase();
    if (aliases[q.toLowerCase()]) return { cmd: action, ticker: aliases[q.toLowerCase()] };
    if (symbol(upper)) {
      // Prefer an actual symbol over a company-name match (e.g. META), but
      // don't interpret a short company name such as Apple as ticker APPLE.
      const view = taiwan(upper) ? 'tw_entities' : 'entities';
      if (taiwan(upper) || (await db.get(`${view}?ticker=eq.${encodeURIComponent(upper)}&select=ticker&limit=1`)).length)
        return { cmd: action, ticker: upper };
    }
    const view = /[\u3400-\u9fff]/.test(q) ? 'tw_entities' : 'entities';
    const rows = await db.get(`${view}?name=ilike.*${encodeURIComponent(q)}*&select=ticker,name&limit=6`);
    const exact = rows.filter((r) => r.name === q);
    const matches = exact.length === 1 ? exact : rows;
    if (matches.length === 1) return { cmd: action, ticker: matches[0].ticker };
    if (!matches.length) return symbol(upper) ? { cmd: action, ticker: upper } : message(`找不到「${q}」，請輸入股票代號。`);
    const verb = ({ add: '加', del: '刪', explain: '解讀', explanation: '查看解讀', readnote: '讀筆記', clearnote: '清除筆記', researchstock:'研究' })[action];
    return { cmd: 'message', text: `「${q}」符合多檔，請選擇：`, choices: matches.map((r) => ({ label: `${r.ticker} ${r.name}`, text: `${verb} ${r.ticker}` })) };
  }
  // Name lookup must establish the resolved ticker before a follow-up action.
  if (aliases[text.toLowerCase()]) return { cmd: 'stock', ticker: aliases[text.toLowerCase()] };
  const parsed = parse(text);
  if ((/^[\u3400-\u9fff]{2,12}$/.test(text) && parsed.cmd === 'unknown') ||
      (/^[A-Za-z][A-Za-z .-]{1,50}$/.test(text) && ['stock', 'unknown'].includes(parsed.cmd))) {
    const q = cleanName(text);
    const view = /[\u3400-\u9fff]/.test(q) ? 'tw_entities' : 'entities';
    if (parsed.cmd === 'stock' && (await db.get(`${view}?ticker=eq.${encodeURIComponent(parsed.ticker)}&select=ticker&limit=1`)).length) return parsed;
    const rows = await db.get(`${view}?name=ilike.*${encodeURIComponent(q)}*&select=ticker,name&limit=6`);
    const exact = rows.filter((r) => r.name?.toLowerCase() === q.toLowerCase());
    if (exact.length === 1 || rows.length === 1) return { cmd: 'stock', ticker: (exact[0] || rows[0]).ticker };
    if (rows.length > 1) return { cmd: 'message', text: `「${q}」符合多檔，請選擇：`, choices: rows.map((r) => ({ label: `${r.ticker} ${r.name}`, text: r.ticker })) };
  }
  if (explicit && /美股|us/i.test(explicit[1])) text = explicit[2] || '榜單';
  const cmd = parse(text);
  if (cmd.cmd === 'note' && !cmd.text) cmd.cmd = 'readnote';
  if (['top', 'today', 'week', 'report', 'industry', 'smart', 'more'].includes(cmd.cmd) && !cmd.ticker) cmd.tw = market === 'tw';
  return cmd;
}

export function nextSession(session, cmd) {
  if (['reset','forgetpreferences'].includes(cmd.cmd)) return { market: 'us', ticker: null, page: 1 };
  const out = { market: session.market || 'us', ticker: session.ticker || null, page: session.page || 1 };
  if (typeof cmd.tw === 'boolean') {
    const market = cmd.tw ? 'tw' : 'us';
    if (market !== out.market) { out.ticker = null; out.page = 1; }
    out.market = market;
  }
  if (cmd.ticker) {
    const market = taiwan(cmd.ticker) ? 'tw' : 'us';
    if (market !== out.market) out.page = 1;
    out.market = market; out.ticker = cmd.ticker;
  }
  if (cmd.cmd === 'top') out.page = cmd.page || 1;
  return out;
}

export function sessionWithPreferences(saved, preferences = {}, now = Date.now()) {
  if (saved && now - Date.parse(saved.updated_at) < 86400000) return saved;
  const market = preferences.market || 'us';
  const ticker = preferences.focus_ticker;
  return {market,ticker:ticker && (taiwan(ticker)?'tw':'us')===market ? ticker : null,page:1};
}
