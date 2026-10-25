#!/usr/bin/env python
"""Render the Xiaohongshu (1080x1440, 3:4) image set for Presence.

    python docs/social/render-social.py

Outputs into docs/social/:
  cover-light.png / cover-dark.png   封面（无真实主机名/域名）
  tools.png                          14 个工具
  workflow.png                       agent 远程工作流程
  shot-frame.png                     带光晕的截图模板（把 DSH 截图贴进去）

Design notes
- 3:4 1080x1440, sRGB, safe margins 96px, bottom 200px kept free.
- Glow = radial gradient on its own layer + blur + screen-like alpha; duplicated
  and blurred again for the layered light pool.
- 96px technical grid + light grain to keep the flat gradient from banding.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent
W, H = 1080, 1440
FONT_DIR = Path("C:/Windows/Fonts")
FONT_CN = FONT_DIR / "msyh.ttc"
FONT_CN_BOLD = FONT_DIR / "msyhbd.ttc"
FONT_MONO = FONT_DIR / "CascadiaMono.ttf" if (FONT_DIR / "CascadiaMono.ttf").exists() else FONT_DIR / "consola.ttf"

BLUE = (47, 107, 255)
BLUE_LIGHT = (91, 155, 255)
PURPLE = (124, 58, 237)
WHITE = (248, 250, 252)
INK = (15, 23, 42)
SLATE = (148, 163, 184)
GREEN = (61, 220, 132)


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.exists():
        return ImageFont.load_default()
    return ImageFont.truetype(str(path), size)


def has_cjk(text: str) -> bool:
    return any("\u3400" <= ch <= "\u9fff" for ch in text)


def vgradient(top, bottom) -> Image.Image:
    rows = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    t = np.array(top, dtype=np.float32)
    b = np.array(bottom, dtype=np.float32)
    arr = (t + (b - t) * rows)[:, None, :].repeat(W, axis=1)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")


def glow(cx, cy, radius, color, strength=1.0) -> Image.Image:
    y, x = np.ogrid[:H, :W]
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
    a = (np.clip(1 - d, 0, 1) ** 2 * strength * 255).astype(np.uint8)
    layer = np.zeros((H, W, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = color
    layer[..., 3] = a
    img = Image.fromarray(layer, "RGBA")
    return img.filter(ImageFilter.GaussianBlur(radius * 0.18))


def grid(alpha=10, step=96) -> Image.Image:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=(255, 255, 255, alpha), width=1)
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=(255, 255, 255, alpha), width=1)
    return layer


def grain(alpha=6) -> Image.Image:
    rng = np.random.default_rng(11)
    n = rng.integers(0, 255, (H, W), dtype=np.uint8)
    rgba = np.zeros((H, W, 4), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = (n > 205).astype(np.uint8) * alpha
    return Image.fromarray(rgba, "RGBA")


def dark_canvas() -> Image.Image:
    c = vgradient((9, 13, 28), (16, 26, 54)).convert("RGBA")
    c.alpha_composite(glow(880, 1180, 720, BLUE, 0.40))
    c.alpha_composite(glow(180, 180, 540, PURPLE, 0.26))
    c.alpha_composite(grid(9))
    return c


def light_canvas() -> Image.Image:
    c = vgradient((248, 250, 253), (232, 241, 255)).convert("RGBA")
    c.alpha_composite(glow(860, 220, 600, BLUE, 0.30))
    c.alpha_composite(glow(150, 1240, 520, PURPLE, 0.10))
    c.alpha_composite(grid(10))
    return c


def text_width(d: ImageDraw.ImageDraw, s: str, f) -> int:
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0]


def chip(d, x, y, label, dark=True, size=23) -> int:
    f = font(FONT_CN, size)
    tw = text_width(d, label, f)
    pad_x, h = 20, 42
    w = tw + pad_x * 2
    if dark:
        fill, outline, fg = (19, 28, 54, 235), (255, 255, 255, 30), (203, 213, 225)
    else:
        fill, outline, fg = (255, 255, 255, 235), (47, 107, 255, 40), (51, 65, 85)
    d.rounded_rectangle([x, y, x + w, y + h], radius=999, fill=fill, outline=outline, width=1)
    d.text((x + pad_x, y + 7), label, font=f, fill=fg)
    return w


def brand(canvas: Image.Image, dark: bool, badge="DSH 插件") -> None:
    d = ImageDraw.Draw(canvas)
    icon = Image.new("RGBA", (72, 72), (0, 0, 0, 0))
    id_ = ImageDraw.Draw(icon)
    id_.rounded_rectangle([0, 0, 71, 71], radius=18, fill=(BLUE[0], BLUE[1], BLUE[2], 255))
    id_.rounded_rectangle([13, 18, 59, 52], radius=8, outline=(255, 255, 255, 235), width=4)
    id_.line([(22, 28), (30, 35), (22, 42)], fill=(255, 255, 255), width=4, joint="curve")
    id_.line([(35, 44), (45, 44)], fill=(255, 255, 255), width=4)
    canvas.alpha_composite(icon, (96, 92))
    d.text((186, 104), "Presence", font=font(FONT_CN_BOLD, 34), fill=WHITE if dark else INK)
    # badge lives in the top-right corner, not under the wordmark
    bf = font(FONT_CN, 21)
    bw = text_width(d, badge, bf) + 40
    bx, by = W - 96 - bw, 96
    if dark:
        d.rounded_rectangle([bx, by, bx + bw, by + 42], radius=999, outline=(255, 255, 255, 34),
                            fill=(19, 28, 54, 200), width=1)
    else:
        d.rounded_rectangle([bx, by, bx + bw, by + 42], radius=999, outline=(47, 107, 255, 46),
                            fill=(255, 255, 255, 220), width=1)
    d.text((bx + 20, by + 8), badge, font=bf, fill=SLATE if dark else (71, 85, 105))


def headline(d, lines, dark, top):
    f = font(FONT_CN_BOLD, 100)
    y = top
    for text, accent in lines:
        color = BLUE_LIGHT if accent else (WHITE if dark else INK)
        d.text((96, y), text, font=f, fill=color)
        y += 122
    return y


def sub_line(d, y, text, dark, size=32, color=None):
    f = font(FONT_CN, size)
    d.text((96, y), text, font=f, fill=color or (SLATE if dark else (100, 116, 139)))


def terminal_card(canvas, xy, size, lines, dark=True):
    x, y = xy
    w, h = size
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([x + 4, y + 26, x + w + 4, y + h + 30], radius=30, fill=(2, 6, 23, 120))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=30, fill=(15, 23, 42, 252),
                         outline=(255, 255, 255, 24), width=2)
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 34 + i * 26
        cd.ellipse([cx - 7, 26, cx + 7, 40], fill=color)
    mono, small = font(FONT_MONO, 27), font(FONT_MONO, 23)
    mono_cn, small_cn = font(FONT_CN, 25), font(FONT_CN, 23)
    yy = 82
    for kind, content in lines:
        if kind == "prompt":
            cd.text((34, yy), "❯", font=mono, fill=GREEN)
            cd.text((64, yy), content, font=mono_cn if has_cjk(content) else mono, fill=(226, 232, 240))
        elif kind == "dim":
            cd.text((64, yy), content, font=small_cn if has_cjk(content) else small, fill=(148, 163, 184))
        elif kind == "ok":
            cd.text((34, yy), "✓", font=mono, fill=GREEN)
            cd.text((64, yy), content, font=small_cn if has_cjk(content) else small, fill=(134, 239, 172))
        yy += 46
    canvas.alpha_composite(card, (x, y))


def glass_card(canvas, xy, size, radius=24, dark=True, alpha=235):
    x, y = xy
    w, h = size
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    if dark:
        cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=(17, 24, 44, alpha),
                             outline=(255, 255, 255, 26), width=2)
    else:
        cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=(255, 255, 255, alpha),
                             outline=(47, 107, 255, 36), width=2)
    return card


# ------------------------------------------------------------------ images
def build_cover(dark: bool) -> Image.Image:
    c = dark_canvas() if dark else light_canvas()
    d = ImageDraw.Draw(c)
    brand(c, dark)
    if dark:
        y = headline(d, [("Agent 就住", False), ("在那台机器上", True)], dark, 250)
        sub_line(d, y + 6, "给你的 agent 一个真实的远程工作台", dark)
        sub_line(d, y + 56, "持久 SSH · 原生工具 · 多台机器随时切换", dark)
        terminal_card(c, (96, 792), (888, 300), [
            ("prompt", "presence exec 'nproc && uname -r'"),
            ("dim", "32"),
            ("dim", "5.15.0-generic"),
            ("ok", "12 个模型步骤，同一连接，0 次握手"),
        ], dark=True)
    else:
        y = headline(d, [("远程机器", False), ("像本地一样用", True)], dark, 250)
        sub_line(d, y + 6, "SSH 零安装 · 连接持久复用", dark)
        sub_line(d, y + 56, "终端 / 文件 / 端口转发，全部原生", dark)
        terminal_card(c, (96, 792), (888, 300), [
            ("prompt", "presence terminal server-a"),
            ("dim", "user@server-a:~/project$ python train.py"),
            ("dim", "[12:31:02] step 120/200  loss=0.043"),
            ("ok", "连接复用 13 ms · 断线自动重连"),
        ], dark=False)
    cx = 96
    for label in ["零安装", "断线重连", "端口转发"]:
        cx += chip(d, cx, 1166, label, dark=dark) + 14
    d.text((96, 1272), "Presence 0.17.2", font=font(FONT_MONO, 22), fill=SLATE if dark else (100, 116, 139))
    c.alpha_composite(grain(6 if dark else 4))
    return c.convert("RGB")


def tool_icon(d: ImageDraw.ImageDraw, x: int, y: int, size: int, name: str, color=(226, 232, 240)) -> None:
    """Simple 2px-ish stroke glyphs for the 14 tools (no font dependencies)."""
    s = size
    w = max(2, round(s / 16))
    if name == "presence_hosts":
        for i in range(2):
            top = y + 4 + i * (s // 2 - 2)
            d.rounded_rectangle([x + 2, top, x + s - 2, top + s // 2 - 5], radius=3, outline=color, width=w)
            d.ellipse([x + s - 9, top + 4, x + s - 5, top + 8], fill=color)
    elif name == "presence_connect":
        d.line([(x + 2, y + s // 2), (x + s - 2, y + s // 2)], fill=color, width=w)
        d.arc([x + s // 4, y + s // 4, x + s - 2, y + s - 2], start=270, end=90, fill=color, width=w)
        d.arc([x + 2, y + s // 4, x + s // 4 + s // 2, y + s - 2], start=90, end=270, fill=color, width=w)
    elif name == "presence_exec":
        d.rounded_rectangle([x + 2, y + 4, x + s - 2, y + s - 4], radius=3, outline=color, width=w)
        d.line([(x + 8, y + 11), (x + 14, y + 16), (x + 8, y + 21)], fill=color, width=w, joint="curve")
        d.line([(x + 18, y + 21), (x + 26, y + 21)], fill=color, width=w)
    elif name in ("presence_read", "presence_write", "presence_edit"):
        d.rounded_rectangle([x + 6, y + 3, x + s - 6, y + s - 3], radius=3, outline=color, width=w)
        if name == "presence_read":
            for i in range(3):
                d.line([(x + 10, y + 9 + i * 5), (x + s - 10, y + 9 + i * 5)], fill=color, width=w)
        elif name == "presence_write":
            d.line([(x + s // 2, y + 9), (x + s // 2, y + s - 9)], fill=color, width=w)
            d.line([(x + s // 2 - 5, y + s - 14), (x + s // 2, y + s - 9), (x + s // 2 + 5, y + s - 14)], fill=color, width=w)
        else:
            d.line([(x + 10, y + s - 12), (x + s - 10, y + 12)], fill=color, width=w)
            d.line([(x + 9, y + s - 6), (x + 16, y + s - 9)], fill=color, width=w)
    elif name == "presence_search":
        d.ellipse([x + 4, y + 4, x + s - 10, y + s - 10], outline=color, width=w)
        d.line([(x + s - 12, y + s - 12), (x + s - 3, y + s - 3)], fill=color, width=w + 1)
    elif name == "presence_glob":
        d.line([(x + 3, y + s - 8), (x + 3, y + 8)], fill=color, width=w)
        d.line([(x + 3, y + 8), (x + s - 12, y + 8), (x + s - 12, y + s - 8), (x + 3, y + s - 8)], fill=color, width=w, joint="curve")
        d.ellipse([x + s - 16, y + s - 16, x + s - 4, y + s - 4], outline=color, width=w)
        d.line([(x + s - 7, y + s - 7), (x + s - 2, y + s - 2)], fill=color, width=w)
    elif name == "presence_import":
        d.line([(x + s // 2, y + 3), (x + s // 2, y + s - 10)], fill=color, width=w)
        d.line([(x + s // 2 - 6, y + s - 16), (x + s // 2, y + s - 10), (x + s // 2 + 6, y + s - 16)], fill=color, width=w)
        d.line([(x + 5, y + s - 4), (x + s - 5, y + s - 4)], fill=color, width=w)
    elif name == "presence_export":
        d.line([(x + s // 2, y + s - 3), (x + s // 2, y + 10)], fill=color, width=w)
        d.line([(x + s // 2 - 6, y + 16), (x + s // 2, y + 10), (x + s // 2 + 6, y + 16)], fill=color, width=w)
        d.line([(x + 5, y + s - 4), (x + s - 5, y + s - 4)], fill=color, width=w)
    elif name == "presence_jobs":
        d.ellipse([x + 4, y + 4, x + s - 4, y + s - 4], outline=color, width=w)
        d.line([(x + s // 2, y + 10), (x + s // 2, y + s // 2), (x + s - 9, y + s // 2 + 4)], fill=color, width=w, joint="curve")
    elif name == "presence_forward":
        d.line([(x + 4, y + 12), (x + s - 5, y + 12)], fill=color, width=w)
        d.line([(x + s - 11, y + 7), (x + s - 5, y + 12), (x + s - 11, y + 17)], fill=color, width=w)
        d.line([(x + 5, y + s - 12), (x + s - 4, y + s - 12)], fill=color, width=w)
        d.line([(x + 11, y + s - 17), (x + 5, y + s - 12), (x + 11, y + s - 7)], fill=color, width=w)
    elif name == "presence_terminal":
        d.rounded_rectangle([x + 2, y + 5, x + s - 2, y + s - 5], radius=3, outline=color, width=w)
        d.line([(x + 7, y + 12), (x + 13, y + 17), (x + 7, y + 22)], fill=color, width=w, joint="curve")
        d.line([(x + 17, y + 22), (x + 24, y + 22)], fill=color, width=w)
    elif name == "presence_trash":
        d.line([(x + 5, y + 9), (x + s - 5, y + 9)], fill=color, width=w)
        d.rounded_rectangle([x + 8, y + 9, x + s - 8, y + s - 5], radius=3, outline=color, width=w)
        d.line([(x + s // 2 - 5, y + 4), (x + s // 2 + 5, y + 4)], fill=color, width=w)
        d.line([(x + s // 2 - 4, y + 13), (x + s // 2 - 4, y + s - 9)], fill=color, width=w)
        d.line([(x + s // 2 + 4, y + 13), (x + s // 2 + 4, y + s - 9)], fill=color, width=w)


def node_icon(d: ImageDraw.ImageDraw, cx: int, cy: int, kind: str, color=(255, 255, 255)) -> None:
    r = 18
    if kind == "chat":
        d.rounded_rectangle([cx - r, cy - r + 4, cx + r, cy + r - 4], radius=8, outline=color, width=3)
        d.line([(cx - 6, cy + r - 4), (cx - 2, cy + r + 4)], fill=color, width=3)
    elif kind == "agent":
        d.rounded_rectangle([cx - r + 2, cy - r + 6, cx + r - 2, cy + r], radius=8, outline=color, width=3)
        d.ellipse([cx - 8, cy - 8, cx - 2, cy - 2], fill=color)
        d.ellipse([cx + 2, cy - 8, cx + 8, cy - 2], fill=color)
        d.line([(cx, cy - r - 2), (cx, cy - r + 4)], fill=color, width=3)
        d.ellipse([cx - 3, cy - r - 5, cx + 3, cy - r + 1], fill=color)
    elif kind == "link":
        d.line([(cx - r, cy), (cx + r, cy)], fill=color, width=3)
        d.arc([cx - r - 4, cy - r, cx + r + 4, cy + r], start=200, end=340, fill=color, width=3)
    elif kind == "remote":
        d.rounded_rectangle([cx - r, cy - r + 2, cx + r, cy + r], radius=5, outline=color, width=3)
        d.line([(cx - 10, cy + 4), (cx - 4, cy + 10), (cx - 10, cy + 16)], fill=color, width=3, joint="curve")
        d.line([(cx - 2, cy + 16), (cx + 8, cy + 16)], fill=color, width=3)


def build_tools() -> Image.Image:
    c = dark_canvas()
    c.alpha_composite(glow(540, 1000, 560, BLUE, 0.22))
    d = ImageDraw.Draw(c)
    brand(c, True)
    y = headline(d, [("14 个工具", False), ("和本地一样顺手", True)], True, 220)
    sub_line(d, y + 2, "全部走同一条常驻连接 · 远端零安装", True)

    col_x = [96, 558]
    card_w, card_h = 426, 72
    gap_y = 10
    top = 632
    for index, (name, desc, icon) in enumerate(TOOLS):
        col = index % 2
        row = index // 2
        x = col_x[col]
        cy = top + row * (card_h + gap_y)
        card = glass_card(c, (x, cy), (card_w, card_h), radius=20, dark=True, alpha=232)
        c.alpha_composite(card, (x, cy))
        d = ImageDraw.Draw(c)
        # icon tile
        d.rounded_rectangle([x + 12, cy + 12, x + 60, cy + 60], radius=14,
                            fill=(30, 41, 74, 255), outline=(255, 255, 255, 22), width=1)
        tool_icon(d, x + 22, cy + 22, 28, name, color=(147, 197, 253))
        d.text((x + 74, cy + 13), name, font=font(FONT_MONO, 20), fill=(226, 232, 240))
        d.text((x + 74, cy + 40), desc, font=font(FONT_CN, 17), fill=SLATE)

    d.line([(96, 1316), (W - 96, 1316)], fill=(255, 255, 255, 24), width=1)
    d.text((96, 1330), "14 个工具 = 读 / 写 / 编辑 / 搜索 / 执行 / 传输 / 任务 / 转发 / 终端 / 回收站",
           font=font(FONT_CN, 19), fill=SLATE)
    c.alpha_composite(grain(6))
    return c.convert("RGB")


TOOLS = [
    ("presence_hosts", "列出远程机器", "hosts"), ("presence_connect", "建立 / 复用连接", "connect"),
    ("presence_exec", "执行命令", "exec"), ("presence_read", "读取文件", "read"),
    ("presence_write", "写入文件", "write"), ("presence_edit", "精确编辑", "edit"),
    ("presence_search", "内容搜索", "search"), ("presence_glob", "文件查找", "glob"),
    ("presence_import", "上传文件", "import"), ("presence_export", "下载文件", "export"),
    ("presence_jobs", "后台任务", "jobs"), ("presence_forward", "端口转发", "forward"),
    ("presence_terminal", "持久终端", "terminal"), ("presence_trash", "回收站", "trash"),
]

NODES = [
    ("01", "你说", "把训练跑起来，失败就修", "chat"),
    ("02", "Agent", "DSH 插件 / MCP 客户端", "agent"),
    ("03", "常驻 SSH", "一条连接，13 ms 往返，断线自动重连", "link"),
    ("04", "远程机器", "代码 · 环境 · GPU，全在那边", "remote"),
]


def build_workflow() -> Image.Image:
    c = dark_canvas()
    d = ImageDraw.Draw(c)
    brand(c, True)
    y = headline(d, [("它真的", False), ("在那台机器上干活", True)], True, 205)
    sub_line(d, y + 2, "从一句话到远端结果，中间只有一条常驻连接", True)

    x_card, w_card = 214, 770
    top, h_card, gap = 540, 148, 40
    line = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    x_line = x_card - 46
    ld.line([(x_line, top + 50), (x_line, top + 3 * (h_card + gap) + h_card - 50)],
            fill=(47, 107, 255, 200), width=3)
    c.alpha_composite(line.filter(ImageFilter.GaussianBlur(7)))
    c.alpha_composite(line.filter(ImageFilter.GaussianBlur(1.2)))

    for index, (num, title, desc, kind) in enumerate(NODES):
        cy = top + index * (h_card + gap)
        card = glass_card(c, (x_card, cy), (w_card, h_card), radius=26, dark=True)
        c.alpha_composite(card, (x_card, cy))
        d = ImageDraw.Draw(c)
        d.ellipse([x_line - 11, cy + 61, x_line + 11, cy + 83], fill=BLUE_LIGHT,
                  outline=(255, 255, 255, 120), width=2)
        # icon disc
        d.ellipse([x_card + 26, cy + 40, x_card + 94, cy + 108], fill=(30, 41, 74, 255),
                  outline=(255, 255, 255, 22), width=1)
        node_icon(d, x_card + 60, cy + 74, kind, color=(191, 219, 254))
        d.text((x_card + 116, cy + 26), num, font=font(FONT_MONO, 18), fill=BLUE_LIGHT)
        d.text((x_card + 160, cy + 20), title, font=font(FONT_CN_BOLD, 34), fill=WHITE)
        d.text((x_card + 116, cy + 84), desc, font=font(FONT_CN, 21), fill=SLATE)
        if kind == "remote":
            d.ellipse([x_card + w_card - 44, cy + 28, x_card + w_card - 30, cy + 42], fill=GREEN)

    d = ImageDraw.Draw(c)
    cx = 96
    for label in ["零安装", "断线重连", "端口转发"]:
        cx += chip(d, cx, 1300, label, dark=True) + 12
    c.alpha_composite(grain(6))
    return c.convert("RGB")


def wallpaper() -> Image.Image:
    c = vgradient((16, 32, 64), (44, 20, 52)).convert("RGBA")
    c.alpha_composite(glow(280, 420, 620, (34, 211, 238), 0.55))
    c.alpha_composite(glow(860, 760, 700, (47, 107, 255), 0.50))
    c.alpha_composite(glow(420, 1230, 560, (251, 146, 60), 0.34))
    c.alpha_composite(glow(950, 180, 420, (124, 58, 237), 0.30))
    # vignette
    y, x = np.ogrid[:H, :W]
    vig = np.clip(np.sqrt(((x - W / 2) / (W * 0.72)) ** 2 + ((y - H / 2) / (H * 0.72)) ** 2) - 0.35, 0, 1)
    dark = np.zeros((H, W, 4), dtype=np.uint8)
    dark[..., 3] = (vig * 150).astype(np.uint8)
    c.alpha_composite(Image.fromarray(dark, "RGBA"))
    return c


def ring(d: ImageDraw.ImageDraw, cx: int, cy: int, radius: int, pct: float, color, width=7) -> None:
    d.arc([cx - radius, cy - radius, cx + radius, cy + radius], start=-90, end=270,
          fill=(255, 255, 255, 40), width=width)
    d.arc([cx - radius, cy - radius, cx + radius, cy + radius], start=-90,
          end=-90 + int(360 * pct), fill=color, width=width)


def build_shot_frame() -> Image.Image:
    c = wallpaper()
    # big soft panel shadow
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([96, 620, 984, 1200], radius=44, fill=(0, 0, 0, 150))
    c.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(52)))

    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle([96, 600, 984, 1180], radius=44, fill=(10, 15, 30, 205),
                         outline=(255, 255, 255, 34), width=2)
    # inner top highlight
    pd.rounded_rectangle([100, 604, 980, 1176], radius=42, outline=(255, 255, 255, 18), width=1)
    c.alpha_composite(panel)
    d = ImageDraw.Draw(c)

    # headline above panel
    brand(c, True)
    y = headline(d, [("真实截图", False), ("放进玻璃卡片", True)], True, 176)
    sub_line(d, y + 2, "壁纸底 + 毛玻璃 + 柔投影 + 内高光", True)

    d.text((140, 646), "把 DSH 截图贴在虚框里", font=font(FONT_CN, 26), fill=(226, 232, 240))
    d.text((140, 688), "1600×1000 以上 · 深色主题 · 圆角 32", font=font(FONT_CN, 19), fill=SLATE)
    for y0 in (770, 1040):
        for x0 in range(140, 940, 26):
            d.line([(x0, y0), (min(x0 + 13, 940), y0)], fill=(91, 155, 255, 170), width=2)

    # floating glass widget (like a system widget)
    widget = Image.new("RGBA", (330, 176), (0, 0, 0, 0))
    wd = ImageDraw.Draw(widget)
    wd.rounded_rectangle([0, 0, 329, 175], radius=26, fill=(12, 18, 34, 220),
                         outline=(255, 255, 255, 40), width=2)
    wd.text((24, 20), "Presence · 会话", font=font(FONT_CN, 19), fill=(226, 232, 240))
    wd.text((24, 52), "连接复用", font=font(FONT_CN, 17), fill=SLATE)
    ring(wd, 92, 128, 34, 0.86, BLUE_LIGHT)
    wd.text((72, 118), "13", font=font(FONT_MONO, 20), fill=WHITE)
    wd.text((62, 142), "ms", font=font(FONT_MONO, 13), fill=SLATE)
    wd.text((168, 60), "工具调用", font=font(FONT_CN, 17), fill=SLATE)
    ring(wd, 204, 128, 34, 0.72, GREEN)
    wd.text((190, 118), "14", font=font(FONT_MONO, 20), fill=WHITE)
    wd.text((182, 142), "个", font=font(FONT_CN, 13), fill=SLATE)
    c.alpha_composite(widget, (690, 640))

    d.text((96, 1246), "叠层顺序：壁纸 → 柔投影 → 毛玻璃面板 → 截图 → 内高光 → 全局 3% 噪点",
           font=font(FONT_CN, 19), fill=(203, 213, 225))
    c.alpha_composite(grain(7))
    return c.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("cover-light.png", lambda: build_cover(False)),
        ("cover-dark.png", lambda: build_cover(True)),
        ("tools.png", build_tools),
        ("workflow.png", build_workflow),
        ("shot-frame.png", build_shot_frame),
    ]
    for name, builder in jobs:
        image = builder()
        path = OUT / name
        image.save(path, "PNG", optimize=True)
        print(f"wrote {path.name} ({path.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"render failed: {error}", file=sys.stderr)
        raise
