"""Daily digest: what changed on the boards since the previous run, sent to Telegram.

Runs after the other stages. Does nothing (and never fails the run) unless TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID are set. The message is plain text and short on purpose.
"""
from __future__ import annotations

import datetime as dt
import os

import requests

TOP_N = 20
JUMP = 8.0           # score points that count as a "big move"
DASHBOARD = os.getenv("DASHBOARD_URL", "")


def compose(today_rows: list[dict], prev_rows: list[dict], smart: dict, raises: list[dict], as_of: str) -> str | None:
    """Pure function → message text, or None when there is nothing worth sending."""
    cur = {r["ticker"]: r for r in today_rows if r.get("board") == "main"}
    prev = {r["ticker"]: r for r in prev_rows if r.get("board") == "main"}
    top = [r for r in cur.values() if (r.get("rank") or 999) <= TOP_N]
    prev_top = {t for t, r in prev.items() if (r.get("rank") or 999) <= TOP_N}
    entered = sorted((r for r in top if r["ticker"] not in prev_top), key=lambda r: r["rank"]) if prev else []
    jumps = sorted((r for r in cur.values() if r["ticker"] in prev and r.get("score") is not None and prev[r["ticker"]].get("score") is not None
                    and r["score"] - prev[r["ticker"]]["score"] >= JUMP), key=lambda r: -(r["score"] - prev[r["ticker"]]["score"]))[:5]
    big = sorted((r for r in top if (smart.get(r["ticker"]) or {}).get("score", 0) > 0), key=lambda r: r["rank"])
    lines = []
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
    if not lines:
        return None
    head = f"趨勢爬蟲 {as_of}"
    tail = f"\n{DASHBOARD}" if DASHBOARD else ""
    return head + "\n" + "\n".join(lines) + tail


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
    text = compose(cur, prev, smart, raises, str(dates[0])[:10])
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
    print(f"  digest: sent via {sent or 'nobody'}")
    return {"sent": bool(sent), "channels": sent}
