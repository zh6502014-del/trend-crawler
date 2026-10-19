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
    big=font('RICHMENU_FONT_BOLD','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',105)
    small=font('RICHMENU_FONT_MEDIUM','/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc',47)
    tabf=font('RICHMENU_FONT_BOLD','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',72)
    d.rectangle((0,0,W,TAB_H),fill=INK)
    for i,(key,market) in enumerate(CONFIG['markets'].items()):
        x0,x1=i*W//2+22,(i+1)*W//2-22
        on=key==active
        if on: d.rounded_rectangle((x0,20,x1,TAB_H-18),radius=32,fill='#D6F4E7')
        d.text(((x0+x1)//2,TAB_H//2),market['label']+'研究',font=tabf,fill=INK if on else '#A8BFB8',anchor='mm')
    cw,ch=W//3,(H-TAB_H)//2
    for i,cell in enumerate(CONFIG['markets'][active]['cells']):
        x0=(i%3)*cw+18; y0=TAB_H+(i//3)*ch+16
        x1=(i%3+1)*cw-18; y1=TAB_H+(i//3+1)*ch-16
        fill='#FFFFFF' if i<3 else '#E3F3EC'
        d.rounded_rectangle((x0,y0,x1,y1),radius=28,fill=fill,outline='#CBDED4',width=2)
        icon(d,cell['icon'],x0+85,y0+91,TEAL)
        d.text((x0+153,y0+91),cell['title'],font=big,fill=INK,anchor='lm')
        d.text((x0+54,y0+224),cell['subtitle'],font=small,fill=MUTED,anchor='lm')
        d.line((x0+54,y0+165,x1-54,y0+165),fill='#C5DBD0',width=2)
    im.save(out,optimize=True)
    return out


if __name__ == '__main__':
    out_dir=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'docs'
    out_dir.mkdir(parents=True,exist_ok=True)
    for key,market in CONFIG['markets'].items(): print(draw(key,out_dir/market['image']))
