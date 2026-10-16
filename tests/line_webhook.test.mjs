// Run: node --test tests/line_webhook.test.mjs   (Node 22.18+ strips the .ts types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, dataAge, withQuick, run, findByName, timeoutText, stockCard, cleanQuery } from "../supabase/functions/line-webhook/index.ts";

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
  assert.deepEqual(items, ["刪 NRXS", "提醒 NRXS", "大戶 NRXS", "榜單"]);
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
  const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "e1", replyToken: "rt", source: { userId: "U1" }, message: { type: "text", text: "NRXS" } }] });
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(body))).toString("base64");
  const replies = [];
  const fetchFn = async (url, opt) => {
    if (String(url).includes("api.line.me")) { replies.push(JSON.parse(opt.body)); return { ok: true, text: async () => "" }; }
    return new Promise(() => {}); // database never answers
  };
  const t0 = Date.now();
  const res = await handle(new Request("http://x", { method: "POST", body, headers: { "x-line-signature": mac } }), fetchFn);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < TIMEOUT_MS + 1500);
  assert.match(replies[0].messages[0].text, /超過 8 秒/);
});
