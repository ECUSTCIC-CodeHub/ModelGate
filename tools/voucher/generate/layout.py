"""兑换券版式常量与冻结坐标。

坐标系约定：券画布为 3840×1648 px，1mm = 3840/136 = 28.2352941 px（即 717.2 dpi）。
所有矩形用画布像素表示，右下角开区间；页面位置用毫米表示，原点在纸张左上角。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

PX_PER_MM = 3840 / 136
CANVAS_W = 3840
CANVAS_H = 1648
COUPON_W_MM = 136.0
COUPON_H_MM = CANVAS_H / PX_PER_MM
PAGE_W_MM = 297.0
PAGE_H_MM = 210.0
GRID_GAP_MM = 5.0
COL_X_MM = (10.0, 151.0)
ROW_Y_MM = (
    12.45,
    12.45 + COUPON_H_MM + GRID_GAP_MM,
    12.45 + 2 * (COUPON_H_MM + GRID_GAP_MM),
)
COLS = 2
ROWS = 3
SHEET_COUPONS = COLS * ROWS
MM_TO_PT = 72.0 / 25.4


def mm_to_pt(mm: float) -> float:
    return mm * MM_TO_PT


def pt_to_mm(pt: float) -> float:
    return pt / MM_TO_PT


def px_to_mm(px: float) -> float:
    return px / PX_PER_MM


def mm_to_px(mm: float) -> float:
    return mm * PX_PER_MM


@dataclass(frozen=True)
class Region:
    name: str
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    @property
    def width_mm(self) -> float:
        return px_to_mm(self.width)

    @property
    def height_mm(self) -> float:
        return px_to_mm(self.height)

    def box(self) -> tuple[int, int, int, int]:
        return (self.x0, self.y0, self.x1, self.y1)

    def shifted(self, dx: int, dy: int) -> "Region":
        return Region(self.name, self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)

    def within(self, other: "Region") -> bool:
        return self.x0 >= other.x0 and self.y0 >= other.y0 and self.x1 <= other.x1 and self.y1 <= other.y1

    def overlaps(self, other: "Region") -> bool:
        return not (self.x1 <= other.x0 or other.x1 <= self.x0 or self.y1 <= other.y0 or other.y1 <= self.y0)

    def to_dict(self) -> dict:
        return {"x0": self.x0, "y0": self.y0, "x1": self.x1, "y1": self.y1}


@dataclass
class QrSpec:
    """二维码参数（r4：纠错 M、version 3 = 29 模块、模块 19px、四边静默区 ≥4 模块）。

    静默区由底图的平涂留白提供：内容方阵外四边各留 quiet_modules 个模块的浅色区，
    r3 已把标题下沿到兑换码条之间的区域让出来，生成器不再整平底图。
    """

    quiet_modules: int = 4
    ec_level: str = "M"
    mask_policy: str = "safe"
    # 原稿面板内膛只有 639x529，不刷底的前提下模块只能到 14px（0.496mm）。
    # 0.45mm 是能扫的下限，实测 cv2 与 zbar 双引擎在 14px 下均可解码。
    min_module_mm: float = 0.45
    target_module_px: int = 14
    # 静默区不再写死像素，按 静默模块数 x 实际模块尺寸 计算
    modules: int = 29
    panel_px: int = 812
    flatten_panel: bool = False
    flatten_inset_px: int = 8

    def module_px(self, module_count: int, content_px: int) -> int:
        return content_px // module_count

    def to_dict(self) -> dict:
        return {
            "quiet_modules": self.quiet_modules,
            "ec_level": self.ec_level,
            "mask_policy": self.mask_policy,
            "min_module_mm": self.min_module_mm,
            "target_module_px": self.target_module_px,
            "modules": self.modules,
            "panel_px": self.panel_px,
            "flatten_panel": self.flatten_panel,
            "flatten_inset_px": self.flatten_inset_px,
        }


@dataclass
class Layout:
    """可变位只有四处：正面二维码、正面明文兑换码、正面序列号、背面玩梗行。

    back_fixed_left / back_fixed_right 是 t6 底图上已经写好的固定说明与规则，生成器不叠加任何东西。
    """

    front_qr: Region
    front_qr_content: Region
    front_code_bar: Region
    front_code_text: Region
    front_code_area: Region
    front_serial_band: Region
    front_serial_text: Region
    back_quote_bar: Region
    back_quote_text: Region
    back_fixed_left: Region
    back_fixed_right: Region
    qr: QrSpec = field(default_factory=QrSpec)
    quote_em_mm: float = 1.5
    serial_em_mm: float = 1.4
    # 明文码：总宽 ≤ 可用宽 CODE_AREA 的 96%，文字外接框落在胶囊条内且四边各 ≥8px。
    # 改用原稿自带的 896px 胶囊条后，14 位字高上限约 2.44mm，故下限放到 2.4mm。
    code_min_ink_mm: float = 1.85
    code_width_ratio: float = 0.96
    code_pill_margin_px: int = 8
    serial_padding_px: int = 6

    def regions(self) -> dict[str, Region]:
        return {
            "front_qr": self.front_qr,
            "front_qr_content": self.front_qr_content,
            "front_code_bar": self.front_code_bar,
            "front_code_text": self.front_code_text,
            "front_code_area": self.front_code_area,
            "front_serial_band": self.front_serial_band,
            "front_serial_text": self.front_serial_text,
            "back_quote_bar": self.back_quote_bar,
            "back_quote_text": self.back_quote_text,
            "back_fixed_left": self.back_fixed_left,
            "back_fixed_right": self.back_fixed_right,
        }

    def with_overrides(self, data: dict) -> "Layout":
        regions = self.regions()
        for key, value in (data.get("regions") or {}).items():
            if key not in regions:
                raise ValueError(f"未知区域名：{key}")
            base = regions[key]
            regions[key] = Region(key, int(value["x0"]), int(value["y0"]), int(value["x1"]), int(value["y1"]))
        qr_data = data.get("qr") or {}
        qr = QrSpec(
            quiet_modules=int(qr_data.get("quiet_modules", self.qr.quiet_modules)),
            ec_level=str(qr_data.get("ec_level", self.qr.ec_level)),
            mask_policy=str(qr_data.get("mask_policy", self.qr.mask_policy)),
            min_module_mm=float(qr_data.get("min_module_mm", self.qr.min_module_mm)),
            target_module_px=int(qr_data.get("target_module_px", self.qr.target_module_px)),
            modules=int(qr_data.get("modules", self.qr.modules)),
            panel_px=int(qr_data.get("panel_px", self.qr.panel_px)),
            flatten_panel=bool(qr_data.get("flatten_panel", self.qr.flatten_panel)),
            flatten_inset_px=int(qr_data.get("flatten_inset_px", self.qr.flatten_inset_px)),
        )
        return Layout(
            **regions,
            qr=qr,
            quote_em_mm=float(data.get("quote_em_mm", self.quote_em_mm)),
            serial_em_mm=float(data.get("serial_em_mm", self.serial_em_mm)),
            code_min_ink_mm=float(data.get("code_min_ink_mm", self.code_min_ink_mm)),
            code_width_ratio=float(data.get("code_width_ratio", self.code_width_ratio)),
            code_pill_margin_px=int(data.get("code_pill_margin_px", self.code_pill_margin_px)),
            serial_padding_px=int(data.get("serial_padding_px", self.serial_padding_px)),
        )

    def to_dict(self) -> dict:
        return {
            "px_per_mm": PX_PER_MM,
            "canvas": [CANVAS_W, CANVAS_H],
            "coupon_mm": [COUPON_W_MM, COUPON_H_MM],
            "page_mm": [PAGE_W_MM, PAGE_H_MM],
            "col_x_mm": list(COL_X_MM),
            "row_y_mm": list(ROW_Y_MM),
            "regions": {name: region.to_dict() for name, region in self.regions().items()},
            "qr": self.qr.to_dict(),
            "quote_em_mm": self.quote_em_mm,
            "serial_em_mm": self.serial_em_mm,
            "code_min_ink_mm": self.code_min_ink_mm,
            "code_width_ratio": self.code_width_ratio,
            "code_pill_margin_px": self.code_pill_margin_px,
        }

    def validate(self) -> list[str]:
        """返回几何告警列表；跨区域冲突属于致命错误，调用方应终止。"""
        problems: list[str] = []
        if not self.front_qr_content.within(self.front_qr):
            problems.append("二维码实际绘制方阵必须落在冻结预留区内")
        for name, region in self.regions().items():
            if region.x0 < 0 or region.y0 < 0 or region.x1 > CANVAS_W or region.y1 > CANVAS_H:
                problems.append(f"区域 {name} 超出券画布：{region.box()}")
            if region.width <= 0 or region.height <= 0:
                problems.append(f"区域 {name} 尺寸非正：{region.box()}")
        if not self.front_code_text.within(self.front_code_bar):
            problems.append("兑换码文本可用区必须落在兑换码白条内")
        if not self.front_code_area.within(self.front_code_text):
            problems.append("兑换码可用排版区必须落在胶囊条内")
        if not self.front_serial_text.within(self.front_serial_band):
            problems.append("序列号文本区必须落在正面左下横带内")
        if self.front_qr_content.overlaps(self.front_code_bar):
            problems.append("二维码绘制方阵与兑换码白条重叠")
        if self.front_qr_content.overlaps(self.front_serial_band):
            problems.append("二维码绘制方阵与正面序列号横带重叠")
        if self.front_qr_content.overlaps(self.back_quote_bar):
            problems.append("二维码绘制方阵与背面元素重叠")
        if not self.back_quote_text.within(self.back_quote_bar):
            problems.append("玩梗文本区必须落在背面顶部横幅第 2 行内")
        if abs(self.front_qr_content.width - self.front_qr_content.height) > 1:
            problems.append(
                f"二维码内容方阵必须接近正方形：{self.front_qr_content.width}×{self.front_qr_content.height}"
            )
        margins = {
            "上": self.front_qr_content.y0 - self.front_qr.y0,
            "下": self.front_qr.y1 - self.front_qr_content.y1,
            "左": self.front_qr_content.x0 - self.front_qr.x0,
            "右": self.front_qr.x1 - self.front_qr_content.x1,
        }
        module_px = self.front_qr_content.width // self.qr.modules
        need_quiet = self.qr.quiet_modules * module_px
        for label, margin in margins.items():
            if margin < need_quiet:
                problems.append(
                    f"二维码{label}静默区 {margin}px 小于 {self.qr.quiet_modules} 模块要求的 {need_quiet}px"
                    f"（模块 {module_px}px）"
                )
        if self.front_qr.y1 >= self.front_code_text.y0:
            problems.append(
                f"二维码下静默区止于 y{self.front_qr.y1}，已碰到兑换码胶囊条 y{self.front_code_text.y0}"
            )
        return problems


def default_layout() -> Layout:
    """冻结坐标（captain 修订版）：四处可变位，其余文字由 t6 底图写死。"""
    return Layout(
        # 二维码整体（含 4 模块静默区）：直接落在原稿面板内膛正中，不做任何平涂。
        # 原稿面板内膛实测 (2760,500)-(3399,1029) 共 639x529；518x518 居中于 (3079,764)。
        front_qr=Region("front_qr", 2806, 534, 3324, 1052),
        # 内容方阵：29 模块 × 14px = 406px，四边各 56px = 4 模块静默区
        front_qr_content=Region("front_qr_content", 2862, 590, 3268, 996),
        # 兑换码：沿用原稿自带的深蓝标签带与米色胶囊条，不重绘
        front_code_bar=Region("front_code_bar", 2604, 1134, 3500, 1314),
        front_code_text=Region("front_code_text", 2716, 1183, 3405, 1277),
        front_code_area=Region("front_code_area", 2724, 1189, 3397, 1271),
        # 序列号：沿用原稿左下铭牌
        front_serial_band=Region("front_serial_band", 440, 1440, 1106, 1558),
        front_serial_text=Region("front_serial_text", 452, 1452, 1094, 1546),
        # 背面顶部横幅：第 1 行标题（t6 固定），第 2 行玩梗留给生成器
        back_quote_bar=Region("back_quote_bar", 1456, 128, 2400, 272),
        back_quote_text=Region("back_quote_text", 1466, 206, 2390, 260),
        # t6 固定文案区：只用于版式自检，生成器不叠加
        back_fixed_left=Region("back_fixed_left", 480, 1200, 1584, 1424),
        back_fixed_right=Region("back_fixed_right", 2256, 1200, 3360, 1424),
    )


def load_layout(path: "str | Path | None") -> Layout:
    layout = default_layout()
    if path:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        layout = layout.with_overrides(data)
    return layout


def grid_position_mm(col: int, row: int) -> tuple[float, float]:
    return (COL_X_MM[col], ROW_Y_MM[row])


def mirrored_column(col: int) -> int:
    """左右翻转：正面 (c,r) 的券，背面画在 (COLS-1-c, r)。"""
    return COLS - 1 - col


def mirrored_row(row: int) -> int:
    """上下翻转：正面 (c,r) 的券，背面画在 (c, ROWS-1-r)。"""
    return ROWS - 1 - row


def back_slot(col: int, row: int, flip: str = "h") -> tuple[int, int]:
    if flip == "h":
        return (mirrored_column(col), row)
    if flip == "v":
        return (col, mirrored_row(row))
    raise ValueError("翻转模式必须是 h（左右）或 v（上下）")
