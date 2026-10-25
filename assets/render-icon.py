"""Render assets/icon-180.png: storefront tile for the awesome list / market."""
from pathlib import Path

from PIL import Image, ImageDraw

S = 180
FONT = Path("C:/Windows/Fonts/CascadiaMono.ttf")
from PIL import ImageFont
mono = ImageFont.truetype(str(FONT), 44)

# rounded gradient tile via two vertical strips, then a rounded mask
top, bottom = (91, 155, 255), (47, 107, 255)
base = Image.new("RGB", (S, S))
draw = ImageDraw.Draw(base)
for y in range(S):
    t = y / (S - 1)
    draw.line([(0, y), (S, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=40, fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(base, (0, 0), mask)

d = ImageDraw.Draw(icon)
# terminal window
d.rounded_rectangle([38, 52, 142, 118], radius=16, outline=(255, 255, 255, 245), width=7)
# prompt >_ 
d.line([(56, 70), (70, 84), (56, 98)], fill=(255, 255, 255, 255), width=7, joint="curve")
d.line([(80, 98), (110, 98)], fill=(255, 255, 255, 255), width=7)
# live dot + pulse
d.ellipse([116, 112, 134, 130], fill=(61, 220, 132, 255))
d.arc([104, 100, 152, 148], start=200, end=340, fill=(61, 220, 132, 220), width=6)

icon.save("assets/icon-180.png")
print("wrote assets/icon-180.png", icon.size)
