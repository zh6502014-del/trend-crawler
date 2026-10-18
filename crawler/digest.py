"""Daily digest: what changed on the boards since the previous run, sent to LINE (and Telegram if configured).

One message a day, sent at the end of the US run (Taipei morning). It also carries a Taiwan section built from the
latest Taiwan run (the previous Taipei afternoon), so both markets share the single daily push.

Runs after the other stages. Does nothing (and never fails the run) unless TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID are set. The message is plain text and short on purpose.
"""
from __future__ import annotations

import datetime as dt
import os
import re

import requests

TOP_N = 20
JUMP = 8.0           # score points that count as a "big move"
DASHBOARD = os.getenv("DASHBOARD_URL", "")


WATCH_MOVE = 5.0     # score points a watchlist name must move to be mentioned
OPS = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b}
METRICS = {"score": "分數", "rank": "排名"}
MAIN_BOARDS = ("main", "tw_main")


def is_tw(ticker) -> bool:
    """Taiwan codes are 4-6 digits (plus an optional letter); US tickers start with a letter."""
    return re.fullmatch(r"\d{4,6}[A-Za-z]?", str(ticker or "")) is not None


def check_alerts(alerts: list[dict], rows: dict) -> list[dict]:
    """alerts: user_alerts rows still armed; rows: {ticker: today's score row}. Returns the alerts that now hold."""
    hit = []
    for a in alerts:
        if a.get("fired_at"):
            continue
        r = rows.get(a.get("ticker"))
        op = OPS.get(a.get("op"))
        if r is None or op is None or a.get("metric") not in METRICS:
            continue
        v = r.get(a["metric"])
        try:
            if v is not None and op(float(v), float(a["value"])):
                hit.append({**a, "now": float(v)})
        except (TypeError, ValueError):
            continue
    return hit


def watch_lines(watch: list[str], today: dict, prev: dict, smart: dict) -> list[str]:
    """One line per watchlist name that did something worth a message. today/prev: {ticker: row} on ANY board."""
    tags = {"insider_cluster": "內部人群買", "insider_buy": "內部人買進", "activist_13d": "13D", "new_5pct": "新5%持有人"}
    out = []
    for t in watch:
        r = today.get(t)
        if not r or r.get("score") is None:
            continue
        p = prev.get(t) or {}
        bits = []
        if p.get("score") is not None and abs(r["score"] - p["score"]) >= WATCH_MOVE:
            bits.append(f"分數 {p['score']:.0f}→{r['score']:.0f}")
        if p.get("board") and p["board"] != r.get("board"):
            bits.append("進入主榜" if r.get("board") in MAIN_BOARDS else "掉出主榜")
        sm = smart.get(t) or {}
        if (sm.get("score") or 0) > 0 and sm.get("tags"):
            bits.append("大戶：" + "/".join(tags.get(x, x) for x in sm["tags"]))
        if bits:
            out.append(f"{t}　" + "；".join(bits))
    return out


def tw_lines(today_rows: list[dict], prev_rows: list[dict], watch_msgs: list[str] | None = None) -> list[str]:
    """Taiwan section: watchlist moves, new top-20 names, big score jumps, top-20 names with 法人買超. Pure."""
    cur = {r["ticker"]: r for r in today_rows if r.get("board") == "tw_main"}
    prev = {r["ticker"]: r for r in prev_rows if r.get("board") == "tw_main"}
    top = [r for r in cur.values() if (r.get("rank") or 999) <= TOP_N]
    prev_top = {t for t, r in prev.items() if (r.get("rank") or 999) <= TOP_N}
    out = []
    if watch_msgs:
        out.append("自選異動：\n" + "\n".join(watch_msgs[:8]))
    entered = sorted((r for r in top if r["ticker"] not in prev_top), key=lambda r: r["rank"]) if prev else []
    if entered:
        out.append("新進前 20 名：" + "、".join(f"{r['ticker']}{r.get('name') or ''}（第{r['rank']}名）" for r in entered[:6]))
    jumps = sorted((r for r in cur.values() if r["ticker"] in prev and r.get("score") is not None and prev[r["ticker"]].get("score") is not None
                    and r["score"] - prev[r["ticker"]]["score"] >= JUMP), key=lambda r: -(r["score"] - prev[r["ticker"]]["score"]))[:5]
    if jumps:
        out.append("分數大幅上升：" + "、".join(f"{r['ticker']}{r.get('name') or ''} +{r['score'] - prev[r['ticker']]['score']:.0f}" for r in jumps))
    buy = sorted((r for r in top if "inst_buy" in (r.get("flags") or [])), key=lambda r: r["rank"])
    if buy:
        out.append("前 20 名法人買超：" + "、".join(f"{r['ticker']}{r.get('name') or ''}" for r in buy[:6]))
    return out


def compose(today_rows: list[dict], prev_rows: list[dict], smart: dict, raises: list[dict], as_of: str,
            watch_msgs: list[str] | None = None, fired: list[dict] | None = None,
            tw: dict | None = None) -> str | None:
    """Pure function → message text, or None when there is nothing worth sending."""
    cur = {r["ticker"]: r for r in today_rows if r.get("board") == "main"}
    prev = {r["ticker"]: r for r in prev_rows if r.get("board") == "main"}
    top = [r for r in cur.values() if (r.get("rank") or 999) <= TOP_N]
    prev_top = {t for t, r in prev.items() if (r.get("rank") or 999) <= TOP_N}
    entered = sorted((r for r in top if r["ticker"] not in prev_top), key=lambda r: r["rank"]) if prev else []
    jumps = sorted((r for r in cur.values() if r["ticker"] in prev and r.get("score") is not None and prev[r["ticker"]].get("score") is not None
                    and r["score"] - prev[r["ticker"]]["score"] >= JUMP), key=lambda r: -(r["score"] - prev[r["ticker"]]["score"]))[:5]
    big = sorted((r for r in top if (smart.get(r["ticker"]) or {}).get("score", 0) > 0), key=lambda r: r["rank"])
    head_lines, lines = [], []
    if fired:
        head_lines.append("你設的提醒：" + "、".join(
            f"{a['ticker']} {METRICS[a['metric']]}{a['op']}{a['value']:g}（現在 {a['now']:.0f}）" for a in fired[:6]))
    if watch_msgs:
        lines.append("自選異動：\n" + "\n".join(watch_msgs[:8]))
    if entered:
        lines.append("新進前 20 名：" + "、".join(f"{r['ticker']}（第{r['rank']}名）" for r in entered[:8]))
    if jumps:
        lines.append("分數大幅上升：" + "、".join(f"{r['ticker']} +{r['score'] - prev[r['ticker']]['score']:.0f}" for r in jumps))
    if big:
        tags = {"insider_cluster": "內部人群買", "insider_buy": "內部人買進", "activist_13d": "13D", "new_5pct": "新5%持有人"}
        lines.append("前 20 名中有大戶動向：" + "、".join(
            f"{r['ticker']}（{'/'.join(tags.get(x, x) for x in (smart[r['ticker']].get('tags') or []))}）" for r in big[:6]))
    if raises:
        lines.append("新的 Reg CF 募資：" + "、".join(r.get("issuer") or "?" for r in raises[:6]))
    tw_part = (tw or {}).get("lines") or []
    if tw_part:  # label the markets only when both are in the message
        if lines:
            lines = ["【美股】"] + lines
        lines += [f"【台股 {tw.get('as_of', '')}】".replace(" 】", "】")] + tw_part
    if not head_lines and not lines:
        return None
    head = f"趨勢爬蟲 {as_of}"
    tail = f"\n{DASHBOARD}" if DASHBOARD else ""
    return head + "\n" + "\n".join(head_lines + lines) + tail


def send_telegram(text: str, token: str, chat_id: str) -> None:
    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}, timeout=30)
    r.raise_for_status()


LINE_MONTHLY_CAP = int(os.getenv("LINE_MONTHLY_CAP", "100"))   # our own ceiling, well under the free quota
LINE_RESERVE = 20                                                # always keep this many messages of the plan unused


def line_budget_ok(token: str, session=None) -> tuple[bool, str]:
    """Ask LINE how many messages this month's plan allows and how many are used. Fail CLOSED: any doubt means do not send.

    Sends only on a plan with a hard monthly limit (the free plan), never on an unlimited / pay-per-message plan,
    and only while usage + 1 stays under min(LINE_MONTHLY_CAP, limit - LINE_RESERVE).
    """
    sess = session or requests
    h = {"Authorization": f"Bearer {token}"}
    try:
        q = sess.get("https://api.line.me/v2/bot/message/quota", headers=h, timeout=30)
        q.raise_for_status()
        u = sess.get("https://api.line.me/v2/bot/message/quota/consumption", headers=h, timeout=30)
        u.raise_for_status()
        quota, used = q.json(), int(u.json().get("totalUsage"))
    except Exception as e:  # noqa: BLE001
        return False, f"quota check failed ({str(e)[:80]}), not sending"
    if quota.get("type") != "limited" or not isinstance(quota.get("value"), int):
        return False, f"plan is not a hard-limited one ({quota.get('type')}), not sending"
    ceiling = min(LINE_MONTHLY_CAP, quota["value"] - LINE_RESERVE)
    if used + 1 > ceiling:
        return False, f"used {used} of ceiling {ceiling} (plan limit {quota['value']}), not sending"
    return True, f"used {used} of ceiling {ceiling}"


def send_line(text: str, token: str, user_id: str) -> None:
    """LINE Messaging API push to one user (LINE Notify was shut down in 2025)."""
    r = requests.post("https://api.line.me/v2/bot/message/push",
                      headers={"Authorization": f"Bearer {token}"},
                      json={"to": user_id, "messages": [{"type": "text", "text": text[:4900]}]}, timeout=30)
    r.raise_for_status()


def taiwan_section(store, today: dt.date, watch: list[str], alerts: list[dict]) -> tuple[dict | None, list[dict]]:
    """Latest Taiwan board vs the one before, if it is fresh (made today or yesterday, UTC). Returns (section, fired alerts)."""
    dates = sorted({r["as_of"] for r in store.select("tw_scores", {"select": "as_of", "as_of": f"gte.{(today - dt.timedelta(days=14)).isoformat()}", "rank": "eq.1", "board": "eq.tw_main"})}, reverse=True)
    if not dates or (today - dt.date.fromisoformat(str(dates[0])[:10])).days > 1:
        return None, []  # no fresh Taiwan run since the last digest: say nothing rather than repeat yesterday
    cols = "ticker,as_of,board,rank,score,flags"
    cur = store.select("tw_scores", {"select": cols, "as_of": f"eq.{dates[0]}", "board": "eq.tw_main"})
    prev = store.select("tw_scores", {"select": cols, "as_of": f"eq.{dates[1]}", "board": "eq.tw_main"}) if len(dates) > 1 else []
    try:
        names = {r["ticker"]: r.get("name") for r in store.select("tw_entities", {"select": "ticker,name", "ticker": "in.(" + ",".join(r["ticker"] for r in cur) + ")"})} if cur else {}
    except Exception:  # noqa: BLE001
        names = {}
    for r in cur + prev:
        r["name"] = names.get(r["ticker"]) or ""
    wt, wp = {}, {}
    tickers = sorted(set(watch) | {a["ticker"] for a in alerts})
    if tickers:
        lst = "in.(" + ",".join(tickers) + ")"
        wt = {r["ticker"]: r for r in store.select("tw_scores", {"select": cols, "as_of": f"eq.{dates[0]}", "ticker": lst})}
        if len(dates) > 1:
            wp = {r["ticker"]: r for r in store.select("tw_scores", {"select": cols, "as_of": f"eq.{dates[1]}", "ticker": lst})}
    fired = check_alerts(alerts, wt)
    lines = tw_lines(cur, prev, watch_lines(watch, wt, wp, {}))
    return ({"as_of": str(dates[0])[:10], "lines": lines} if lines else None), fired


def run_digest(store, today: dt.date | None = None) -> dict:
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    line_token, line_user = os.getenv("LINE_CHANNEL_TOKEN"), os.getenv("LINE_USER_ID")
    use_tg, use_line = bool(token and chat), bool(line_token and line_user)
    if not use_tg and not use_line:
        print("  digest: no TELEGRAM_* or LINE_* secrets set, skipped")
        return {"sent": False, "reason": "not configured"}
    today = today or dt.date.today()
    dates = sorted({r["as_of"] for r in store.select("scores", {"select": "as_of", "as_of": f"gte.{(today - dt.timedelta(days=14)).isoformat()}", "rank": "eq.1", "board": "eq.main"})}, reverse=True)
    if not dates:
        return {"sent": False, "reason": "no scores"}
    cols = "ticker,as_of,board,rank,score"
    cur = store.select("scores", {"select": cols, "as_of": f"eq.{dates[0]}", "board": "eq.main"})
    prev = store.select("scores", {"select": cols, "as_of": f"eq.{dates[1]}", "board": "eq.main"}) if len(dates) > 1 else []
    smart = {r["ticker"]: r for r in store.select("smart_money", {"select": "ticker,score,tags"})}
    since = (today - dt.timedelta(days=1)).isoformat()
    raises = store.select("fundraises", {"select": "issuer,filed_at,form_type", "filed_at": f"gte.{since}", "form_type": "eq.C"})
    watch, alerts, wt, wp = [], [], {}, {}
    try:
        watch = sorted({r["ticker"] for r in store.select("user_watch", {"select": "ticker"})})
        alerts = [a for a in store.select("user_alerts", {"select": "id,ticker,metric,op,value,fired_at"}) if not a.get("fired_at")]
    except Exception as e:  # noqa: BLE001 - missing table / no rows must not stop the digest
        print(f"  digest: watchlist/alerts unavailable ({str(e)[:80]})")
    tw_watch = [t for t in watch if is_tw(t)]
    watch = [t for t in watch if not is_tw(t)]
    tw_alerts = [a for a in alerts if is_tw(a.get("ticker"))]
    alerts = [a for a in alerts if not is_tw(a.get("ticker"))]
    names = sorted(set(watch) | {a["ticker"] for a in alerts})
    if names:
        lst = "in.(" + ",".join(names) + ")"
        wt = {r["ticker"]: r for r in store.select("scores", {"select": cols, "as_of": f"eq.{dates[0]}", "ticker": lst})}
        if len(dates) > 1:
            wp = {r["ticker"]: r for r in store.select("scores", {"select": cols, "as_of": f"eq.{dates[1]}", "ticker": lst})}
    fired = check_alerts(alerts, wt)
    tw, tw_fired = None, []
    try:
        tw, tw_fired = taiwan_section(store, today, tw_watch, tw_alerts)
    except Exception as e:  # noqa: BLE001 - Taiwan is a bonus: never block the US digest
        print(f"  digest: taiwan section skipped ({str(e)[:100]})")
    fired = fired + tw_fired
    text = compose(cur, prev, smart, raises, str(dates[0])[:10], watch_lines(watch, wt, wp, smart), fired, tw)
    if not text:
        print("  digest: nothing new")
        return {"sent": False, "reason": "nothing new"}
    sent = []
    for name, ok, fn in (("telegram", use_tg, lambda: send_telegram(text, token, chat)),
                         ("line", use_line, lambda: send_line(text, line_token, line_user))):
        if not ok:
            continue
        try:
            if name == "line":
                ok, why = line_budget_ok(line_token)
                print(f"  digest: line budget: {why}")
                if not ok:
                    continue
            fn()
            sent.append(name)
        except Exception as e:  # noqa: BLE001 - a failed notification must not fail the crawl
            print(f"  digest: {name} failed: {str(e)[:150]}")
    if sent and fired:  # alerts are one-shot: disarm only once the message actually went out
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        for a in fired:
            try:
                store.update("user_alerts", {"id": a["id"]}, {"fired_at": now})
            except Exception as e:  # noqa: BLE001
                print(f"  digest: could not disarm alert {a['id']}: {str(e)[:80]}")
    print(f"  digest: sent via {sent or 'nobody'}")
    return {"sent": bool(sent), "channels": sent}
