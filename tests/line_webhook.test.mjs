// Run: node --test tests/line_webhook.test.mjs   (Node 22.18+ strips the .ts types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, dataAge, withQuick, run, findByName, timeoutText, stockCard, cleanQuery, suggest, MENU, helpText, dashLink, isTw, twd, MENU_TW, menuAreas, MENU_W, MENU_H, MENU_TAB_H, nextRevenueDeadline, importantDates, reportCard } from "../supabase/functions/line-webhook/index.ts";

const at = (iso) => new Date(iso);

test("dataAge: fresh, weekend and stale cases", () => {
  // Fri 2026-10-16 19:00 Taipei = 11:00Z; data from Thu is one trading day behind → fresh
  assert.equal(dataAge("2026-10-15", at("2026-10-16T11:00:00Z")).stale, false);
  // Mon morning Taipei: data from Friday is fine (weekend doesn't count)
  assert.equal(dataAge("2026-10-16", at("2026-10-19T01:00:00Z")).stale, false);
  // Thu data viewed on Mon US day → 2 trading days behind → stale
  const a = dataAge("2026-10-15", at("2026-10-20T01:00:00Z"));
  assert.equal(a.stale, true); assert.equal(a.lag, 2);
  assert.match(a.label, /落後 2 個交易日/);
  assert.equal(dataAge(null).stale, true);
  assert.equal(dataAge("2026-10-15T00:00:00+00:00", at("2026-10-16T11:00:00Z")).stale, false);
});

test("parseCommand: new forms and old forms still work", () => {
  assert.deepEqual(parseCommand("提醒 nrxs"), { cmd: "alertmenu", ticker: "NRXS" });
  assert.equal(parseCommand("提醒 NRXS 分數>70").cmd, "alert");
  assert.equal(parseCommand("提醒清單").cmd, "alerts");
  assert.deepEqual(parseCommand("大戶 abc"), { cmd: "smart", ticker: "ABC" });
  assert.equal(parseCommand("大戶").cmd, "smart");
  assert.equal(parseCommand("NRXS").cmd, "stock");
  assert.equal(parseCommand("輝達").cmd, "unknown");
  assert.equal(parseCommand("刪提醒 NRXS").cmd, "delalert");
  assert.equal(parseCommand("加 NRXS").cmd, "add");
});

test("withQuick attaches to the last message only, max 13", () => {
  const out = withQuick([{ type: "text", text: "a" }, { type: "text", text: "b" }], Array.from({ length: 20 }, (_, i) => ({ i })));
  assert.equal(out[0].quickReply, undefined);
  assert.equal(out[1].quickReply.items.length, 13);
});

test("cleanQuery strips PostgREST wildcards and limits length", () => {
  assert.equal(cleanQuery("a*b%c,d(e)"), "abcde");
  assert.equal(cleanQuery("x".repeat(50)).length, 30);
});

const mkDb = (tables) => ({
  ownerId: async () => "u1",
  send: async () => {},
  get: async (path) => {
    for (const [prefix, rows] of Object.entries(tables)) if (path.startsWith(prefix)) return typeof rows === "function" ? rows(path) : rows;
    return [];
  },
});
// every string a message shows, whether it is a plain text message or a Flex card (one line per text node)
const allText = (m) => { const out = []; const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") { if (n.type === "text" && typeof n.text === "string") out.push(n.text); Object.values(n).forEach(walk); } }; walk(m); return out.join("\n"); };
const board = { ticker: "NRXS", name: "Neuro Corp", score: 71.4, rank: 8, board: "main", as_of: "2026-10-15", growth: 50, validated: 50, accessibility: 50, attention: 50 };

test("stock card: freshness line + quick replies reflect watch state", async () => {
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board], "smart_money": [], "user_watch": [{ ticker: "NRXS" }] });
  const out = await run({ cmd: "stock", ticker: "NRXS" }, db, {});
  const items = out[0].quickReply.items.map((i) => i.action.text);
  assert.deepEqual(items, ["刪 NRXS", "提醒 NRXS", "大戶 NRXS", "榜單", "解讀 NRXS", "讀筆記 NRXS"]);
  assert.match(JSON.stringify(out[0].contents), /資料截至 2026-10-15/);
  const db2 = mkDb({ "latest_board?ticker=eq.NRXS": [board], "user_watch": [] });
  assert.equal((await run({ cmd: "stock", ticker: "NRXS" }, db2, {}))[0].quickReply.items[0].action.text, "加 NRXS");
});

test("stock card still renders if the watch lookup fails", async () => {
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board], "smart_money": [] });
  db.ownerId = async () => { throw new Error("boom"); };
  const out = await run({ cmd: "stock", ticker: "NRXS" }, db, {});
  assert.equal(out[0].quickReply.items[0].action.text, "加 NRXS");
});

test("alertmenu offers conditions that make sense for rank", async () => {
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board] });
  const out = await run({ cmd: "alertmenu", ticker: "NRXS" }, db, {});
  const t = out[0].quickReply.items.map((i) => i.action.text);
  assert.ok(t.includes("提醒 NRXS 分數>76"));
  assert.ok(t.every((x) => parseCommand(x).cmd === "alert"), "every suggested button must parse as a valid alert");
  assert.ok(!t.includes("提醒 NRXS 排名<=10"), "rank 8 is already inside the top 10");
  assert.ok(t.includes("提醒 NRXS 排名<=20") === false, "rank 8 is also inside the top 20");
  const far = await run({ cmd: "alertmenu", ticker: "NRXS" }, mkDb({ "latest_board?ticker=eq.NRXS": [{ ...board, rank: 40 }] }), {});
  const t2 = far[0].quickReply.items.map((i) => i.action.text);
  assert.ok(t2.includes("提醒 NRXS 排名<=10") && t2.includes("提醒 NRXS 排名<=20"));
});

test("name lookup: alias, single match, multiple, none", async () => {
  const nv = { ...board, ticker: "NVDA", name: "NVIDIA" };
  const db = mkDb({ "latest_board?ticker=eq.NVDA": [nv], "latest_board?ticker=eq.NRXS": [board], "latest_board?name=ilike.*neuro*": [board], "latest_board?name=ilike.*corp*": [board, { ...board, ticker: "ZZZ", rank: 9 }] });
  assert.equal((await findByName(db, "輝達"))[0].altText.startsWith("NVDA"), true);
  assert.equal((await findByName(db, "Neuro"))[0].altText.startsWith("NRXS"), true);
  const many = await findByName(db, "corp");
  assert.match(many[0].altText, /符合 2 檔/);
  assert.equal(many[0].quickReply.items.length, 2);
  assert.equal(await findByName(db, "不存在的公司"), null);
  assert.equal(await findByName(db, "a"), null);
});

test("unknown ticker falls back to name search, then to not-found text", async () => {
  const db = mkDb({ "latest_board?name=ilike.*neuro*": [board], "latest_board?ticker=eq.NRXS": [board] });
  const hit = await run({ cmd: "stock", ticker: "NEURO", raw: "neuro" }, db, {});
  assert.equal(hit[0].altText.startsWith("NRXS"), true);
  const miss = await run({ cmd: "stock", ticker: "QQQQ", raw: "qqqq" }, db, {});
  assert.match(miss[0].text, /找不到 QQQQ/);
});

test("alias to an unscored ticker does not loop", async () => {
  const miss = await findByName(mkDb({}), "特斯拉");
  assert.match(miss[0].text, /找不到 TSLA/);
});

test("today/week show data age and warn when stale", async () => {
  const rows = [{ ticker: "A", score: 60, score_7d: 50, as_of: "2020-01-02" }];
  const wk = await run({ cmd: "week" }, mkDb({ "latest_board": rows, "user_watch": [] }), {});
  assert.equal(wk[0].type, "flex");
  assert.match(allText(wk[0]), /資料截至 2020-01-02（已落後/);
  assert.match(allText(wk[0]), /7 日漲最多\nA\n\+10\.0\n50→60/);
});

test("timeout texts differ for write vs read commands", () => {
  assert.match(timeoutText({ cmd: "add" }), /可能已完成/);
  assert.match(timeoutText({ cmd: "stock" }), /請再輸入一次/);
});

test("slow database → timeout reply (handle)", async () => {
  process.env.LINE_CHANNEL_SECRET = "s"; process.env.LINE_USER_ID = "U1"; process.env.LINE_CHANNEL_TOKEN = "t";
  process.env.SUPABASE_URL = "http://db"; process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  const { handle, TIMEOUT_MS } = await import("../supabase/functions/line-webhook/index.ts");
  const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e1", replyToken: "rt", source: { type: "user", userId: "U1" }, message: { type: "text", text: "NRXS" } }] });
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(body))).toString("base64");
  const replies = [];
  const fetchFn = async (url, opt) => {
    if (String(url).includes("/rpc/begin_line_event")) return {ok:true,json:async()=>({action:"execute"})};
    if (String(url).includes("/rpc/")) return {ok:true,json:async()=>true};
    if (String(url).includes("api.line.me")) { replies.push(JSON.parse(opt.body)); return { ok: true, text: async () => "" }; }
    return new Promise(() => {}); // database never answers
  };
  const t0 = Date.now();
  const res = await handle(new Request("http://x", { method: "POST", body, headers: { "x-line-signature": mac } }), fetchFn);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < TIMEOUT_MS + 1500);
  assert.match(replies[0].messages[0].text, /超過 8 秒/);
});

test("parse: compare, paging, natural add/del", () => {
  assert.equal(parseCommand("比較 NRXS ACOG").cmd, "compare");
  assert.equal(parseCommand("nrxs vs acog").b, "ACOG");
  assert.equal(parseCommand("榜單 2").page, 2);
  assert.equal(parseCommand("榜單").page, 1);
  assert.equal(parseCommand("把 NRXS 加入自選").cmd, "add");
  assert.equal(parseCommand("把 NRXS 移出自選").cmd, "del");
  assert.equal(parseCommand("NRXS 怎麼樣").cmd, "stock");
});

test("menu and commands: cashtag, more, batch add/del", async () => {
  assert.equal(parseCommand("$nrxs").ticker, "NRXS");
  assert.equal(parseCommand("更多功能").cmd, "more");
  assert.equal(parseCommand("更多").cmd, "top");                 // still "next page"
  assert.deepEqual(parseCommand("加 NRXS acog、TSLA").tickers, ["NRXS", "ACOG", "TSLA"]);
  assert.deepEqual(parseCommand("刪 NRXS,ACOG").tickers, ["NRXS", "ACOG"]);
  assert.equal(parseCommand("刪提醒 NRXS").cmd, "delalert");      // not swallowed by batch delete
  assert.equal(parseCommand("加 NRXS").ticker, "NRXS");
  // every rich-menu cell must be a real command
  const { resolveInput } = await import('../supabase/functions/line-webhook/assistant.ts');
  for (const t of MENU) assert.notEqual((await resolveInput(t, parseCommand, mkDb({}))).cmd, 'unknown', t);
});

test("suggest finds the intended command", () => {
  assert.equal(suggest("榜")[0], "榜單");
  assert.equal(suggest("週")[0], "週報");
  assert.equal(suggest("今天怎樣")[0], "今日");
  assert.deepEqual(suggest("zzz"), []);
});

test("unknown text replies with suggestions or main buttons", async () => {
  const a = await run({ cmd: "unknown", text: "榜" }, mkDb({}), {});
  assert.match(a[0].text, /你是不是要/);
  assert.equal(a[0].quickReply.items[0].action.text, "榜單");
  const b = await run({ cmd: "unknown", text: "zzzz" }, mkDb({}), {});
  assert.ok(b[0].quickReply.items.length >= 5);
});

test("more card has tools and a fresh dashboard login action", async () => {
  process.env.DASHBOARD_URL = "https://x.github.io/trend/";
  const out = await run({ cmd: "more" }, mkDb({}), {});
  const s = JSON.stringify(out[0]);
  assert.match(s, /募資/); assert.match(s, /成績單/); assert.match(s, /開啟網頁/);
  delete process.env.DASHBOARD_URL;
});

test("batch add reports found and missing tickers in one write", async () => {
  const writes = [];
  const db = mkDb({ "entities?ticker=in.": [{ ticker: "NRXS" }, { ticker: "ACOG" }] });
  db.send = async (m, p, body) => writes.push({ m, p, body });
  const out = await run(parseCommand("加 NRXS ACOG QQQQ"), db, {});
  assert.match(out[0].text, /已加入自選：NRXS、ACOG/);
  assert.match(out[0].text, /找不到：QQQQ/);
  assert.equal(writes.length, 1); assert.equal(writes[0].body.length, 2);
  const w2 = [];
  db.send = async (m, p) => w2.push(p);
  await run(parseCommand("刪 NRXS ACOG"), db, {});
  assert.match(w2[0], /ticker=in\.\(NRXS,ACOG\)/);
});

test("help text stays short enough for one LINE message", () => {
  assert.ok(helpText().length < 600);
});

test("dashboard: one-time sign-in link, with ticker and fallbacks", async () => {
  assert.deepEqual(parseCommand("儀表板"), { cmd: "dash" });
  assert.deepEqual(parseCommand("儀表板 nrxs"), { cmd: "dash", ticker: "NRXS" });
  const asked = [];
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board] });
  db.magicLink = async (to) => { asked.push(to); return "https://p.supabase.co/auth/v1/verify?token=x&redirect_to=" + encodeURIComponent(to); };
  const a = await dashLink(db, "https://u.github.io/trend", "NRXS");
  assert.equal(a.oneTime, true);
  assert.equal(asked[0], "https://u.github.io/trend/?t=NRXS");          // ticker in the query: the hash carries the tokens
  db.magicLink = async () => null;                                     // admin call failed → plain deep link
  assert.deepEqual(await dashLink(db, "https://u.github.io/trend", "NRXS"), { url: "https://u.github.io/trend/#t=NRXS", oneTime: false });
  db.magicLink = async () => { throw new Error("down"); };
  assert.equal((await dashLink(db, "https://u.github.io/trend")).url, "https://u.github.io/trend");
  assert.deepEqual(await dashLink(db, ""), { url: "", oneTime: false });
});

test("stock cards and tools request fresh dashboard links only when clicked", async () => {
  process.env.DASHBOARD_URL = "https://u.github.io/trend/";
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board], "user_watch": [] });
  let generated = 0;
  db.magicLink = async () => { generated++; return "https://u.github.io/trend/#line_token=" + 'a'.repeat(64) + '&type=email'; };
  const card = await run({ cmd: "stock", ticker: "NRXS" }, db, {});
  assert.equal(card[0].contents.footer.contents[0].action.type, 'message');
  assert.equal(card[0].contents.footer.contents[0].action.text, '儀表板 NRXS');
  const more = await run({ cmd: "more" }, db, {});
  assert.equal(more[0].contents.footer.contents[0].action.text, '儀表板');
  assert.equal(generated, 0, 'viewing stocks must not invalidate a previous login link');
  const d = await run({ cmd: "dash", ticker: "NRXS" }, db, {});
  assert.match(JSON.stringify(d[0]), /line_token=/);
  assert.equal(generated, 1);
  db.magicLink = async () => null;
  const failed = await run({cmd:'dash'}, db, {});
  assert.match(failed[0].text, /暫時無法建立/);
  assert.ok(!JSON.stringify(failed).includes('"type":"uri"'));
  delete process.env.DASHBOARD_URL;
});
// ── Taiwan ────────────────────────────────────────────────────────────────
const twRow = { ticker: "2330", name: "台積電", sector: "半導體業", exchange: "TWSE", board: "tw_main", rank: 3, score: 72.5, score_7d: 70,
  growth: 60, validated: 70, accessibility: 40, attention: 50, price: 1050, rev_yoy: 0.36, rev_cum_yoy: 0.31, ym: "11509",
  rs_6m: 0.12, mkt_cap: 2.7e13, dollar_vol: 3.1e10, as_of: "2026-10-16", flags: [] };

test("Taiwan: codes, 台股 commands, money format", () => {
  assert.ok(isTw("2330") && isTw("00878") && isTw("6488a") && !isTw("NRXS") && !isTw("123"));
  assert.deepEqual(parseCommand("2330"), { cmd: "stock", ticker: "2330", raw: "2330" });
  assert.deepEqual(parseCommand("台股"), { cmd: "top", tw: true, page: 1 });
  assert.deepEqual(parseCommand("台股 3"), { cmd: "top", tw: true, page: 3 });
  assert.equal(parseCommand("台股今日").tw, true);
  assert.equal(parseCommand("台股週報").cmd, "week");
  assert.equal(parseCommand("台股成績單").cmd, "report");
  assert.deepEqual(parseCommand("台股產業 半導體"), { cmd: "industry", tw: true, q: "半導體" });
  assert.equal(parseCommand("台股 2330").ticker, "2330");
  assert.equal(parseCommand("twitter").cmd, "unknown");
  assert.deepEqual(parseCommand("加 NRXS 2330").tickers, ["NRXS", "2330"]);
  assert.equal(twd(2.7e13), "27.00 兆"); assert.equal(twd(4.56e9), "45.6 億");
  for (const t of MENU_TW) assert.notEqual(parseCommand(t).cmd, "unknown", t);
});

test("Taiwan stock card reads the tw tables and shows NT$ fields", async () => {
  const asked = [];
  const db = mkDb({ "tw_latest_board?ticker=eq.2330": [twRow], "tw_latest_board?board=eq.tw_main&sector": [{ ticker: "2454" }, { ticker: "2330" }], "user_watch": [] });
  const get = db.get; db.get = (p) => { asked.push(p); return get(p); };
  const out = await run(parseCommand("2330"), db, {});
  const s = JSON.stringify(out[0]);
  assert.match(s, /台積電/); assert.match(s, /NT\$ 1050\.00/); assert.match(s, /上市/); assert.match(s, /27\.00 兆/);
  assert.match(s, /產業內排名/); assert.match(s, /第 2 \/ 2/);
  assert.ok(!asked.some((p) => p.startsWith("latest_board") || p.startsWith("smart_money")), "must not touch US tables");
  assert.equal(out[0].quickReply.items[0].action.text, "加 2330");
  const miss = await run(parseCommand("9999"), mkDb({}), {});
  assert.match(miss[0].text, /找不到 9999/);
});

test("Chinese names find Taiwan stocks first; US aliases still work", async () => {
  const db = mkDb({ "tw_latest_board?name=ilike.*%E5%8F%B0%E7%A9%8D%E9%9B%BB*": [twRow], "tw_latest_board?ticker=eq.2330": [twRow], "user_watch": [] });
  const out = await findByName(db, "台積電");
  assert.match(out[0].altText, /^2330/);
  const nv = await findByName(mkDb({ "latest_board?ticker=eq.NVDA": [{ ...board, ticker: "NVDA", name: "NVIDIA" }] }), "輝達");
  assert.match(nv[0].altText, /^NVDA/);
});

test("Taiwan top list, compare and unsupported features", async () => {
  const top = await run(parseCommand("台股"), mkDb({ "tw_latest_board?board=eq.tw_main": Array.from({ length: 10 }, (_, i) => ({ ...twRow, ticker: String(1101 + i), rank: i + 1 })) }), {});
  assert.match(top[0].altText, /台股主榜前 10 名/);
  assert.equal(top[0].quickReply.items[0].action.text, "台股 2");
  const cmp = await run(parseCommand("比較 2330 2454"), mkDb({ "tw_latest_board?ticker=in.": [twRow, { ...twRow, ticker: "2454", name: "聯發科", mkt_cap: 1.5e12 }] }), {});
  assert.match(JSON.stringify(cmp[0]), /兆/);
  const mixed = await run(parseCommand("比較 NRXS 2330"), mkDb({}), {});
  assert.match(mixed[0].text, /不能直接比/);
  const w = []; const adb = mkDb({ "tw_entities?ticker=eq.2330": [{ ticker: "2330" }], "user_alerts": [] }); adb.send = async (m, p, b) => w.push({ p, b });
  const set = await run(parseCommand("提醒 2330 分數>80"), adb, {});
  assert.match(set[0].text, /已設定：2330 分數>80/); assert.equal(w[0].p, "user_alerts"); assert.equal(w[0].b[0].ticker, "2330");
  const menu = await run(parseCommand("提醒 2330"), mkDb({ "tw_latest_board?ticker=eq.2330": [twRow] }), {});
  assert.match(menu[0].text, /台股主榜第 3 名/); assert.ok(menu[0].quickReply.items.every((i) => parseCommand(i.action.text).cmd === "alert"));
  const flows = await run(parseCommand("大戶 2330"), mkDb({ "tw_latest_board?ticker=eq.2330": [{ ...twRow, inst_5d: 0.04, inst_20d: 0.08, foreign_20d: 0.06, trust_20d: 0.01, pledge_ratio: 0.35 }] }), {});
  assert.match(flows[0].text, /三大法人　5 日 \+4\.0%　20 日 \+8\.0%/); assert.match(flows[0].text, /董監設質 35%（偏高）/);
  const list = await run(parseCommand("台股法人"), mkDb({ "tw_latest_board?board=eq.tw_main&inst_20d": [{ ...twRow, inst_20d: 0.08, foreign_20d: 0.06, trust_20d: 0.01 }] }), {});
  assert.match(JSON.stringify(list[0]), /三大法人 20 日買超/);
  const card = await run(parseCommand("2330"), mkDb({ "tw_latest_board?ticker=eq.2330": [{ ...twRow, inst_20d: -0.02, pledge_ratio: 0.1, flags: ["inst_buy", "high_pledge"] }], "user_watch": [] }), {});
  const cs = JSON.stringify(card[0]);
  assert.match(cs, /三大法人 20 日/); assert.match(cs, /-2\.0%/); assert.match(cs, /法人買超/); assert.match(cs, /董監設質高/);
});

test("watchlist splits US and Taiwan", async () => {
  const db = mkDb({ "user_watch": [{ ticker: "NRXS" }, { ticker: "2330" }], "latest_board?ticker=in.": [board], "tw_latest_board?ticker=in.": [twRow] });
  const out = await run({ cmd: "watch" }, db, {});
  assert.equal(out.length, 2);
  assert.match(out[0].altText, /美股自選 1 檔/); assert.match(out[1].altText, /台股自選 1 檔/);
});

test("Taiwan today/week/report use the tw tables and the market's own date rule", async () => {
  const asked = [];
  const db = mkDb({ "tw_scores?board=eq.tw_main&rank=eq.1": [{ as_of: "2026-10-16" }, { as_of: "2026-10-15" }], "tw_scores?as_of": [twRow], "user_watch": [], "tw_latest_board?board=eq.tw_main": [twRow], "tw_report_card": [] });
  const get = db.get; db.get = (p) => { asked.push(p); return get(p); };
  const today = await run(parseCommand("台股今日"), db, {});
  assert.equal(today[0].type, "flex");
  assert.match(allText(today[0]), /^台股今日變化\n資料截至 2026-10-16/);
  const week = await run(parseCommand("台股週報"), db, {});
  assert.match(allText(week[0]), /台股週報/);
  const rep = await run(parseCommand("台股成績單"), db, {});
  assert.match(rep[0].text, /台股成績單還沒有資料/);
  assert.ok(!asked.some((p) => /^(scores|latest_board|smart_money|fundraises|report_card)\?/.test(p)), "must not touch US tables");
  // TW data from Friday is fresh on Monday morning Taipei, stale by Tuesday evening
  assert.equal(dataAge("2026-10-16", new Date("2026-10-19T01:00:00Z"), true).stale, false);
  assert.equal(dataAge("2026-10-16", new Date("2026-10-20T10:00:00Z"), true).stale, true);
});

test("tabbed rich menus: geometry and switch actions", () => {
  const a = menuAreas(MENU_TW);
  assert.equal(a.length, 8);
  assert.equal(a[0].action.type, "richmenuswitch"); assert.equal(a[1].action.richMenuAliasId, "trend-tw");
  for (const x of a) {
    assert.ok(x.bounds.x + x.bounds.width <= MENU_W && x.bounds.y + x.bounds.height <= MENU_H);
  }
  assert.equal(a[2].bounds.y, MENU_TAB_H);
  assert.equal(a[7].action.text, "更多功能");
});

// ── score drivers (2026-11-28) ──
import { scoreDrivers, driversText } from "../supabase/functions/line-webhook/index.ts";
// same formula as crawler/score.py: pillars 0–100, each floored at 2, score = geomean × (1 − 0.6 × 擁擠)
const mk = (as_of, g, v, a, att) => ({ as_of, growth: g, validated: v, accessibility: a, attention: att,
  score: Math.round(Math.cbrt(Math.max(g, 2) * Math.max(v, 2) * Math.max(a, 2)) * (1 - 0.6 * att / 100) * 100) / 100 });

test("scoreDrivers: parts add up to the score change and name the biggest mover", () => {
  const pts = [mk("2026-11-12", 60, 50, 70, 30), mk("2026-11-18", 62, 52, 70, 30), mk("2026-11-19", 80, 50, 72, 35)];
  const d = scoreDrivers(pts); // newest = 11-19, base = latest row at least 7 days older = 11-12
  assert.equal(d.from, "2026-11-12");
  assert.ok(Math.abs(d.parts.reduce((s, p) => s + p.pts, 0) - d.delta) < 0.2);
  const by = Object.fromEntries(d.parts.map((p) => [p.label, p.pts]));
  assert.ok(by["成長"] > 0 && by["擁擠"] < 0 && Math.abs(by["驗證"]) < Math.abs(by["成長"]));
  assert.match(driversText(d), /^7 日變化來源：成長 \+/);
});

test("scoreDrivers: says nothing when it cannot be honest", () => {
  assert.equal(scoreDrivers([mk("2026-11-19", 70, 50, 72, 40)]), null);                                      // one point
  assert.equal(scoreDrivers([mk("2026-11-17", 60, 50, 70, 30), mk("2026-11-19", 70, 50, 72, 40)]), null);   // nothing 7 days old
  const floored = scoreDrivers([mk("2026-11-10", 60, 0, 70, 30), mk("2026-11-19", 70, 50, 72, 40)]);          // a 0 pillar is floored at 2, like the score
  assert.ok(floored && Math.abs(floored.parts.reduce((s, p) => s + p.pts, 0) - floored.delta) < 0.2);
  assert.equal(scoreDrivers([{ ...mk("2026-11-10", 60, 50, 70, 30), attention: null }, mk("2026-11-19", 70, 50, 72, 40)]), null); // missing data
  const off = [{ ...mk("2026-11-10", 60, 50, 70, 30), score: 10 }, mk("2026-11-19", 70, 50, 72, 40)];        // score not from the formula
  assert.equal(scoreDrivers(off), null);
  assert.equal(driversText(null), null);
  const flat = [mk("2026-11-10", 60, 50, 70, 30), mk("2026-11-19", 60, 50, 70, 30)];
  assert.equal(driversText(scoreDrivers(flat)), null);                                                        // no move, no line
});

test("stock card shows the drivers line only when given", () => {
  const s = { ticker: "AAA", name: "A", score: 70, rank: 3, board: "main", growth: 70, validated: 50, accessibility: 72, attention: 40, flags: [] };
  const has = (c) => JSON.stringify(c).includes("7 日變化來源");
  assert.equal(has(stockCard(s, null, "", { drivers: "7 日變化來源：成長 +4.0" })), true);
  assert.equal(has(stockCard(s, null, "", {})), false);
});

test("report summary: buckets with sample sizes and honest caveats", async () => {
  const { reportSummary } = await import("../supabase/functions/line-webhook/index.ts");
  const mk = (as_of, horizon, avg, spy) => ({ as_of, horizon, avg_ret: avg, spy_ret: spy, excess: avg - spy, hit_rate: 0.6 });
  const rows = [mk("2026-10-01", 20, 0.05, 0.04), mk("2026-10-02", 20, 0.03, 0.04), mk("2026-10-01", 5, 0.01, 0.0)];
  const b = (as_of, bucket, n, avg, bench) => ({ as_of, horizon: 20, bucket, n, avg_ret: avg, bench_ret: bench, hit_rate: 0.5 });
  const buckets = [b("2026-10-01", "80+", 10, 0.06, 0.04), b("2026-10-02", "80+", 10, 0.02, 0.04), b("2026-10-01", "60-69", 40, 0.04, 0.04)];
  const text = reportSummary(rows, buckets, "大盤", "台股");
  assert.match(text, /^台股成績單：分數級距/);
  assert.match(text, /【20 日後】樣本 2 個榜單日（樣本短）/);
  assert.match(text, /前 20 名　平均 \+4%　大盤 \+4%/);
  assert.match(text, /分數 80\+　平均 \+4%　超額 0%　勝率 50%　2 日 20 筆（太少）/);   // weighted by n, fewer than 30 rows
  assert.match(text, /分數 60-69　平均 \+4%.*1 日 40 筆/);
  assert.ok(!/60-69.*（太少）/.test(text));
  assert.match(text, /【5 日後】樣本 1 個榜單日（樣本短）/);
  assert.match(text, /20 日後：大盤同期平均 \+4%，這段期間行情偏多/);                   // |bench| >= 3% over 20 days
  assert.match(text, /獨立樣本比「筆數」少很多/);
  assert.equal(reportSummary([], [], "SPY", ""), "成績單還沒有資料，要累積 5 個交易日以上。");
  const quiet = reportSummary([mk("2026-10-01", 20, 0.01, 0.0)], [], "SPY");
  assert.ok(!/偏多|偏空/.test(quiet));
});

test("report command reads the bucket table for the right market", async () => {
  const asked = [];
  const rows = [{ as_of: "2026-10-01", horizon: 20, avg_ret: 0.02, spy_ret: 0.01, excess: 0.01, hit_rate: 0.5 }];
  const db = mkDb({ "tw_report_card": rows, "score_bucket_card": [] });
  const get = db.get; db.get = (p) => { asked.push(p); return get(p); };
  const out = await run(parseCommand("台股成績單"), db, {});
  assert.equal(out[0].type, "flex");
  assert.match(allText(out[0]), /^台股成績單\n/);
  assert.match(allText(out[0]), /20 日後/);
  assert.ok(asked.some((p) => p.startsWith("score_bucket_card?market=eq.tw")));
  assert.ok(!asked.some((p) => p.startsWith("report_card?")));
});

test("important dates: command, Taipei date, overdue/soon buckets, revenue deadline, honest US note", async () => {
  assert.equal(parseCommand("重要日期").cmd, "dates");
  assert.equal(parseCommand("行事曆").cmd, "dates");
  assert.equal(nextRevenueDeadline("2026-11-28"), "2026-12-10");
  assert.equal(nextRevenueDeadline("2026-12-28"), "2027-01-10");
  assert.equal(nextRevenueDeadline("2026-12-10"), "2026-12-10");
  const now = Date.parse("2026-11-28T10:00:00Z"); // 18:00 in Taipei, still 11-28
  const text = importantDates([
    { ticker: "NRXS", review_on: "2026-11-25", status: "watching", next_step: "看財報" },
    { ticker: "2330", review_on: "2026-12-02", status: "researching", next_step: "" },
    { ticker: "AAPL", review_on: "2027-03-01", status: "watching" },
    { ticker: "ZZZ", review_on: "2026-11-30", status: "rejected" },
  ], now);
  assert.match(text, /台北時間 2026-11-28/);
  assert.match(text, /下一個期限 2026-12-10（12 天後）/);
  assert.match(text, /已逾期複查\nNRXS　2026-11-25（已逾期 3 天）　下一步：看財報/);
  assert.match(text, /7 天內要複查\n2330　2026-12-02（4 天後）/);
  assert.doesNotMatch(text, /AAPL|ZZZ/);
  assert.match(text, /美股財報日沒有免費/);
  const empty = importantDates([], now);
  assert.match(empty, /還沒有設複查日/);
  const out = await run({ cmd: "dates" }, mkDb({ "research_cards": [{ ticker: "NRXS", review_on: "2026-11-29", status: "watching", next_step: "" }] }), {});
  assert.equal(out[0].type, "flex");
  const t = allText(out[0]);
  assert.match(t, /^重要日期\n台北時間 /);
  assert.match(t, /7 天內要複查\nNRXS/);
  assert.match(t, /台股月營收\n下一個公布期限/);
  assert.match(t, /美股財報日沒有免費/);
  const none = allText((await run({ cmd: "dates" }, mkDb({ "research_cards": [] }), {}))[0]);
  assert.match(none, /研究卡還沒有設複查日/);
});

test("notification switches: parse, show state, write only the chosen market's column", async () => {
  assert.equal(parseCommand("通知設定").cmd, "notify");
  assert.deepEqual(parseCommand("關閉台股通知"), { cmd: "setnotify", tw: true, on: false });
  assert.deepEqual(parseCommand("開啟美股每日摘要"), { cmd: "setnotify", tw: false, on: true });
  const db = mkDb({ "line_preferences": [{ digest_us: true, digest_tw: false }] });
  const shown = await run({ cmd: "notify" }, db, {});
  assert.equal(shown[0].type, "flex");
  assert.match(allText(shown[0]), /美股\n● 開啟\n台股\n● 關閉/);
  assert.match(allText(shown[0]), /沒有另外設安靜時段/);
  assert.deepEqual(shown[0].contents.footer.contents.map((b) => b.action.text), ["關閉美股通知", "開啟台股通知"]);
  const writes = []; const wdb = mkDb({}); wdb.send = async (m, p, b, pref) => writes.push({ m, p, b, pref });
  const set = await run({ cmd: "setnotify", tw: true, on: false }, wdb, { eventTime: "2026-11-28T00:00:00Z" });
  assert.match(set[0].text, /已關閉台股每日摘要/);
  assert.equal(writes[0].p, "line_preferences?on_conflict=user_id");
  assert.equal(writes[0].b.digest_tw, false); assert.ok(!("digest_us" in writes[0].b) && !("market" in writes[0].b));
  assert.equal(writes[0].pref, "resolution=merge-duplicates,return=minimal");
});


test("report card: aligned columns, signed colours, caveats for short samples and a one-sided market", () => {
  const rows = [{ as_of: "2026-10-01", horizon: 20, avg_ret: 0.05, spy_ret: 0.04, excess: 0.01, hit_rate: 0.5 }];
  const buckets = [{ as_of: "2026-10-01", horizon: 20, bucket: "80+", n: 4, avg_ret: 0.06, bench_ret: 0.04, hit_rate: 0.75 },
                   { as_of: "2026-10-01", horizon: 20, bucket: "<60", n: 40, avg_ret: 0.01, bench_ret: 0.04, hit_rate: 0.3 }];
  const card = reportCard(rows, buckets, "SPY", "");
  const t = allText(card);
  assert.match(t, /^成績單\n主榜分數級距，每日收盤價，基準 SPY\n20 日後\n1 個榜單日・樣本短/);
  assert.match(t, /前 20 名\n\+5%\n\+1%\n50%/);
  assert.match(t, /分數 <60\n\+1%\n-3%\n30%\n40/);
  assert.match(t, /20 日後：SPY同期平均 \+4%，這段期間行情偏多/);
  const json = JSON.stringify(card);
  assert.ok(json.includes('"color":"#ee6a7b"') && json.includes('"color":"#2fbf8f"'), "negative excess is red, positive green");
  assert.ok(json.includes('"color":"#f2b44a"'), "a bucket with fewer than 30 rows is flagged");
  assert.equal(reportCard([], [], "SPY", "台股").text, "台股成績單還沒有資料，要累積 5 個交易日以上。");
});

test("alerts list and industry list are cards whose rows send the next command", async () => {
  const al = await run({ cmd: "alerts" }, mkDb({ "user_alerts": [{ ticker: "NRXS", metric: "score", op: ">", value: 70, fired_at: null }, { ticker: "2330", metric: "rank", op: "<=", value: 5, fired_at: "2026-11-01" }] }), {});
  assert.equal(al[0].type, "flex");
  assert.match(allText(al[0]), /^我的提醒\n1 則待觸發，上限 20 則\nNRXS\n分數 > 70\n待觸發\n2330\n排名 <= 5\n已觸發/);
  const sec = await run({ cmd: "industry", q: "" }, mkDb({ "latest_board": [{ sector: "Biotech" }, { sector: "Biotech" }, { sector: "Software" }] }), {});
  assert.equal(sec[0].type, "flex");
  assert.match(allText(sec[0]), /主榜產業分布\n點一列看該產業前 5 名\nBiotech\n2 檔\nSoftware\n1 檔/);
  assert.ok(JSON.stringify(sec[0]).includes('"text":"產業 Biotech"'));
  const none = await run({ cmd: "alerts" }, mkDb({ "user_alerts": [] }), {});
  assert.match(none[0].text, /沒有提醒/);
});
