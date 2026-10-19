"""Render LINE menu images from the same manifest used by the bot and deployment.

python scripts/make_richmenu.py [out_dir]
Needs Pillow and a Traditional Chinese font (RICHMENU_FONT_BOLD/MEDIUM/INDEX).
"""
import json
import math
import os
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'supabase/functions/line-webhook/menu.json').read_text())
W, H, TAB_H = CONFIG['width'], CONFIG['height'], CONFIG['tabHeight']
INK, MUTED, TEAL = '#172C35', '#607570', '#087F70'


def font(env, linux, size):
    fallback = '/System/Library/Fonts/STHeiti Medium.ttc'
    path = os.getenv(env) or (fallback if Path(fallback).exists() else linux)
    index = int(os.getenv('RICHMENU_FONT_INDEX', '0' if path == fallback else '3'))
    return ImageFont.truetype(path, size, index=index)


def icon(d, name, x, y, color):
    w = 7
    if name == 'pulse':
        d.line([(x-37,y+8),(x-18,y+8),(x-7,y-24),(x+9,y+27),(x+22,y-7),(x+37,y-7)], fill=color,width=w,joint='curve')
    elif name == 'chart':
        for dx, height in [(-30,28),(-5,47),(20,68)]:
            d.rounded_rectangle((x+dx,y+32-height,x+dx+14,y+32),radius=5,fill=color)
    elif name in ('star', 'spark'):
        n = 5 if name == 'star' else 4
        points=[]
        for i in range(2*n):
            a=-math.pi/2+i*math.pi/n
            r=36 if i%2==0 else (17 if n==5 else 12)
            points.append((x+math.cos(a)*r,y+math.sin(a)*r))
        d.line(points+[points[0]],fill=color,width=w,joint='curve')
    elif name == 'note':
        d.rounded_rectangle((x-27,y-33,x+27,y+33),radius=8,outline=color,width=w)
        for yy in [-13,3,19]: d.line((x-13,y+yy,x+13,y+yy),fill=color,width=5)
    else:
        for dx in [-29,7]:
            for dy in [-29,7]: d.rounded_rectangle((x+dx,y+dy,x+dx+23,y+dy+23),radius=5,outline=color,width=5)


def draw(active, out):
    im = Image.new('RGB',(W,H),'#EFF4F1')
    d = ImageDraw.Draw(im)
    big=font('RICHMENU_FONT_BOLD','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',120)
    small=font('RICHMENU_FONT_MEDIUM','/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc',70)
    tabf=font('RICHMENU_FONT_BOLD','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',112)
    # The visible rectangles and LINE tap targets use these exact bounds.
    # There are no decorative card gutters that imply a smaller clickable area.
    for (key,market),area in zip(CONFIG['markets'].items(),CONFIG['tabAreas'],strict=True):
        x0,y0=area['x'],area['y']
        x1,y1=x0+area['width'],y0+area['height']
        on=key==active
        d.rectangle((x0,y0,x1-1,y1-1),fill='#D6F4E7' if on else INK)
        if on: d.rectangle((x0,y1-14,x1-1,y1-1),fill=TEAL)
        d.text(((x0+x1)//2,(y0+y1)//2-8),market['label']+'研究',font=tabf,fill=INK if on else '#D6E5DF',anchor='mm')
    for cell,area in zip(CONFIG['markets'][active]['cells'],CONFIG['cellAreas'],strict=True):
        x0,y0=area['x'],area['y']
        x1,y1=x0+area['width'],y0+area['height']
        cx=(x0+x1)//2
        d.rectangle((x0,y0,x1-1,y1-1),fill='#FFFFFF')
        # Draw dividers inside the same rectangle used by the action bounds.
        if x0: d.rectangle((x0,y0,x0+3,y1-1),fill='#CBDED4')
        if y0>TAB_H: d.rectangle((x0,y0,x1-1,y0+3),fill='#CBDED4')
        cy=y0+170
        d.ellipse((cx-112,cy-112,cx+112,cy+112),fill='#E3F3EC')
        glyph=Image.new('RGBA',(100,100))
        icon(ImageDraw.Draw(glyph),cell['icon'],50,50,TEAL)
        glyph=glyph.resize((180,180),Image.Resampling.LANCZOS)
        im.paste(glyph,(cx-90,cy-90),glyph)
        d.text((cx,y0+385),cell['title'],font=big,fill=INK,anchor='mm')
        d.text((cx,y0+530),cell['subtitle'],font=small,fill=MUTED,anchor='mm')
    im.save(out,optimize=True)
    return out


if __name__ == '__main__':
    out_dir=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'docs'
    out_dir.mkdir(parents=True,exist_ok=True)
    for key,market in CONFIG['markets'].items(): print(draw(key,out_dir/market['image']))
