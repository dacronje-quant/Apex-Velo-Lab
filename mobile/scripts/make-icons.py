"""Builds the Android launcher icons and splash screens from ../apex-velo-icon.png (run once after
changing the artwork: python3 scripts/make-icons.py). The artwork is transparent, so it is placed on
the app's background colour."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, '..', 'android', 'app', 'src', 'main', 'res')
BG = (6, 8, 18, 255)  # #060812, the app's --bg-1
art = Image.open(os.path.join(HERE, '..', '..', 'apex-velo-icon.png')).convert('RGBA')
art = art.crop(art.getbbox())

def place(size, scale, bg=None, mask=None):
    canvas = Image.new('RGBA', size, bg or (0, 0, 0, 0))
    side = int(min(size) * scale)
    a = art.copy(); a.thumbnail((side, side), Image.LANCZOS)
    canvas.alpha_composite(a, ((size[0] - a.width) // 2, (size[1] - a.height) // 2))
    if mask == 'circle':
        m = Image.new('L', size, 0); ImageDraw.Draw(m).ellipse((0, 0, size[0] - 1, size[1] - 1), fill=255)
        out = Image.new('RGBA', size, (0, 0, 0, 0)); out.paste(canvas, (0, 0), m); return out
    return canvas

for density, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    d = os.path.join(RES, f'mipmap-{density}')
    place((px, px), 0.84, BG).save(os.path.join(d, 'ic_launcher.png'))
    place((px, px), 0.78, BG, 'circle').save(os.path.join(d, 'ic_launcher_round.png'))
    fg = px * 108 // 48  # adaptive foreground is 108dp; keep the art inside the 66dp safe zone
    place((fg, fg), 0.6).save(os.path.join(d, 'ic_launcher_foreground.png'))

for folder in os.listdir(RES):
    path = os.path.join(RES, folder, 'splash.png')
    if folder.startswith('drawable') and os.path.exists(path):
        size = Image.open(path).size
        place(size, 0.42, BG).convert('RGB').save(path)

with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#060812</color>\n</resources>\n')
print('icons and splash screens written')
