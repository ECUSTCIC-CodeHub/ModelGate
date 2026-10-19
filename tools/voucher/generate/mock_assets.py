"""自检用合成底图：按当前 layout 的矩形平涂留白，供 selfcheck 在没有（或不想用）真实美术底图时跑通整条流水线。

与 tools/voucher/mock/make_mock_assets.py 的区别：这里直接遍历 layout.regions()，
所以版式一改（例如 r4 把二维码静默区让出来）合成底图会自动跟着变，自检不会因为底图过期而误判。
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

import layout as layout_mod

CANVAS = (layout_mod.CANVAS_W, layout_mod.CANVAS_H)

RGB_PALETTE = {
    "bg": (233, 237, 242),
    "panel": (250, 247, 238),
    "blank": (252, 250, 244),
    "ink": (28, 46, 74),
    "accent": (46, 112, 180),
    "soft": (203, 216, 232),
}
CMYK_PALETTE = {
    "bg": (9, 5, 3, 0),
    "panel": (5, 4, 2, 0),
    "blank": (3, 2, 1, 0),
    "ink": (72, 52, 24, 62),
    "accent": (76, 30, 4, 8),
    "soft": (22, 11, 6, 0),
}


def _noise(size: tuple[int, int], seed: int) -> Image.Image:
    rng = random.Random(seed)
    data = bytearray(size[0] * size[1])
    for index in range(len(data)):
        data[index] = (rng.randrange(256) // 3 + 90) & 0xFF
    return Image.frombytes("L", size, bytes(data))


def build_face(layout: layout_mod.Layout, mode: str, seed: int) -> Image.Image:
    palette = RGB_PALETTE if mode == "RGB" else CMYK_PALETTE
    image = Image.new(mode, CANVAS, palette["bg"])
    draw = ImageDraw.Draw(image)
    for index in range(0, layout_mod.CANVAS_W, 160):
        draw.rectangle([index, 0, index + 40, layout_mod.CANVAS_H], fill=palette["soft"])
    # 空白区：全部按 layout 的矩形平涂（含二维码留白框，静默区因此一定干净）
    for name, region in layout.regions().items():
        if name in ("back_fixed_left", "back_fixed_right"):
            continue
        draw.rectangle([region.x0, region.y0, region.x1 - 1, region.y1 - 1], fill=palette["blank"])
    # 装饰：面板与噪声块，保证压缩率接近真实底图
    draw.rectangle([80, 80, 2280, 460], fill=palette["panel"], outline=palette["accent"], width=6)
    draw.rectangle([80, 520, 2280, 1100], fill=palette["panel"], outline=palette["accent"], width=6)
    for index in range(8):
        y = 160 + index * 90
        draw.rectangle([140, y, 140 + 900 - index * 40, y + 36], fill=palette["accent"] if index % 2 == 0 else palette["ink"])
    noise = _noise((900, 420), seed)
    if mode == "RGB":
        patch = noise.convert("RGB")
    else:
        zero = Image.new("L", noise.size, 0)
        patch = Image.merge("CMYK", (zero, zero, zero, noise))
    image.paste(patch, (120, 1000))
    # 固定文案区（back_fixed_left/right）写几行字，确保生成器不往里叠东西也不会被误判为空
    for name in ("back_fixed_left", "back_fixed_right"):
        region = layout.regions()[name]
        for line in range(3):
            top = region.y0 + 10 + line * 66
            draw.rectangle([region.x0 + 40, top, region.x1 - 40, top + 40],
                           fill=palette["ink"] if mode == "RGB" else palette["ink"])
    return image


def write_mock_assets(out_dir: Path, icc: bytes | None = None, seed: int = 20261018) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    layout = layout_mod.default_layout()
    rng = random.Random(seed)
    written: list[Path] = []
    for name in ("front", "back"):
        rgb = build_face(layout, "RGB", rng.randrange(1 << 30))
        path = out_dir / f"{name}_rgb.png"
        rgb.save(path)
        written.append(path)
        packed = _to_cmyk_packed(rgb)
        info = PngInfo()
        info.add_text("ColorSpace", "CMYK-packed")
        info.add_text("Software", "tools/voucher/generate/mock_assets.py")
        params: dict = {"pnginfo": info}
        if icc:
            params["icc_profile"] = icc
        path_cmyk = out_dir / f"{name}_cmyk.png"
        packed.save(path_cmyk, **params)
        written.append(path_cmyk)
    return written


def _to_cmyk_packed(rgb: Image.Image) -> Image.Image:
    red, green, blue = rgb.split()
    c = red.point(lambda value: 255 - value)
    m = green.point(lambda value: 255 - value)
    y = blue.point(lambda value: 255 - value)
    k = Image.new("L", rgb.size, 0)
    return Image.merge("RGBA", (c, m, y, k))


def find_icc() -> bytes | None:
    candidates = (
        Path(__file__).resolve().parents[1] / "assets" / "icc" / "JapanColor2001Coated.icc",
        Path(r"C:\Program Files (x86)\Common Files\Adobe\Color\Profiles\Recommended\JapanColor2001Coated.icc"),
    )
    for path in candidates:
        if path.exists():
            return path.read_bytes()
    return None


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "out" / "mock_assets"
    files = write_mock_assets(target, find_icc())
    print("已写入合成底图：" + "，".join(str(path) for path in files))
