#!/usr/bin/env python
"""Light-theme social image set for Presence (1080x1440, 3:4).

Uses the real screenshots in docs/image/ inside white glass cards, with the
sensitive text (hosts, IPs, usernames, paths) frosted out before scaling.

    python docs/social/render-light.py

Outputs docs/social/light/*.png
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "docs" / "image"
OUT = Path(__file__).resolve().parent / "light"
W, H = 1080, 1440
FONT_DIR = Path("C:/Windows/Fonts")
FONT_CN = FONT_DIR / "msyh.ttc"
FONT_CN_BOLD = FONT_DIR / "msyhbd.ttc"
FONT_MONO = FONT_DIR / "CascadiaMono.ttf" if (FONT_DIR / "CascadiaMono.ttf").exists() else FONT_DIR / "consola.ttf"

BLUE = (47, 107, 255)
BLUE_LIGHT = (91, 155, 255)
INK = (15, 23, 42)
SLATE = (100, 116, 139)
MUTED = (148, 163, 184)
LINE = (203, 213, 225)


def font(path, size):
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def has_cjk(text: str) -> bool:
    return any("\u3400" <= ch <= "\u9fff" for ch in text)


def vgrad(top, bottom) -> Image.Image:
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
    return Image.fromarray(layer, "RGBA").filter(ImageFilter.GaussianBlur(radius * 0.2))


def dotted_grid(alpha=26, step=72) -> Image.Image:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for y in range(24, H, step):
        for x in range(24, W, step):
            d.ellipse([x, y, x + 2, y + 2], fill=(15, 23, 42, alpha))
    return layer


def grain(alpha=3) -> Image.Image:
    rng = np.random.default_rng(5)
    n = rng.integers(0, 255, (H, W), dtype=np.uint8)
    rgba = np.zeros((H, W, 4), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = (n > 210).astype(np.uint8) * alpha
    return Image.fromarray(rgba, "RGBA")


def canvas_light() -> Image.Image:
    c = vgrad((250, 251, 254), (232, 240, 252)).convert("RGBA")
    c.alpha_composite(glow(880, 150, 560, (147, 197, 253), 0.55))
    c.alpha_composite(glow(120, 1180, 560, (253, 186, 116), 0.38))
    c.alpha_composite(glow(540, 760, 620, (255, 255, 255), 0.65))
    c.alpha_composite(dotted_grid())
    return c


def tw(d, s, f) -> int:
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0]


def brand(c: Image.Image, badge="DSH 插件") -> None:
    d = ImageDraw.Draw(c)
    icon = Image.new("RGBA", (72, 72), (0, 0, 0, 0))
    id_ = ImageDraw.Draw(icon)
    id_.rounded_rectangle([0, 0, 71, 71], radius=18, fill=(*BLUE, 255))
    id_.rounded_rectangle([13, 18, 59, 52], radius=8, outline=(255, 255, 255, 235), width=4)
    id_.line([(22, 28), (30, 35), (22, 42)], fill=(255, 255, 255), width=4, joint="curve")
    id_.line([(35, 44), (45, 44)], fill=(255, 255, 255), width=4)
    c.alpha_composite(icon, (96, 92))
    d.text((186, 104), "Presence", font=font(FONT_CN_BOLD, 34), fill=INK)
    bf = font(FONT_CN, 21)
    bw = tw(d, badge, bf) + 40
    bx, by = W - 96 - bw, 96
    d.rounded_rectangle([bx, by, bx + bw, by + 42], radius=999, fill=(255, 255, 255, 220),
                        outline=(47, 107, 255, 46), width=1)
    d.text((bx + 20, by + 8), badge, font=bf, fill=SLATE)


def headline(d, lines, top, size=86):
    f = font(FONT_CN_BOLD, size)
    y = top
    for text, accent in lines:
        d.text((96, y), text, font=f, fill=BLUE if accent else INK)
        y += int(size * 1.24)
    return y


def sub(d, y, text, size=28):
    d.text((96, y), text, font=font(FONT_CN, size), fill=SLATE)


def pill(d, x, y, label, color=(255, 255, 255), fg=SLATE, border=(47, 107, 255, 40), size=21):
    f = font(FONT_CN, size)
    w = tw(d, label, f) + 36
    d.rounded_rectangle([x, y, x + w, y + 40], radius=999, fill=(*color, 235) if len(color) == 3 else color,
                        outline=border, width=1)
    d.text((x + 18, y + 7), label, font=f, fill=fg)
    return w


def shot_card(c: Image.Image, box, image: Image.Image, radius=26) -> Image.Image:
    """White card with a screenshot inside; returns the scaled screenshot for callouts."""
    x, y, w, h = box
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([x + 2, y + 20, x + w + 2, y + h + 24], radius=radius + 2, fill=(15, 23, 42, 70))
    c.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(30)))
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=(255, 255, 255, 250),
                         outline=(203, 213, 225, 160), width=1)
    c.alpha_composite(card, (x, y))
    pad = 10
    inner_w, inner_h = w - pad * 2, h - pad * 2
    scaled = image.resize((inner_w, inner_h), Image.LANCZOS).filter(
        ImageFilter.UnsharpMask(radius=1.1, percent=115, threshold=2))
    mask = Image.new("L", (inner_w, inner_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner_w - 1, inner_h - 1], radius=radius - 10, fill=255)
    c.paste(scaled, (x + pad, y + pad), mask)
    return scaled


def redact(c: Image.Image, origin, rects, scale, blur=10) -> None:
    """Frost out sensitive regions of the placed screenshot (looks intentional)."""
    ox, oy = origin
    for (rx, ry, rw, rh) in rects:
        x0, y0 = ox + int(rx * scale), oy + int(ry * scale)
        x1, y1 = x0 + max(2, int(rw * scale)), y0 + max(2, int(rh * scale))
        region = c.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(blur))
        veil = Image.new("RGBA", region.size, (255, 255, 255, 150))
        region = Image.alpha_composite(region.convert("RGBA"), veil)
        c.paste(region, (x0, y0))
        d = ImageDraw.Draw(c)
        d.rounded_rectangle([x0, y0, x1, y1], radius=6, outline=(148, 163, 184, 90), width=1)


def callout(d, x, y, n, color=BLUE):
    d.ellipse([x - 15, y - 15, x + 15, y + 15], fill=(*color, 240), outline=(255, 255, 255, 235), width=2)
    f = font(FONT_CN_BOLD, 17)
    d.text((x - 6, y - 9), str(n), font=f, fill=(255, 255, 255))


def footer(d, page: str) -> None:
    d.line([(96, 1292), (W - 96, 1292)], fill=(15, 23, 42, 26), width=1)
    d.text((96, 1306), "Presence · DSH 插件", font=font(FONT_CN, 19), fill=MUTED)
    f = font(FONT_MONO, 18)
    d.text((W - 96 - tw(d, page, f), 1308), page, font=f, fill=MUTED)


# --------------------------------------------------------------- val page
PAGES = {
    "workspaces": {
        "file": "远程工作区.png",
        "title": [("机器和文件夹", False), ("就是本地标签页", True)],
        "sub": "一台机器一条常驻连接，下面是它的文件夹",
        "crop": (190, 52, 800, 700),
        "redact": [
            (200, 120, 600, 30), (200, 220, 600, 30),
            (230, 150, 240, 26), (230, 250, 260, 26), (230, 300, 160, 26), (230, 350, 160, 26),
            (220, 420, 580, 250),
        ],
        "marks": [(0.22, 0.10), (0.22, 0.27), (0.55, 0.80)],
        "page": "03 / 07",
    },
    "files": {
        "file": "远程文件.png",
        "title": [("文件树", False), ("直接就是远端", True)],
        "sub": "双击预览、拖拽上传下载，和本地一样",
        "crop": (0, 0, 452, 633),
        "redact": [(12, 36, 150, 28), (12, 76, 320, 24)],
        "marks": [(0.30, 0.09), (0.45, 0.18), (0.55, 0.93)],
        "page": "04 / 07",
    },
    "ports": {
        "file": "端口转发.png",
        "title": [("远程 8000", False), ("本地直接打开", True)],
        "sub": "本地端口默认同号，被占用自动换一个",
        "crop": (0, 0, 432, 467),
        "redact": [(10, 90, 240, 32), (8, 168, 414, 36), (4, 200, 120, 22), (4, 342, 120, 22)],
        "marks": [(0.32, 0.26), (0.88, 0.27), (0.94, 0.48)],
        "page": "05 / 07",
    },
    "terminal": {
        "file": "远程终端.png",
        "title": [("命令真的", False), ("跑在那台机器上", True)],
        "sub": "GPU、环境、进程，全是远端实况",
        "crop": (0, 0, 453, 521),
        "redact": [(4, 26, 440, 26), (56, 94, 70, 20), (396, 322, 60, 196)],
        "marks": [(0.32, 0.07), (0.55, 0.60), (0.20, 0.28)],
        "page": "06 / 07",
    },
}


def build_cover() -> Image.Image:
    c = canvas_light()
    d = ImageDraw.Draw(c)
    brand(c)
    y = headline(d, [("远程机器", False), ("像本地一样用", True)], 250, 96)
    sub(d, y + 4, "SSH 零安装 · 连接持久复用", 31)
    sub(d, y + 52, "终端 / 文件 / 端口转发，全部原生", 31)

    # terminal card stays dark for contrast on the light background
    card_w, card_h = 888, 300
    x, y0 = 96, 780
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x + 2, y0 + 18, x + card_w + 2, y0 + card_h + 22], radius=30, fill=(15, 23, 42, 80))
    c.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
    term = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    td = ImageDraw.Draw(term)
    td.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=30, fill=(15, 23, 42, 252), outline=(255, 255, 255, 24), width=2)
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 34 + i * 26
        td.ellipse([cx - 7, 26, cx + 7, 40], fill=col)
    mono, small = font(FONT_MONO, 27), font(FONT_MONO, 23)
    rows = [
        ("prompt", "presence terminal server-a"),
        ("dim", "user@server-a:~/project$ python train.py"),
        ("dim", "[12:31:02] step 120/200  loss=0.043"),
        ("ok", "连接复用 13 ms · 断线自动重连"),
    ]
    yy = 82
    for kind, text in rows:
        if kind == "prompt":
            td.text((34, yy), "❯", font=mono, fill=(61, 220, 132))
            td.text((64, yy), text, font=font(FONT_MONO, 25) if not has_cjk(text) else font(FONT_CN, 24), fill=(226, 232, 240))
        elif kind == "dim":
            td.text((64, yy), text, font=small if not has_cjk(text) else font(FONT_CN, 22), fill=(148, 163, 184))
        else:
            td.text((34, yy), "✓", font=mono, fill=(61, 220, 132))
            td.text((64, yy), text, font=font(FONT_CN, 22), fill=(134, 239, 172))
        yy += 46
    c.alpha_composite(term, (x, y0))

    cx = 96
    for label in ["零安装", "断线重连", "端口转发"]:
        cx += pill(d, cx, 1130, label) + 12
    footer(d, "01 / 07")
    c.alpha_composite(grain())
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


def icon(d, x, y, s, name, color=BLUE) -> None:
    w = 2
    if name == "hosts":
        for i in range(2):
            top = y + 4 + i * (s // 2 - 2)
            d.rounded_rectangle([x + 2, top, x + s - 2, top + s // 2 - 5], radius=3, outline=color, width=w)
            d.ellipse([x + s - 9, top + 4, x + s - 5, top + 8], fill=color)
    elif name == "connect":
        d.line([(x + 2, y + s // 2), (x + s - 2, y + s // 2)], fill=color, width=w)
        d.arc([x + s // 4, y + s // 4, x + s - 2, y + s - 2], start=270, end=90, fill=color, width=w)
    elif name in ("exec", "terminal"):
        d.rounded_rectangle([x + 2, y + 5, x + s - 2, y + s - 5], radius=3, outline=color, width=w)
        d.line([(x + 7, y + 12), (x + 13, y + 17), (x + 7, y + 22)], fill=color, width=w, joint="curve")
        d.line([(x + 17, y + 22), (x + 24, y + 22)], fill=color, width=w)
    elif name in ("read", "write", "edit"):
        d.rounded_rectangle([x + 6, y + 3, x + s - 6, y + s - 3], radius=3, outline=color, width=w)
        if name == "read":
            for i in range(3):
                d.line([(x + 10, y + 9 + i * 5), (x + s - 10, y + 9 + i * 5)], fill=color, width=w)
        elif name == "write":
            d.line([(x + s // 2, y + 9), (x + s // 2, y + s - 9)], fill=color, width=w)
            d.line([(x + s // 2 - 5, y + s - 14), (x + s // 2, y + s - 9), (x + s // 2 + 5, y + s - 14)], fill=color, width=w)
        else:
            d.line([(x + 10, y + s - 12), (x + s - 10, y + 12)], fill=color, width=w)
            d.line([(x + 9, y + s - 6), (x + 16, y + s - 9)], fill=color, width=w)
    elif name == "search":
        d.ellipse([x + 4, y + 4, x + s - 10, y + s - 10], outline=color, width=w)
        d.line([(x + s - 12, y + s - 12), (x + s - 3, y + s - 3)], fill=color, width=w + 1)
    elif name == "glob":
        d.line([(x + 3, y + s - 8), (x + 3, y + 8), (x + s - 12, y + 8), (x + s - 12, y + s - 8), (x + 3, y + s - 8)],
               fill=color, width=w, joint="curve")
        d.ellipse([x + s - 16, y + s - 16, x + s - 4, y + s - 4], outline=color, width=w)
        d.line([(x + s - 7, y + s - 7), (x + s - 2, y + s - 2)], fill=color, width=w)
    elif name == "import":
        d.line([(x + s // 2, y + 3), (x + s // 2, y + s - 10)], fill=color, width=w)
        d.line([(x + s // 2 - 6, y + s - 16), (x + s // 2, y + s - 10), (x + s // 2 + 6, y + s - 16)], fill=color, width=w)
        d.line([(x + 5, y + s - 4), (x + s - 5, y + s - 4)], fill=color, width=w)
    elif name == "export":
        d.line([(x + s // 2, y + s - 3), (x + s // 2, y + 10)], fill=color, width=w)
        d.line([(x + s // 2 - 6, y + 16), (x + s // 2, y + 10), (x + s // 2 + 6, y + 16)], fill=color, width=w)
        d.line([(x + 5, y + s - 4), (x + s - 5, y + s - 4)], fill=color, width=w)
    elif name == "jobs":
        d.ellipse([x + 4, y + 4, x + s - 4, y + s - 4], outline=color, width=w)
        d.line([(x + s // 2, y + 10), (x + s // 2, y + s // 2), (x + s - 9, y + s // 2 + 4)], fill=color, width=w, joint="curve")
    elif name == "forward":
        d.line([(x + 4, y + 12), (x + s - 5, y + 12)], fill=color, width=w)
        d.line([(x + s - 11, y + 7), (x + s - 5, y + 12), (x + s - 11, y + 17)], fill=color, width=w)
        d.line([(x + 5, y + s - 12), (x + s - 4, y + s - 12)], fill=color, width=w)
        d.line([(x + 11, y + s - 17), (x + 5, y + s - 12), (x + 11, y + s - 7)], fill=color, width=w)
    elif name == "trash":
        d.line([(x + 5, y + 9), (x + s - 5, y + 9)], fill=color, width=w)
        d.rounded_rectangle([x + 8, y + 9, x + s - 8, y + s - 5], radius=3, outline=color, width=w)
        d.line([(x + s // 2 - 5, y + 4), (x + s // 2 + 5, y + 4)], fill=color, width=w)
        d.line([(x + s // 2 - 4, y + 13), (x + s // 2 - 4, y + s - 9)], fill=color, width=w)
        d.line([(x + s // 2 + 4, y + 13), (x + s // 2 + 4, y + s - 9)], fill=color, width=w)


def build_tools() -> Image.Image:
    c = canvas_light()
    d = ImageDraw.Draw(c)
    brand(c)
    y = headline(d, [("14 个工具", False), ("和本地一样顺手", True)], 210, 88)
    sub(d, y + 4, "全部走同一条常驻连接 · 远端零安装", 26)
    col_x = [96, 558]
    card_w, card_h, gap = 426, 72, 10
    top = 620
    for index, (name, desc, key) in enumerate(TOOLS):
        x = col_x[index % 2]
        cy = top + (index // 2) * (card_h + gap)
        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([x + 1, cy + 6, x + card_w + 1, cy + card_h + 8], radius=20, fill=(15, 23, 42, 26))
        c.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
        card = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=20, fill=(255, 255, 255, 245),
                             outline=(203, 213, 225, 140), width=1)
        c.alpha_composite(card, (x, cy))
        d = ImageDraw.Draw(c)
        d.rounded_rectangle([x + 12, cy + 12, x + 60, cy + 60], radius=14, fill=(239, 246, 255, 255),
                            outline=(191, 219, 254, 200), width=1)
        icon(d, x + 22, cy + 22, 28, key, color=BLUE)
        d.text((x + 74, cy + 13), name, font=font(FONT_MONO, 20), fill=INK)
        d.text((x + 74, cy + 40), desc, font=font(FONT_CN, 17), fill=SLATE)
    footer(d, "02 / 07")
    c.alpha_composite(grain())
    return c.convert("RGB")


def build_workflow() -> Image.Image:
    c = canvas_light()
    d = ImageDraw.Draw(c)
    brand(c)
    y = headline(d, [("它真的", False), ("在那台机器上干活", True)], 200, 84)
    sub(d, y + 4, "从一句话到远端结果，中间只有一条常驻连接", 26)
    x_card, w_card = 214, 770
    top, h_card, gap = 540, 148, 40
    line = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    x_line = x_card - 46
    ld.line([(x_line, top + 50), (x_line, top + 3 * (h_card + gap) + h_card - 50)], fill=(*BLUE, 150), width=3)
    c.alpha_composite(line.filter(ImageFilter.GaussianBlur(6)))
    nodes = [
        ("01", "你说", "把训练跑起来，失败就修", "chat"),
        ("02", "Agent", "DSH 插件 / MCP 客户端", "agent"),
        ("03", "常驻 SSH", "一条连接，13 ms 往返，断线自动重连", "link"),
        ("04", "远程机器", "代码 · 环境 · GPU，全在那边", "remote"),
    ]
    for index, (num, title, desc, kind) in enumerate(nodes):
        cy = top + index * (h_card + gap)
        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([x_card + 2, cy + 16, x_card + w_card + 2, cy + h_card + 20], radius=26, fill=(15, 23, 42, 40))
        c.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
        card = Image.new("RGBA", (w_card, h_card), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle([0, 0, w_card - 1, h_card - 1], radius=26, fill=(255, 255, 255, 246),
                             outline=(203, 213, 225, 150), width=1)
        c.alpha_composite(card, (x_card, cy))
        d = ImageDraw.Draw(c)
        d.ellipse([x_line - 11, cy + 61, x_line + 11, cy + 83], fill=BLUE, outline=(255, 255, 255, 200), width=2)
        d.ellipse([x_card + 26, cy + 40, x_card + 94, cy + 108], fill=(239, 246, 255, 255),
                  outline=(191, 219, 254, 220), width=1)
        # node glyphs
        cx, cyc = x_card + 60, cy + 74
        if kind == "chat":
            d.rounded_rectangle([cx - 16, cyc - 12, cx + 16, cyc + 12], radius=8, outline=BLUE, width=3)
            d.line([(cx - 6, cyc + 12), (cx - 2, cyc + 20)], fill=BLUE, width=3)
        elif kind == "agent":
            d.rounded_rectangle([cx - 16, cyc - 12, cx + 16, cyc + 14], radius=8, outline=BLUE, width=3)
            d.ellipse([cx - 8, cyc - 8, cx - 3, cyc - 3], fill=BLUE)
            d.ellipse([cx + 3, cyc - 8, cx + 8, cyc - 3], fill=BLUE)
        elif kind == "link":
            d.line([(cx - 16, cyc), (cx + 16, cyc)], fill=BLUE, width=3)
            d.arc([cx - 20, cyc - 16, cx + 20, cyc + 16], start=200, end=340, fill=BLUE, width=3)
        else:
            d.rounded_rectangle([cx - 16, cyc - 14, cx + 16, cyc + 14], radius=5, outline=BLUE, width=3)
            d.line([(cx - 8, cyc + 2), (cx - 2, cyc + 8), (cx - 8, cyc + 13)], fill=BLUE, width=3, joint="curve")
            d.line([(cx - 1, cyc + 13), (cx + 9, cyc + 13)], fill=BLUE, width=3)
        d.text((x_card + 116, cy + 26), num, font=font(FONT_MONO, 18), fill=BLUE)
        d.text((x_card + 160, cy + 20), title, font=font(FONT_CN_BOLD, 34), fill=INK)
        d.text((x_card + 116, cy + 84), desc, font=font(FONT_CN, 21), fill=SLATE)
        if kind == "remote":
            d.ellipse([x_card + w_card - 44, cy + 28, x_card + w_card - 30, cy + 42], fill=(34, 197, 94))
    cx = 96
    for label in ["零安装", "断线重连", "端口转发"]:
        cx += pill(d, cx, 1300, label) + 12
    footer(d, "07 / 07")
    c.alpha_composite(grain())
    return c.convert("RGB")


def build_shot(name: str) -> Image.Image:
    cfg = PAGES[name]
    c = canvas_light()
    d = ImageDraw.Draw(c)
    brand(c)
    y = headline(d, cfg["title"], 196, 84)
    sub(d, y + 2, cfg["sub"], 26)
    d.text((96, y + 48), "截图来自真实使用界面",
           font=font(FONT_CN, 18), fill=MUTED)

    src = Image.open(SHOTS / cfg["file"]).convert("RGBA")
    cx0, cy0, cx1, cy1 = cfg.get("crop", (0, 0, src.width, src.height))
    src = src.crop((cx0, cy0, cx1, cy1))
    sw, sh = src.size
    max_w, max_h = 820, 720
    scale = min(max_w / sw, max_h / sh)
    inner_w, inner_h = int(sw * scale), int(sh * scale)
    card_w, card_h = inner_w + 20, inner_h + 20
    x = (W - card_w) // 2
    top = 512
    shot_card(c, (x, top, card_w, card_h), src)
    d = ImageDraw.Draw(c)
    for number, (nx, ny) in enumerate(cfg["marks"], start=1):
        callout(d, x + 10 + int(nx * inner_w), top + 10 + int(ny * inner_h), number)
    footer(d, cfg["page"])
    c.alpha_composite(grain())
    return c.convert("RGB")


def PillowCard(c, box, src):  # pragma: no cover - unused helper kept for clarity
    return None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("cover.png", build_cover),
        ("tools.png", build_tools),
        ("workspaces.png", lambda: build_shot("workspaces")),
        ("files.png", lambda: build_shot("files")),
        ("ports.png", lambda: build_shot("ports")),
        ("terminal.png", lambda: build_shot("terminal")),
        ("workflow.png", build_workflow),
    ]
    for name, builder in jobs:
        image = builder()
        path = OUT / name
        image.save(path, "PNG", optimize=True)
        print(f"wrote {path.name} ({path.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
