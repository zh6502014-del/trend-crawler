// LINE chat bot for ONE person (the owner). Replies are free (reply messages are not counted in the LINE quota).
// Secrets (Supabase > Edge Functions > Secrets): LINE_CHANNEL_SECRET, LINE_CHANNEL_TOKEN, LINE_USER_ID, DASHBOARD_URL (optional).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Deploy with JWT verification OFF (LINE has no JWT);
// the request is authenticated by the LINE signature instead.
const env = (k) => (typeof Deno !== "undefined" ? Deno.env.get(k) : process.env[k]) || "";

const TAGS = { insider_cluster: "內部人群買", insider_buy: "內部人買進", activist_13d: "13D 積極持有", new_5pct: "新增 5% 持有人" };
const FLAGS = { short_runway: "現金撐不久", deep_loss: "虧損嚴重", high_debt: "高負債", dilution: "稀釋", thin_volume: "成交量薄",
  micro_cap: "微型股", crowded: "擁擠", data_thin: "資料不足" };
const COLORS = { growth: "#2fbf8f", validated: "#6f86f2", accessibility: "#f2b44a", attention: "#ee6a7b" };

// ── formatting helpers ──────────────────────────────────────────────────────
export const usd = (n) => {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  return (n < 0 ? "-" : "") + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "K" : a.toFixed(0));
};
export const pct = (n, sign = true) => (n == null || isNaN(n) ? "—" : (sign && n > 0 ? "+" : "") + (n * 100).toFixed(0) + "%");
const num = (n, d = 1) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(d));

// ── data freshness: how many US trading days behind is the data? (weekdays only; holidays are not modelled) ──
export function dataAge(asOf, now = new Date()) {
  const m = String(asOf || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { label: "資料日期未知", stale: true, lag: null };
  const d0 = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const ref = new Date(now.getTime() - 5 * 3600000); // roughly US Eastern
  const d1 = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  let lag = 0;
  for (let t = d0 + 86400000; t <= d1; t += 86400000) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) lag++; }
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return lag >= 2
    ? { label: `資料截至 ${day}（已落後 ${lag} 個交易日，可能休市或爬蟲沒跑）`, stale: true, lag }
    : { label: `資料截至 ${day}`, stale: false, lag };
}

// ── quick replies (buttons under the last message) ──
const qr = (label, text) => ({ type: "action", action: { type: "message", label: String(label).slice(0, 20), text } });
export const withQuick = (msgs, items) => {
  if (!msgs.length || !items.length) return msgs;
  const out = msgs.slice();
  out[out.length - 1] = { ...out[out.length - 1], quickReply: { items: items.slice(0, 13) } };
  return out;
};
const MAIN_QUICK = [qr("榜單", "榜單"), qr("自選", "自選"), qr("今日", "今日"), qr("週報", "週報"), qr("大戶", "大戶")];

// ── name / alias lookup (stock names in the DB are mostly English; common Chinese names go here) ──
export const ALIASES = {
  "輝達": "NVDA", "英偉達": "NVDA", "特斯拉": "TSLA", "蘋果": "AAPL", "微軟": "MSFT", "谷歌": "GOOGL", "亞馬遜": "AMZN",
  "超微": "AMD", "英特爾": "INTC", "網飛": "NFLX", "帕蘭泰爾": "PLTR", "台積電": "TSM", "美光": "MU", "高通": "QCOM",
};
export const cleanQuery = (q) => String(q || "").normalize("NFKC").replace(/[*%,()\\]/g, "").trim().slice(0, 30);

// ── command parsing ─────────────────────────────────────────────────────────
export function parseCommand(raw) {
  let t = String(raw || "").normalize("NFKC").trim();
  if (!t) return { cmd: "help" };
  const low = t.toLowerCase();
  if (/^(說明|help|\?|指令|選單)$/.test(low)) return { cmd: "help" };
  if (/^(設定選單|setup menu)$/.test(low)) return { cmd: "menu" };
  const pg = low.match(/^(榜單|前十|top|top10|主榜)\s*(?:第)?\s*(\d{1,2})?\s*(?:頁)?$/);
  if (pg) return { cmd: "top", page: Math.min(15, Math.max(1, Number(pg[2] || 1))) };
  if (/^(下一頁|next|更多)$/.test(low)) return { cmd: "top", page: 2 };
  if (/^(自選|我的自選|watch|watchlist)$/.test(low)) return { cmd: "watch" };
  if (/^(大戶|內部人|smart)$/.test(low)) return { cmd: "smart" };
  let sm = t.match(/^(大戶|內部人|smart)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (sm) return { cmd: "smart", ticker: sm[2].toUpperCase() };
  if (/^(募資|regcf|reg cf)$/.test(low)) return { cmd: "raise" };
  if (/^(成績單|成績|report)$/.test(low)) return { cmd: "report" };
  if (/^(提醒清單|提醒列表|我的提醒|alerts)$/.test(low)) return { cmd: "alerts" };
  if (/^(額度|用量|quota)$/.test(low)) return { cmd: "quota" };
  if (/^(今日|今天|today)$/.test(low)) return { cmd: "today" };
  if (/^(週報|周報|本週|week|weekly)$/.test(low)) return { cmd: "week" };
  let m = t.match(/^(刪提醒|刪除提醒|取消提醒)\s*([A-Za-z][A-Za-z.\-]{0,5})$/);
  if (m) return { cmd: "delalert", ticker: m[2].toUpperCase() };
  m = t.match(/^(提醒|alert)\s*([A-Za-z][A-Za-z.\-]{0,5})\s*(分數|排名|score|rank)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { cmd: "alert", ticker: m[2].toUpperCase(), metric: /分數|score/i.test(m[3]) ? "score" : "rank", op: m[4], value: Number(m[5]) };
  m = t.match(/^(提醒|alert)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "alertmenu", ticker: m[2].toUpperCase() };
  m = t.match(/^(加|新增|add)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "add", ticker: m[2].toUpperCase() };
  m = t.match(/^(刪|刪除|移除|del|remove)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "del", ticker: m[2].toUpperCase() };
  m = t.match(/^(筆記|note)\s*([A-Za-z][A-Za-z.\-]{0,5})\s*([\s\S]*)$/i);
  if (m) return { cmd: "note", ticker: m[2].toUpperCase(), text: m[3].trim() };
  m = t.match(/^(產業|industry)\s*(.*)$/i);
  if (m) return { cmd: "industry", q: m[2].trim() };
  m = t.match(/^(?:比較|比|compare)\s*([A-Za-z][A-Za-z.\-]{0,5})\s*(?:和|跟|與|vs\.?|,|，|\s)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i)
    || t.match(/^([A-Za-z][A-Za-z.\-]{0,5})\s*(?:vs\.?|比|對)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "compare", a: m[1].toUpperCase(), b: m[2].toUpperCase() };
  m = t.match(/^(?:把|將)?\s*([A-Za-z][A-Za-z.\-]{0,5})\s*(?:加入?|新增)(?:到)?(?:我的)?自選(?:清單)?$/);
  if (m) return { cmd: "add", ticker: m[1].toUpperCase() };
  m = t.match(/^(?:把|將)?\s*([A-Za-z][A-Za-z.\-]{0,5})\s*(?:移出|移除|刪除|刪掉|拿掉)(?:自選)?(?:清單)?$/);
  if (m) return { cmd: "del", ticker: m[1].toUpperCase() };
  m = t.match(/^(?:查|看|看看|stock)?\s*([A-Za-z][A-Za-z.\-]{0,5})\s*(?:怎麼樣|如何|好嗎|呢|嗎|分數|卡片|[?？])?$/i);
  if (m) return { cmd: "stock", ticker: m[1].toUpperCase(), raw: m[1] };
  return { cmd: "unknown", text: t };
}

// ── flex builders ───────────────────────────────────────────────────────────
const txt = (text, o = {}) => ({ type: "text", text: String(text), wrap: true, size: "sm", ...o });
const row = (label, value, o = {}) => ({
  type: "box", layout: "horizontal", contents: [txt(label, { color: "#8a93a6", flex: 3 }), txt(value, { align: "end", flex: 4, ...o })],
});
const bar = (label, value, color) => ({
  type: "box", layout: "vertical", spacing: "xs", margin: "sm", contents: [
    { type: "box", layout: "horizontal", contents: [txt(label, { size: "xs", color: "#8a93a6" }), txt(num(value, 0), { size: "xs", align: "end" })] },
    { type: "box", layout: "vertical", height: "6px", backgroundColor: "#2a3142", cornerRadius: "3px", contents: [
      { type: "box", layout: "vertical", width: Math.max(2, Math.min(100, Math.round(value || 0))) + "%", height: "6px", backgroundColor: color, cornerRadius: "3px", contents: [{ type: "filler" }] },
    ] },
  ],
});
const bubble = (body, footer) => ({
  type: "bubble", size: "mega",
  styles: { body: { backgroundColor: "#141a28" }, footer: { backgroundColor: "#141a28" } },
  body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
  ...(footer ? { footer: { type: "box", layout: "vertical", contents: footer } } : {}),
});
const flex = (altText, contents) => ({ type: "flex", altText: String(altText).slice(0, 380), contents });
const link = (url, label) => ({ type: "button", style: "primary", height: "sm", color: "#4f6cf0", action: { type: "uri", label, uri: url } });
const tapRow = (left, mid, right, tapText) => ({
  type: "box", layout: "horizontal", paddingAll: "6px", spacing: "sm", action: { type: "message", label: String(tapText).slice(0, 20), text: tapText },
  contents: [txt(left, { flex: 1, color: "#8a93a6", size: "xs" }), txt(mid, { flex: 4, weight: "bold", color: "#eef1f8" }), txt(right, { flex: 2, align: "end", color: "#eef1f8" })],
});

const dataLine = (asOf) => { const a = dataAge(asOf); return txt(a.label, { size: "xs", color: a.stale ? "#ee6a7b" : "#8a93a6", margin: "md" }); };

export function deepLink(base, ticker) { return base ? base.replace(/\/?$/, "/") + "#t=" + encodeURIComponent(ticker) : ""; }

export function stockCard(s, smart, dash, extra = {}) {
  const tags = (smart && smart.tags || []).map((t) => TAGS[t] || t);
  const flags = (s.flags || []).map((f) => FLAGS[f] || f);
  const delta = s.score_7d != null ? s.score - s.score_7d : null;
  const body = [
    { type: "box", layout: "horizontal", contents: [
      { type: "box", layout: "vertical", flex: 4, contents: [txt(s.ticker, { size: "xl", weight: "bold", color: "#eef1f8" }), txt(s.name || "", { size: "xs", color: "#8a93a6" })] },
      { type: "box", layout: "vertical", flex: 2, contents: [txt(num(s.score), { size: "xxl", weight: "bold", align: "end", color: "#eef1f8" }),
        txt(s.board === "main" ? "主榜 #" + s.rank : "觀察 #" + s.rank, { size: "xs", align: "end", color: "#8a93a6" })] },
    ] },
    ...(extra.spark ? [extra.spark, txt(`近 ${extra.n} 日分數 ${num(extra.first, 0)} → ${num(s.score, 0)}`, { size: "xs", color: "#8a93a6" })] : []),
    ...(delta != null ? [txt("7 日分數 " + (delta >= 0 ? "+" : "") + num(delta), { size: "xs", color: delta >= 0 ? "#2fbf8f" : "#ee6a7b" })] : []),
    { type: "separator", margin: "md", color: "#2a3142" },
    bar("成長", s.growth, COLORS.growth), bar("驗證", s.validated, COLORS.validated),
    bar("進場", s.accessibility, COLORS.accessibility), bar("擁擠（越高越擠）", s.attention, COLORS.attention),
    { type: "separator", margin: "md", color: "#2a3142" },
    row("營收年增", pct(s.rev_yoy)), row("6 個月強度", pct(s.rs_6m)), row("市值", usd(s.mkt_cap)), row("日成交額", usd(s.dollar_vol)),
    row("產業", s.sector || "—"),
    ...(extra.sectorRank ? [row("產業內排名", `第 ${extra.sectorRank[0]} / ${extra.sectorRank[1]}`)] : []),
    ...(tags.length ? [row("大戶", tags.join("、"), { color: "#2fbf8f", weight: "bold" })] : []),
    ...(flags.length ? [row("風險", flags.join("、"), { color: "#ee6a7b" })] : []),
    dataLine(s.as_of),
  ];
  const url = deepLink(dash, s.ticker);
  return flex(`${s.ticker} 分數 ${num(s.score)}`, bubble(body, url ? [link(url, "在儀表板開啟")] : null));
}

export const daysLeft = (d, now = Date.now()) => {
  const n = Math.ceil((Date.parse(d) - now) / 86400000);
  return isNaN(n) ? "" : n < 0 ? "（已截止）" : n === 0 ? "（今天）" : `（剩 ${n} 天）`;
};

// last N scores as a tiny bar sparkline (flex boxes, oldest → newest)
export function sparkline(points) {
  if (!points || points.length < 2) return null;
  const v = points.map((p) => Number(p.score)), lo = Math.min(...v), hi = Math.max(...v), span = Math.max(hi - lo, 1);
  const bars = v.map((x, i) => ({
    type: "box", layout: "vertical", flex: 1, justifyContent: "flex-end", height: "34px", margin: i ? "2px" : "none",
    contents: [{ type: "box", layout: "vertical", height: Math.round(6 + 28 * (x - lo) / span) + "px", backgroundColor: i === v.length - 1 ? "#4f6cf0" : "#3a4258", cornerRadius: "2px", contents: [{ type: "filler" }] }],
  }));
  return { type: "box", layout: "horizontal", margin: "sm", contents: bars };
}

const fmtCmp = (label, v) => (v == null ? "—" : label === "營收年增" || label === "6 個月強度" ? pct(v) : label === "市值" ? usd(v) : label === "排名" ? "#" + v : num(v, label === "分數" ? 1 : 0));
export function compareCard(A, B) {
  const line = (label, f, hi = true) => {
    const a = f(A), b = f(B);
    const win = a == null || b == null || a === b ? 0 : ((a > b) === hi ? 1 : 2);
    return { type: "box", layout: "horizontal", margin: "sm", contents: [
      txt(label, { color: "#8a93a6", flex: 3, size: "xs" }),
      txt(fmtCmp(label, a), { flex: 3, align: "end", weight: win === 1 ? "bold" : "regular", color: win === 1 ? "#2fbf8f" : "#eef1f8" }),
      txt(fmtCmp(label, b), { flex: 3, align: "end", weight: win === 2 ? "bold" : "regular", color: win === 2 ? "#2fbf8f" : "#eef1f8" }),
    ] };
  };
  const body = [
    { type: "box", layout: "horizontal", contents: [txt("", { flex: 3 }), txt(A.ticker, { flex: 3, align: "end", weight: "bold", size: "lg", color: "#eef1f8" }), txt(B.ticker, { flex: 3, align: "end", weight: "bold", size: "lg", color: "#eef1f8" })] },
    { type: "separator", margin: "md", color: "#2a3142" },
    line("分數", (r) => r.score), line("排名", (r) => (r.board === "main" ? r.rank : null), false),
    line("成長", (r) => r.growth), line("驗證", (r) => r.validated), line("進場", (r) => r.accessibility), line("擁擠", (r) => r.attention, false),
    line("營收年增", (r) => r.rev_yoy), line("6 個月強度", (r) => r.rs_6m), line("市值", (r) => r.mkt_cap, false),
  ];
  if (A.as_of) body.push(dataLine(A.as_of));
  return flex(`${A.ticker} vs ${B.ticker}`, bubble(body));
}

export function topCard(rows, title) {
  const body = [txt(title, { size: "md", weight: "bold", color: "#eef1f8" }), txt("點一列看詳細", { size: "xs", color: "#8a93a6" })];
  rows.forEach((r) => body.push(tapRow("#" + r.rank, r.ticker + "  " + (r.name || "").slice(0, 16), num(r.score), r.ticker)));
  if (rows[0] && rows[0].as_of) body.push(dataLine(rows[0].as_of));
  return flex(title, bubble(body));
}

export function helpText() {
  return [
    "指令（回覆免費）",
    "NRXS　個股卡片（下方按鈕：加自選、設提醒、大戶）",
    "輝達／apple　用名稱或常見別名找股票",
    "比較 NRXS ACOG　兩檔並排",
    "榜單 2　翻到第 2 頁",
    "榜單　主榜前 10 名",
    "自選　自選股現況",
    "加 NRXS／刪 NRXS　改自選",
    "筆記 NRXS 內容　寫筆記",
    "大戶　近期大戶訊號；大戶 NRXS 看單一個股",
    "提醒 NRXS　列出建議條件按鈕",
    "提醒 NRXS 分數>70　設提醒（觸發一次，每日摘要一起送）",
    "提醒清單／刪提醒 NRXS　管理提醒",
    "額度　本月 LINE 推播用量",
    "今日　與前一個交易日比的變化",
    "週報　7 日分數漲跌與自選股",
    "產業 生技　該產業前 5 名",
    "募資　Reg CF 近況",
    "成績單　對 SPY 表現",
    "設定選單　建立底部圖文選單",
  ].join("\n");
}

// ── data access (Supabase REST, service role) ───────────────────────────────
function makeDb(fetchFn) {
  const base = env("SUPABASE_URL").replace(/\/$/, ""), key = env("SUPABASE_SERVICE_ROLE_KEY");
  const h = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const sig = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(7500) } : {});
  const get = async (path) => {
    const r = await fetchFn(base + "/rest/v1/" + path, { headers: h, ...sig() });
    if (!r.ok) throw new Error("db " + r.status + " " + (await r.text()).slice(0, 200));
    return r.json();
  };
  const send = async (method, path, body, prefer) => {
    const r = await fetchFn(base + "/rest/v1/" + path, { method, headers: { ...h, Prefer: prefer || "return=minimal" }, body: body ? JSON.stringify(body) : undefined, ...sig() });
    if (!r.ok) throw new Error("db " + r.status + " " + (await r.text()).slice(0, 200));
  };
  let uid = env("OWNER_UID") || null;
  const ownerId = async () => {
    if (uid) return uid;
    const r = await fetchFn(base + "/auth/v1/admin/users?per_page=5", { headers: h });
    if (!r.ok) throw new Error("auth " + r.status);
    const users = (await r.json()).users || [];
    if (!users.length) throw new Error("no dashboard user yet");
    uid = users[0].id;
    return uid;
  };
  return { get, send, ownerId };
}

// ── pure summaries (exported for tests) ─────────────────────────────────────
export function todaySummary(cur, prev, watchRows, smart, raises) {
  const c = new Map(cur.map((r) => [r.ticker, r])), p = new Map(prev.map((r) => [r.ticker, r]));
  const lines = [];
  if (prev.length) {
    const entered = cur.filter((r) => r.rank <= 20 && !(p.get(r.ticker) && p.get(r.ticker).rank <= 20)).sort((a, b) => a.rank - b.rank);
    if (entered.length) lines.push("新進前 20 名：" + entered.slice(0, 8).map((r) => `${r.ticker}（第${r.rank}名）`).join("、"));
    const left = prev.filter((r) => r.rank <= 20 && !(c.get(r.ticker) && c.get(r.ticker).rank <= 20)).map((r) => r.ticker);
    if (left.length) lines.push("掉出前 20 名：" + left.slice(0, 8).join("、"));
    const jumps = cur.filter((r) => p.get(r.ticker) && r.score - p.get(r.ticker).score >= 8).sort((a, b) => (b.score - p.get(b.ticker).score) - (a.score - p.get(a.ticker).score)).slice(0, 5);
    if (jumps.length) lines.push("分數大幅上升：" + jumps.map((r) => `${r.ticker} +${(r.score - p.get(r.ticker).score).toFixed(0)}`).join("、"));
  }
  const big = cur.filter((r) => r.rank <= 20 && smart[r.ticker]).slice(0, 6);
  if (big.length) lines.push("前 20 名的大戶動向：" + big.map((r) => `${r.ticker}（${(smart[r.ticker].tags || []).map((t) => TAGS[t] || t).join("/")}）`).join("、"));
  const wl = [];
  for (const r of watchRows.cur) {
    const q = watchRows.prev.find((x) => x.ticker === r.ticker);
    if (q && q.score != null && r.score != null && Math.abs(r.score - q.score) >= 5) wl.push(`${r.ticker} ${q.score.toFixed(0)}→${r.score.toFixed(0)}`);
    else if (q && q.board !== r.board) wl.push(`${r.ticker} ${r.board === "main" ? "進入主榜" : "掉出主榜"}`);
  }
  if (wl.length) lines.push("自選異動：" + wl.join("、"));
  if (raises.length) lines.push("新的 Reg CF 募資：" + raises.slice(0, 6).map((r) => r.issuer || "?").join("、"));
  return lines;
}

export function weekSummary(rows, watch) {
  const ch = rows.filter((r) => r.score_7d != null && r.score != null).map((r) => ({ ...r, d: r.score - r.score_7d }));
  const up = [...ch].sort((a, b) => b.d - a.d).slice(0, 5), down = [...ch].sort((a, b) => a.d - b.d).slice(0, 3);
  const f = (r) => `${r.ticker} ${r.d >= 0 ? "+" : ""}${r.d.toFixed(1)}（${num(r.score_7d, 0)}→${num(r.score, 0)}）`;
  const lines = [];
  if (up.length) lines.push("7 日漲最多：\n" + up.filter((r) => r.d > 0).map(f).join("\n"));
  if (down.length) lines.push("7 日跌最多：\n" + down.filter((r) => r.d < 0).map(f).join("\n"));
  const w = ch.filter((r) => watch.has(r.ticker)).sort((a, b) => b.d - a.d);
  if (w.length) lines.push("自選 7 日：\n" + w.map(f).join("\n"));
  return lines;
}

// name search: alias table first, then company-name substring; returns messages, or null when nothing matches
export async function findByName(db, q) {
  const key = cleanQuery(q).toLowerCase();
  if (key.length < 2) return null;
  if (ALIASES[key]) return run({ cmd: "stock", ticker: ALIASES[key], noFallback: true }, db, {});
  const rows = await db.get(`latest_board?name=ilike.*${encodeURIComponent(key)}*&order=rank.asc&limit=5`);
  if (!rows.length) return null;
  if (rows.length === 1) return run({ cmd: "stock", ticker: rows[0].ticker, noFallback: true }, db, {});
  return withQuick([topCard(rows, `「${key}」符合 ${rows.length} 檔`)], rows.map((r) => qr(r.ticker, r.ticker)));
}

// ── command handlers → array of LINE message objects ────────────────────────
export async function run(cmd, db, ctx) {
  const dash = env("DASHBOARD_URL");
  const enc = encodeURIComponent;
  switch (cmd.cmd) {
    case "help": return withQuick([{ type: "text", text: helpText() }], MAIN_QUICK);
    case "stock": {
      const rows = await db.get(`latest_board?ticker=eq.${enc(cmd.ticker)}&limit=1`);
      if (!rows.length) {
        const found = cmd.noFallback ? null : await findByName(db, cmd.raw || cmd.ticker);
        return found || [{ type: "text", text: `找不到 ${cmd.ticker}。只有已評分的股票查得到。` }];
      }
      const [sm, hist] = await Promise.all([
        db.get(`smart_money?ticker=eq.${enc(cmd.ticker)}&limit=1`),
        db.get(`scores?ticker=eq.${enc(cmd.ticker)}&order=as_of.desc&limit=14&select=as_of,score`).catch(() => []),
      ]);
      const pts = hist.slice().reverse();
      const extra = { spark: sparkline(pts), n: pts.length, first: pts[0] && pts[0].score };
      if (rows[0].sector && rows[0].board === "main") {
        const peers = await db.get(`latest_board?board=eq.main&sector=eq.${enc(rows[0].sector)}&select=ticker&order=score.desc&limit=200`).catch(() => []);
        const i = peers.findIndex((r) => r.ticker === cmd.ticker);
        if (i >= 0) extra.sectorRank = [i + 1, peers.length];
      }
      let watching = null;
      try {
        const uid = await db.ownerId();
        watching = (await db.get(`user_watch?user_id=eq.${uid}&ticker=eq.${enc(cmd.ticker)}&select=ticker&limit=1`)).length > 0;
      } catch (_) { /* buttons still work without knowing the watch state */ }
      const t = cmd.ticker;
      return withQuick([stockCard(rows[0], sm[0], dash, extra)], [
        watching ? qr("移出自選", "刪 " + t) : qr("加入自選", "加 " + t), qr("設提醒", "提醒 " + t), qr("大戶訊號", "大戶 " + t), qr("榜單", "榜單"),
      ]);
    }
    case "compare": {
      if (cmd.a === cmd.b) return [{ type: "text", text: "請給兩檔不同的股票。" }];
      const rows = await db.get(`latest_board?ticker=in.(${enc(cmd.a)},${enc(cmd.b)})`);
      const A = rows.find((r) => r.ticker === cmd.a), B = rows.find((r) => r.ticker === cmd.b);
      if (!A || !B) return [{ type: "text", text: `找不到 ${!A ? cmd.a : cmd.b}。` }];
      return withQuick([compareCard(A, B)], [qr(cmd.a, cmd.a), qr(cmd.b, cmd.b), qr("榜單", "榜單")]);
    }
    case "alertmenu": {
      const rows = await db.get(`latest_board?ticker=eq.${enc(cmd.ticker)}&limit=1`);
      if (!rows.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有可設定的條件。` }];
      const r = rows[0], t = cmd.ticker, sc = Math.round(r.score);
      const opts = [`分數>${sc + 5}`, `分數>${sc + 10}`, `分數<${Math.max(0, sc - 5)}`];
      if (r.rank > 10) opts.push("排名<=10");
      if (r.rank > 20) opts.push("排名<=20");
      return withQuick([{ type: "text", text: `${t} 目前分數 ${num(r.score)}、${r.board === "main" ? "主榜" : "觀察"}第 ${r.rank} 名。\n點下方條件，或自己輸入，例如：提醒 ${t} 分數>${sc + 5}` }],
        opts.map((o) => qr(o, `提醒 ${t} ${o}`)));
    }
    case "top": {
      const pg = cmd.page || 1, from = (pg - 1) * 10;
      const rows = await db.get(`latest_board?board=eq.main&order=rank.asc&limit=10&offset=${from}`);
      if (!rows.length) return withQuick([{ type: "text", text: "沒有更多了。" }], [qr("榜單", "榜單")]);
      const more = rows.length === 10 && pg < 15 ? [qr("下一頁", "榜單 " + (pg + 1))] : [];
      return withQuick([topCard(rows, pg === 1 ? "主榜前 10 名" : `主榜第 ${from + 1}–${from + rows.length} 名`)], [...more, ...MAIN_QUICK]);
    }
    case "watch": {
      const uid = await db.ownerId();
      const w = await db.get(`user_watch?user_id=eq.${uid}&select=ticker,note`);
      if (!w.length) return [{ type: "text", text: "自選是空的。輸入「加 NRXS」開始。" }];
      const list = w.map((x) => enc(x.ticker)).join(",");
      const rows = await db.get(`latest_board?ticker=in.(${list})&order=score.desc`);
      const have = new Set(rows.map((r) => r.ticker));
      const missing = w.filter((x) => !have.has(x.ticker)).map((x) => x.ticker);
      const msgs = [topCard(rows, "自選 " + rows.length + " 檔")];
      if (missing.length) msgs.push({ type: "text", text: "今天沒有評分資料：" + missing.join("、") });
      return msgs;
    }
    case "add": case "del": case "note": {
      const uid = await db.ownerId();
      if (cmd.cmd === "del") {
        await db.send("DELETE", `user_watch?user_id=eq.${uid}&ticker=eq.${enc(cmd.ticker)}`);
        return [{ type: "text", text: `已從自選移除 ${cmd.ticker}。` }];
      }
      const ex = await db.get(`entities?ticker=eq.${enc(cmd.ticker)}&select=ticker&limit=1`);
      if (!ex.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有加入。` }];
      const row = { user_id: uid, ticker: cmd.ticker, updated_at: new Date().toISOString() };
      if (cmd.cmd === "note") row.note = cmd.text;
      await db.send("POST", "user_watch?on_conflict=user_id,ticker", [row], "resolution=merge-duplicates,return=minimal");
      return [{ type: "text", text: cmd.cmd === "note" ? `已更新 ${cmd.ticker} 的筆記。` : `已加入自選：${cmd.ticker}。` }];
    }
    case "smart": {
      if (cmd.ticker) {
        const one = await db.get(`smart_money?ticker=eq.${enc(cmd.ticker)}&limit=1`);
        if (!one.length || !(one[0].tags || []).length) return withQuick([{ type: "text", text: `${cmd.ticker} 目前沒有大戶訊號。` }], [qr(cmd.ticker, cmd.ticker)]);
        return withQuick([{ type: "text", text: `${cmd.ticker} 大戶訊號（參考線索，不計入分數）\n` + one[0].tags.map((x) => TAGS[x] || x).join("、") + `\n訊號分數 ${num(one[0].score, 0)}` }], [qr(cmd.ticker, cmd.ticker)]);
      }
      const rows = await db.get("smart_money?score=gt.0&order=score.desc&limit=10");
      if (!rows.length) return [{ type: "text", text: "目前沒有大戶訊號。" }];
      const body = [txt("大戶訊號（參考線索，不計入分數）", { weight: "bold", color: "#eef1f8" })];
      rows.forEach((r) => body.push(tapRow(num(r.score, 0), r.ticker, (r.tags || []).map((t) => TAGS[t] || t).join("、"), r.ticker)));
      return [flex("大戶訊號", bubble(body))];
    }
    case "industry": {
      if (!cmd.q) {
        const rows = await db.get("latest_board?board=eq.main&select=sector&limit=1000");
        const c = {};
        rows.forEach((r) => { if (r.sector) c[r.sector] = (c[r.sector] || 0) + 1; });
        const list = Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}（${v}）`).join("\n");
        return [{ type: "text", text: "主榜產業分布：\n" + list + "\n\n輸入「產業 生技」看該產業前 5 名。" }];
      }
      const rows = await db.get(`latest_board?board=eq.main&sector=ilike.*${enc(cmd.q)}*&order=rank.asc&limit=5`);
      if (!rows.length) return [{ type: "text", text: `主榜裡沒有符合「${cmd.q}」的產業。輸入「產業」看清單。` }];
      return [topCard(rows, rows[0].sector + " 前 5 名")];
    }
    case "raise": {
      const rows = await db.get("fundraises?order=filed_at.desc&limit=6");
      if (!rows.length) return [{ type: "text", text: "還沒有 Reg CF 資料。" }];
      const lines = rows.map((r) => `${r.issuer || r.cik}\n  申報 ${r.filed_at}　目標 ${usd(r.target_amount)}　上限 ${usd(r.max_amount)}${r.deadline ? "　截止 " + r.deadline + daysLeft(r.deadline) : ""}`);
      return [{ type: "text", text: "最近的 Reg CF 募資：\n" + lines.join("\n") }];
    }
    case "report": {
      const rows = await db.get("report_card?order=as_of.desc,horizon.asc&limit=6");
      if (!rows.length) return [{ type: "text", text: "成績單還沒有資料，要累積 5 個交易日以上。" }];
      const lines = rows.map((r) => `${r.as_of}　${r.horizon} 日　平均 ${pct(r.avg_ret)}　SPY ${pct(r.spy_ret)}　超額 ${pct(r.excess)}　勝率 ${pct(r.hit_rate, false)}`);
      return [{ type: "text", text: "前 20 名之後的表現：\n" + lines.join("\n") }];
    }
    case "today": {
      const dates = (await db.get("scores?board=eq.main&rank=eq.1&select=as_of&order=as_of.desc&limit=2")).map((r) => r.as_of);
      if (!dates.length) return [{ type: "text", text: "還沒有評分資料。" }];
      const cols = "ticker,board,rank,score";
      const [cur, prev] = await Promise.all([
        db.get(`scores?as_of=eq.${enc(dates[0])}&board=eq.main&select=${cols}&limit=1000`),
        dates[1] ? db.get(`scores?as_of=eq.${enc(dates[1])}&board=eq.main&select=${cols}&limit=1000`) : Promise.resolve([]),
      ]);
      const uid = await db.ownerId();
      const w = await db.get(`user_watch?user_id=eq.${uid}&select=ticker`);
      let wr = { cur: [], prev: [] };
      if (w.length) {
        const list = w.map((x) => enc(x.ticker)).join(",");
        wr = { cur: await db.get(`scores?as_of=eq.${enc(dates[0])}&ticker=in.(${list})&select=${cols}`),
               prev: dates[1] ? await db.get(`scores?as_of=eq.${enc(dates[1])}&ticker=in.(${list})&select=${cols}`) : [] };
      }
      const sm = {}; (await db.get("smart_money?score=gt.0&select=ticker,tags&limit=500")).forEach((r) => { sm[r.ticker] = r; });
      const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const raises = await db.get(`fundraises?filed_at=gte.${since}&form_type=eq.C&select=issuer&limit=6`);
      const lines = todaySummary(cur, prev, wr, sm, raises);
      return withQuick([{ type: "text", text: `${dataAge(dates[0]).label}${dates[1] ? "（對比 " + String(dates[1]).slice(0, 10) + "）" : ""}\n` + (lines.length ? lines.join("\n") : "沒有明顯變化。") }], [qr("週報", "週報"), qr("自選", "自選"), qr("榜單", "榜單")]);
    }
    case "week": {
      const rows = await db.get("latest_board?board=eq.main&select=ticker,score,score_7d,as_of&limit=1000");
      const uid = await db.ownerId();
      const w = new Set((await db.get(`user_watch?user_id=eq.${uid}&select=ticker`)).map((x) => x.ticker));
      const lines = weekSummary(rows, w);
      const age = dataAge(rows[0] && rows[0].as_of).label;
      return withQuick([{ type: "text", text: lines.length ? "週報（主榜 7 日分數變化）\n" + age + "\n\n" + lines.join("\n\n") : "還沒有 7 日前的資料可以比。" }], [qr("今日", "今日"), qr("自選", "自選"), qr("榜單", "榜單")]);
    }
    case "alert": {
      const uid = await db.ownerId();
      const ex = await db.get(`entities?ticker=eq.${enc(cmd.ticker)}&select=ticker&limit=1`);
      if (!ex.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有設定。` }];
      const mine = await db.get(`user_alerts?user_id=eq.${uid}&fired_at=is.null&select=id`);
      if (mine.length >= 20) return [{ type: "text", text: "未觸發的提醒已達 20 則上限，先刪一些。" }];
      await db.send("POST", "user_alerts", [{ user_id: uid, ticker: cmd.ticker, metric: cmd.metric, op: cmd.op, value: cmd.value }]);
      return [{ type: "text", text: `已設定：${cmd.ticker} ${cmd.metric === "score" ? "分數" : "排名"}${cmd.op}${cmd.value}。條件成立時會放進下一次每日摘要，只通知一次。` }];
    }
    case "alerts": {
      const uid = await db.ownerId();
      const rows = await db.get(`user_alerts?user_id=eq.${uid}&order=created_at.asc&select=ticker,metric,op,value,fired_at`);
      if (!rows.length) return [{ type: "text", text: "沒有提醒。例：提醒 NRXS 分數>70" }];
      return [{ type: "text", text: "提醒：\n" + rows.map((r) => `${r.fired_at ? "✓已觸發" : "待觸發"}　${r.ticker} ${r.metric === "score" ? "分數" : "排名"}${r.op}${r.value}`).join("\n") }];
    }
    case "delalert": {
      const uid = await db.ownerId();
      await db.send("DELETE", `user_alerts?user_id=eq.${uid}&ticker=eq.${enc(cmd.ticker)}`);
      return [{ type: "text", text: `已刪除 ${cmd.ticker} 的提醒。` }];
    }
    case "quota": return [{ type: "text", text: await ctx.quota() }];
    case "menu": return [{ type: "text", text: await ctx.setupMenu() }];
    default: {
      const found = cmd.cmd === "unknown" ? await findByName(db, cmd.text) : null;
      return found || [{ type: "text", text: "看不懂「" + String(cmd.text || "").slice(0, 30) + "」。輸入「說明」看指令。" }];
    }
  }
}

// ── LINE plumbing ───────────────────────────────────────────────────────────
export async function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let bin = ""; mac.forEach((b) => (bin += String.fromCharCode(b)));
  const expect = btoa(bin);
  if (expect.length !== signature.length) return false;
  let diff = 0; for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export const TIMEOUT_MS = 8000; // reply tokens last ~1 minute; answer within 8s or say so
const TIMEOUT = Symbol("timeout");
const WRITE_CMDS = new Set(["add", "del", "note", "alert", "delalert", "menu"]);
export const timeoutText = (cmd) => WRITE_CMDS.has(cmd.cmd)
  ? "資料庫回應太慢（超過 8 秒）。這個操作可能已完成，請用「自選」或「提醒清單」確認。"
  : "資料庫回應太慢（超過 8 秒），可能剛從休眠醒來。請再輸入一次。";
function withTimeout(p, ms) {
  p.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
  let t;
  const to = new Promise((res) => { t = setTimeout(() => res(TIMEOUT), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

const seen = new Map(); // webhookEventId -> time; only guards redelivery inside one warm instance
const fresh = (id) => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 600000) seen.delete(k);
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
};

async function lineReply(fetchFn, replyToken, messages) {
  const r = await fetchFn("https://api.line.me/v2/bot/message/reply", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!r.ok) console.error("reply failed", r.status, (await r.text()).slice(0, 300));
}

async function quotaText(fetchFn) {
  const h = { Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") };
  try {
    const [q, u] = await Promise.all([fetchFn("https://api.line.me/v2/bot/message/quota", { headers: h }), fetchFn("https://api.line.me/v2/bot/message/quota/consumption", { headers: h })]);
    if (!q.ok || !u.ok) return "查不到額度（" + q.status + "/" + u.status + "）。";
    const qj = await q.json(), uj = await u.json();
    return `本月推播用量：${uj.totalUsage} / ${qj.type === "limited" ? qj.value : "無上限（付費方案）"}\n回覆訊息不計入。每日摘要最多 1 則，自設上限 100 則。`;
  } catch (e) { return "查額度失敗：" + String(e).slice(0, 80); }
}

async function setupMenu(fetchFn) {
  const auth = { Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") };
  const dash = env("DASHBOARD_URL");
  if (!dash) return "缺少 DASHBOARD_URL，無法取得選單圖片。";
  const img = await fetchFn(dash.replace(/\/?$/, "/") + "richmenu.png");
  if (!img.ok) return "找不到選單圖片 richmenu.png（" + img.status + "）。";
  const bytes = new Uint8Array(await img.arrayBuffer());
  const labels = ["榜單", "自選", "大戶", "募資", "成績單", "說明"];
  const w = 2500, h = 843, cw = Math.floor(w / 3), ch = Math.floor(h / 2);
  const areas = labels.map((t, i) => ({ bounds: { x: (i % 3) * cw, y: Math.floor(i / 3) * ch, width: cw, height: ch }, action: { type: "message", text: t } }));
  const c = await fetchFn("https://api.line.me/v2/bot/richmenu", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ size: { width: w, height: h }, selected: true, name: "trend-menu", chatBarText: "選單", areas }),
  });
  if (!c.ok) return "建立選單失敗：" + c.status + " " + (await c.text()).slice(0, 200);
  const { richMenuId } = await c.json();
  const up = await fetchFn(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: bytes });
  if (!up.ok) return "上傳圖片失敗：" + up.status + " " + (await up.text()).slice(0, 200);
  const def = await fetchFn(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: "POST", headers: auth });
  if (!def.ok) return "設為預設失敗：" + def.status;
  return "選單已建立。";
}

export async function handle(req, fetchFn = fetch) {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get("x-line-signature"), env("LINE_CHANNEL_SECRET")))) return new Response("bad signature", { status: 401 });
  const owner = env("LINE_USER_ID");
  let payload; try { payload = JSON.parse(body); } catch { return new Response("ok"); }
  const db = makeDb(fetchFn);
  for (const ev of payload.events || []) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      if (!owner || ev.source?.userId !== owner) continue; // only the owner; everyone else is ignored silently
      if (!fresh(ev.webhookEventId)) continue;
      const cmd = parseCommand(ev.message.text);
      const out = await withTimeout(run(cmd, db, { setupMenu: () => setupMenu(fetchFn), quota: () => quotaText(fetchFn) }), TIMEOUT_MS);
      await lineReply(fetchFn, ev.replyToken, out === TIMEOUT ? [{ type: "text", text: timeoutText(cmd) }] : out);
    } catch (e) {
      console.error("event failed", String(e));
      try { await lineReply(fetchFn, ev.replyToken, [{ type: "text", text: "查詢失敗，稍後再試。" }]); } catch (_) { /* ignore */ }
    }
  }
  return new Response("ok"); // LINE only needs a 2xx
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve((req) => handle(req));
