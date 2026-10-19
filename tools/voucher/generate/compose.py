"""可变层合成：把二维码与文字以「纯黑油墨遮罩」的方式压到券底图上。

统一用 L 模式遮罩表达墨量（0 = 不着墨，255 = 满墨），再按通道合成：
RGB 底图取黑墨，CMYK 底图只改 K 通道——CMYK 版因此是 K100 单色黑，不引入任何 C/M/Y。
"""
from __future__ import annotations

from dataclasses import dataclass

from PIL import Image, ImageChops, ImageDraw, ImageFont

from layout import PX_PER_MM, Region


@dataclass
class Overlay:
    """页面叠加层：PDF 里自己的图像 XObject，位置相对券左上角。"""

    name: str
    rect: Region
    image: Image.Image
    object_id: int = 0


def ink_mask(size: tuple[int, int]) -> Image.Image:
    return Image.new("L", size, 0)


def apply_ink(target: Image.Image, mask: Image.Image) -> None:
    """在 target（RGB/CMYK/L）上按遮罩压纯黑，原地修改。"""
    if target.size != mask.size:
        raise ValueError(f"遮罩尺寸 {mask.size} 与目标尺寸 {target.size} 不一致")
    inverse = ImageChops.invert(mask)
    if target.mode == "RGB":
        channels = [ImageChops.multiply(channel, inverse) for channel in target.split()]
        target.paste(Image.merge("RGB", channels))
    elif target.mode == "CMYK":
        # 墨色是 (0,0,0,100%)：满墨处把底图的 C/M/Y 一起压掉，保证二维码与文字是 K100 单色黑，
        # 不会和底图的浅色底纹叠成四色黑。
        c, m, y, k = target.split()
        c = ImageChops.multiply(c, inverse)
        m = ImageChops.multiply(m, inverse)
        y = ImageChops.multiply(y, inverse)
        k = ImageChops.add(ImageChops.multiply(k, inverse), mask)
        target.paste(Image.merge("CMYK", (c, m, y, k)))
    elif target.mode == "L":
        target.paste(ImageChops.multiply(target, inverse))
    else:
        raise ValueError(f"不支持的合成模式：{target.mode}")


def qr_mask(module_count: int, box_px: "int | tuple[int, int]", quiet_modules: int, modules: list[list[bool]]) -> tuple[Image.Image, int, int, int]:
    """把二维码矩阵画成硬边遮罩（无抗锯齿）。

    box_px 可以是单值或 (宽, 高)：内容方阵居中画在框里，多余的 1px 平均分到两侧。
    返回 (遮罩, 模块像素, 横向内容起点, 纵向内容起点)。
    """
    width, height = (box_px, box_px) if isinstance(box_px, int) else (box_px[0], box_px[1])
    total = module_count + quiet_modules * 2
    module_px = min(width, height) // total
    if module_px <= 0:
        raise ValueError(f"二维码框 {width}×{height}px 放不下 {total} 个模块")
    content_px = module_px * total
    offset_x = (width - content_px) // 2
    offset_y = (height - content_px) // 2
    mask = ink_mask((width, height))
    draw = ImageDraw.Draw(mask)
    origin_x = offset_x + quiet_modules * module_px
    origin_y = offset_y + quiet_modules * module_px
    for row, cells in enumerate(modules):
        y0 = origin_y + row * module_px
        for col, dark in enumerate(cells):
            if dark:
                x0 = origin_x + col * module_px
                draw.rectangle([x0, y0, x0 + module_px - 1, y0 + module_px - 1], fill=255)
    return mask, module_px, origin_x, origin_y


def fit_font(font_path: str, text: str, box_px: tuple[int, int], max_em_px: float, min_em_px: float, padding_px: int = 0) -> ImageFont.FreeTypeFont:
    """按可用框自动选字号：先满足宽度，再满足高度。"""
    avail_w = box_px[0] - padding_px * 2
    avail_h = box_px[1] - padding_px * 2
    em = max_em_px
    while em > min_em_px:
        font = ImageFont.truetype(font_path, em)
        left, top, right, bottom = font.getbbox(text)
        if (right - left) <= avail_w and (bottom - top) <= avail_h:
            return font
        em -= max(0.5, em * 0.02)
    return ImageFont.truetype(font_path, min_em_px)


CAP_REFERENCE = "H"


def cap_height(font: ImageFont.FreeTypeFont) -> float:
    """大写字母高度（字高）：不含下伸部，跨字符组合稳定。"""
    left, top, right, bottom = font.getbbox(CAP_REFERENCE)
    return float(bottom - top)


DESCENDER_REFERENCE = "QJ"


def fit_font_by_ink(
    font_path: str,
    text: str,
    box_px: tuple[int, int],
    min_ink_height_px: float = 0.0,
    padding_px: int = 0,
    padding_y_px: "int | None" = None,
    height_reference: str = DESCENDER_REFERENCE,
) -> tuple[ImageFont.FreeTypeFont, float]:
    """在可用框内尽量放大字号。

    高度按含下伸部的参考串（默认 QJ）计算，保证同一批里带 Q/J 的兑换码不会把字顶出可用区，
    同时所有券的字号一致。返回字号与大写字母高度（像素）。
    """
    pad_y = padding_px if padding_y_px is None else padding_y_px
    avail_w = box_px[0] - padding_px * 2
    avail_h = box_px[1] - pad_y * 2
    probe = ImageFont.truetype(font_path, 100)
    probe_box = probe.getbbox(text)
    width_at_100 = max(1.0, probe_box[2] - probe_box[0])
    ref_box = probe.getbbox(height_reference)
    height_at_100 = max(1.0, ref_box[3] - ref_box[1])
    em = min(avail_w * 100.0 / width_at_100, avail_h * 100.0 / height_at_100)
    font = ImageFont.truetype(font_path, max(8.0, em))
    for _ in range(64):
        box = font.getbbox(text)
        ref = font.getbbox(height_reference)
        if (box[2] - box[0]) <= avail_w and (ref[3] - ref[1]) <= avail_h:
            break
        font = ImageFont.truetype(font_path, max(8.0, font.size * 0.99))
    return font, cap_height(font)


def fit_code_font(
    font_path: str,
    text: str,
    pill_px: tuple[int, int],
    width_limit_px: float,
    margin_px: int,
) -> tuple[ImageFont.FreeTypeFont, float, int, int]:
    """明文兑换码专用排版：总宽 ≤ width_limit，且文字外接框在胶囊条内四边各留 margin。

    返回 (字体, 大写字母高度 px, 文本总宽 px, 文字外接框高 px)。
    """
    limit_w = min(float(width_limit_px), float(pill_px[0] - 2 * margin_px))
    limit_h = float(pill_px[1] - 2 * margin_px)
    probe = ImageFont.truetype(font_path, 100)
    probe_box = probe.getbbox(text)
    width_at_100 = max(1.0, probe_box[2] - probe_box[0])
    height_at_100 = max(1.0, probe_box[3] - probe_box[1])
    em = min(limit_w * 100.0 / width_at_100, limit_h * 100.0 / height_at_100)
    font = ImageFont.truetype(font_path, max(8.0, em))
    for _ in range(64):
        box = font.getbbox(text)
        if (box[2] - box[0]) <= limit_w and (box[3] - box[1]) <= limit_h:
            break
        font = ImageFont.truetype(font_path, max(8.0, font.size * 0.99))
    box = font.getbbox(text)
    return font, cap_height(font), int(box[2] - box[0]), int(box[3] - box[1])


def text_mask(text: str, font: ImageFont.FreeTypeFont, box_px: tuple[int, int], align: str = "center") -> Image.Image:
    """把文字画成遮罩，并按实际着墨范围对齐（横向居中/居左/居右，纵向居中）。"""
    mask = ink_mask(box_px)
    draw = ImageDraw.Draw(mask)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    width = right - left
    height = bottom - top
    if width > box_px[0] or height > box_px[1]:
        raise ValueError(f"文本在 {box_px[0]}×{box_px[1]}px 框内溢出（实测 {width}×{height}px）：{text}")
    draw.text((-left, -top), text, font=font, fill=255)
    bbox = mask.getbbox()
    if not bbox:
        return mask
    if align == "center":
        dx = (box_px[0] - (bbox[2] + bbox[0])) // 2
    elif align == "left":
        dx = -bbox[0]
    else:
        dx = box_px[0] - bbox[2]
    dy = (box_px[1] - (bbox[3] + bbox[1])) // 2
    if dx or dy:
        shifted = ink_mask(box_px)
        shifted.paste(mask.crop(bbox), (bbox[0] + dx, bbox[1] + dy))
        mask = shifted
    return mask


def text_metrics(text: str, font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    left, top, right, bottom = font.getbbox(text)
    return (right - left, bottom - top)


def flatten_panel(image: Image.Image, inset_px: int = 8) -> tuple[Image.Image, int, tuple]:
    """把叠加区内部整平成面板底色（保留外圈装饰）。

    二维码静默区必须干净：底图四角的装饰角标若留在静默区里，扫码时会当成定位图形。
    底色取区域内出现次数最多的颜色，因此平涂结果与面板同色、看不出接缝。
    """
    inner = (inset_px, inset_px, image.width - inset_px, image.height - inset_px)
    patch = image.crop(inner)
    colors = patch.getcolors(maxcolors=1 << 26)
    if not colors:
        return image, 0, image.getpixel((0, 0))
    base_color = max(colors, key=lambda item: item[0])[1]
    changed = sum(count for count, color in colors if color != base_color)
    image.paste(Image.new(image.mode, patch.size, base_color), (inset_px, inset_px))
    return image, changed, base_color


def overlay_from_region(base: Image.Image, rect: Region, mask: Image.Image) -> Overlay:
    """从底图裁剪区域、压上墨层，得到可直接贴到页面上的不透明叠加层。"""
    region = base.crop(rect.box())
    apply_ink(region, mask)
    return Overlay(name=rect.name, rect=rect, image=region)


def module_mm(module_px: int) -> float:
    return module_px / PX_PER_MM
