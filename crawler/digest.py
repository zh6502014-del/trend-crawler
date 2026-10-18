"""Daily digest: what changed on the boards since the previous run, sent to LINE (and Telegram if configured).

Production sends one digest per market snapshot, after each market crawl.
Manual runs may use DIGEST_MARKET=both to combine the markets.

Runs after the other stages. Requires LINE_CHANNEL_TOKEN/LINE_USER_ID or
TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID. The message is plain text and short on purpose.
"""
from __future__ import annotations

import datetime as dt
import os
import re
import uuid

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
            f"{a['ticker']} {METRICS[a['metric']]}{a['op']}{a['value']:g}（現在 {a['now']:.0f}）" for a in fired))
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

    Sends only on a plan with a hard monthly limit (this alone does not prove the account is free), never on an unlimited plan,
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


def line_messages(text: str) -> list[dict]:
    """One request, up to five chunks. Count UTF-16 units as required by LINE."""
    chunks, current, units = [], [], 0
    for c in text:
        size = 2 if ord(c) > 0xFFFF else 1
        if units + size > 4900:
            chunks.append({"type": "text", "text": "".join(current)})
            current, units = [], 0
        current.append(c)
        units += size
    if current:
        chunks.append({"type": "text", "text": "".join(current)})
    if not chunks or len(chunks) > 5:
        raise ValueError("Digest exceeds one LINE request; no alerts were acknowledged")
    return chunks


def send_line(text: str, token: str, user_id: str, retry_key: str | None = None) -> None:
    headers = {"Authorization": f"Bearer {token}", "X-Line-Retry-Key": retry_key or str(uuid.uuid4())}
    r = requests.post("https://api.line.me/v2/bot/message/push", headers=headers,
                      json={"to": user_id, "messages": line_messages(text)}, timeout=30)
    if r.status_code == 409 and r.headers.get("x-line-accepted-request-id"):
        return  # The exact same request was already accepted by LINE.
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


def run_digest(store, today: dt.date | None = None, market: str | None = None) -> dict:
    """Split-market delivery in production; 'both' remains available for manual runs."""
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    line_token, line_user = os.getenv("LINE_CHANNEL_TOKEN"), os.getenv("LINE_USER_ID")
    use_tg, use_line = bool(token and chat), bool(line_token and line_user)
    if not use_tg and not use_line:
        return {"sent": False, "reason": "not configured"}
    market = market or os.getenv("DIGEST_MARKET", "both")
    if market not in ("us", "tw", "both"):
        raise ValueError("DIGEST_MARKET must be us, tw or both")
    today = today or dt.datetime.now(dt.timezone.utc).date()
    owner = store.owner_id() if hasattr(store, "owner_id") else os.getenv("OWNER_UID")
    scope = {"user_id": f"eq.{owner}"} if owner else {}
    watch = sorted({r["ticker"] for r in store.select("user_watch", {"select": "ticker", **scope})})
    alerts = store.select("user_alerts", {"select": "id,ticker,metric,op,value,fired_at", "fired_at": "is.null", **scope})
    alerts = [a for a in alerts if not a.get("fired_at")]
    cur, prev, smart, raises, wt, wp, fired = [], [], {}, [], {}, {}, []
    dates = []
    if market != "tw":
        dates = sorted({r["as_of"] for r in store.select("scores", {"select": "as_of", "as_of": f"gte.{(today - dt.timedelta(days=14)).isoformat()}", "rank": "eq.1", "board": "eq.main"})}, reverse=True)
        if not dates or (today - dt.date.fromisoformat(str(dates[0])[:10])).days > 1:
            return {"sent": False, "reason": "no fresh US scores"}
        cols = "ticker,as_of,board,rank,score"
        cur = store.select("scores", {"select": cols, "as_of": f"eq.{dates[0]}", "board": "eq.main"})
        prev = store.select("scores", {"select": cols, "as_of": f"eq.{dates[1]}", "board": "eq.main"}) if len(dates) > 1 else []
        smart = {r["ticker"]: r for r in store.select("smart_money", {"select": "ticker,score,tags"})}
        raises = store.select("fundraises", {"select": "issuer,filed_at,form_type", "filed_at": f"gte.{(today - dt.timedelta(days=1)).isoformat()}", "form_type": "eq.C"})
        names = sorted({t for t in watch if not is_tw(t)} | {a["ticker"] for a in alerts if not is_tw(a["ticker"])})
        if names:
            filters = {"select": cols, "ticker": "in.(" + ",".join(names) + ")"}
            wt = {r["ticker"]: r for r in store.select("scores", {**filters, "as_of": f"eq.{dates[0]}"})}
            wp = {r["ticker"]: r for r in store.select("scores", {**filters, "as_of": f"eq.{dates[1]}"})} if len(dates) > 1 else {}
        fired = check_alerts([a for a in alerts if not is_tw(a["ticker"])], wt)
    tw = None
    if market != "us":
        tw, tw_fired = taiwan_section(store, today, [t for t in watch if is_tw(t)], [a for a in alerts if is_tw(a["ticker"])])
        fired += tw_fired
        if market == "tw":
            # Get the snapshot date even when only an alert, rather than a board change, fired.
            dates = sorted({r["as_of"] for r in store.select("tw_scores", {"select": "as_of", "rank": "eq.1", "board": "eq.tw_main", "as_of": f"gte.{(today - dt.timedelta(days=1)).isoformat()}"})}, reverse=True)
            if not dates:
                return {"sent": False, "reason": "no fresh Taiwan scores"}
    as_of = str(dates[0])[:10]
    text = compose(cur, prev, smart, raises, as_of, watch_lines([t for t in watch if not is_tw(t)], wt, wp, smart), fired, tw)
    if not text:
        return {"sent": False, "reason": "nothing new"}
    sent = []
    # LINE is authoritative for alert delivery when it is configured. A Telegram
    # success alone must never silently consume an alert that LINE failed to send.
    for name, enabled, recipient in (("line", use_line, line_user), ("telegram", use_tg, chat)):
        if not enabled:
            continue
        try:
            key = f"{name}:{recipient}:{market}:{as_of}"
            record = store.prepare_delivery(key, recipient, text, [a["id"] for a in fired]) if hasattr(store, "prepare_delivery") else None
            body = record["body"] if record else text
            ids = record["alert_ids"] if record else [a["id"] for a in fired]
            if record and record.get("sent_at"):
                # Recover the case where delivery succeeded but acknowledgement failed.
                if name == "line" or not use_line:
                    for alert_id in ids:
                        store.update("user_alerts", {"id": alert_id}, {"fired_at": record["sent_at"]})
                continue
            if record and dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(record["created_at"].replace("Z", "+00:00")) >= dt.timedelta(hours=23):
                print(f"  digest: {name} pending delivery expired; manual review required")
                continue  # Never reuse a retry key after LINE's 24-hour guarantee.
            if name == "line":
                line_messages(body)  # Validate completeness before sending anything.
                ok, why = line_budget_ok(line_token)
                if not ok:
                    print(f"  digest: {why}")
                    continue
                if record:
                    send_line(body, line_token, recipient, record["retry_key"])
                else:
                    send_line(body, line_token, recipient)
            else:
                send_telegram(body, token, recipient)
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            if record:
                store.update("line_deliveries", {"delivery_key": key}, {"sent_at": now})
            if name == "line" or not use_line:
                for alert_id in ids:
                    store.update("user_alerts", {"id": alert_id}, {"fired_at": now})
            sent.append(name)
        except Exception as e:
            print(f"  digest: {name} failed: {type(e).__name__}: {str(e)[:100]}")
    return {"sent": bool(sent), "channels": sent}


if __name__ == "__main__":
    from .store import Supabase
    print(run_digest(Supabase()))
