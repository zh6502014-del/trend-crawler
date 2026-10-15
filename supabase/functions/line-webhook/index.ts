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

// ── command parsing ─────────────────────────────────────────────────────────
export function parseCommand(raw) {
  let t = String(raw || "").normalize("NFKC").trim();
  if (!t) return { cmd: "help" };
  const low = t.toLowerCase();
  if (/^(說明|help|\?|指令|選單)$/.test(low)) return { cmd: "help" };
  if (/^(設定選單|setup menu)$/.test(low)) return { cmd: "menu" };
  if (/^(榜單|前十|top|top10|主榜)$/.test(low)) return { cmd: "top" };
  if (/^(自選|我的自選|watch|watchlist)$/.test(low)) return { cmd: "watch" };
  if (/^(大戶|內部人|smart)$/.test(low)) return { cmd: "smart" };
  if (/^(募資|regcf|reg cf)$/.test(low)) return { cmd: "raise" };
  if (/^(成績單|成績|report)$/.test(low)) return { cmd: "report" };
  let m = t.match(/^(加|新增|add)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "add", ticker: m[2].toUpperCase() };
  m = t.match(/^(刪|刪除|移除|del|remove)\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "del", ticker: m[2].toUpperCase() };
  m = t.match(/^(筆記|note)\s*([A-Za-z][A-Za-z.\-]{0,5})\s*([\s\S]*)$/i);
  if (m) return { cmd: "note", ticker: m[2].toUpperCase(), text: m[3].trim() };
  m = t.match(/^(產業|industry)\s*(.*)$/i);
  if (m) return { cmd: "industry", q: m[2].trim() };
  m = t.match(/^(查|stock)?\s*([A-Za-z][A-Za-z.\-]{0,5})$/i);
  if (m) return { cmd: "stock", ticker: m[2].toUpperCase() };
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

export function deepLink(base, ticker) { return base ? base.replace(/\/?$/, "/") + "#t=" + encodeURIComponent(ticker) : ""; }

export function stockCard(s, smart, dash) {
  const tags = (smart && smart.tags || []).map((t) => TAGS[t] || t);
  const flags = (s.flags || []).map((f) => FLAGS[f] || f);
  const delta = s.score_7d != null ? s.score - s.score_7d : null;
  const body = [
    { type: "box", layout: "horizontal", contents: [
      { type: "box", layout: "vertical", flex: 4, contents: [txt(s.ticker, { size: "xl", weight: "bold", color: "#eef1f8" }), txt(s.name || "", { size: "xs", color: "#8a93a6" })] },
      { type: "box", layout: "vertical", flex: 2, contents: [txt(num(s.score), { size: "xxl", weight: "bold", align: "end", color: "#eef1f8" }),
        txt(s.board === "main" ? "主榜 #" + s.rank : "觀察 #" + s.rank, { size: "xs", align: "end", color: "#8a93a6" })] },
    ] },
    ...(delta != null ? [txt("7 日分數 " + (delta >= 0 ? "+" : "") + num(delta), { size: "xs", color: delta >= 0 ? "#2fbf8f" : "#ee6a7b" })] : []),
    { type: "separator", margin: "md", color: "#2a3142" },
    bar("成長", s.growth, COLORS.growth), bar("驗證", s.validated, COLORS.validated),
    bar("進場", s.accessibility, COLORS.accessibility), bar("擁擠（越高越擠）", s.attention, COLORS.attention),
    { type: "separator", margin: "md", color: "#2a3142" },
    row("營收年增", pct(s.rev_yoy)), row("6 個月強度", pct(s.rs_6m)), row("市值", usd(s.mkt_cap)), row("日成交額", usd(s.dollar_vol)),
    row("產業", s.sector || "—"),
    ...(tags.length ? [row("大戶", tags.join("、"), { color: "#2fbf8f", weight: "bold" })] : []),
    ...(flags.length ? [row("風險", flags.join("、"), { color: "#ee6a7b" })] : []),
  ];
  const url = deepLink(dash, s.ticker);
  return flex(`${s.ticker} 分數 ${num(s.score)}`, bubble(body, url ? [link(url, "在儀表板開啟")] : null));
}

export function topCard(rows, title) {
  const body = [txt(title, { size: "md", weight: "bold", color: "#eef1f8" }), txt("點一列看詳細", { size: "xs", color: "#8a93a6" })];
  rows.forEach((r) => body.push(tapRow("#" + r.rank, r.ticker + "  " + (r.name || "").slice(0, 16), num(r.score), r.ticker)));
  return flex(title, bubble(body));
}

export function helpText() {
  return [
    "指令（回覆免費）",
    "NRXS　個股卡片",
    "榜單　主榜前 10 名",
    "自選　自選股現況",
    "加 NRXS／刪 NRXS　改自選",
    "筆記 NRXS 內容　寫筆記",
    "大戶　近期大戶訊號",
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
  const get = async (path) => {
    const r = await fetchFn(base + "/rest/v1/" + path, { headers: h });
    if (!r.ok) throw new Error("db " + r.status + " " + (await r.text()).slice(0, 200));
    return r.json();
  };
  const send = async (method, path, body, prefer) => {
    const r = await fetchFn(base + "/rest/v1/" + path, { method, headers: { ...h, Prefer: prefer || "return=minimal" }, body: body ? JSON.stringify(body) : undefined });
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

// ── command handlers → array of LINE message objects ────────────────────────
export async function run(cmd, db, ctx) {
  const dash = env("DASHBOARD_URL");
  const enc = encodeURIComponent;
  switch (cmd.cmd) {
    case "help": return [{ type: "text", text: helpText() }];
    case "stock": {
      const rows = await db.get(`latest_board?ticker=eq.${enc(cmd.ticker)}&limit=1`);
      if (!rows.length) return [{ type: "text", text: `找不到 ${cmd.ticker}。只有已評分的股票查得到。` }];
      const sm = await db.get(`smart_money?ticker=eq.${enc(cmd.ticker)}&limit=1`);
      return [stockCard(rows[0], sm[0], dash)];
    }
    case "top": {
      const rows = await db.get("latest_board?board=eq.main&order=rank.asc&limit=10");
      return [topCard(rows, "主榜前 10 名 · " + (rows[0] ? rows[0].as_of : ""))];
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
      const lines = rows.map((r) => `${r.issuer || r.cik}\n  申報 ${r.filed_at}　目標 ${usd(r.target_amount)}　上限 ${usd(r.max_amount)}${r.deadline ? "　截止 " + r.deadline : ""}`);
      return [{ type: "text", text: "最近的 Reg CF 募資：\n" + lines.join("\n") }];
    }
    case "report": {
      const rows = await db.get("report_card?order=as_of.desc,horizon.asc&limit=6");
      if (!rows.length) return [{ type: "text", text: "成績單還沒有資料，要累積 5 個交易日以上。" }];
      const lines = rows.map((r) => `${r.as_of}　${r.horizon} 日　平均 ${pct(r.avg_ret)}　SPY ${pct(r.spy_ret)}　超額 ${pct(r.excess)}　勝率 ${pct(r.hit_rate, false)}`);
      return [{ type: "text", text: "前 20 名之後的表現：\n" + lines.join("\n") }];
    }
    case "menu": return [{ type: "text", text: await ctx.setupMenu() }];
    default: return [{ type: "text", text: "看不懂「" + String(cmd.text || "").slice(0, 30) + "」。輸入「說明」看指令。" }];
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
      const msgs = await run(parseCommand(ev.message.text), db, { setupMenu: () => setupMenu(fetchFn) });
      await lineReply(fetchFn, ev.replyToken, msgs);
    } catch (e) {
      console.error("event failed", String(e));
      try { await lineReply(fetchFn, ev.replyToken, [{ type: "text", text: "查詢失敗，稍後再試。" }]); } catch (_) { /* ignore */ }
    }
  }
  return new Response("ok"); // LINE only needs a 2xx
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve((req) => handle(req));
