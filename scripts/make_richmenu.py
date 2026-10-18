"""Draw the two LINE rich menu images (2500x843): docs/richmenu.png (美股) and docs/richmenu_tw.png (台股).

python scripts/make_richmenu.py [out_dir]
Each image has a tab bar (美股 | 台股) on top and 3x2 cells below. The geometry (MENU_W/H, MENU_TAB_H) and the
cell order must match menuAreas / MENU / MENU_TW in supabase/functions/line-webhook/index.ts.
Needs Pillow and a Traditional Chinese font: set RICHMENU_FONT_BOLD / RICHMENU_FONT_MEDIUM (and
RICHMENU_FONT_INDEX for a .ttc); defaults are Noto Sans CJK TC on Linux.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H, TAB_H = 2500, 843, 170
BG, CARD, EDGE = (16, 21, 34), (27, 34, 54), (42, 49, 66)
TITLE, SUB, DIM = (238, 241, 248), (138, 147, 166), (96, 104, 124)
GREEN, BLUE, AMBER, CORAL, PURPLE, GRAY, TEAL = (47, 191, 143), (79, 108, 240), (242, 180, 74), (238, 106, 123), (167, 125, 240), (138, 147, 166), (64, 196, 214)
MENUS = {
    "us": ("richmenu.png", [
        ("今日", "比前一個交易日", GREEN), ("榜單", "主榜前 10 名", BLUE), ("自選", "美股＋台股", AMBER),
        ("週報", "7 日分數漲跌", CORAL), ("大戶", "內部人與大股東", PURPLE), ("更多", "募資・成績單・提醒", GRAY)]),
    "tw": ("richmenu_tw.png", [
        ("今日", "比前一個交易日", GREEN), ("榜單", "台股主榜前 10 名", BLUE), ("自選", "美股＋台股", AMBER),
        ("週報", "7 日分數漲跌", CORAL), ("成績單", "對大盤表現", TEAL), ("更多", "儀表板・產業・說明", GRAY)]),
}


def font(env, default, size):
    return ImageFont.truetype(os.getenv(env, default), size, index=int(os.getenv("RICHMENU_FONT_INDEX", "3")))


def draw(active, cells, out):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    big = font("RICHMENU_FONT_BOLD", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 124)
    small = font("RICHMENU_FONT_MEDIUM", "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc", 50)
    tabf = font("RICHMENU_FONT_BOLD", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 70)
    m, gap = 18, 30
    # tab bar: two halves, the active one filled with an underline
    for i, (key, label) in enumerate((("us", "美股"), ("tw", "台股"))):
        x0, x1 = m + i * (W // 2), (i + 1) * (W // 2) - m
        on = key == active
        d.rounded_rectangle((x0, m, x1, TAB_H - 12), radius=34, fill=CARD if on else BG, outline=EDGE if on else None, width=3)
        if on:
            d.rounded_rectangle(((x0 + x1) // 2 - 90, TAB_H - 34, (x0 + x1) // 2 + 90, TAB_H - 22), radius=6, fill=BLUE)
        d.text(((x0 + x1) // 2, (m + TAB_H - 12) // 2 - 4), label, font=tabf, fill=TITLE if on else DIM, anchor="mm")
    top = TAB_H + 4
    cw, ch = (W - 2 * m - 2 * gap) // 3, (H - top - m - gap) // 2
    for i, (title, sub, acc) in enumerate(cells):
        x0, y0 = m + (i % 3) * (cw + gap), top + (i // 3) * (ch + gap)
        x1, y1 = x0 + cw, y0 + ch
        d.rounded_rectangle((x0, y0, x1, y1), radius=36, fill=CARD, outline=EDGE, width=3)
        d.rounded_rectangle((x0, y0, x0 + 16, y1), radius=8, fill=acc)
        cx = (x0 + x1) // 2 + 8
        d.text((cx, y0 + ch * 0.42), title, font=big, fill=TITLE, anchor="mm")
        d.text((cx, y0 + ch * 0.79), sub, font=small, fill=SUB, anchor="mm")
    im.save(out, optimize=True)
    return out


if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "docs"
    for key, (name, cells) in MENUS.items():
        print(draw(key, cells, os.path.join(out_dir, name)))
