// LINE chat bot for ONE person (the owner). Replies are free (reply messages are not counted in the LINE quota).
// Secrets (Supabase > Edge Functions > Secrets): LINE_CHANNEL_SECRET, LINE_CHANNEL_TOKEN, LINE_USER_ID, DASHBOARD_URL (optional).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Deploy with JWT verification OFF (LINE has no JWT);
// the request is authenticated by the LINE signature instead.
import { resolveInput, nextSession, cleanName } from './assistant.ts';
import { explain } from './ai.ts';
const env = (k) => (typeof Deno !== "undefined" ? Deno.env.get(k) : process.env[k]) || "";

const TAGS = { insider_cluster: "內部人群買", insider_buy: "內部人買進", activist_13d: "13D 積極持有", new_5pct: "新增 5% 持有人" };
const FLAGS = { short_runway: "現金撐不久", deep_loss: "虧損嚴重", high_debt: "高負債", dilution: "稀釋", thin_volume: "成交量薄",
  micro_cap: "微型股", crowded: "擁擠", data_thin: "資料不足", high_pledge: "董監設質高", insider_selling: "內部人申報轉讓" };
const COLORS = { growth: "#2fbf8f", validated: "#6f86f2", accessibility: "#f2b44a", attention: "#ee6a7b" };

// ── formatting helpers ──────────────────────────────────────────────────────
export const usd = (n) => {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  return (n < 0 ? "-" : "") + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "K" : a.toFixed(0));
};
export const spct = (n, d = 1) => (n == null || isNaN(n) ? "—" : (n > 0 ? "+" : "") + (n * 100).toFixed(d) + "%");
export const pct = (n, sign = true) => (n == null || isNaN(n) ? "—" : (sign && n > 0 ? "+" : "") + (n * 100).toFixed(0) + "%");
const num = (n, d = 1) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(d));
// Taiwan dollars: 1.2 兆 / 350 億 / 980 萬
export const twd = (n) => {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n), sg = n < 0 ? "-" : "";
  return sg + (a >= 1e12 ? (a / 1e12).toFixed(2) + " 兆" : a >= 1e8 ? (a / 1e8).toFixed(a >= 1e10 ? 0 : 1) + " 億" : a >= 1e4 ? (a / 1e4).toFixed(0) + " 萬" : a.toFixed(0));
};

// ── markets: US tickers are letters, Taiwan codes are 4–6 digits (+ optional letter) ──
export const isTw = (t) => /^\d{4,6}[A-Z]?$/.test(String(t || "").toUpperCase());
const MK = {
  us: { view: "latest_board", scores: "scores", ent: "entities", main: "main", label: "美股", report: "report_card", bench: "SPY" },
  tw: { view: "tw_latest_board", scores: "tw_scores", ent: "tw_entities", main: "tw_main", label: "台股", report: "tw_report_card", bench: "大盤" },
};
export const mk = (tw) => (tw ? MK.tw : MK.us);
const EXCH = { TWSE: "上市", TPEx: "上櫃", TPEX: "上櫃" };

// ── data freshness: how many US trading days behind is the data? (weekdays only; holidays are not modelled) ──
export function dataAge(asOf, now = new Date(), tw = false) {
  const m = String(asOf || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { label: "資料日期未知", stale: true, lag: null };
  const d0 = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const ref = new Date(now.getTime() - (tw ? 8 : 5) * 3600000); // US: roughly Eastern time; TW: Taipei (+8h) minus a 16:00 cut-over
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
const MAIN_QUICK = [qr("今日", "今日"), qr("榜單", "榜單"), qr("自選", "自選"), qr("週報", "週報"), qr("大戶", "大戶"), qr("台股", "台股"), qr("更多功能", "更多功能")];
const TW_QUICK = [qr("台股今日", "台股今日"), qr("台股榜單", "台股"), qr("自選", "自選"), qr("台股週報", "台股週報"), qr("台股法人", "台股法人"), qr("台股成績單", "台股成績單"), qr("美股榜單", "榜單")];
// rich menu cells, left→right, top→bottom. The image (docs/richmenu.png) is drawn by scripts/make_richmenu.py in the same order.
export const MENU = ["今日", "榜單", "自選", "週報", "大戶", "更多功能"];
export const MENU_TW = ["台股今日", "台股", "自選", "台股週報", "台股法人", "更多功能"];
const TICK = "(?:[A-Za-z][A-Za-z.\\-]{0,5}|\\d{4,6}[A-Za-z]?)";
// words that start a command, for "did you mean" suggestions
const COMMAND_WORDS = ["今日", "榜單", "自選", "週報", "大戶", "台股", "台股今日", "台股週報", "募資", "成績單", "提醒清單", "額度", "產業", "比較", "說明", "更多功能"];

// ── name / alias lookup (stock names in the DB are mostly English; common Chinese names go here) ──
export const ALIASES = {
  "輝達": "NVDA", "英偉達": "NVDA", "特斯拉": "TSLA", "蘋果": "AAPL", "微軟": "MSFT", "谷歌": "GOOGL", "亞馬遜": "AMZN",
  "超微": "AMD", "英特爾": "INTC", "網飛": "NFLX", "帕蘭泰爾": "PLTR", "台積電adr": "TSM", "美光": "MU", "高通": "QCOM",
};
export const cleanQuery = (q) => String(q || "").normalize("NFKC").replace(/[*%,()\\]/g, "").trim().slice(0, 30);

// ── command parsing ─────────────────────────────────────────────────────────
export function parseCommand(raw) {
  let t = String(raw || "").normalize("NFKC").trim().replace(/^\$(?=[A-Za-z])/, "");
  if (!t) return { cmd: "help" };
  const low = t.toLowerCase();
  if (/^(說明|help|\?|指令|選單)$/.test(low)) return { cmd: "help" };
  if (/^(設定選單|setup menu)$/.test(low)) return { cmd: "menu" };
  if (/^(更多功能|功能|工具|more)$/.test(low)) return { cmd: "more" };
  // Taiwan: 台股 / 台股 2 / 台股今日 / 台股週報 / 台股成績單 / 台股產業 半導體 / 台股 2330
  const twm = t.match(/^(?:台股|tw)(?![a-z])\s*(.*)$/i);
  if (twm) {
    const rest = twm[1].trim();
    const pgm = rest.match(/^(?:榜單|主榜|前十)?\s*(?:第)?\s*(\d{1,2})?\s*(?:頁)?$/);
    if (pgm) return { cmd: "top", tw: true, page: Math.min(15, Math.max(1, Number(pgm[1] || 1))) };
    if (/^(今日|今天)$/.test(rest)) return { cmd: "today", tw: true };
    if (/^(週報|周報|本週)$/.test(rest)) return { cmd: "week", tw: true };
    if (/^(成績單|成績)$/.test(rest)) return { cmd: "report", tw: true };
    if (/^(法人|大戶|三大法人)$/.test(rest)) return { cmd: "smart", tw: true };
    const ind = rest.match(/^產業\s*(.*)$/);
    if (ind) return { cmd: "industry", tw: true, q: ind[1].trim() };
    const inner = parseCommand(rest);
    if (inner.cmd !== "unknown" && inner.cmd !== "help") return inner;
    return { cmd: "unknown", text: t };
  }
  const dm = t.match(/^(儀表板|dashboard|網頁)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))?$/i);
  if (dm) return { cmd: "dash", ...(dm[2] ? { ticker: dm[2].toUpperCase() } : {}) };
  const pg = low.match(/^(榜單|前十|top|top10|主榜)\s*(?:第)?\s*(\d{1,2})?\s*(?:頁)?$/);
  if (pg) return { cmd: "top", page: Math.min(15, Math.max(1, Number(pg[2] || 1))) };
  if (/^(下一頁|next|更多)$/.test(low)) return { cmd: "top", page: 2 };
  if (/^(自選|我的自選|watch|watchlist)$/.test(low)) return { cmd: "watch" };
  if (/^(大戶|內部人|smart)$/.test(low)) return { cmd: "smart" };
  let sm = t.match(/^(大戶|內部人|smart)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))$/i);
  if (sm) return { cmd: "smart", ticker: sm[2].toUpperCase() };
  if (/^(募資|regcf|reg cf)$/.test(low)) return { cmd: "raise" };
  if (/^(成績單|成績|report)$/.test(low)) return { cmd: "report" };
  if (/^(提醒清單|提醒列表|我的提醒|alerts)$/.test(low)) return { cmd: "alerts" };
  if (/^(額度|用量|quota)$/.test(low)) return { cmd: "quota" };
  if (/^(今日|今天|today)$/.test(low)) return { cmd: "today" };
  if (/^(週報|周報|本週|week|weekly)$/.test(low)) return { cmd: "week" };
  let m = t.match(/^(刪提醒|刪除提醒|取消提醒)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))$/);
  if (m) return { cmd: "delalert", ticker: m[2].toUpperCase() };
  m = t.match(/^(提醒|alert)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(分數|排名|score|rank)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { cmd: "alert", ticker: m[2].toUpperCase(), metric: /分數|score/i.test(m[3]) ? "score" : "rank", op: m[4], value: Number(m[5]) };
  m = t.match(/^(提醒|alert)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))$/i);
  if (m) return { cmd: "alertmenu", ticker: m[2].toUpperCase() };
  // one or several tickers: 加 NRXS ACOG、TSLA
  m = t.match(new RegExp(`^(加|新增|add|刪|刪除|移除|del|remove)\\s*(${TICK}(?:\\s*[,，、\\s]\\s*${TICK}){0,9})$`, "i"));
  if (m) {
    const tickers = [...new Set(m[2].split(/[\s,，、]+/).filter(Boolean).map((x) => x.toUpperCase()))];
    return { cmd: /^(加|新增|add)$/i.test(m[1]) ? "add" : "del", ticker: tickers[0], tickers };
  }
  m = t.match(/^(筆記|note)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*([\s\S]*)$/i);
  if (m) return { cmd: "note", ticker: m[2].toUpperCase(), text: m[3].trim() };
  m = t.match(/^(產業|industry)\s*(.*)$/i);
  if (m) return { cmd: "industry", q: m[2].trim() };
  m = t.match(/^(?:比較|比|compare)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(?:和|跟|與|vs\.?|,|，|\s)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))$/i)
    || t.match(/^((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(?:vs\.?|比|對)\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))$/i);
  if (m) return { cmd: "compare", a: m[1].toUpperCase(), b: m[2].toUpperCase() };
  m = t.match(/^(?:把|將)?\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(?:加入?|新增)(?:到)?(?:我的)?自選(?:清單)?$/);
  if (m) return { cmd: "add", ticker: m[1].toUpperCase() };
  m = t.match(/^(?:把|將)?\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(?:移出|移除|刪除|刪掉|拿掉)(?:自選)?(?:清單)?$/);
  if (m) return { cmd: "del", ticker: m[1].toUpperCase() };
  m = t.match(/^(?:查|看|看看|stock)?\s*((?:[A-Za-z][A-Za-z.\-]{0,5}|\d{4,6}[A-Za-z]?))\s*(?:怎麼樣|如何|好嗎|呢|嗎|分數|卡片|[?？])?$/i);
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

const dataLine = (asOf, tw = false) => { const a = dataAge(asOf, new Date(), tw); return txt(a.label, { size: "xs", color: a.stale ? "#ee6a7b" : "#8a93a6", margin: "md" }); };

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
  const url = extra.url || deepLink(dash, s.ticker);
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

const fmtCmp = (label, v, tw = false) => (v == null ? "—" : label === "營收年增" || label === "6 個月強度" ? pct(v) : label === "市值" ? (tw ? twd(v) : usd(v)) : label === "排名" ? "#" + v : num(v, label === "分數" ? 1 : 0));
export function compareCard(A, B, tw = false) {
  const line = (label, f, hi = true) => {
    const a = f(A), b = f(B);
    const win = a == null || b == null || a === b ? 0 : ((a > b) === hi ? 1 : 2);
    return { type: "box", layout: "horizontal", margin: "sm", contents: [
      txt(label, { color: "#8a93a6", flex: 3, size: "xs" }),
      txt(fmtCmp(label, a, tw), { flex: 3, align: "end", weight: win === 1 ? "bold" : "regular", color: win === 1 ? "#2fbf8f" : "#eef1f8" }),
      txt(fmtCmp(label, b, tw), { flex: 3, align: "end", weight: win === 2 ? "bold" : "regular", color: win === 2 ? "#2fbf8f" : "#eef1f8" }),
    ] };
  };
  const body = [
    { type: "box", layout: "horizontal", contents: [txt("", { flex: 3 }), txt(A.ticker, { flex: 3, align: "end", weight: "bold", size: "lg", color: "#eef1f8" }), txt(B.ticker, { flex: 3, align: "end", weight: "bold", size: "lg", color: "#eef1f8" })] },
    { type: "separator", margin: "md", color: "#2a3142" },
    line("分數", (r) => r.score), line("排名", (r) => (r.board === "main" || r.board === "tw_main" ? r.rank : null), false),
    line("成長", (r) => r.growth), line("驗證", (r) => r.validated), line("進場", (r) => r.accessibility), line("擁擠", (r) => r.attention, false),
    line("營收年增", (r) => r.rev_yoy), line("6 個月強度", (r) => r.rs_6m), line("市值", (r) => r.mkt_cap, false),
  ];
  if (A.as_of) body.push(dataLine(A.as_of, tw));
  return flex(`${A.ticker} vs ${B.ticker}`, bubble(body));
}

// Taiwan stock card: monthly revenue instead of quarterly, NT$, 上市/上櫃, no smart-money layer
export function twStockCard(s, extra = {}) {
  const flags = (s.flags || []).filter((f) => f !== "inst_buy").map((f) => FLAGS[f] || f);
  const instBuy = (s.flags || []).includes("inst_buy");
  const tone = (v) => ({ color: v > 0 ? "#2fbf8f" : v < 0 ? "#ee6a7b" : "#eef1f8" });
  const delta = s.score_7d != null ? s.score - s.score_7d : null;
  const body = [
    { type: "box", layout: "horizontal", contents: [
      { type: "box", layout: "vertical", flex: 4, contents: [txt(s.ticker + "  " + (s.name || ""), { size: "lg", weight: "bold", color: "#eef1f8" }),
        txt(["台股", EXCH[s.exchange] || s.exchange, s.sector].filter(Boolean).join(" · "), { size: "xs", color: "#8a93a6" })] },
      { type: "box", layout: "vertical", flex: 2, contents: [txt(num(s.score), { size: "xxl", weight: "bold", align: "end", color: "#eef1f8" }),
        txt(s.board === "tw_main" ? "主榜 #" + s.rank : "觀察 #" + s.rank, { size: "xs", align: "end", color: "#8a93a6" })] },
    ] },
    ...(extra.spark ? [extra.spark, txt(`近 ${extra.n} 日分數 ${num(extra.first, 0)} → ${num(s.score, 0)}`, { size: "xs", color: "#8a93a6" })] : []),
    ...(delta != null ? [txt("7 日分數 " + (delta >= 0 ? "+" : "") + num(delta), { size: "xs", color: delta >= 0 ? "#2fbf8f" : "#ee6a7b" })] : []),
    { type: "separator", margin: "md", color: "#2a3142" },
    bar("成長", s.growth, COLORS.growth), bar("驗證", s.validated, COLORS.validated),
    bar("進場", s.accessibility, COLORS.accessibility), bar("擁擠（越高越擠）", s.attention, COLORS.attention),
    { type: "separator", margin: "md", color: "#2a3142" },
    row("股價", s.price != null ? "NT$ " + num(s.price, 2) : "—"),
    row("月營收年增" + (s.ym ? `（${s.ym}）` : ""), pct(s.rev_yoy)), row("累計營收年增", pct(s.rev_cum_yoy)),
    row("6 個月強度（對大盤）", pct(s.rs_6m)), row("市值", twd(s.mkt_cap)), row("日成交值", twd(s.dollar_vol)),
    ...(s.inst_20d != null ? [row("三大法人 20 日（佔量）", spct(s.inst_20d), tone(s.inst_20d))] : []),
    ...(s.foreign_20d != null || s.trust_20d != null ? [row("外資／投信 20 日", spct(s.foreign_20d) + "／" + spct(s.trust_20d))] : []),
    ...(s.pledge_ratio != null ? [row("董監設質", (s.pledge_ratio * 100).toFixed(0) + "%", s.pledge_ratio >= 0.3 ? { color: "#ee6a7b" } : {})] : []),
    ...(instBuy ? [row("訊號", "法人買超", { color: "#2fbf8f", weight: "bold" })] : []),
    ...(extra.sectorRank ? [row("產業內排名", `第 ${extra.sectorRank[0]} / ${extra.sectorRank[1]}`)] : []),
    ...(flags.length ? [row("風險", flags.join("、"), { color: "#ee6a7b" })] : []),
    dataLine(s.as_of, true),
  ];
  return flex(`${s.ticker} ${s.name || ""} 分數 ${num(s.score)}`, bubble(body, extra.url ? [link(extra.url, "在儀表板開啟")] : null));
}

export function topCard(rows, title) {
  const body = [txt(title, { size: "md", weight: "bold", color: "#eef1f8" }), txt("點一列看詳細", { size: "xs", color: "#8a93a6" })];
  rows.forEach((r) => body.push(tapRow("#" + r.rank, r.ticker + "  " + (r.name || "").slice(0, 16), num(r.score), r.ticker)));
  if (rows[0] && rows[0].as_of) body.push(dataLine(rows[0].as_of, String(rows[0].board || "").startsWith("tw")));
  return flex(title, bubble(body));
}

export function helpText() {
  return [
    "指令（回覆都免費，不占推播額度）",
    "",
    "【查股票】",
    "NRXS 或 $NRXS　個股卡片",
    "輝達／apple　用名稱找",
    "比較 NRXS ACOG　兩檔並排（台股也可）",
    "",
    "【每天看】",
    "今日　比前一個交易日的變化",
    "榜單（榜單 2 翻頁）　主榜排名",
    "週報　7 日分數漲跌",
    "大戶　內部人與大股東訊號",
    "",
    "【自選與提醒】",
    "自選　自選股現況",
    "加 NRXS 2330／刪 NRXS　可一次多檔",
    "筆記 NRXS 內容　寫筆記",
    "筆記 NRXS　讀筆記；搜尋筆記 關鍵字",
    "解讀 NRXS　資料解讀；新話題　重設上下文",
    "提醒 NRXS　點選條件設提醒",
    "提醒清單／刪提醒 NRXS",
    "",
    "【台股】",
    "2330／台積電　台股個股卡片",
    "台股（台股 2 翻頁）・台股今日・台股週報",
    "台股法人・台股成績單・台股產業 半導體",
    "",
    "【其他】",
    "更多功能　募資、成績單、產業、額度、儀表板",
    "設定選單　重建底部圖文選單",
  ].join("\n");
}

// "did you mean": command words that share characters with the input, best first
export function suggest(text, words = COMMAND_WORDS) {
  const t = String(text || "").normalize("NFKC").trim().toLowerCase();
  if (!t) return [];
  const scored = words.map((w) => {
    const chars = [...w].filter((c) => t.includes(c)).length;
    const hit = w.includes(t) || t.includes(w) ? 10 : 0;
    return { w, s: hit + chars / w.length };
  }).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  return scored.slice(0, 4).map((x) => x.w);
}

export function moreCard(dash, oneTime = false) {
  const btn = (label, text) => ({ type: "button", style: "secondary", height: "sm", flex: 1, action: { type: "message", label, text } });
  const pair = (a, b) => ({ type: "box", layout: "horizontal", spacing: "sm", contents: [a, b] });
  const body = [
    txt("更多功能", { size: "md", weight: "bold", color: "#eef1f8" }),
    pair(btn("募資", "募資"), btn("成績單", "成績單")),
    pair(btn("提醒清單", "提醒清單"), btn("額度", "額度")),
    pair(btn("台股成績單", "台股成績單"), btn("台股產業", "台股產業")),
    pair(btn("產業分布", "產業"), btn("全部指令", "說明")),
    ...(oneTime ? [txt("儀表板按鈕免登入，1 小時內有效、只能用一次。", { size: "xxs", color: "#8a93a6", margin: "md" })] : []),
  ];
  return flex("更多功能", bubble(body, dash ? [link(dash, "開啟儀表板")] : null));
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
    const r = await fetchFn(base + "/auth/v1/admin/users?per_page=2", { headers: h, ...sig() });
    if (!r.ok) throw new Error("auth " + r.status);
    const users = (await r.json()).users || [];
    if (users.length !== 1) throw new Error("Set OWNER_UID when the dashboard does not have exactly one user");
    uid = users[0].id;
    email = users[0].email || null;
    return uid;
  };
  // One-time sign-in link for the dashboard (Supabase admin generate_link): no email is sent, the link logs the
  // owner straight in. Single use, expires with the project's OTP expiry (default 1 hour). Only ever sent to the owner.
  let email = null;
  const magicLink = async (redirectTo) => {
    await ownerId();
    if (!email) {
      const r = await fetchFn(base + "/auth/v1/admin/users/" + encodeURIComponent(uid), { headers: h, ...sig() });
      if (!r.ok) return null;
      const data = await r.json(), u = data.user || data;
      email = (u && u.email) || null;
    }
    if (!email) return null;
    const r = await fetchFn(base + "/auth/v1/admin/generate_link", {
      method: "POST", headers: h, body: JSON.stringify({ type: "magiclink", email, redirect_to: redirectTo }), ...sig(),
    });
    if (!r.ok) { console.error("generate_link", r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    return j.action_link || (j.properties && j.properties.action_link) || null;
  };
  const rpc = async (name, body) => {
    const r = await fetchFn(base + '/rest/v1/rpc/' + name, { method: 'POST', headers: h, body: JSON.stringify(body), ...sig() });
    if (!r.ok) throw new Error('rpc ' + name + ' ' + r.status);
    return r.json();
  };
  return { get, send, ownerId, magicLink, rpc };
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
  const pick = (rows) => rows.length === 1
    ? run({ cmd: "stock", ticker: rows[0].ticker, noFallback: true }, db, {})
    : withQuick([topCard(rows, `「${key}」符合 ${rows.length} 檔`)], rows.map((r) => qr(r.ticker + " " + (r.name || "").slice(0, 8), r.ticker)));
  if (/[\u3400-\u9fff]/.test(key) && !ALIASES[key]) { // Chinese: Taiwan names are Chinese, so look there first
    const tw = await db.get(`tw_latest_board?name=ilike.*${encodeURIComponent(key)}*&order=score.desc&limit=5`).catch(() => []);
    if (tw.length) return pick(tw);
  }
  if (ALIASES[key]) return run({ cmd: "stock", ticker: ALIASES[key], noFallback: true }, db, {});
  const rows = await db.get(`latest_board?name=ilike.*${encodeURIComponent(key)}*&order=rank.asc&limit=5`);
  if (!rows.length) return null;
  if (rows.length === 1) return run({ cmd: "stock", ticker: rows[0].ticker, noFallback: true }, db, {});
  return withQuick([topCard(rows, `「${key}」符合 ${rows.length} 檔`)], rows.map((r) => qr(r.ticker, r.ticker)));
}

// ── command handlers → array of LINE message objects ────────────────────────
// dashboard URL that signs the owner in without email; falls back to the plain URL
export async function dashLink(db, dash, ticker) {
  if (!dash) return { url: "", oneTime: false };
  const plain = ticker ? deepLink(dash, ticker) : dash;
  if (!db.magicLink) return { url: plain, oneTime: false };
  try {
    const target = dash.replace(/\/?$/, "/") + (ticker ? "?t=" + encodeURIComponent(ticker) : "");
    const url = await db.magicLink(target);
    return url ? { url, oneTime: true } : { url: plain, oneTime: false };
  } catch (_) { return { url: plain, oneTime: false }; }
}

// Taiwan "big money": 三大法人 net buying (share of traded volume) and director pledging
async function twFlows(cmd, db) {
  const enc = encodeURIComponent;
  if (cmd.ticker) {
    const r = (await db.get(`tw_latest_board?ticker=eq.${enc(cmd.ticker)}&limit=1`))[0];
    if (!r) return [{ type: "text", text: `找不到 ${cmd.ticker}。` }];
    if (r.inst_20d == null && r.pledge_ratio == null) return withQuick([{ type: "text", text: `${r.ticker} ${r.name || ""} 還沒有法人資料。` }], [qr(r.ticker, r.ticker)]);
    const lines = [`${r.ticker} ${r.name || ""}　法人動向（買賣超佔成交量）`,
      `三大法人　5 日 ${spct(r.inst_5d)}　20 日 ${spct(r.inst_20d)}`,
      `外資 20 日 ${spct(r.foreign_20d)}　投信 20 日 ${spct(r.trust_20d)}`,
      ...(r.pledge_ratio != null ? [`董監設質 ${(r.pledge_ratio * 100).toFixed(0)}%${r.pledge_ratio >= 0.3 ? "（偏高）" : ""}`] : []),
      ...((r.flags || []).includes("insider_selling") ? ["內部人近期申報轉讓持股"] : []),
      "參考線索，不計入分數。"];
    return withQuick([{ type: "text", text: lines.join("\n") }], [qr(r.ticker, r.ticker), qr("台股法人", "台股法人")]);
  }
  const rows = await db.get("tw_latest_board?board=eq.tw_main&inst_20d=gt.0&order=inst_20d.desc&limit=10&select=ticker,name,inst_20d,foreign_20d,trust_20d,as_of,board").catch(() => []);
  if (!rows.length) return withQuick([{ type: "text", text: "台股主榜目前沒有法人買超資料。" }], TW_QUICK);
  const body = [txt("台股主榜　三大法人 20 日買超", { weight: "bold", color: "#eef1f8" }), txt("買超佔成交量，參考線索，不計入分數", { size: "xs", color: "#8a93a6" })];
  rows.forEach((r) => body.push(tapRow(spct(r.inst_20d), r.ticker + "  " + (r.name || "").slice(0, 8), "外 " + spct(r.foreign_20d, 0) + " 投 " + spct(r.trust_20d, 0), r.ticker)));
  body.push(dataLine(rows[0].as_of, true));
  return withQuick([flex("台股法人買超", bubble(body))], TW_QUICK);
}

async function twStock(cmd, db, dash) {
  const enc = encodeURIComponent, t = cmd.ticker;
  const rows = await db.get(`tw_latest_board?ticker=eq.${enc(t)}&limit=1`);
  if (!rows.length) return [{ type: "text", text: `找不到 ${t}。只有已評分的台股查得到（上市櫃普通股，不含 ETF）。` }];
  const r = rows[0];
  const hist = await db.get(`tw_scores?ticker=eq.${enc(t)}&order=as_of.desc&limit=14&select=as_of,score`).catch(() => []);
  const pts = hist.slice().reverse();
  const extra = { spark: sparkline(pts), n: pts.length, first: pts[0] && pts[0].score };
  if (r.sector && r.board === "tw_main") {
    const peers = await db.get(`tw_latest_board?board=eq.tw_main&sector=eq.${enc(r.sector)}&select=ticker&order=score.desc&limit=200`).catch(() => []);
    const i = peers.findIndex((p) => p.ticker === t);
    if (i >= 0) extra.sectorRank = [i + 1, peers.length];
  }
  let watching = null;
  try {
    const uid = await db.ownerId();
    watching = (await db.get(`user_watch?user_id=eq.${uid}&ticker=eq.${enc(t)}&select=ticker&limit=1`)).length > 0;
  } catch (_) { /* buttons still work */ }
  extra.url = (await dashLink(db, dash, t)).url;
  return withQuick([twStockCard(r, extra)], [
    watching ? qr("移出自選", "刪 " + t) : qr("加入自選", "加 " + t), qr("設提醒", "提醒 " + t), qr("法人動向", "大戶 " + t), qr("台股榜單", "台股"),
    qr('解讀', '解讀 ' + t), qr('筆記', '讀筆記 ' + t),
    ...(r.sector ? [qr(("同產業 " + r.sector).slice(0, 20), "台股產業 " + r.sector)] : []),
  ]);
}

export async function run(cmd, db, ctx) {
  const dash = env("DASHBOARD_URL");
  const enc = encodeURIComponent;
  switch (cmd.cmd) {
    case 'message': return withQuick([{ type: 'text', text: cmd.text }], (cmd.choices || []).map((x) => qr(x.label, x.text)));
    case 'reset': return withQuick([{ type: 'text', text: '已重設目前市場、股票與頁碼。' }], MAIN_QUICK);
    case 'explain': case 'explanation': return explain(cmd, db, ctx);
    case 'notes': {
      const uid = await db.ownerId(), q = cleanName(cmd.q);
      const rows = await db.get(`user_watch?user_id=eq.${uid}&note=neq.&select=ticker,note,updated_at&order=updated_at.desc&limit=10${q ? '&note=ilike.*' + enc(q) + '*' : ''}`);
      if (!rows.length) return [{ type: 'text', text: q ? `沒有符合「${q}」的筆記。` : '還沒有筆記。例：筆記 2330 關注下次營收。' }];
      return withQuick([{ type: 'text', text: '最近筆記（最多 10 筆）：\n' + rows.map((r) => `${r.ticker}：${r.note.slice(0, 200)}`).join('\n\n') }], rows.map((r) => qr(r.ticker, '讀筆記 ' + r.ticker)));
    }
    case 'readnote': case 'clearnote': {
      const uid = await db.ownerId();
      const path = `user_watch?user_id=eq.${uid}&ticker=eq.${enc(cmd.ticker)}`;
      if (cmd.cmd === 'clearnote') {
        await db.send('PATCH', path, { note: '', updated_at: new Date().toISOString() });
        return [{ type: 'text', text: `已清除 ${cmd.ticker} 筆記。` }];
      }
      const row = (await db.get(path + '&select=note&limit=1'))[0];
      return withQuick([{ type: 'text', text: `${cmd.ticker} 筆記：\n${row?.note || '尚未記錄。'}\n\n輸入「筆記 ${cmd.ticker} 內容」可更新。` }], [qr('查看股票', cmd.ticker)]);
    }
    case "help": return withQuick([{ type: "text", text: helpText() }], MAIN_QUICK);
    case "more": {
      const d = await dashLink(db, dash);
      return withQuick([moreCard(d.url, d.oneTime)], MAIN_QUICK.slice(0, 5));
    }
    case "dash": {
      const d = await dashLink(db, dash, cmd.ticker);
      if (!d.url) return [{ type: "text", text: "還沒設定 DASHBOARD_URL。" }];
      return [flex("開啟儀表板", bubble([txt(cmd.ticker ? `在儀表板開啟 ${cmd.ticker}` : "開啟儀表板", { weight: "bold", color: "#eef1f8" }),
        ...(d.oneTime ? [txt("免登入，1 小時內有效、只能用一次。", { size: "xs", color: "#8a93a6" })] : [])], [link(d.url, "開啟")]))];
    }
    case "stock": {
      if (isTw(cmd.ticker)) return twStock(cmd, db, dash);
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
      extra.url = (await dashLink(db, dash, t)).url;
      return withQuick([stockCard(rows[0], sm[0], dash, extra)], [
        watching ? qr("移出自選", "刪 " + t) : qr("加入自選", "加 " + t), qr("設提醒", "提醒 " + t), qr("大戶訊號", "大戶 " + t), qr("榜單", "榜單"), qr('解讀', '解讀 ' + t), qr('筆記', '讀筆記 ' + t),
      ]);
    }
    case "compare": {
      if (cmd.a === cmd.b) return [{ type: "text", text: "請給兩檔不同的股票。" }];
      const tw = isTw(cmd.a);
      if (tw !== isTw(cmd.b)) return [{ type: "text", text: "美股和台股的分數是各自市場內比出來的，不能直接比。請給同一個市場的兩檔。" }];
      const rows = await db.get(`${mk(tw).view}?ticker=in.(${enc(cmd.a)},${enc(cmd.b)})`);
      const A = rows.find((r) => r.ticker === cmd.a), B = rows.find((r) => r.ticker === cmd.b);
      if (!A || !B) return [{ type: "text", text: `找不到 ${!A ? cmd.a : cmd.b}。` }];
      return withQuick([compareCard(A, B, tw)], [qr(cmd.a, cmd.a), qr(cmd.b, cmd.b), tw ? qr("台股榜單", "台股") : qr("榜單", "榜單")]);
    }
    case "alertmenu": {
      const tw = isTw(cmd.ticker);
      const rows = await db.get(`${mk(tw).view}?ticker=eq.${enc(cmd.ticker)}&limit=1`);
      if (!rows.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有可設定的條件。` }];
      const r = rows[0], t = cmd.ticker, sc = Math.round(r.score);
      const opts = [`分數>${sc + 5}`, `分數>${sc + 10}`, `分數<${Math.max(0, sc - 5)}`];
      if (r.rank > 10) opts.push("排名<=10");
      if (r.rank > 20) opts.push("排名<=20");
      return withQuick([{ type: "text", text: `${t} 目前分數 ${num(r.score)}、${tw ? "台股" : ""}${r.board === "main" || r.board === "tw_main" ? "主榜" : "觀察"}第 ${r.rank} 名。\n點下方條件，或自己輸入，例如：提醒 ${t} 分數>${sc + 5}` }],
        opts.map((o) => qr(o, `提醒 ${t} ${o}`)));
    }
    case "top": {
      const S = mk(cmd.tw), pg = cmd.page || 1, from = (pg - 1) * 10;
      const rows = await db.get(`${S.view}?board=eq.${S.main}&order=rank.asc&limit=10&offset=${from}`);
      const home = cmd.tw ? qr("台股榜單", "台股") : qr("榜單", "榜單");
      if (!rows.length) return withQuick([{ type: "text", text: "沒有更多了。" }], [home]);
      const more = rows.length === 10 && pg < 15 ? [qr("下一頁", (cmd.tw ? "台股 " : "榜單 ") + (pg + 1))] : [];
      const name = cmd.tw ? "台股主榜" : "主榜";
      return withQuick([topCard(rows, pg === 1 ? `${name}前 10 名` : `${name}第 ${from + 1}–${from + rows.length} 名`)], [...more, ...(cmd.tw ? TW_QUICK : MAIN_QUICK)]);
    }
    case "watch": {
      const uid = await db.ownerId();
      const w = await db.get(`user_watch?user_id=eq.${uid}&select=ticker,note`);
      if (!w.length) return withQuick([{ type: "text", text: "自選是空的。輸入「加 NRXS」開始，可一次加多檔：加 NRXS ACOG。" }], [qr("榜單", "榜單"), qr("今日", "今日")]);
      const usW = w.filter((x) => !isTw(x.ticker)), twW = w.filter((x) => isTw(x.ticker));
      const inList = (xs) => xs.map((x) => enc(x.ticker)).join(",");
      const [rows, twRows] = await Promise.all([
        usW.length ? db.get(`latest_board?ticker=in.(${inList(usW)})&order=score.desc`) : Promise.resolve([]),
        twW.length ? db.get(`tw_latest_board?ticker=in.(${inList(twW)})&order=score.desc`).catch(() => []) : Promise.resolve([]),
      ]);
      const have = new Set([...rows, ...twRows].map((r) => r.ticker));
      const missing = w.filter((x) => !have.has(x.ticker)).map((x) => x.ticker);
      const both = rows.length && twRows.length;
      const msgs = [];
      if (rows.length || !twRows.length) msgs.push(topCard(rows, (both ? "美股自選 " : "自選 ") + rows.length + " 檔"));
      if (twRows.length) msgs.push(topCard(twRows, (both ? "台股自選 " : "自選 ") + twRows.length + " 檔"));
      if (missing.length) msgs.push({ type: "text", text: "今天沒有評分資料：" + missing.join("、") });
      return withQuick(msgs, [qr("今日", "今日"), qr("週報", "週報"), qr("榜單", "榜單"), qr("更多功能", "更多功能")]);
    }
    case "add": case "del": case "note": {
      if (cmd.cmd === 'note' && !cmd.text) return run({ cmd: 'readnote', ticker: cmd.ticker }, db, ctx);
      if (cmd.cmd === 'note' && cmd.text.length > 2000) return [{ type: 'text', text: '筆記請控制在 2,000 字以內。' }];
      const uid = await db.ownerId();
      const list = cmd.tickers && cmd.tickers.length ? cmd.tickers : [cmd.ticker];
      if (cmd.cmd === "del") {
        await db.send("DELETE", `user_watch?user_id=eq.${uid}&ticker=in.(${list.map(enc).join(",")})`);
        return withQuick([{ type: "text", text: `已從自選移除 ${list.join("、")}。` }], [qr("自選", "自選")]);
      }
      if (cmd.cmd === "add" && list.length > 1) {
        const usL = list.filter((x) => !isTw(x)), twL = list.filter(isTw);
        const got = await Promise.all([
          usL.length ? db.get(`entities?ticker=in.(${usL.map(enc).join(",")})&select=ticker`) : Promise.resolve([]),
          twL.length ? db.get(`tw_entities?ticker=in.(${twL.map(enc).join(",")})&select=ticker`).catch(() => []) : Promise.resolve([]),
        ]);
        const ex = new Set(got.flat().map((r) => r.ticker));
        const ok = list.filter((x) => ex.has(x)), bad = list.filter((x) => !ex.has(x));
        const now = new Date().toISOString();
        if (ok.length) await db.send("POST", "user_watch?on_conflict=user_id,ticker", ok.map((x) => ({ user_id: uid, ticker: x, updated_at: now })), "resolution=merge-duplicates,return=minimal");
        return withQuick([{ type: "text", text: (ok.length ? `已加入自選：${ok.join("、")}。` : "沒有加入任何股票。") + (bad.length ? `\n找不到：${bad.join("、")}。` : "") }], [qr("自選", "自選")]);
      }
      const ex = await db.get(`${mk(isTw(cmd.ticker)).ent}?ticker=eq.${enc(cmd.ticker)}&select=ticker&limit=1`);
      if (!ex.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有加入。` }];
      const row = { user_id: uid, ticker: cmd.ticker, updated_at: new Date().toISOString() };
      if (cmd.cmd === "note") row.note = cmd.text;
      await db.send("POST", "user_watch?on_conflict=user_id,ticker", [row], "resolution=merge-duplicates,return=minimal");
      return withQuick([{ type: "text", text: cmd.cmd === "note" ? `已更新 ${cmd.ticker} 的筆記。` : `已加入自選：${cmd.ticker}。` }], [qr("自選", "自選"), qr("設提醒", "提醒 " + cmd.ticker)]);
    }
    case "smart": {
      if (cmd.tw || (cmd.ticker && isTw(cmd.ticker))) return twFlows(cmd, db);
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
      const S = mk(cmd.tw), hint = cmd.tw ? "台股產業 半導體" : "產業 生技", pre = cmd.tw ? "台股" : "";
      if (!cmd.q) {
        const rows = await db.get(`${S.view}?board=eq.${S.main}&select=sector&limit=1000`);
        const c = {};
        rows.forEach((r) => { if (r.sector) c[r.sector] = (c[r.sector] || 0) + 1; });
        const list = Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}（${v}）`).join("\n");
        return [{ type: "text", text: `${pre}主榜產業分布：\n` + list + `\n\n輸入「${hint}」看該產業前 5 名。` }];
      }
      const rows = await db.get(`${S.view}?board=eq.${S.main}&sector=ilike.*${enc(cmd.q)}*&order=rank.asc&limit=5`);
      if (!rows.length) return [{ type: "text", text: `${pre}主榜裡沒有符合「${cmd.q}」的產業。輸入「${pre}產業」看清單。` }];
      return [topCard(rows, rows[0].sector + " 前 5 名")];
    }
    case "raise": {
      const rows = await db.get("fundraises?order=filed_at.desc&limit=6");
      if (!rows.length) return [{ type: "text", text: "還沒有 Reg CF 資料。" }];
      const lines = rows.map((r) => `${r.issuer || r.cik}\n  申報 ${r.filed_at}　目標 ${usd(r.target_amount)}　上限 ${usd(r.max_amount)}${r.deadline ? "　截止 " + r.deadline + daysLeft(r.deadline) : ""}`);
      return [{ type: "text", text: "最近的 Reg CF 募資：\n" + lines.join("\n") }];
    }
    case "report": {
      const S = mk(cmd.tw), pre = cmd.tw ? "台股" : "";
      const rows = await db.get(`${S.report}?order=as_of.desc,horizon.asc&limit=6`).catch(() => []);
      if (!rows.length) return [{ type: "text", text: `${pre}成績單還沒有資料，要累積 5 個交易日以上。` }];
      const lines = rows.map((r) => `${r.as_of}　${r.horizon} 日　平均 ${pct(r.avg_ret)}　${S.bench} ${pct(r.spy_ret)}　超額 ${pct(r.excess)}　勝率 ${pct(r.hit_rate, false)}`);
      return [{ type: "text", text: `${pre}前 20 名之後的表現：\n` + lines.join("\n") }];
    }
    case "today": {
      const S = mk(cmd.tw);
      const dates = (await db.get(`${S.scores}?board=eq.${S.main}&rank=eq.1&select=as_of&order=as_of.desc&limit=2`)).map((r) => r.as_of);
      if (!dates.length) return [{ type: "text", text: "還沒有評分資料。" }];
      const cols = "ticker,board,rank,score";
      const [cur, prev] = await Promise.all([
        db.get(`${S.scores}?as_of=eq.${enc(dates[0])}&board=eq.${S.main}&select=${cols}&limit=1000`),
        dates[1] ? db.get(`${S.scores}?as_of=eq.${enc(dates[1])}&board=eq.${S.main}&select=${cols}&limit=1000`) : Promise.resolve([]),
      ]);
      const uid = await db.ownerId();
      const w = (await db.get(`user_watch?user_id=eq.${uid}&select=ticker`)).filter((x) => isTw(x.ticker) === !!cmd.tw);
      let wr = { cur: [], prev: [] };
      if (w.length) {
        const list = w.map((x) => enc(x.ticker)).join(",");
        wr = { cur: await db.get(`${S.scores}?as_of=eq.${enc(dates[0])}&ticker=in.(${list})&select=${cols}`),
               prev: dates[1] ? await db.get(`${S.scores}?as_of=eq.${enc(dates[1])}&ticker=in.(${list})&select=${cols}`) : [] };
      }
      const sm = {};
      let raises = [];
      if (!cmd.tw) { // smart money and Reg CF are US-only
        (await db.get("smart_money?score=gt.0&select=ticker,tags&limit=500")).forEach((r) => { sm[r.ticker] = r; });
        const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        raises = await db.get(`fundraises?filed_at=gte.${since}&form_type=eq.C&select=issuer&limit=6`);
      }
      const lines = todaySummary(cur, prev, wr, sm, raises);
      return withQuick([{ type: "text", text: `${cmd.tw ? "台股　" : ""}${dataAge(dates[0], new Date(), !!cmd.tw).label}${dates[1] ? "（對比 " + String(dates[1]).slice(0, 10) + "）" : ""}\n` + (lines.length ? lines.join("\n") : "沒有明顯變化。") }],
        cmd.tw ? [qr("台股週報", "台股週報"), qr("自選", "自選"), qr("台股榜單", "台股"), qr("美股今日", "今日")] : [qr("週報", "週報"), qr("自選", "自選"), qr("榜單", "榜單"), qr("台股今日", "台股今日")]);
    }
    case "week": {
      const S = mk(cmd.tw);
      const rows = await db.get(`${S.view}?board=eq.${S.main}&select=ticker,score,score_7d,as_of&limit=1000`);
      const uid = await db.ownerId();
      const w = new Set((await db.get(`user_watch?user_id=eq.${uid}&select=ticker`)).map((x) => x.ticker).filter((t) => isTw(t) === !!cmd.tw));
      const lines = weekSummary(rows, w);
      const age = dataAge(rows[0] && rows[0].as_of, new Date(), !!cmd.tw).label;
      const head = `${cmd.tw ? "台股" : ""}週報（主榜 7 日分數變化）`;
      return withQuick([{ type: "text", text: lines.length ? head + "\n" + age + "\n\n" + lines.join("\n\n") : "還沒有 7 日前的資料可以比。" }],
        cmd.tw ? [qr("台股今日", "台股今日"), qr("自選", "自選"), qr("台股榜單", "台股"), qr("美股週報", "週報")] : [qr("今日", "今日"), qr("自選", "自選"), qr("榜單", "榜單"), qr("台股週報", "台股週報")]);
    }
    case "alert": {
      const uid = await db.ownerId();
      const ex = await db.get(`${mk(isTw(cmd.ticker)).ent}?ticker=eq.${enc(cmd.ticker)}&select=ticker&limit=1`);
      if (!ex.length) return [{ type: "text", text: `找不到 ${cmd.ticker}，沒有設定。` }];
      const mine = await db.get(`user_alerts?user_id=eq.${uid}&fired_at=is.null&select=id`);
      if (mine.length >= 20) return [{ type: "text", text: "未觸發的提醒已達 20 則上限，先刪一些。" }];
      const same = await db.get(`user_alerts?user_id=eq.${uid}&ticker=eq.${enc(cmd.ticker)}&metric=eq.${cmd.metric}&op=eq.${enc(cmd.op)}&value=eq.${cmd.value}&fired_at=is.null&select=id&limit=1`);
      if (same.length) return [{ type: 'text', text: '相同條件的提醒已存在。' }];
      await db.send("POST", "user_alerts", [{ user_id: uid, ticker: cmd.ticker, metric: cmd.metric, op: cmd.op, value: cmd.value }]);
      return [{ type: "text", text: `已設定：${cmd.ticker} ${cmd.metric === "score" ? "分數" : "排名"}${cmd.op}${cmd.value}。以收盤後更新的分數判斷，條件成立時放進該市場下一次摘要，只通知一次；非盤中即時提醒。` }];
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
      if (found) return found;
      const sug = suggest(cmd.text);
      return sug.length
        ? withQuick([{ type: "text", text: "看不懂「" + String(cmd.text || "").slice(0, 30) + "」。你是不是要：" }], sug.map((w) => qr(w, w)))
        : withQuick([{ type: "text", text: "看不懂「" + String(cmd.text || "").slice(0, 30) + "」。輸入股票代號，或點下方按鈕。" }], [...MAIN_QUICK.slice(0, 5), qr("說明", "說明")]);
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
const WRITE_CMDS = new Set(["add", "del", "note", "clearnote", "alert", "delalert", "menu"]);
export const timeoutText = (cmd) => WRITE_CMDS.has(cmd.cmd)
  ? "資料庫回應太慢（超過 8 秒）。這個操作可能已完成，請用「自選」或「提醒清單」確認。"
  : "資料庫回應太慢（超過 8 秒），可能剛從休眠醒來。請再輸入一次。";
function withTimeout(p, ms) {
  p.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
  let t;
  const to = new Promise((res) => { t = setTimeout(() => res(TIMEOUT), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

async function lineReply(fetchFn, replyToken, messages) {
  const r = await fetchFn("https://api.line.me/v2/bot/message/reply", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
    signal: AbortSignal.timeout(7500),
  });
  if (!r.ok) console.error("reply failed", r.status, (await r.text()).slice(0, 300));
}

async function quotaText(fetchFn) {
  const h = { Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") };
  try {
    const [q, u] = await Promise.all([fetchFn("https://api.line.me/v2/bot/message/quota", { headers: h }), fetchFn("https://api.line.me/v2/bot/message/quota/consumption", { headers: h })]);
    if (!q.ok || !u.ok) return "查不到額度（" + q.status + "/" + u.status + "）。";
    const qj = await q.json(), uj = await u.json();
    return `本月推播用量：${uj.totalUsage} / ${qj.type === "limited" ? qj.value : "依帳號方案"}\n回覆訊息不計入。台、美股分時摘要；推播上限 ${env('LINE_MONTHLY_CAP') || '100'} 則。`;
  } catch (e) { return "查額度失敗：" + String(e).slice(0, 80); }
}

// Rich menu geometry; scripts/make_richmenu.py draws the images with the same numbers.
export const MENU_W = 2500, MENU_H = 843, MENU_TAB_H = 170;
export function menuAreas(cells) {
  const tabs = [["trend-us", 0], ["trend-tw", MENU_W / 2]].map(([alias, x]) => ({
    bounds: { x, y: 0, width: MENU_W / 2, height: MENU_TAB_H },
    action: { type: "richmenuswitch", richMenuAliasId: alias, data: "menu=" + alias.slice(6) },
  }));
  const cw = Math.floor(MENU_W / 3), ch = Math.floor((MENU_H - MENU_TAB_H) / 2);
  return [...tabs, ...cells.map((text, i) => ({
    bounds: { x: (i % 3) * cw, y: MENU_TAB_H + Math.floor(i / 3) * ch, width: cw, height: ch }, action: { type: "message", text },
  }))];
}

async function setupMenu(fetchFn) {
  const auth = { Authorization: "Bearer " + env("LINE_CHANNEL_TOKEN") };
  const json = { ...auth, "Content-Type": "application/json" };
  const dash = env("DASHBOARD_URL");
  if (!dash) return "缺少 DASHBOARD_URL，無法取得選單圖片。";
  const make = async (name, bar, file, cells, tabs = true) => {
    const img = await fetchFn(dash.replace(/\/?$/, "/") + file);
    if (!img.ok) throw new Error(`找不到選單圖片 ${file}（${img.status}）`);
    const bytes = new Uint8Array(await img.arrayBuffer());
    const c = await fetchFn("https://api.line.me/v2/bot/richmenu", {
      method: "POST", headers: json,
      body: JSON.stringify({ size: { width: MENU_W, height: MENU_H }, selected: true, name, chatBarText: bar, areas: menuAreas(cells).filter((a) => tabs || a.action.type !== "richmenuswitch") }),
    });
    if (!c.ok) throw new Error("建立選單失敗：" + c.status + " " + (await c.text()).slice(0, 200));
    const { richMenuId } = await c.json();
    const up = await fetchFn(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: bytes });
    if (!up.ok) throw new Error("上傳圖片失敗：" + up.status + " " + (await up.text()).slice(0, 200));
    return richMenuId;
  };
  const alias = async (id, richMenuId) => { // create, or point an existing alias at the new menu
    const c = await fetchFn("https://api.line.me/v2/bot/richmenu/alias", { method: "POST", headers: json, body: JSON.stringify({ richMenuAliasId: id, richMenuId }) });
    if (c.ok) return;
    const u = await fetchFn(`https://api.line.me/v2/bot/richmenu/alias/${id}`, { method: "POST", headers: json, body: JSON.stringify({ richMenuId }) });
    if (!u.ok) throw new Error(`設定分頁切換失敗（${id}）：` + u.status + " " + (await u.text()).slice(0, 120));
  };
  let us, tw;
  try {
    // first run: the tab buttons point at aliases that don't exist yet, so park the aliases on tab-less menus first
    const al = await fetchFn("https://api.line.me/v2/bot/richmenu/alias/list", { headers: auth });
    const have = new Set(al.ok ? ((await al.json()).aliases || []).map((a) => a.richMenuAliasId) : []);
    if (!have.has("trend-us")) await alias("trend-us", await make("trend-menu-boot", "選單", "richmenu.png", MENU, false));
    if (!have.has("trend-tw")) await alias("trend-tw", await make("trend-menu-boot", "選單", "richmenu_tw.png", MENU_TW, false));
    us = await make("trend-menu", "美股選單", "richmenu.png", MENU);
    tw = await make("trend-menu-tw", "台股選單", "richmenu_tw.png", MENU_TW);
    await alias("trend-us", us);
    await alias("trend-tw", tw);
  } catch (e) { return String((e && e.message) || e); }
  const def = await fetchFn(`https://api.line.me/v2/bot/user/all/richmenu/${us}`, { method: "POST", headers: auth });
  if (!def.ok) return "設為預設失敗：" + def.status;
  // remove the menus this bot made before, so repeated setups don't pile up
  let removed = 0;
  try {
    const ls = await fetchFn("https://api.line.me/v2/bot/richmenu/list", { headers: auth });
    const old = ls.ok ? ((await ls.json()).richmenus || []).filter((m) => String(m.name).startsWith("trend-menu") && m.richMenuId !== us && m.richMenuId !== tw) : [];
    for (const m of old) {
      const d = await fetchFn(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: "DELETE", headers: auth });
      if (d.ok) removed++;
    }
  } catch (_) { /* cleanup is best-effort */ }
  return "選單已建立（美股／台股，點上方分頁切換）。" + (removed ? `已清掉 ${removed} 個舊選單。` : "");
}

export async function handle(req, fetchFn = fetch) {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get("x-line-signature"), env("LINE_CHANNEL_SECRET")))) return new Response("bad signature", { status: 401 });
  const owner = env("LINE_USER_ID");
  let payload; try { payload = JSON.parse(body); } catch { return new Response("ok"); }
  const db = makeDb(fetchFn);
  for (const ev of payload.events || []) {
    // Replies to group events are visible to everybody in that group, including sign-in links.
    if (!owner || ev.source?.userId !== owner || ev.source?.type !== 'user') continue;
    const menu = ev.type === 'postback' && /^menu=(us|tw)$/.exec(ev.postback?.data || '');
    if (!menu && (ev.type !== 'message' || ev.message?.type !== 'text')) continue;
    try {
      if (!ev.webhookEventId || !(await db.rpc('claim_line_event', { p_event_id: ev.webhookEventId }))) continue;
    } catch (_) {
      // No durable claim = no side effects. Ask LINE to redeliver once storage is back.
      return new Response('event storage unavailable', { status: 503 });
    }
    try {
      let executing = { cmd: 'unknown' };
      const task = async () => {
        const uid = await db.ownerId();
        const saved = (await db.get(`line_sessions?user_id=eq.${uid}&limit=1`))[0];
        const session = saved && Date.now() - Date.parse(saved.updated_at) < 86400000 ? saved : {};
        const cmd = menu ? { cmd: 'market', tw: menu[1] === 'tw' } : await resolveInput(ev.message.text, parseCommand, db, session, ALIASES);
        executing = cmd;
        const next = nextSession(session, cmd);
        const out = menu ? [] : await run(cmd, db, { fetchFn, setupMenu: () => setupMenu(fetchFn), quota: () => quotaText(fetchFn),
          waitUntil: typeof EdgeRuntime !== 'undefined' ? (p) => EdgeRuntime.waitUntil(p) : undefined });
        await db.send('POST', 'line_sessions?on_conflict=user_id', { user_id: uid, ...next, updated_at: new Date(ev.timestamp || Date.now()).toISOString() }, 'resolution=merge-duplicates,return=minimal');
        return out;
      };
      const out = await withTimeout(task(), TIMEOUT_MS);
      if (menu) continue;
      await lineReply(fetchFn, ev.replyToken, out === TIMEOUT ? [{ type: "text", text: timeoutText(executing) }] : out);
    } catch (e) {
      console.error("event failed", String(e));
      try { await lineReply(fetchFn, ev.replyToken, [{ type: "text", text: "查詢失敗，稍後再試。" }]); } catch (_) { /* ignore */ }
    }
  }
  return new Response("ok"); // LINE only needs a 2xx
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve((req) => handle(req));
