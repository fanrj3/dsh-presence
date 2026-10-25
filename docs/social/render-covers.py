#!/usr/bin/env python
"""Render 1080x1440 (3:4) Xiaohongshu cover templates for Presence.

Run from the repo root:
    python docs/social/render-covers.py

Outputs docs/social/cover-light.png and docs/social/cover-dark.png.
Every colour is defined here so re-running gives the same result.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
W, H = 1080, 1440

FONT_DIR = Path("C:/Windows/Fonts")
FONT_CN = FONT_DIR / "msyh.ttc"
FONT_CN_BOLD = FONT_DIR / "msyhbd.ttc"
FONT_MONO = FONT_DIR / "CascadiaMono.ttf" if (FONT_DIR / "CascadiaMono.ttf").exists() else FONT_DIR / "consola.ttf"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.exists():
        print(f"missing font: {path}", file=sys.stderr)
        return ImageFont.load_default()
    return ImageFont.truetype(str(path), size)


def vgradient(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    rows = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    top_arr = np.array(top, dtype=np.float32)
    bottom_arr = np.array(bottom, dtype=np.float32)
    arr = top_arr + (bottom_arr - top_arr) * rows
    arr = np.repeat(arr[:, None, :], W, axis=1)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")


def radial_glow(cx: float, cy: float, radius: float, color: tuple[int, int, int], strength: float = 1.0) -> Image.Image:
    y, x = np.ogrid[:H, :W]
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
    alpha = np.clip(1.0 - dist, 0.0, 1.0) ** 2 * strength
    layer = np.zeros((H, W, 4), dtype=np.float32)
    layer[..., 0] = color[0]
    layer[..., 1] = color[1]
    layer[..., 2] = color[2]
    layer[..., 3] = alpha * 255
    return Image.fromarray(layer.clip(0, 255).astype(np.uint8), "RGBA")


def grain(size: tuple[int, int], alpha: int = 5, seed: int = 7) -> Image.Image:
    rng = np.random.default_rng(seed)
    noise = rng.integers(0, 255, (size[1], size[0]), dtype=np.uint8)
    rgba = np.zeros((size[1], size[0], 4), dtype=np.uint8)
    rgba[..., 0:3] = 255
    rgba[..., 3] = (noise > 200).astype(np.uint8) * alpha
    return Image.fromarray(rgba, "RGBA")


def mesh_grid(color: tuple[int, int, int, int], step: int = 90) -> Image.Image:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x in range(0, W, step):
        draw.line([(x, 0), (x, H)], fill=color, width=1)
    for y in range(0, H, step):
        draw.line([(0, y), (W, y)], fill=color, width=1)
    return layer


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], content: str, fnt, fill) -> None:
    draw.text(xy, content, font=fnt, fill=fill)


def measure(draw: ImageDraw.ImageDraw, content: str, fnt) -> tuple[int, int]:
    box = draw.textbbox((0, 0), content, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def brand_row(draw: ImageDraw.ImageDraw, dark: bool) -> None:
    tile = Image.new("RGBA", (72, 72), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    td.rounded_rectangle([0, 0, 71, 71], radius=18, fill=(47, 107, 255, 255))
    td.rounded_rectangle([13, 18, 59, 52], radius=8, outline=(255, 255, 255, 235), width=4)
    td.line([(22, 28), (30, 35), (22, 42)], fill=(255, 255, 255, 255), width=4, joint="curve")
    td.line([(35, 44), (45, 44)], fill=(255, 255, 255, 255), width=4)
    tile.putalpha(tile.getchannel("A").filter(ImageFilter.GaussianBlur(0.2)))
    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    # paste through a composed canvas later; here just return positions
    return tile  # type: ignore[return-value]


def draw_terminal_card(canvas: Image.Image, xy: tuple[int, int], size: tuple[int, int], dark: bool, lines) -> None:
    x, y = xy
    w, h = size
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([x + 6, y + 22, x + w + 6, y + h + 28], radius=30, fill=(15, 23, 42, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    canvas.alpha_composite(shadow)

    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    if dark:
        cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=30, fill=(17, 24, 44, 245), outline=(255, 255, 255, 26), width=2)
    else:
        cd.rounded_rectangle([0, 0, w - 1, h - 1], radius=30, fill=(15, 23, 42, 252))
    # window dots
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 34 + i * 26
        cd.ellipse([cx - 7, 26, cx + 7, 40], fill=color)
    title_font = font(FONT_MONO, 22)
    cd.text((w - 26 - measure(cd, "server — zsh", title_font)[0], 22), "server — zsh", font=title_font, fill=(148, 163, 184, 235))

    mono = font(FONT_MONO, 27)
    small = font(FONT_MONO, 23)
    mono_cn = font(FONT_CN, 25)
    small_cn = font(FONT_CN, 23)

    def has_cjk(value: str) -> bool:
        return any("\u3400" <= ch <= "\u9fff" for ch in value)
    cursor_y = 84
    for kind, content in lines:
        if kind == "prompt":
            cd.text((34, cursor_y), "❯", font=mono, fill=(74, 222, 128, 255))
            cd.text((64, cursor_y), content, font=mono, fill=(226, 232, 240, 255))
        elif kind == "dim":
            cd.text((64, cursor_y), content, font=small_cn if has_cjk(content) else small, fill=(148, 163, 184, 235))
        elif kind == "ok":
            cd.text((34, cursor_y), "✓", font=mono, fill=(74, 222, 128, 255))
            cd.text((64, cursor_y), content, font=small_cn if has_cjk(content) else small, fill=(134, 239, 172, 240))
        cursor_y += 46
    canvas.alpha_composite(card, (x, y))


def chip(draw: ImageDraw.ImageDraw, x: int, y: int, content: str, dark: bool) -> int:
    fnt = font(FONT_CN, 24)
    tw, th = measure(draw, content, fnt)
    pad_x, pad_y = 22, 12
    bw, bh = tw + pad_x * 2, th + pad_y * 2 + 6
    if dark:
        fill, outline, fg = (19, 28, 54, 235), (255, 255, 255, 30), (203, 213, 225, 255)
    else:
        fill, outline, fg = (255, 255, 255, 235), (47, 107, 255, 40), (51, 65, 85, 255)
    draw.rounded_rectangle([x, y, x + bw, y + bh], radius=999, fill=fill, outline=outline, width=1)
    draw.text((x + pad_x, y + pad_y - 2), content, font=fnt, fill=fg)
    return bw


def headline(draw: ImageDraw.ImageDraw, lines, dark: bool, top: int) -> int:
    fnt = font(FONT_CN_BOLD, 104)
    y = top
    for line in lines:
        if isinstance(line, tuple):
            content, accent = line
        else:
            content, accent = line, False
        fill = (47, 107, 255, 255) if accent else ((248, 250, 252, 255) if dark else (15, 23, 42, 255))
        draw.text((96, y), content, font=fnt, fill=fill)
        y += 128
    return y


def build_light() -> Image.Image:
    canvas = vgradient((248, 250, 253), (234, 242, 255)).convert("RGBA")
    canvas.alpha_composite(radial_glow(860, 210, 620, (47, 107, 255), 0.32))
    canvas.alpha_composite(radial_glow(150, 1240, 560, (124, 58, 237), 0.10))
    canvas.alpha_composite(mesh_grid((15, 23, 42, 10), step=96))
    draw = ImageDraw.Draw(canvas)

    icon = brand_row(draw, dark=False)
    canvas.alpha_composite(icon, (96, 92))
    draw.text((186, 104), "Presence", font=font(FONT_CN_BOLD, 34), fill=(15, 23, 42, 255))
    chip(draw, 186, 146, "DSH 插件", dark=False)

    y = headline(draw, [("远程机器", False), ("像本地一样用", True)], dark=False, top=250)
    sub = font(FONT_CN, 33)
    draw.text((96, y + 6), "SSH 零安装 · 连接持久复用", font=sub, fill=(71, 85, 105, 255))
    draw.text((96, y + 56), "终端 / 文件 / 端口转发，全部原生", font=sub, fill=(100, 116, 139, 255))

    draw_terminal_card(canvas, (96, 792), (888, 320), False,
        [
            ("prompt", "presence terminal server"),
            ("dim", "user@server:/srv/app/VAE $ python train.py"),
            ("dim", "[12:31:02] step 120/200  loss=0.043"),
            ("ok", "连接复用 13 ms · 断线自动重连"),
        ],
    )

    cx = 96
    for label in ["零安装", "断线重连", "原生 sshd 通道"]:
        cx += chip(draw, cx, 1166, label, dark=False) + 14

    draw.text((96, 1272), "Presence 0.17.1", font=font(FONT_MONO, 22), fill=(100, 116, 139, 220))
    canvas.alpha_composite(grain((W, H), alpha=4))
    return canvas.convert("RGB")


def build_dark() -> Image.Image:
    canvas = vgradient((9, 13, 28), (16, 26, 54)).convert("RGBA")
    canvas.alpha_composite(radial_glow(880, 1180, 760, (47, 107, 255), 0.45))
    canvas.alpha_composite(radial_glow(180, 160, 560, (124, 58, 237), 0.28))
    canvas.alpha_composite(mesh_grid((255, 255, 255, 9), step=96))
    draw = ImageDraw.Draw(canvas)

    icon = brand_row(draw, dark=True)
    canvas.alpha_composite(icon, (96, 92))
    draw.text((186, 104), "Presence", font=font(FONT_CN_BOLD, 34), fill=(248, 250, 252, 255))
    chip(draw, 186, 146, "DSH 插件", dark=True)

    y = headline(draw, [("Agent 就住", False), ("在那台机器上", True)], dark=True, top=250)
    sub = font(FONT_CN, 33)
    draw.text((96, y + 6), "给你的 agent 一个真实的远程工作台", font=sub, fill=(203, 213, 225, 255))
    draw.text((96, y + 56), "持久 SSH · 原生工具 · 13 台机器随时切换", font=sub, fill=(148, 163, 184, 255))

    draw_terminal_card(canvas, (96, 792), (888, 320), True,
        [
            ("prompt", "presence exec 'nproc && uname -r'"),
            ("dim", "32"),
            ("dim", "5.15.0-124-generic"),
            ("ok", "12 个模型步骤，同一连接，0 次握手"),
        ],
    )

    cx = 96
    for label in ["零安装", "断线自动重连", "端口转发"]:
        cx += chip(draw, cx, 1166, label, dark=True) + 14

    draw.text((96, 1272), "Presence 0.17.1", font=font(FONT_MONO, 22), fill=(148, 163, 184, 200))
    canvas.alpha_composite(grain((W, H), alpha=6))
    return canvas.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, builder in [("cover-light.png", build_light), ("cover-dark.png", build_dark)]:
        image = builder()
        path = OUT / name
        image.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
