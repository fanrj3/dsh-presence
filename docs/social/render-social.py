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


TOOLS = [
    ("presence_hosts", "列出远程机器"), ("presence_connect", "建立 / 复用连接"),
    ("presence_exec", "执行命令"), ("presence_read", "读取文件"),
    ("presence_write", "写入文件"), ("presence_edit", "精确编辑"),
    ("presence_search", "内容搜索"), ("presence_glob", "文件查找"),
    ("presence_import", "上传文件"), ("presence_export", "下载文件"),
    ("presence_jobs", "后台任务"), ("presence_forward", "端口转发"),
    ("presence_terminal", "持久终端"), ("presence_trash", "回收站"),
]


def build_tools() -> Image.Image:
    c = dark_canvas()
    d = ImageDraw.Draw(c)
    brand(c, True)
    y = headline(d, [("全部工具", False), ("和本地一样顺手", True)], True, 230)
    sub_line(d, y + 2, "14 个工具 · 一条常驻连接 · 远端零安装", True)

    col_x = [96, 558]
    row_h, gap_y = 66, 12
    top = 648
    name_f, desc_f = font(FONT_MONO, 21), font(FONT_CN, 17)
    for index, (name, desc) in enumerate(TOOLS):
        col = index % 2
        row = index // 2
        x = col_x[col]
        cy = top + row * (row_h + gap_y)
        card = glass_card(c, (x, cy), (426, row_h), radius=18, dark=True, alpha=225)
        c.alpha_composite(card, (x, cy))
        d = ImageDraw.Draw(c)
        d.text((x + 18, cy + 9), name, font=name_f, fill=(226, 232, 240))
        d.text((x + 18, cy + 36), desc, font=desc_f, fill=SLATE)
    # footer line
    d = ImageDraw.Draw(c)
    d.line([(96, 1310), (W - 96, 1310)], fill=(255, 255, 255, 26), width=1)
    d.text((96, 1326), "同一进程内复用连接：1 次握手，之后每次调用都是往返毫秒级",
           font=font(FONT_CN, 20), fill=SLATE)
    c.alpha_composite(grain(6))
    return c.convert("RGB")


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
    y = headline(d, [("它真的", False), ("在那台机器上干活", True)], True, 210)
    sub_line(d, y + 2, "从一句话到远端结果，中间只有一条常驻连接", True)

    x_card, w_card = 214, 770
    top, h_card, gap = 548, 138, 44
    # connecting glow line
    line = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    x_line = x_card - 44
    ld.line([(x_line, top + 40), (x_line, top + 3 * (h_card + gap) + h_card - 40)],
            fill=(47, 107, 255, 190), width=3)
    c.alpha_composite(line.filter(ImageFilter.GaussianBlur(6)))
    c.alpha_composite(line.filter(ImageFilter.GaussianBlur(1.2)))

    for index, (num, title, desc, kind) in enumerate(NODES):
        cy = top + index * (h_card + gap)
        card = glass_card(c, (x_card, cy), (w_card, h_card), radius=26, dark=True)
        c.alpha_composite(card, (x_card, cy))
        d = ImageDraw.Draw(c)
        # node dot on the rail
        d.ellipse([x_line - 11, cy + 56, x_line + 11, cy + 78], fill=BLUE_LIGHT,
                  outline=(255, 255, 255, 120), width=2)
        d.text((x_card + 28, cy + 26), num, font=font(FONT_MONO, 18), fill=BLUE_LIGHT)
        d.text((x_card + 78, cy + 20), title, font=font(FONT_CN_BOLD, 34), fill=WHITE)
        d.text((x_card + 78, cy + 76), desc, font=font(FONT_CN, 22), fill=SLATE)
        if kind == "remote":
            # little green live dot
            d.ellipse([x_card + w_card - 46, cy + 30, x_card + w_card - 32, cy + 44], fill=GREEN)

    # result arrow back
    d = ImageDraw.Draw(c)
    d.text((96, 1268), "结果直接回到对话，不需要你再手动 ssh", font=font(FONT_CN, 21), fill=SLATE)
    cx = 96
    for label in ["零安装", "断线重连", "端口转发"]:
        cx += chip(d, cx, 1300, label, dark=True) + 12
    c.alpha_composite(grain(6))
    return c.convert("RGB")


def build_shot_frame() -> Image.Image:
    c = dark_canvas()
    d = ImageDraw.Draw(c)
    brand(c, True)
    y = headline(d, [("真实界面", False), ("截图放这里", True)], True, 220)
    sub_line(d, y + 2, "把你的 DSH 截图贴进发光框，再加 2–3 个标注", True)

    # ambient rings behind the frame (Figma "layer blur" look)
    rings = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    cx, cy = W // 2, 940
    for radius, alpha in [(360, 60), (270, 70), (190, 80)]:
        rd.ellipse([cx - radius, cy - radius * 0.62, cx + radius, cy + radius * 0.62],
                   outline=(47, 107, 255, alpha), width=26)
    c.alpha_composite(rings.filter(ImageFilter.GaussianBlur(34)))

    frame = Image.new("RGBA", (880, 520), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle([0, 0, 879, 519], radius=26, fill=(13, 20, 39, 200),
                         outline=(255, 255, 255, 34), width=2)
    # dashed placeholder
    for x in range(40, 840, 26):
        fd.line([(x, 200), (min(x + 13, 840), 200)], fill=(91, 155, 255, 200), width=2)
    for x in range(40, 840, 26):
        fd.line([(x, 330), (min(x + 13, 840), 330)], fill=(91, 155, 255, 200), width=2)
    fd.text((250, 232), "替换成你的 DSH 截图", font=font(FONT_CN, 40), fill=WHITE)
    fd.text((214, 292), "建议 1600×1000 以上，圆角 24，深色主题", font=font(FONT_CN, 21), fill=SLATE)
    fd.text((60, 40), "presence", font=font(FONT_MONO, 22), fill=(148, 163, 184))
    c.alpha_composite(frame, (100, 690))

    # callout dots suggestion
    d = ImageDraw.Draw(c)
    for label, xy in [("①", (150, 720)), ("②", (874, 820)), ("③", (150, 1120))]:
        d.ellipse([xy[0] - 20, xy[1] - 20, xy[0] + 20, xy[1] + 20], fill=(47, 107, 255, 235))
        d.text((xy[0] - 10, xy[1] - 17), label, font=font(FONT_CN, 24), fill=WHITE)

    d.text((96, 1256), "光晕配方（Figma）：发光圆环 → Layer blur 60；", font=font(FONT_CN, 20), fill=SLATE)
    d.text((96, 1290), "底盘径向渐变 → 混合模式 Screen；再叠 3% 噪点纹理。", font=font(FONT_CN, 20), fill=SLATE)
    c.alpha_composite(grain(6))
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
