"""生成自检用的合成底图：不是交付美术资产，只用来在 t6 底图就绪前跑通流水线。

输出 4 张 3840×1648 PNG：front_rgb / back_rgb（RGB）与 front_cmyk / back_cmyk（RGBA 打包，R=C、G=M、B=Y、A=K）。
二维码面板与各文本条位置严格按冻结坐标，面板为纯白均匀区。
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "generate"))

import layout as layout_mod  # noqa: E402

CANVAS = (layout_mod.CANVAS_W, layout_mod.CANVAS_H)
ICC_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Common Files\Adobe\Color\Profiles\Recommended\JapanColor2001Coated.icc"),
    Path(r"C:\Program Files\Common Files\Adobe\Color\Profiles\Recommended\JapanColor2001Coated.icc"),
)

RGB_PALETTE = {
    "bg": (233, 237, 242),
    "panel": (255, 255, 255),
    "ink": (28, 46, 74),
    "accent": (46, 112, 180),
    "soft": (203, 216, 232),
}
CMYK_PALETTE = {
    "bg": (9, 5, 3, 0),
    "panel": (0, 0, 0, 0),
    "ink": (72, 52, 24, 62),
    "accent": (76, 30, 4, 8),
    "soft": (22, 11, 6, 0),
}


def _noise(size, seed: int, sigma: int = 26) -> Image.Image:
    rng = random.Random(seed)
    data = bytes((128 + (rng.randrange(256) - 128) * sigma // 256) & 0xFF for _ in range(size[0] * size[1]))
    return Image.frombytes("L", size, data)


def build_face(layout: layout_mod.Layout, palette: dict, mode: str, seed: int, title: str) -> Image.Image:
    image = Image.new(mode, CANVAS, palette["bg"])
    draw = ImageDraw.Draw(image)
    accent = palette["accent"]
    ink = palette["ink"]
    # 装饰：斜条 + 噪声块，让压缩率接近真实美术底图
    for index in range(0, layout_mod.CANVAS_W, 160):
        draw.rectangle([index, 0, index + 40, layout_mod.CANVAS_H], fill=palette["soft"])
    noise = _noise((900, 420), seed)
    if mode == "RGB":
        patch = noise.convert("RGB")
    else:
        zero = Image.new("L", noise.size, 0)
        patch = Image.merge("CMYK", (zero, zero, zero, noise))
    image.paste(patch, (120, 1000))
    draw.rectangle([80, 80, 2280, 460], fill=palette["panel"], outline=accent, width=6)
    draw.rectangle([80, 520, 2280, 1100], fill=palette["panel"], outline=accent, width=6)
    draw.rectangle([2400, 80, 3760, 1100], fill=palette["panel"], outline=accent, width=6)
    for index in range(8):
        y = 160 + index * 90
        draw.rectangle([140, y, 140 + 900 - index * 40, y + 36], fill=accent if index % 2 == 0 else ink)
    for name in ("front_qr", "front_code_bar", "back_quote_bar", "back_serial_block", "front_code_text", "back_quote_text", "back_serial_text"):
        region = layout.regions()[name]
        draw.rectangle([region.x0 - 2, region.y0 - 2, region.x1 + 1, region.y1 + 1], fill=palette["panel"])
    draw.rectangle([layout.front_qr.x0 - 3, layout.front_qr.y0 - 3, layout.front_qr.x1 + 2, layout.front_qr.y1 + 2],
                   fill=palette["panel"], outline=accent, width=3)
    return image


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="生成自检用合成底图")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "out" / "mock_assets"))
    parser.add_argument("--icc", default=None)
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    layout = layout_mod.default_layout()
    icc_path = Path(args.icc) if args.icc else next((path for path in ICC_CANDIDATES if path.exists()), None)
    icc = icc_path.read_bytes() if icc_path else None
    rng = random.Random(20261018)

    front_rgb = build_face(layout, RGB_PALETTE, "RGB", rng.randrange(1 << 30), "front")
    back_rgb = build_face(layout, RGB_PALETTE, "RGB", rng.randrange(1 << 30), "back")
    front_rgb.save(out / "front_rgb.png", optimize=True)
    back_rgb.save(out / "back_rgb.png", optimize=True)

    for name, source in (("front_cmyk", front_rgb), ("back_cmyk", back_rgb)):
        packed = _to_cmyk_packed(source)
        info = PngInfo()
        info.add_text("ColorSpace", "CMYK-packed")
        info.add_text("Software", "tools/voucher/mock/make_mock_assets.py")
        params = {"pnginfo": info}
        if icc:
            params["icc_profile"] = icc
        packed.save(out / f"{name}.png", **params)
    print(f"合成底图已写入 {out}（ICC：{icc_path if icc else '无'}）")
    return 0


def _to_cmyk_packed(rgb: Image.Image) -> Image.Image:
    """按 t6 约定打包：R=C、G=M、B=Y、A=K（这里用简单换算近似）。"""
    r, g, b = rgb.split()
    c = r.point(lambda v: 255 - v)
    m = g.point(lambda v: 255 - v)
    y = b.point(lambda v: 255 - v)
    k = Image.new("L", rgb.size, 0)
    return Image.merge("RGBA", (c, m, y, k))


if __name__ == "__main__":
    sys.exit(main())
