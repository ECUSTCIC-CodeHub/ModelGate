"""兑换券生成器核心：CSV + 文案清单 → RGB/CMYK 两套 A4 横向双面 6-up 拼版 PDF。

设计要点：
- 底图整幅按 3840px = 136mm 贴入，页面里再叠「可变层」的不透明小图；小图是底图同一区域的裁剪加墨后的结果，
  所以「底图 + 叠加层」与「整张合成券」逐像素一致，同时避免把 600 张 3840×1648 全图塞进 PDF。
- 墨层只有黑色：RGB 版压黑，CMYK 版只改 K 通道（K100 单色黑）。
- mock CSV 与真实 CSV 走同一个 load_codes，没有任何按文件名分支的逻辑。
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageFont

import compose
import layout as layout_mod
import pdfwrite
import qr
from layout import (
    CANVAS_H,
    CANVAS_W,
    COUPON_H_MM,
    COUPON_W_MM,
    PAGE_H_MM,
    PAGE_W_MM,
    PX_PER_MM,
    Layout,
    mm_to_pt,
    px_to_mm,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_QUOTES = REPO_ROOT / "tools" / "voucher" / "quotes.txt"
DEFAULT_ASSETS = REPO_ROOT / "tools" / "voucher" / "assets"
DEFAULT_OUT = REPO_ROOT / "tools" / "voucher" / "out"
DEFAULT_MOCK_CSV = REPO_ROOT / "tools" / "voucher" / "mock" / "codes_mock.csv"
DEFAULT_MOCK_QUOTES = REPO_ROOT / "tools" / "voucher" / "mock" / "quotes.mock.txt"

# t6 的 CMYK 底图用 RGBA 打包（R=C、G=M、B=Y、A=K），PNG 文本标记形如
# "CMYK-packed: R=C,G=M,B=Y,A=K"，按前缀识别即可
CMYK_PACKED_MARKER = "CMYK-packed"

# 兑换码格式：ModelGate 生成的是 XXXX-XXXX-XXXX（字母 A-Z + 数字 2-9，不含 0/O/1/I）
CODE_PATTERN = re.compile(r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")
CODE_HINT = "格式应为 XXXX-XXXX-XXXX（大写字母 A-Z 与数字 2-9）"

# CSV 表头候选（归一化后比较：去空白、转小写、去括号内英文说明）
HEADER_ALIASES = {
    "兑换码", "code", "codes", "redeemcode", "redeem_code", "redeem-code",
    "兑换码codes", "兑换码code", "兑换码(codes)", "兑换码（codes）",
}

DEFAULT_BASE_URL = "https://ai.ecustcic.com"

ICC_IDENTIFIER = "JapanColor2001Coated"
ICC_REGISTRY = "http://www.japan-color.com"
ICC_INFO = "Japan Color 2001 Coated"
ICC_FALLBACKS = (
    Path(r"C:\Program Files (x86)\Common Files\Adobe\Color\Profiles\Recommended") / "JapanColor2001Coated.icc",
    Path(r"C:\Program Files\Common Files\Adobe\Color\Profiles\Recommended") / "JapanColor2001Coated.icc",
    Path(r"C:\Windows\System32\spool\drivers\color") / "JapanColor2001Coated.icc",
)

CJK_FONT_CANDIDATES = (
    ("微软雅黑", r"C:\Windows\Fonts\msyh.ttc"),
    ("Noto Sans SC", r"C:\Windows\Fonts\NotoSansSC-VF.ttf"),
    ("等线", r"C:\Windows\Fonts\Deng.ttf"),
    ("黑体", r"C:\Windows\Fonts\simhei.ttf"),
    ("宋体", r"C:\Windows\Fonts\simsun.ttc"),
    ("Noto Serif SC", r"C:\Windows\Fonts\NotoSerifSC-VF.ttf"),
    ("Noto Sans CJK", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ("Noto Sans CJK", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
)

MONO_FONT_CANDIDATES = (
    ("Consolas", r"C:\Windows\Fonts\consola.ttf"),
    ("Courier New", r"C:\Windows\Fonts\cour.ttf"),
    ("DejaVu Sans Mono", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    ("Liberation Mono", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"),
)


class VoucherError(Exception):
    """可预期的输入或校验错误，消息直接面向使用者。"""


@dataclass(frozen=True)
class CodeRow:
    code: str
    batch: str


@dataclass(frozen=True)
class QuoteLine:
    lineno: int
    text: str


@dataclass(frozen=True)
class Overflow:
    lineno: int
    text: str
    width_px: float
    limit_px: int
    height_px: float
    height_limit_px: int

    def message(self) -> str:
        return (
            f"文案清单第 {self.lineno} 行超出横条可用区：实测宽 {self.width_px:.1f}px = "
            f"{self.width_px / PX_PER_MM:.2f}mm（上限 {self.limit_px}px = {self.limit_px / PX_PER_MM:.2f}mm），"
            f"高 {self.height_px:.1f}px（上限 {self.height_limit_px}px）：「{self.text}」"
        )


@dataclass
class SheetPlan:
    index: int
    front: dict[tuple[int, int], int]
    back: dict[tuple[int, int], int]


@dataclass
class SetResult:
    name: str
    pdf_path: Path
    bytes_written: int
    pages: int
    unique_images: int
    color_space: str
    output_intent: bool


@dataclass
class Report:
    codes: int
    sheets: int
    quotes: int
    quote_usage: Counter
    overflow: list[Overflow]
    warnings: list[str]
    sets: list[SetResult]
    manifest_path: Path | None
    font_path: str
    font_label: str
    mono_path: str
    qr_version: int
    qr_module_px: int
    elapsed_s: float
    manifest: dict = field(default_factory=dict)


@dataclass
class GenerateConfig:
    csv_path: Path
    quotes_path: Path = DEFAULT_QUOTES
    assets_dir: Path = DEFAULT_ASSETS
    out_dir: Path = DEFAULT_OUT
    basename: str = "vouchers"
    sets: tuple[str, ...] = ("rgb", "cmyk")
    sheets: int | None = None
    flip: str = "h"
    font_path: str | None = None
    mono_path: str | None = None
    icc_path: str | None = None
    layout: Layout = field(default_factory=layout_mod.default_layout)
    base_url: str = DEFAULT_BASE_URL
    on_overflow: str = "error"
    zlib_level: int = 6
    front_rgb: Path | None = None
    back_rgb: Path | None = None
    front_cmyk: Path | None = None
    back_cmyk: Path | None = None
    write_manifest: bool = True
    log: object = print


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_header(cell: str) -> str:
    return re.sub(r"\s+", "", cell).lower()


def load_codes(path: Path, log=print) -> list[CodeRow]:
    """读取「兑换码,批次」CSV。

    mock 与真实导出走同一条路径：文件句柄 + csv 模块（引号内换行不会被吞），
    表头可选，逐行做格式校验与「大小写归一化后」查重，非 UTF-8 文件给出中文报错。
    """
    path = Path(path)
    if not path.exists():
        raise VoucherError(f"找不到兑换码 CSV：{path}")
    rows: list[CodeRow] = []
    seen: dict[str, int] = {}
    header_checked = False
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            for cells in reader:
                # reader.line_num 是该条记录的最后一个物理行号，报错行号与文件实际行号一致
                line = reader.line_num
                if not any(cell.strip() for cell in cells):
                    continue
                code = cells[0].strip()
                batch = cells[1].strip() if len(cells) > 1 else ""
                if not header_checked:
                    header_checked = True
                    if _normalize_header(code) in HEADER_ALIASES:
                        continue
                    log(f"提示：{path} 第一行不是可识别的表头（{code}），按无表头处理")
                normalized = code.upper()
                if not CODE_PATTERN.match(normalized):
                    raise VoucherError(
                        f"兑换码格式不正确：{path} 第 {line} 行「{code}」，{CODE_HINT}"
                    )
                if normalized in seen:
                    raise VoucherError(
                        f"兑换码重复（大小写归一化后）：{path} 第 {seen[normalized]} 行与第 {line} 行都是 {normalized}"
                    )
                seen[normalized] = line
                rows.append(CodeRow(code=normalized, batch=batch))
    except UnicodeDecodeError:
        raise VoucherError(
            f"兑换码 CSV 不是 UTF-8 编码：{path}；请用 Excel/编辑器另存为「CSV UTF-8」后重试"
        ) from None
    if not rows:
        raise VoucherError(f"兑换码 CSV 没有数据行：{path}")
    return rows


def load_quotes(path: Path) -> list[QuoteLine]:
    """读取纯文本文案清单：一行一条，空行与 # 开头的注释行忽略。"""
    path = Path(path)
    if not path.exists():
        raise VoucherError(f"找不到文案清单：{path}")
    raw = path.read_text(encoding="utf-8-sig")
    lines: list[QuoteLine] = []
    for number, text in enumerate(raw.splitlines(), start=1):
        stripped = text.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(QuoteLine(lineno=number, text=stripped))
    if not lines:
        raise VoucherError(f"文案清单为空：{path}（请每行写一条文案，不要留空文件）")
    return lines


def _first_existing(candidates) -> tuple[str, str] | None:
    for label, path in candidates:
        if Path(path).exists():
            return (label, path)
    return None


def discover_font(explicit: str | None = None) -> tuple[str, str]:
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise VoucherError(f"指定的字体不存在：{path}")
        return (path.name, str(path))
    found = _first_existing(CJK_FONT_CANDIDATES)
    if not found:
        raise VoucherError(
            "找不到可用的中文字体，请用 --font 指定一个 TTF/TTC 文件（例如 C:\\Windows\\Fonts\\msyh.ttc）"
        )
    return found


def discover_mono_font(explicit: str | None = None) -> tuple[str, str]:
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise VoucherError(f"指定的等宽字体不存在：{path}")
        return (path.name, str(path))
    found = _first_existing(MONO_FONT_CANDIDATES)
    if found:
        return found
    return discover_font(None)


def validate_quotes(quotes: list[QuoteLine], font_path: str, layout: Layout) -> list[Overflow]:
    """逐条量宽，返回溢出清单（调用方决定报错还是缩小字号）。"""
    em = layout.quote_em_mm * PX_PER_MM
    font = ImageFont.truetype(font_path, em)
    limit_w = layout.back_quote_text.width
    limit_h = layout.back_quote_text.height
    overflows: list[Overflow] = []
    for quote in quotes:
        width, height = compose.text_metrics(quote.text, font)
        if width > limit_w or height > limit_h:
            overflows.append(
                Overflow(
                    lineno=quote.lineno,
                    text=quote.text,
                    width_px=width,
                    limit_px=limit_w,
                    height_px=height,
                    height_limit_px=limit_h,
                )
            )
    return overflows


def assign_quotes(voucher_count: int, quote_count: int) -> list[int]:
    """确定性铺开：第 k 张券用 quotes[k % N]，同一输入必然得到同一输出。"""
    if quote_count <= 0:
        raise VoucherError("文案清单为空，无法铺开")
    return [index % quote_count for index in range(voucher_count)]


def sheet_quote_blocks(assignment: list[int]) -> list[list[int]]:
    return [assignment[start:start + layout_mod.SHEET_COUPONS] for start in range(0, len(assignment), layout_mod.SHEET_COUPONS)]


def plan_sheets(voucher_count: int, flip: str = "h") -> list[SheetPlan]:
    """排页：每张纸正面 2×3，背面把正面的 (c,r) 放到镜像格，保证翻面后严格对位。"""
    sheets: list[SheetPlan] = []
    total = (voucher_count + layout_mod.SHEET_COUPONS - 1) // layout_mod.SHEET_COUPONS
    for index in range(total):
        front: dict[tuple[int, int], int] = {}
        for slot in range(layout_mod.SHEET_COUPONS):
            voucher = index * layout_mod.SHEET_COUPONS + slot
            if voucher >= voucher_count:
                break
            front[(slot % layout_mod.COLS, slot // layout_mod.COLS)] = voucher
        back: dict[tuple[int, int], int] = {}
        for (col, row), voucher in front.items():
            back[layout_mod.back_slot(col, row, flip)] = voucher
        if len(set(back.values())) != len(back):
            raise VoucherError(f"第 {index + 1} 张纸背面出现重复券位，翻转映射不是双射")
        if len(back) != len(front):
            raise VoucherError(f"第 {index + 1} 张纸正反面券数不一致")
        for (col, row), voucher in front.items():
            target = layout_mod.back_slot(col, row, flip)
            if back[target] != voucher:
                raise VoucherError(f"第 {index + 1} 张纸 (c={col}, r={row}) 翻面后未落在 {target}")
        sheets.append(SheetPlan(index=index, front=front, back=back))
    return sheets


def load_base(path: Path, want: str, log=print) -> tuple[Image.Image, bytes | None]:
    """加载底图。CMYK 版按 t6 约定用 RGBA 打包（R=C、G=M、B=Y、A=K）。"""
    path = Path(path)
    if not path.exists():
        raise VoucherError(f"找不到底图：{path}")
    with Image.open(path) as image:
        icc = image.info.get("icc_profile")
        marker = str(image.info.get("ColorSpace", "") or "")
        mode = image.mode
        size = image.size
        if size != (CANVAS_W, CANVAS_H):
            raise VoucherError(
                f"底图 {path} 尺寸为 {size[0]}×{size[1]}px，契约要求 {CANVAS_W}×{CANVAS_H}px；生成器不做重采样"
            )
        if want == "RGB":
            if mode == "RGB":
                return image.copy(), icc
            if mode == "RGBA":
                raise VoucherError(f"底图 {path} 是 RGBA（CMYK 打包），不能用作 RGB 版底图")
            raise VoucherError(f"底图 {path} 的颜色模式为 {mode}，RGB 版需要 RGB")
        if mode == "CMYK":
            return image.copy(), icc
        if mode == "RGBA":
            # 底图的标记是 "CMYK-packed: R=C,G=M,B=Y,A=K"（t6 约定），按前缀识别，避免误报
            if not marker.startswith(CMYK_PACKED_MARKER):
                log(f"提示：{path} 没有 {CMYK_PACKED_MARKER} 标记，仍按 R=C/G=M/B=Y/A=K 解包")
            red, green, blue, alpha = image.split()
            return Image.merge("CMYK", (red, green, blue, alpha)), icc
        raise VoucherError(f"底图 {path} 的颜色模式为 {mode}，CMYK 版需要 CMYK 或 CMYK-packed RGBA")


def resolve_icc(explicit: str | None, assets_dir: Path, embedded: bytes | None, log=print) -> tuple[bytes, str]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(Path(assets_dir) / "icc" / f"{ICC_IDENTIFIER}.icc")
    for path in candidates:
        if path.exists():
            return path.read_bytes(), str(path)
    if embedded:
        return embedded, "CMYK 底图内嵌 ICC"
    for path in ICC_FALLBACKS:
        if path.exists():
            return path.read_bytes(), str(path)
    raise VoucherError(
        "找不到 JapanColor2001Coated 的 ICC 配置文件；请用 --icc 指定路径，"
        "或把它放到 tools/voucher/assets/icc/JapanColor2001Coated.icc"
    )


def describe_icc(profile: bytes) -> str:
    """从 ICC 头部读出色彩空间与描述，用于自检与清单记录。"""
    if len(profile) < 128:
        raise VoucherError("ICC 配置文件过短，不是有效的 ICC")
    if profile[36:40] != b"acsp":
        raise VoucherError("ICC 配置文件缺少 acsp 签名")
    space = profile[16:20].decode("latin1")
    return space


def qr_quiet_px(layout: Layout) -> dict:
    """四边静默区像素数（内容方阵到留白框边界的距离）。"""
    content = layout.front_qr_content
    quiet = layout.front_qr
    return {
        "top": content.y0 - quiet.y0,
        "bottom": quiet.y1 - content.y1,
        "left": content.x0 - quiet.x0,
        "right": quiet.x1 - content.x1,
    }


def _reference_decodes(mask_image: Image.Image, payload: str, module_px: int) -> bool:
    """用参考解码器（OpenCV，装了才用）试读候选掩码；读不出来就换下一个候选。"""
    try:
        import cv2
        import numpy
    except Exception:  # noqa: BLE001
        return True
    border = 6 * module_px
    canvas = Image.new("L", (mask_image.width + border * 2, mask_image.height + border * 2), 250)
    canvas.paste(mask_image, (border, border))
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(numpy.array(canvas))
    return decoded == payload


def render_qr_overlay(
    base: Image.Image, layout: Layout, code_text: str, base_url: str = DEFAULT_BASE_URL
) -> tuple[compose.Overlay, qr.QrCode, int, int, str]:
    """画出二维码叠加层。

    掩码策略：按惩罚函数给出候选顺序（安全掩码优先），再用参考解码器逐候选试读，
    读得出来的第一个才用；一个都读不出来时退回偏好序第一的掩码。
    """
    payload = f"{base_url.rstrip('/')}/r/{code_text}"
    content = layout.front_qr_content
    ranked = qr.rank_masks(payload, ec_level=layout.qr.ec_level, mask_policy=layout.qr.mask_policy)
    matrix = None
    mask_image = None
    module_px = 0
    chosen_mask = ranked[0]
    mask_reason = layout.qr.mask_policy
    for candidate_mask in ranked:
        candidate = qr.encode(payload, ec_level=layout.qr.ec_level, mask=candidate_mask, mask_policy=layout.qr.mask_policy)
        candidate_image, candidate_module_px, _, _ = compose.qr_mask(
            candidate.size, (content.width, content.height), 0, candidate.modules
        )
        readable = Image.new("L", candidate_image.size, 255)
        readable.paste(candidate_image.point(lambda value: 0 if value else 255), (0, 0))
        if _reference_decodes(readable, payload, candidate_module_px):
            matrix, mask_image, module_px, chosen_mask = candidate, candidate_image, candidate_module_px, candidate_mask
            mask_reason = layout.qr.mask_policy if candidate_mask == ranked[0] else "decoder-hardened"
            break
    if matrix is None:
        matrix = qr.encode(payload, ec_level=layout.qr.ec_level, mask=ranked[0], mask_policy=layout.qr.mask_policy)
        mask_image, module_px, _, _ = compose.qr_mask(matrix.size, (content.width, content.height), 0, matrix.modules)
    module_mm = module_px / PX_PER_MM
    if module_mm < layout.qr.min_module_mm:
        need = -(-((matrix.size + layout.qr.quiet_modules * 2) * layout.qr.min_module_mm * PX_PER_MM) // 1)
        raise VoucherError(
            f"兑换码 {code_text}（{len(payload)} 字节）编码为二维码 version {matrix.version}，"
            f"{content.width}px 方阵内模块只有 {module_mm:.3f}mm，低于契约要求的 {layout.qr.min_module_mm}mm；"
            f"需要把绘制方阵放大到约 {need:.0f}px 或缩短兑换码"
        )
    region = base.crop(content.box())
    flattened = 0
    if layout.qr.flatten_panel:
        region, flattened, _ = compose.flatten_panel(region, layout.qr.flatten_inset_px)
    compose.apply_ink(region, mask_image)
    overlay = compose.Overlay(name="qr", rect=content, image=region)
    return overlay, matrix, module_px, flattened, mask_reason


def render_code_overlay(base: Image.Image, layout: Layout, code_text: str, font_paths: list[str]) -> tuple[compose.Overlay, dict]:
    """明文兑换码：按实际字形宽度自适应字号。

    约束：总宽 ≤ CODE_AREA 可用宽的 code_width_ratio（96%）；文字像素外接框落在胶囊条内且四边各 ≥8px；
    字高（大写字母高度）≥ code_min_ink_mm。三条任一不满足都直接报错，不静默印小字或印出界。
    """
    pill = layout.front_code_text
    area = layout.front_code_area
    width_limit = area.width * layout.code_width_ratio
    best: tuple[float, str, ImageFont.FreeTypeFont, int, int] | None = None
    for path in font_paths:
        font, cap_px, text_width, ink_height = compose.fit_code_font(
            path, code_text, (pill.width, pill.height), width_limit, layout.code_pill_margin_px
        )
        if best is None or cap_px > best[0]:
            best = (cap_px, path, font, text_width, ink_height)
    if best is None:
        raise VoucherError("没有可用的等宽/中文字体来渲染明文兑换码")
    cap_px, path, font, text_width, ink_height = best
    min_cap_px = layout.code_min_ink_mm * PX_PER_MM
    if cap_px < min_cap_px - 0.5:
        raise VoucherError(
            f"明文兑换码 {code_text} 在 {pill.width}×{pill.height}px 的胶囊条里最多只能排到 "
            f"{cap_px / PX_PER_MM:.2f}mm 字高（大写字母高度），低于契约要求的 {layout.code_min_ink_mm}mm；请加宽胶囊条或换更窄的字体"
        )
    if text_width > width_limit + 0.5:
        raise VoucherError(
            f"明文兑换码 {code_text} 总宽 {text_width}px 超过可用宽 {width_limit:.0f}px"
            f"（CODE_AREA {area.width}px 的 {layout.code_width_ratio:.0%}）"
        )
    text_ink = compose.text_mask(code_text, font, (pill.width, pill.height), align="center")
    bbox = text_ink.getbbox()
    if bbox is None:
        raise VoucherError(f"明文兑换码 {code_text} 没有产生任何文字像素")
    margin = layout.code_pill_margin_px
    if bbox[0] < margin or bbox[1] < margin or bbox[2] > pill.width - margin or bbox[3] > pill.height - margin:
        raise VoucherError(
            f"明文兑换码 {code_text} 的文字外接框 {bbox} 未能在胶囊条 {pill.width}×{pill.height}px 内四边各留 {margin}px"
        )
    overlay = compose.overlay_from_region(base, pill, text_ink)
    overlay.name = "code"
    metrics = {
        "font": path,
        "em_px": round(font.size, 2),
        "cap_height_px": round(cap_px, 2),
        "cap_height_mm": round(cap_px / PX_PER_MM, 3),
        "text_width_px": int(text_width),
        "text_width_mm": round(text_width / PX_PER_MM, 3),
        "text_width_limit_px": int(width_limit),
        "ink_height_px": int(ink_height),
        "pill_margin_px": margin,
        "pill_px": [pill.width, pill.height],
    }
    return overlay, metrics


def render_quote_overlay(base: Image.Image, layout: Layout, quote_text: str, font_path: str, shrink_to_fit: bool = False) -> compose.Overlay:
    """玩梗行叠加层只取决于文案与底图，同一条文案在所有券上完全一致，可整轮复用。"""
    region = layout.back_quote_text
    em = layout.quote_em_mm * PX_PER_MM
    if shrink_to_fit:
        font = compose.fit_font(font_path, quote_text, (region.width, region.height), max_em_px=em, min_em_px=em * 0.7)
    else:
        font = ImageFont.truetype(font_path, em)
    ink = compose.text_mask(quote_text, font, (region.width, region.height), align="center")
    overlay = compose.overlay_from_region(base, region, ink)
    overlay.name = "quote"
    return overlay


def render_serial_overlay(base: Image.Image, layout: Layout, serial_text: str, font_mono_path: str) -> compose.Overlay:
    region = layout.front_serial_text
    font = compose.fit_font(
        font_mono_path,
        serial_text,
        (region.width, region.height),
        max_em_px=layout.serial_em_mm * PX_PER_MM,
        min_em_px=layout.serial_em_mm * PX_PER_MM * 0.7,
        padding_px=layout.serial_padding_px,
    )
    ink = compose.text_mask(serial_text, font, (region.width, region.height), align="center")
    overlay = compose.overlay_from_region(base, region, ink)
    overlay.name = "serial"
    return overlay


def _draw_list(page_height_pt: float, base_object: int, overlays: list[compose.Overlay], col: int, row: int) -> list[tuple[int, float, float, float, float]]:
    x_mm, y_mm = layout_mod.grid_position_mm(col, row)
    x_pt = mm_to_pt(x_mm)
    top_pt = page_height_pt - mm_to_pt(y_mm)
    widths_pt = mm_to_pt(COUPON_W_MM)
    heights_pt = mm_to_pt(COUPON_H_MM)
    draws: list[tuple[int, float, float, float, float]] = [(base_object, x_pt, top_pt - heights_pt, widths_pt, heights_pt)]
    for overlay in overlays:
        rect = overlay.rect
        draws.append(
            (
                overlay.object_id,
                x_pt + mm_to_pt(px_to_mm(rect.x0)),
                top_pt - mm_to_pt(px_to_mm(rect.y1)),
                mm_to_pt(px_to_mm(rect.width)),
                mm_to_pt(px_to_mm(rect.height)),
            )
        )
    return draws


def asset_paths(config: GenerateConfig) -> dict[str, Path]:
    assets = Path(config.assets_dir)
    return {
        "front_rgb": Path(config.front_rgb) if config.front_rgb else assets / "front_rgb.png",
        "back_rgb": Path(config.back_rgb) if config.back_rgb else assets / "back_rgb.png",
        "front_cmyk": Path(config.front_cmyk) if config.front_cmyk else assets / "front_cmyk.png",
        "back_cmyk": Path(config.back_cmyk) if config.back_cmyk else assets / "back_cmyk.png",
    }


def generate(config: GenerateConfig) -> Report:
    started = time.time()
    log = config.log
    layout = config.layout
    problems = layout.validate()
    if problems:
        raise VoucherError("版式自检失败：" + "；".join(problems))

    base_url = str(config.base_url or DEFAULT_BASE_URL).rstrip("/")
    parsed_url = urlparse(base_url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        raise VoucherError(f"--base-url 不是合法的 http(s) 地址：{config.base_url}")

    codes = load_codes(config.csv_path, log=log)
    quotes = load_quotes(config.quotes_path)
    quote_font_label, quote_font_path = discover_font(config.font_path)
    mono_label, mono_path = discover_mono_font(config.mono_path)

    overflows = validate_quotes(quotes, quote_font_path, layout)
    for item in overflows:
        log(("告警：" if config.on_overflow == "warn" else "错误：") + item.message())
    if overflows and config.on_overflow != "warn":
        detail = "\n".join("  " + item.message() for item in overflows)
        raise VoucherError(
            f"文案清单有 {len(overflows)} 条超出可用宽度，已停止生成：\n{detail}\n"
            f"请修改 {Path(config.quotes_path)} 后重跑（或加 --on-overflow warn 自动缩小字号）"
        )

    voucher_total = len(codes)
    voucher_count = voucher_total
    if config.sheets is not None:
        voucher_count = min(voucher_count, config.sheets * layout_mod.SHEET_COUPONS)
    assignment = assign_quotes(voucher_count, len(quotes))
    usage = Counter(assignment)
    blocks = sheet_quote_blocks(assignment)
    warnings: list[str] = []
    if len(quotes) < layout_mod.SHEET_COUPONS:
        warnings.append(
            f"文案只有 {len(quotes)} 条，少于每面 {layout_mod.SHEET_COUPONS} 张券，同一张纸上会出现重复文案（按最大值铺开）"
        )

    serials = [f"{index + 1:04d}" for index in range(voucher_count)]
    if len(set(serials)) != len(serials):
        raise VoucherError("序列号出现重复")

    sheets = plan_sheets(voucher_count, config.flip)
    paths = asset_paths(config)
    page_height_pt = mm_to_pt(PAGE_H_MM)
    page_width_pt = mm_to_pt(PAGE_W_MM)

    results: list[SetResult] = []
    manifest_pages: dict[str, list[dict]] = {}

    for set_name in config.sets:
        if set_name not in ("rgb", "cmyk"):
            raise VoucherError(f"未知输出集：{set_name}")
        want = "RGB" if set_name == "rgb" else "CMYK"
        front_base, front_icc = load_base(paths[f"front_{set_name}"], want, log)
        back_base, back_icc = load_base(paths[f"back_{set_name}"], want, log)
        writer = pdfwrite.PdfWriter(
            (page_width_pt, page_height_pt),
            title=f"ModelGate 兑换券 {set_name.upper()}",
            creator="tools/voucher/generate/make_vouchers.py",
            subject="600 张实体兑换券拼版",
        )
        writer.compression_level = config.zlib_level
        if set_name == "cmyk":
            icc_bytes, icc_origin = resolve_icc(config.icc_path, config.assets_dir, front_icc or back_icc, log)
            space = describe_icc(icc_bytes)
            if space != "CMYK":
                raise VoucherError(f"OutputIntent 的 ICC 色彩空间是 {space}，不是 CMYK：{icc_origin}")
            writer.set_output_intent(
                icc_bytes,
                ICC_IDENTIFIER,
                info=ICC_INFO,
                registry=ICC_REGISTRY,
                pdfx_version="PDF/X-1a:2003",
            )
            log(f"CMYK 版 OutputIntent：{icc_origin}（{len(icc_bytes)} 字节）")
        front_base_object = writer.add_image(front_base)
        back_base_object = writer.add_image(back_base)

        quiet_px = qr_quiet_px(layout)
        quote_cache: dict[int, compose.Overlay] = {}
        pages_detail: list[dict] = []
        for sheet in sheets:
            for side, positions in (("front", sheet.front), ("back", sheet.back)):
                base = front_base if side == "front" else back_base
                base_object = front_base_object if side == "front" else back_base_object
                draws: list[tuple[int, float, float, float, float]] = []
                slots: list[dict] = []
                for (col, row), voucher in sorted(positions.items(), key=lambda item: (item[0][1], item[0][0])):
                    code = codes[voucher].code
                    serial = serials[voucher]
                    serial_text = f"No. {serial} / {voucher_total:04d}"
                    quote_index = assignment[voucher]
                    quote_line = quotes[quote_index]
                    if side == "front":
                        qr_overlay, matrix, module_px, flattened, mask_reason = render_qr_overlay(
                            base, layout, code, base_url
                        )
                        code_overlay, code_metrics = render_code_overlay(base, layout, code, [mono_path, quote_font_path])
                        serial_overlay = render_serial_overlay(base, layout, serial_text, mono_path)
                        overlays = [qr_overlay, code_overlay, serial_overlay]
                        extra = {
                            "qr_payload": f"{base_url}/r/{code}",
                            "qr_version": matrix.version,
                            "qr_modules": matrix.size,
                            "qr_ec_level": matrix.ec_level,
                            "qr_mask": matrix.mask,
                            "qr_mask_reason": mask_reason,
                            "qr_module_px": module_px,
                            "qr_module_mm": round(module_px / PX_PER_MM, 4),
                            "qr_quiet_px": quiet_px,
                            "qr_content_rect": layout.front_qr_content.to_dict(),
                            "code_metrics": code_metrics,
                            "serial_text": serial_text,
                        }
                    else:
                        quote_overlay = quote_cache.get(quote_index)
                        if quote_overlay is None:
                            quote_overlay = render_quote_overlay(
                                base, layout, quote_line.text, quote_font_path, shrink_to_fit=bool(overflows)
                            )
                            quote_cache[quote_index] = quote_overlay
                        overlays = [quote_overlay]
                        extra = {"quote_line": quote_line.lineno, "quote": quote_line.text}
                    for overlay in overlays:
                        overlay.object_id = writer.add_image(overlay.image)
                    x_mm, y_mm = layout_mod.grid_position_mm(col, row)
                    slots.append(
                        {
                            "col": col,
                            "row": row,
                            "x_mm": round(x_mm, 6),
                            "y_mm": round(y_mm, 6),
                            "serial": serial,
                            "code": code,
                            "batch": codes[voucher].batch,
                            "objects": {overlay.name: overlay.object_id for overlay in overlays},
                            "rects": {overlay.name: overlay.rect.to_dict() for overlay in overlays},
                            "base_object": base_object,
                            **extra,
                        }
                    )
                    draws.extend(_draw_list(page_height_pt, base_object, overlays, col, row))
                page_number = writer.page_count() + 1
                writer.add_page(draws)
                pages_detail.append({"page": page_number, "sheet": sheet.index + 1, "side": side, "slots": slots})
            if (sheet.index + 1) % 10 == 0:
                log(f"  {set_name.upper()} 已排版 {sheet.index + 1}/{len(sheets)} 张纸")
        pdf_path = Path(config.out_dir) / f"{config.basename}_{set_name}.pdf"
        written = writer.save(pdf_path)
        results.append(
            SetResult(
                name=set_name,
                pdf_path=pdf_path,
                bytes_written=written,
                pages=writer.page_count(),
                unique_images=writer.unique_images,
                color_space=want,
                output_intent=bool(writer.output_intent),
            )
        )
        manifest_pages[set_name] = pages_detail
        log(f"  {set_name.upper()} 完成：{writer.page_count()} 页，{written / 1048576:.1f} MB，唯一图像对象 {writer.unique_images}")

    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "flip": config.flip,
        "base_url": base_url,
        "vouchers": voucher_count,
        "sheets": len(sheets),
        "serials": {"first": serials[0], "last": serials[-1], "unique": len(set(serials))},
        "inputs": {
            "csv": {"path": str(config.csv_path), "sha1": sha1_file(config.csv_path)},
            "quotes": {"path": str(config.quotes_path), "sha1": sha1_file(config.quotes_path), "count": len(quotes)},
            "font": {"label": quote_font_label, "path": quote_font_path, "sha1": sha1_file(Path(quote_font_path))},
            "mono_font": {"label": mono_label, "path": mono_path, "sha1": sha1_file(Path(mono_path))},
        },
        "layout": layout.to_dict(),
        "qr": {
            "quiet_box_rect": layout.front_qr.to_dict(),
            "content_rect": layout.front_qr_content.to_dict(),
            "content_px": [layout.front_qr_content.width, layout.front_qr_content.height],
            "content_center": [
                (layout.front_qr_content.x0 + layout.front_qr_content.x1) / 2,
                (layout.front_qr_content.y0 + layout.front_qr_content.y1) / 2,
            ],
            "ec_level": layout.qr.ec_level,
            "version": qr_geometry(layout, codes)[0],
            "modules": 29,
            "module_px": qr_geometry(layout, codes)[1],
            "module_mm": round(qr_geometry(layout, codes)[1] / PX_PER_MM, 4),
            "quiet_modules_required": layout.qr.quiet_modules,
            "quiet_px": qr_quiet_px(layout),
            "quiet_min_px": layout.qr.min_quiet_px,
            "note": "静默区由 r3 让出的底图平涂留白提供：上起 y478、下止 y1107（距深蓝带 y1134 有 27px）、左右各 68px",
        },
        "quote_usage": {quotes[index].lineno: count for index, count in sorted(usage.items())},
        "overflow": [item.message() for item in overflows],
        "warnings": warnings,
        "sets": {
            result.name: {
                "pdf": str(result.pdf_path),
                "bytes": result.bytes_written,
                "pages": result.pages,
                "unique_images": result.unique_images,
                "color_space": result.color_space,
                "output_intent": result.output_intent,
            }
            for result in results
        },
        "pages": manifest_pages,
    }
    manifest_path = None
    if config.write_manifest:
        manifest_path = Path(config.out_dir) / f"{config.basename}.manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    report = Report(
        codes=len(codes),
        sheets=len(sheets),
        quotes=len(quotes),
        quote_usage=usage,
        overflow=overflows,
        warnings=warnings,
        sets=results,
        manifest_path=manifest_path,
        font_path=quote_font_path,
        font_label=quote_font_label,
        mono_path=mono_path,
        qr_version=0,
        qr_module_px=0,
        elapsed_s=time.time() - started,
        manifest=manifest,
    )
    report.qr_version, report.qr_module_px = qr_geometry(layout, codes)
    return report


def qr_geometry(layout: Layout, codes: list[CodeRow]) -> tuple[int, int]:
    """按最长兑换码预估二维码版本与模块像素，用于自检与清单。"""
    longest = max(codes, key=lambda row: len(row.code))
    payload = f"https://ai.ecustcic.com/r/{longest.code}"
    matrix = qr.encode(payload, ec_level=layout.qr.ec_level)
    return matrix.version, layout.front_qr_content.width // matrix.size
