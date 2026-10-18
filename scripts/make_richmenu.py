"""Draw the LINE rich menu image (2500x843, 3x2 cells) -> docs/richmenu.png.

python scripts/make_richmenu.py [out.png]
Needs Pillow and a Traditional Chinese font. Set RICHMENU_FONT_BOLD / RICHMENU_FONT_MEDIUM to a .ttc/.otf path
(and RICHMENU_FONT_INDEX if the .ttc holds several faces); the defaults are Noto Sans CJK TC on Linux.
Cell order and texts must match MENU in supabase/functions/line-webhook/index.ts.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
BG, CARD, EDGE = (16, 21, 34), (27, 34, 54), (42, 49, 66)
TITLE, SUB = (238, 241, 248), (138, 147, 166)
CELLS = [  # (title, subtitle, accent)
    ("今日", "比前一個交易日", (47, 191, 143)),
    ("榜單", "主榜前 10 名", (79, 108, 240)),
    ("自選", "我的自選股", (242, 180, 74)),
    ("週報", "7 日分數漲跌", (238, 106, 123)),
    ("大戶", "內部人與大股東", (167, 125, 240)),
    ("更多", "募資・成績單・提醒", (138, 147, 166)),
]


def font(env, default, size):
    return ImageFont.truetype(os.getenv(env, default), size, index=int(os.getenv("RICHMENU_FONT_INDEX", "3")))


def draw(out):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    big = font("RICHMENU_FONT_BOLD", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 150)
    small = font("RICHMENU_FONT_MEDIUM", "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc", 58)
    m, gap = 18, 35
    cw, ch = (W - 2 * m - 2 * gap) // 3, (H - 2 * m - gap) // 2
    for i, (title, sub, acc) in enumerate(CELLS):
        x0, y0 = m + (i % 3) * (cw + gap), m + (i // 3) * (ch + gap)
        x1, y1 = x0 + cw, y0 + ch
        d.rounded_rectangle((x0, y0, x1, y1), radius=40, fill=CARD, outline=EDGE, width=3)
        d.rounded_rectangle((x0, y0, x0 + 17, y1), radius=9, fill=acc)
        cx = (x0 + x1) // 2 + 8
        d.text((cx, y0 + ch * 0.42), title, font=big, fill=TITLE, anchor="mm")
        d.text((cx, y0 + ch * 0.77), sub, font=small, fill=SUB, anchor="mm")
    im.save(out, optimize=True)
    return out


if __name__ == "__main__":
    print(draw(sys.argv[1] if len(sys.argv) > 1 else "docs/richmenu.png"))
