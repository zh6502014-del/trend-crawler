// Run: node --test tests/line_webhook.test.mjs   (Node 22.18+ strips the .ts types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, dataAge, withQuick, run, findByName, timeoutText, stockCard, cleanQuery, suggest, MENU, helpText, dashLink, isTw, twd, MENU_TW, menuAreas, MENU_W, MENU_H, MENU_TAB_H } from "../supabase/functions/line-webhook/index.ts";

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
  assert.match(wk[0].text, /資料截至 2020-01-02（已落後/);
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
    if (String(url).includes("/rpc/claim_line_event")) return {ok:true,json:async()=>true};
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

test("menu and commands: cashtag, more, batch add/del", () => {
  assert.equal(parseCommand("$nrxs").ticker, "NRXS");
  assert.equal(parseCommand("更多功能").cmd, "more");
  assert.equal(parseCommand("更多").cmd, "top");                 // still "next page"
  assert.deepEqual(parseCommand("加 NRXS acog、TSLA").tickers, ["NRXS", "ACOG", "TSLA"]);
  assert.deepEqual(parseCommand("刪 NRXS,ACOG").tickers, ["NRXS", "ACOG"]);
  assert.equal(parseCommand("刪提醒 NRXS").cmd, "delalert");      // not swallowed by batch delete
  assert.equal(parseCommand("加 NRXS").ticker, "NRXS");
  // every rich-menu cell must be a real command
  for (const t of MENU) assert.notEqual(parseCommand(t).cmd, "unknown", t);
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

test("more card has buttons and a dashboard link", async () => {
  process.env.DASHBOARD_URL = "https://x.github.io/trend/";
  const out = await run({ cmd: "more" }, mkDb({}), {});
  const s = JSON.stringify(out[0]);
  assert.match(s, /募資/); assert.match(s, /成績單/); assert.match(s, /開啟儀表板/);
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

test("stock card and 更多 carry the sign-in link", async () => {
  process.env.DASHBOARD_URL = "https://u.github.io/trend/";
  const db = mkDb({ "latest_board?ticker=eq.NRXS": [board], "user_watch": [] });
  db.magicLink = async () => "https://p.supabase.co/auth/v1/verify?token=abc";
  const card = await run({ cmd: "stock", ticker: "NRXS" }, db, {});
  assert.match(JSON.stringify(card[0]), /verify\?token=abc/);
  const more = await run({ cmd: "more" }, db, {});
  assert.match(JSON.stringify(more[0]), /verify\?token=abc/);
  assert.match(JSON.stringify(more[0]), /只能用一次/);
  const d = await run({ cmd: "dash", ticker: "NRXS" }, db, {});
  assert.match(JSON.stringify(d[0]), /verify\?token=abc/);
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
  assert.match(today[0].text, /^台股　資料截至 2026-10-16/);
  const week = await run(parseCommand("台股週報"), db, {});
  assert.match(week[0].text, /台股週報/);
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

test("設定選單: first run parks aliases, builds both menus, repoints aliases, cleans old ones", async () => {
  process.env.DASHBOARD_URL = "https://u.github.io/trend/"; process.env.LINE_CHANNEL_SECRET = "s"; process.env.LINE_USER_ID = "U1";
  process.env.LINE_CHANNEL_TOKEN = "t"; process.env.SUPABASE_URL = "http://db"; process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  const { handle } = await import("../supabase/functions/line-webhook/index.ts");
  const calls = []; let n = 0; const aliases = {};
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => "", arrayBuffer: async () => new ArrayBuffer(4) });
  const fetchFn = async (url, opt = {}) => {
    const m = opt.method || "GET"; calls.push(m + " " + url);
    if (url.includes("/auth/v1/admin/users")) return ok({users:[{id:"u1",email:"owner@example.invalid"}]});
    if (url.includes("/rest/v1/line_sessions")) return ok([]);
    if (url.endsWith(".png")) return ok({});
    if (url.endsWith("/richmenu/alias/list")) return ok({ aliases: [] });
    if (url.endsWith("/v2/bot/richmenu") && m === "POST") {
      const b = JSON.parse(opt.body);
      for (const a of b.areas) if (a.action.type === "richmenuswitch" && !aliases[a.action.richMenuAliasId]) return { ok: false, status: 400, text: async () => "alias not found" };
      return ok({ richMenuId: "rm" + (++n) });
    }
    if (url.endsWith("/richmenu/alias") && m === "POST") { const b = JSON.parse(opt.body); if (aliases[b.richMenuAliasId]) return { ok: false, status: 400, text: async () => "dup" }; aliases[b.richMenuAliasId] = b.richMenuId; return ok({}); }
    if (/\/richmenu\/alias\/trend-/.test(url)) { aliases[url.split("/").pop()] = JSON.parse(opt.body).richMenuId; return ok({}); }
    if (url.endsWith("/richmenu/list")) return ok({ richmenus: [{ name: "trend-menu", richMenuId: "old1" }, { name: "trend-menu-boot", richMenuId: "rm1" }, { name: "other", richMenuId: "x" }, ...Object.values(aliases).map((id) => ({ name: "trend-menu", richMenuId: id }))] });
    if (url.includes("api.line.me/v2/bot/message/reply")) { calls.reply = JSON.parse(opt.body); return ok({}); }
    return ok({});
  };
  const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "menu1", replyToken: "rt", source: { type: "user", userId: "U1" }, message: { type: "text", text: "設定選單" } }] });
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(body))).toString("base64");
  await handle(new Request("http://x", { method: "POST", body, headers: { "x-line-signature": mac } }), fetchFn);
  assert.match(calls.reply.messages[0].text, /選單已建立（美股／台股/);
  assert.equal(aliases["trend-us"], "rm3"); assert.equal(aliases["trend-tw"], "rm4");      // repointed to the tabbed menus
  assert.ok(calls.includes("DELETE https://api.line.me/v2/bot/richmenu/old1") && calls.includes("DELETE https://api.line.me/v2/bot/richmenu/rm1"));
  assert.ok(!calls.includes("DELETE https://api.line.me/v2/bot/richmenu/x"));
  assert.ok(calls.includes("POST https://api.line.me/v2/bot/user/all/richmenu/rm3"));
  delete process.env.DASHBOARD_URL;
});
