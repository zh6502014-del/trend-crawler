"""LINE digest as one Flex card: same text, buttons that are free replies, plain-text fallback."""
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from crawler import digest  # noqa: E402

TEXT = "\n".join([
    "趨勢爬蟲 2026-11-06",
    "你設的提醒：NRXS 分數>70（現在 72）",
    "自選異動：",
    "NRXS　分數 66→74",
    "ACOG　進入主榜",
    "新進前 20 名：AAA（第3名）、BBB（第9名）",
    "https://example.github.io/trend-crawler/",
])


def texts(card):
    return [c["text"] for c in card["contents"]["body"]["contents"] if c["type"] == "text"]


def test_card_keeps_every_line_and_drops_the_bare_url():
    card = digest.digest_flex(TEXT, "us")
    t = texts(card)
    assert t[0] == "趨勢爬蟲 每日摘要" and t[1] == "美股　2026-11-06"
    assert "你設的提醒" in t and "NRXS 分數>70（現在 72）" in t
    assert "・NRXS　分數 66→74" in t and "・ACOG　進入主榜" in t
    assert "AAA（第3名）　BBB（第9名）" in t
    assert not any("http" in x for x in t)
    assert card["altText"].startswith("趨勢爬蟲 2026-11-06") and len(card["altText"]) <= 400


def test_buttons_are_bot_commands_for_the_market():
    def cmds(m):
        return [b["action"]["text"] for b in digest.digest_flex(TEXT, m)["contents"]["footer"]["contents"]]
    assert cmds("us") == ["美股 今日", "自選", "儀表板"]
    assert cmds("tw") == ["台股今日", "自選", "儀表板"]
    assert cmds(None) == ["美股 今日", "台股今日", "自選", "儀表板"]
    for m in ("us", "tw", None):
        for b in digest.digest_flex(TEXT, m)["contents"]["footer"]["contents"]:
            assert b["action"]["type"] == "message" and len(b["action"]["label"]) <= 20


def test_both_markets_get_headings():
    text = "趨勢爬蟲 2026-11-06\n【美股】\n分數大幅上升：AAA +10\n【台股 2026-11-06】\n前 20 名法人買超：2330台積電"
    t = texts(digest.digest_flex(text))
    assert "美股" in t and "台股 2026-11-06" in t and "2330台積電" in t


def test_card_is_deterministic_for_retries():
    a = json.dumps(digest.digest_flex(TEXT, "tw"), ensure_ascii=False)
    b = json.dumps(digest.digest_flex(TEXT, "tw"), ensure_ascii=False)
    assert a == b


def test_too_large_falls_back_to_text_and_empty_gives_none():
    big = "趨勢爬蟲 2026-11-06\n" + "\n".join(f"T{i:04d}　分數 50→60" for i in range(1200))
    assert digest.digest_flex(big, "us") is None
    payload = digest.line_payload(big, "us")
    assert all(m["type"] == "text" for m in payload) and len(payload) <= 5
    assert digest.digest_flex("", "us") is None


def test_push_carries_one_flex_message(monkeypatch):
    calls = []

    def post(url, headers=None, json=None, timeout=None):
        calls.append(json)
        r = requests.Response()
        r.status_code = 200
        return r
    monkeypatch.setattr(digest.requests, "post", post)
    monkeypatch.setenv("DIGEST_MARKET", "tw")
    digest.send_line(TEXT, "fake", "recipient", "key")
    assert len(calls[0]["messages"]) == 1 and calls[0]["messages"][0]["type"] == "flex"
    footer = calls[0]["messages"][0]["contents"]["footer"]["contents"]
    assert footer[0]["action"]["text"] == "台股今日"
