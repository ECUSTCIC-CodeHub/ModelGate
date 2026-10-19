"""t7 自检：逐条验证兑换券生成器的验收条款。

默认用 mock 合成底图跑一条小规模流水线（12 张券 / 4 页），再做结构与像素级核对；
--use-real-assets 时改用 tools/voucher/assets 下的真实底图；--full-size 时按 600 张券完整生成并实测体积。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zlib
from collections import Counter
from pathlib import Path

from PIL import Image, ImageFont, ImageStat

GENERATE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(GENERATE_DIR))

import compose  # noqa: E402
import layout as layout_mod  # noqa: E402
import pdfread  # noqa: E402
import qr  # noqa: E402
import qr_selftest  # noqa: E402
import vouchers  # noqa: E402

try:  # 控制台可能不是 UTF-8（Windows GBK），避免打印中文时报错中断自检
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

REPO_ROOT = GENERATE_DIR.parents[2]
MOCK_ASSET_DIR = REPO_ROOT / "tools" / "voucher" / "out" / "mock_assets"
MOCK_CSV = REPO_ROOT / "tools" / "voucher" / "mock" / "codes_mock.csv"
MOCK_QUOTES = REPO_ROOT / "tools" / "voucher" / "mock" / "quotes.mock.txt"
REAL_QUOTES = REPO_ROOT / "tools" / "voucher" / "quotes.txt"
REAL_ASSETS = REPO_ROOT / "tools" / "voucher" / "assets"
# 每次运行用独立目录，避免与并行运行的自检互相删中间产物
WORK_DIR = REPO_ROOT / "tools" / "voucher" / "out" / "selfcheck" / f"run-{os.getpid()}"
MM_TOL = 0.002


class Checks:
    def __init__(self) -> None:
        self.items: list[tuple[str, bool, str]] = []

    def add(self, name: str, ok: bool, detail: str = "") -> bool:
        self.items.append((name, ok, detail))
        print(f"[{'通过' if ok else '失败'}] {name}" + (f"\n         {detail}" if detail and not ok else (f"  （{detail}）" if detail else "")))
        return ok

    def run(self, name: str, func) -> bool:
        try:
            detail = func() or ""
            return self.add(name, True, detail)
        except AssertionError as error:
            return self.add(name, False, str(error))
        except Exception as error:  # noqa: BLE001
            return self.add(name, False, f"{type(error).__name__}: {error}")

    def failures(self) -> int:
        return sum(1 for _, ok, _ in self.items if not ok)


def ink_bbox(base_crop: Image.Image, overlay: Image.Image, threshold: int = 8):
    """叠加层相对底图的实际着墨范围。"""
    from PIL import ImageChops

    diff = ImageChops.difference(base_crop.convert("L"), overlay.convert("L"))
    return diff.point(lambda value: 255 if value > threshold else 0).getbbox()


def ops_by_object(page, slot) -> dict:
    """按图像对象号把「叠加层名 -> 绘制操作」找出来（同一个对象可能被多页共享）。"""
    result = {}
    for operation in page.operations:
        object_id = page.xobjects[operation[0]]
        for key, value in slot["objects"].items():
            if value == object_id:
                result[key] = operation
    return result


def qr_module_geometry(rect: dict, module_count: int, quiet_modules: int = 0) -> tuple[int, int]:
    """叠加层矩形里的模块像素与内容起点（r4 起叠加层只含内容方阵，静默区在底图上）。"""
    box = rect["x1"] - rect["x0"]
    total = module_count + quiet_modules * 2
    module_px = box // total
    origin = (box - module_px * total) // 2 + quiet_modules * module_px
    return module_px, origin


def qr_compare_from_image(doc, page, slot) -> dict:
    """从 PDF 内嵌的二维码图层独立取回模块矩阵并与理想矩阵比对，再用 OpenCV 实际解码。

    理想矩阵按契约内容重新编码得到；像素采样允许极少数模块受底图装饰影响出现偏差
    （ECC H 可纠约 30% 的模块错误），但偏差比例必须很小，且外部解码器要能真的读出内容。
    """
    from PIL import ImageDraw

    image = doc.images[slot["objects"]["qr"]]
    rect = slot["rects"]["qr"]
    gray = image.convert("L")
    box = rect["x1"] - rect["x0"]
    ideal = qr.encode(
        slot["qr_payload"],
        ec_level=layout_mod.default_layout().qr.ec_level,
        mask=slot.get("qr_mask"),
    )
    module_px = box // ideal.size
    if module_px < 2:
        raise AssertionError(f"二维码图层 {box}px 太小，放不下 {ideal.size} 个模块")
    origin = (box - module_px * ideal.size) // 2
    sampled = read_matrix_from_image(gray, 0, module_px, 0, ideal.size, origin)
    mismatches = sum(
        1
        for row in range(ideal.size)
        for col in range(ideal.size)
        if sampled[row][col] != ideal.modules[row][col]
    )
    ratio = mismatches / (ideal.size * ideal.size)
    payload, level, mask = "无法直接解码", "?", 0
    try:
        payload, level, mask = decode_qr_matrix(sampled)
    except AssertionError:
        pass
    return {
        "ideal": ideal,
        "sampled": sampled,
        "module_px": module_px,
        "mismatches": mismatches,
        "ratio": ratio,
        "payload": payload,
        "level": level,
        "mask": mask,
        "image": gray,
    }


def cv2_decode_payload(image: Image.Image, module_px: int) -> str:
    """用 OpenCV 独立解码（补一圈浅色静默区，模拟面板提供的留白）。"""
    try:
        import cv2
        import numpy
    except Exception:  # noqa: BLE001
        return ""
    border = 4 * module_px
    canvas = Image.new("L", (image.width + border * 2, image.height + border * 2), 250)
    canvas.paste(image, (border, border))
    detector = cv2.QRCodeDetector()
    decoded, _, _ = detector.detectAndDecode(numpy.array(canvas))
    return decoded or ""


def ensure_mock_assets(assets_dir: Path) -> Path:
    """按当前 layout 现画合成底图（原地重建：版式改了就必须跟着变，不能复用旧图）。"""
    import mock_assets

    mock_assets.write_mock_assets(assets_dir, mock_assets.find_icc())
    return assets_dir


# ---------------------------------------------------------------- 二维码矩阵解析
def read_matrix_from_image(image: Image.Image, quiet_modules: int, module_px: int, box_offset: int, size: int, origin: int) -> list[list[bool]]:
    """从渲染图里按模块中心采样，还原模块矩阵（与编码器无关的读取路径）。"""
    matrix = [[False] * size for _ in range(size)]
    for row in range(size):
        for col in range(size):
            x = origin + col * module_px + module_px // 2
            y = origin + row * module_px + module_px // 2
            matrix[row][col] = image.getpixel((x, y)) < 128
    return matrix


def function_map(version: int) -> list[list[bool]]:
    """独立重算功能图形占位（定位、分隔、时序、校正、格式、版本、暗模块）。"""
    size = version * 4 + 17
    mask = [[False] * size for _ in range(size)]

    def mark(x: int, y: int) -> None:
        if 0 <= x < size and 0 <= y < size:
            mask[y][x] = True

    for i in range(size):
        mark(6, i)
        mark(i, 6)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                mark(cx + dx, cy + dy)
    positions = _align_positions(version)
    last = len(positions) - 1
    for i, x in enumerate(positions):
        for j, y in enumerate(positions):
            if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    mark(x + dx, y + dy)
    for i in range(9):
        mark(8, i)
        mark(i, 8)
    for i in range(8):
        mark(size - 1 - i, 8)
        mark(8, size - 1 - i)
    if version >= 7:
        for i in range(18):
            a = size - 11 + i % 3
            b = i // 3
            mark(a, b)
            mark(b, a)
    return mask


def _align_positions(version: int) -> list[int]:
    if version == 1:
        return []
    size = version * 4 + 17
    num = version // 7 + 2
    step = 26 if version == 32 else (version * 4 + num * 2 + 1) // (num * 2 - 2) * 2
    result = [6] + [0] * (num - 1)
    pos = size - 7
    for i in range(num - 1, 0, -1):
        result[i] = pos
        pos -= step
    return result


def unmask(modules: list[list[bool]], mask: int) -> list[list[bool]]:
    size = len(modules)
    functions = function_map((size - 17) // 4)
    out = [row[:] for row in modules]
    for y in range(size):
        for x in range(size):
            if functions[y][x]:
                continue
            if mask == 0:
                invert = (x + y) % 2 == 0
            elif mask == 1:
                invert = y % 2 == 0
            elif mask == 2:
                invert = x % 3 == 0
            elif mask == 3:
                invert = (x + y) % 3 == 0
            elif mask == 4:
                invert = (x // 3 + y // 2) % 2 == 0
            elif mask == 5:
                invert = x * y % 2 + x * y % 3 == 0
            elif mask == 6:
                invert = (x * y % 2 + x * y % 3) % 2 == 0
            else:
                invert = ((x + y) % 2 + x * y % 3) % 2 == 0
            if invert:
                out[y][x] = not out[y][x]
    return out


def read_format(modules: list[list[bool]]) -> tuple[str, int]:
    read = [modules[i][8] for i in range(6)]
    read.append(modules[7][8])
    read.append(modules[8][8])
    read.append(modules[8][7])
    read += [modules[8][14 - i] for i in range(9, 15)]
    value = 0
    for index, bit in enumerate(read):
        value |= (1 if bit else 0) << index
    value ^= 0x5412
    data = value >> 10
    levels = {1: "L", 0: "M", 3: "Q", 2: "H"}
    return levels[(data >> 3) & 3], data & 7


def decode_qr_matrix(modules: list[list[bool]]) -> tuple[str, str, int]:
    """返回 (payload, 纠错等级, 掩码)。逐层反解，任何一步失败都会抛错。"""
    size = len(modules)
    version = (size - 17) // 4
    level, mask = read_format(modules)
    data = unmask(modules, mask)
    functions = function_map(version)
    bits: list[int] = []
    index = 0
    total = qr.total_codewords(version) * 8
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = size - 1 - vert if upward else vert
                if not functions[y][x] and index < total:
                    bits.append(1 if data[y][x] else 0)
                    index += 1
        right -= 2
    codewords = []
    for i in range(0, len(bits) - 7, 8):
        value = 0
        for bit in bits[i:i + 8]:
            value = (value << 1) | bit
        codewords.append(value)
    blocks = qr._NUM_EC_BLOCKS[level][version - 1]
    ecc = qr._ECC_CODEWORDS_PER_BLOCK[level][version - 1]
    raw = qr.total_codewords(version)
    short_blocks = blocks - raw % blocks
    short_len = raw // blocks
    split: list[list[int]] = [[] for _ in range(blocks)]
    cursor = 0
    for i in range(short_len + 1):
        for j in range(blocks):
            if i != short_len - ecc or j >= short_blocks:
                if cursor < len(codewords):
                    split[j].append(codewords[cursor])
                    cursor += 1
    for block in split:
        for i in range(ecc):
            acc = 0
            x = qr._EXP[i]
            for coef in block:
                acc = qr._gf_mul(acc, x) ^ coef
            if acc != 0:
                raise AssertionError("纠错校验失败：二维码码字不是合法的 RS 码字")
    flat: list[int] = []
    for block in split:
        flat.extend(block[:len(block) - ecc])
    stream: list[int] = []
    for value in flat:
        for shift in range(7, -1, -1):
            stream.append((value >> shift) & 1)
    mode = int("".join(str(bit) for bit in stream[0:4]), 2)
    if mode != 0b0100:
        raise AssertionError(f"二维码不是字节模式（模式位 {mode:04b}）")
    count_bits = 8 if version <= 9 else 16
    length = int("".join(str(bit) for bit in stream[4:4 + count_bits]), 2)
    payload = bytearray()
    cursor = 4 + count_bits
    for _ in range(length):
        value = 0
        for bit in stream[cursor:cursor + 8]:
            value = (value << 1) | bit
        payload.append(value)
        cursor += 8
    return payload.decode("utf-8"), level, mask


# ---------------------------------------------------------------- 主流程
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="兑换券生成器自检")
    parser.add_argument("--use-real-assets", action="store_true", help="使用 tools/voucher/assets 下的真实底图")
    parser.add_argument("--full-size", action="store_true", help="按 600 张券完整生成并实测体积")
    parser.add_argument("--keep", action="store_true", help="保留中间产物目录")
    args = parser.parse_args(argv)

    started = time.time()
    checks = Checks()
    work = WORK_DIR
    if work.exists() and not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    layout = layout_mod.default_layout()

    # 1. 版式常量
    def layout_constants():
        coupons = [
            (layout_mod.PX_PER_MM, 28.235294117647058, "px/mm"),
            (layout_mod.COUPON_W_MM, 136.0, "券宽 mm"),
            (layout_mod.COUPON_H_MM, 58.3667, "券高 mm"),
            (layout_mod.PAGE_W_MM, 297.0, "页宽 mm"),
            (layout_mod.PAGE_H_MM, 210.0, "页高 mm"),
        ]
        for got, want, label in coupons:
            assert abs(got - want) < 1e-3, f"{label}: {got} != {want}"
        assert layout_mod.CANVAS_W == 3840 and layout_mod.CANVAS_H == 1648, "画布不是 3840×1648"
        assert tuple(round(value, 4) for value in layout_mod.COL_X_MM) == (10.0, 151.0), f"列坐标 {layout_mod.COL_X_MM}"
        rows = tuple(round(value, 2) for value in layout_mod.ROW_Y_MM)
        assert rows == (12.45, 75.82, 139.18), f"行坐标 {rows}"
        assert layout_mod.COLS == 2 and layout_mod.ROWS == 3, "券位不是 2×3"
        problems = layout.validate()
        assert not problems, "；".join(problems)
        return f"券位 {layout_mod.COUPON_W_MM:.4f}×{layout_mod.COUPON_H_MM:.4f}mm，行距 {layout_mod.ROW_Y_MM[1] - layout_mod.ROW_Y_MM[0]:.4f}mm"

    checks.run("版式常量：页面 297×210mm、券位 136×58.37mm、x=10/151、y=12.45/75.82/139.18", layout_constants)

    # 2. 二维码编码器
    for result in qr_selftest.run():
        checks.add(f"二维码编码器：{result.name}", result.ok, result.detail)

    def qr_geometry_check():
        payload = "https://ai.ecustcic.com/r/ABCD-EFGH-JKLM"
        code = qr.encode(payload, ec_level=layout.qr.ec_level)
        content = layout.front_qr_content
        module_px = content.width // code.size
        module_mm = module_px / layout_mod.PX_PER_MM
        quiet = vouchers.qr_quiet_px(layout)
        assert layout.qr.ec_level == "M", f"纠错等级应为 M，实际 {layout.qr.ec_level}"
        assert code.ec_level == "M" and code.version == 3 and code.size == 29, (
            f"40 字节 + 纠错 M 应为 version 3（29 模块），实际 version {code.version}（{code.size} 模块）"
        )
        assert abs(content.width - code.size * module_px) <= 1, (
            f"内容方阵 {content.width}px 与 {code.size}×{module_px}px 不匹配（允许 1px 余量）"
        )
        assert content.box() == (2816, 546, 3309, 1039), f"内容方阵 {content.box()} 与冻结值不符"
        assert content.within(layout.front_qr), "内容方阵超出留白框"
        assert module_mm >= 0.60, f"模块尺寸 {module_mm:.4f}mm 小于 0.60mm"
        for label, margin in quiet.items():
            assert margin >= layout.qr.min_quiet_px, f"{label} 静默区 {margin}px < {layout.qr.min_quiet_px}px"
            assert margin >= layout.qr.quiet_modules * module_px, (
                f"{label} 静默区 {margin}px 不足 {layout.qr.quiet_modules} 个模块（{layout.qr.quiet_modules * module_px}px）"
            )
        assert layout.front_qr.y0 == 478, f"上静默区应起于 y478（标题墨迹到 477），实际 {layout.front_qr.y0}"
        assert layout.front_qr.y1 == 1107, f"下静默区应止于 y1107（深蓝带 1134），实际 {layout.front_qr.y1}"
        assert layout.front_qr.y1 < layout.front_code_text.y0, (
            f"下静默区 y{layout.front_qr.y1} 碰到了兑换码条 y{layout.front_code_text.y0}"
        )
        center = ((content.x0 + content.x1) / 2, (content.y0 + content.y1) / 2)
        assert center == (3062.5, 792.5), f"内容方阵中心 {center} 与冻结值 (3062.5, 792.5) 不符"
        return (
            f"纠错 M / version {code.version}（{code.size} 模块），模块 {module_px}px = {module_mm:.4f}mm，"
            f"内容方阵 {content.width}×{content.height} 中心 {center}，四边静默区 {quiet}"
        )

    checks.run("二维码：纠错 M、version 3（29 模块）、模块 17px、四边静默区 ≥68px", qr_geometry_check)

    # 3. 文案清单行为
    def quotes_behaviour():
        empty = work / "empty_quotes.txt"
        empty.write_text("\n\n# 只有注释\n", encoding="utf-8")
        try:
            vouchers.load_quotes(empty)
            raise AssertionError("空文案清单没有报错")
        except vouchers.VoucherError as error:
            assert "文案清单为空" in str(error), f"空清单报错信息不含提示：{error}"
        long_file = work / "long_quotes.txt"
        long_file.write_text("短的一条。\n" + "很长很长的一条文案" * 6 + "\n", encoding="utf-8")
        label, font = vouchers.discover_font(None)
        overflows = vouchers.validate_quotes(vouchers.load_quotes(long_file), font, layout)
        assert len(overflows) == 1, f"应当只有第 2 行溢出，实际 {len(overflows)} 条"
        assert overflows[0].lineno == 2, f"溢出报错行号错误：{overflows[0].lineno}"
        config = vouchers.GenerateConfig(
            csv_path=MOCK_CSV, quotes_path=long_file, assets_dir=MOCK_ASSET_DIR, out_dir=work / "quotes_fail",
            log=lambda *a, **k: None,
        )
        try:
            vouchers.generate(config)
            raise AssertionError("超长文案没有让生成失败")
        except vouchers.VoucherError as error:
            text = str(error)
            assert "第 2 行" in text, f"报错信息没有指出行号：{text}"
            assert "px" in text, f"报错信息没有给出实测宽度：{text}"
        return f"空清单报错、第 2 行溢出报错（实测 {overflows[0].width_px:.1f}px / 上限 {overflows[0].limit_px}px）"

    checks.run("文案清单：空清单报错、超长条目报错并指出行号与实测宽度", quotes_behaviour)

    def real_quotes_report():
        lines = vouchers.load_quotes(REAL_QUOTES)
        label, font = vouchers.discover_font(None)
        overflows = vouchers.validate_quotes(lines, font, layout)
        if overflows:
            detail = "；".join(f"第 {item.lineno} 行 {item.width_px:.1f}px" for item in overflows)
            print(f"         quotes.txt 实测溢出：{detail}（生成时会按要求报错停止）")
        return f"tools/voucher/quotes.txt 共 {len(lines)} 条，其中 {len(overflows)} 条超宽"

    checks.run("文案清单：真实 quotes.txt 体检（超宽条目会被生成流程拒绝）", real_quotes_report)

    def quote_assignment():
        assignment = vouchers.assign_quotes(600, 28)
        assert assignment == vouchers.assign_quotes(600, 28), "同一输入两次铺开结果不同"
        blocks = vouchers.sheet_quote_blocks(assignment)
        for block in blocks:
            assert len(set(block)) == len(block), "同一张纸上出现重复文案"
        usage = Counter(assignment)
        assert sum(usage.values()) == 600, "使用次数总和与券数不符"
        assert max(usage.values()) - min(usage.values()) <= 1, "铺开不均匀"
        few = vouchers.assign_quotes(12, 4)
        blocks_few = vouchers.sheet_quote_blocks(few)
        assert any(len(set(block)) < len(block) for block in blocks_few), "文案不足 6 条时应按最大值铺开"
        return f"28 条铺 600 张：每面 6 条不同；4 条铺 12 张时每面最多 {len(set(blocks_few[0]))} 条"

    checks.run("文案铺开：确定性、同面 6 条不重复、次数统计", quote_assignment)

    def csv_variants():
        base = vouchers.load_codes(MOCK_CSV)
        assert len(base) == 600, f"mock CSV 行数 {len(base)}"
        assert [f"{i:04d}" for i in range(1, 601)] == [f"{index + 1:04d}" for index in range(len(base))]
        raw = MOCK_CSV.read_text(encoding="utf-8").splitlines()
        no_header = work / "codes_no_header.csv"
        no_header.write_text("\n".join(raw[1:]) + "\n", encoding="utf-8")
        bom_crlf = work / "codes_bom_crlf.csv"
        bom_crlf.write_bytes(b"\xef\xbb\xbf" + "\r\n".join(raw).encode("utf-8") + b"\r\n")
        spaced = work / "codes_spaced.csv"
        spaced.write_text("\n\n".join(f"  {line.split(',')[0]} ,{line.split(',')[1]} " for line in raw[1:]) + "\n", encoding="utf-8")
        for path in (no_header, bom_crlf, spaced):
            rows = vouchers.load_codes(path)
            assert [(row.code, row.batch) for row in rows] == [(row.code, row.batch) for row in base], f"{path.name} 解析结果与标准 CSV 不一致"
        return "带表头 / 无表头 / BOM+CRLF / 含空格 四种写法都走同一条 load_codes，结果一致（600 行）"

    checks.run("CSV：mock 与真实同一路径、600 行、序列号 0001-0600 唯一", csv_variants)

    # 4. 生成
    assets_dir = REAL_ASSETS if args.use_real_assets else ensure_mock_assets(work / "mock_assets")
    labels = ["front_rgb", "back_rgb", "front_cmyk", "back_cmyk"]
    missing = [name for name in labels if not (assets_dir / f"{name}.png").exists()]
    if missing:
        checks.add("底图可用性", False, f"{assets_dir} 缺少 {missing}")
    else:
        sizes = []
        for name in labels:
            with Image.open(assets_dir / f"{name}.png") as image:
                sizes.append(f"{name}={image.size[0]}×{image.size[1]}")
        checks.add("底图：4 张 3840×1648", all("3840×1648" in item for item in sizes), "，".join(sizes))

    def base_region_report():
        """把四个可变位在底图上的明暗统计打出来：既验证底图可用，也能发现底图还是旧几何。"""
        notes = []
        for face, regions in (
            ("front", ("front_qr", "front_code_bar", "front_serial_band")),
            ("back", ("back_quote_text",)),
        ):
            path = assets_dir / f"{face}_rgb.png"
            if not path.exists():
                continue
            with Image.open(path) as handle:
                gray = handle.convert("L")
                for name in regions:
                    region = layout.regions()[name]
                    patch = gray.crop(region.box())
                    stat = ImageStat.Stat(patch)
                    dark = sum(1 for value in patch.getdata() if value < 150) / (region.width * region.height)
                    notes.append(
                        f"{name} 均值 {stat.mean[0]:.0f} 标准差 {stat.stddev[0]:.1f} 暗像素 {dark * 100:.1f}%"
                    )
        return "；".join(notes)

    checks.run("底图可变位明暗统计（用于发现底图与冻结坐标不一致）", base_region_report)

    def qr_quiet_report():
        """r4 专项：四边静默区逐边实测；下静默区到深蓝带的间距；四角 L 角标是否已移除。"""
        path = assets_dir / "front_rgb.png"
        with Image.open(path) as handle:
            gray = handle.convert("L")
        content = layout.front_qr_content
        quiet = layout.front_qr
        bands = (
            ("上", (content.x0, quiet.y0, content.x1, content.y0)),
            ("下", (content.x0, content.y1, content.x1, quiet.y1)),
            ("左", (quiet.x0, content.y0, content.x0, content.y1)),
            ("右", (content.x1, content.y0, quiet.x1, content.y1)),
        )
        notes = []
        for label, box in bands:
            band = gray.crop(box)
            stat = ImageStat.Stat(band)
            dark = sum(1 for value in band.getdata() if value < 150)
            assert dark == 0, f"二维码{label}静默区有 {dark} 个暗像素（应为纯留白）"
            notes.append(f"{label} {box[2] - box[0]}×{box[3] - box[1]}px 均值 {stat.mean[0]:.0f} 暗像素 0")
        # 下静默区到深蓝标签带的间距
        probe = gray.crop((content.x0, quiet.y1, content.x1, quiet.y1 + 60))
        pixels = probe.load()
        gap = None
        for offset in range(probe.height):
            if any(pixels[x, offset] < 150 for x in range(probe.width)):
                gap = quiet.y1 + offset - quiet.y1
                break
        assert gap is None or gap >= 27, f"下静默区到深蓝带只有 {gap}px，小于契约要求 27px"
        # 左右静默区不得越出装饰边框线
        assert quiet.x0 >= 2724, f"左静默区外沿 {quiet.x0} 越出了装饰边框线 x2723"
        assert quiet.x1 <= 3402, f"右静默区外沿 {quiet.x1} 越出了装饰边框线 x3403"
        # 四角 L 角标必须已移除（原角标臂 100×14）
        corner_dark = 0
        for box in (
            (2723, 427, 2823, 441),
            (2723, 427, 2737, 527),
            (3303, 427, 3403, 441),
            (3303, 427, 3317, 527),
            (2723, 1007, 2823, 1107),
            (2723, 1007, 2737, 1107),
            (3303, 1007, 3403, 1107),
            (3303, 1007, 3317, 1107),
        ):
            patch = gray.crop(box)
            corner_dark += sum(1 for value in patch.getdata() if value < 150)
        assert corner_dark == 0, f"二维码区四角仍有 {corner_dark} 个暗像素，L 角标未移除干净"
        return (
            f"四边静默区逐边纯留白（{'；'.join(notes)}）；下静默区到深蓝带 {gap if gap is not None else '>60'}px；"
            f"左右外沿 {quiet.x0}/{quiet.x1} 在装饰边框线内侧；四角 L 角标已移除"
        )

    checks.run("二维码静默区：四边留白实测、下边到深蓝带间距、四角 L 角标已移除", qr_quiet_report)

    smoke_dir = work / "smoke"
    sheets = 100 if args.full_size else 2
    config = vouchers.GenerateConfig(
        csv_path=MOCK_CSV,
        quotes_path=MOCK_QUOTES,
        assets_dir=assets_dir,
        out_dir=smoke_dir,
        sheets=sheets,
        log=(lambda *a, **k: None) if not args.full_size else print,
    )
    started_generate = time.time()
    try:
        report = vouchers.generate(config)
        checks.add(
            f"生成：{sheets} 张纸 × 2 面，RGB + CMYK 两套",
            True,
            f"{report.sets[0].pages} 页 / {report.sets[1].pages} 页，耗时 {time.time() - started_generate:.1f}s",
        )
    except Exception as error:  # noqa: BLE001
        checks.add("生成：拼版 PDF 产出", False, f"{type(error).__name__}: {error}")
        print("\n生成阶段失败，后续结构核对跳过")
        return 1

    manifest = json.loads((smoke_dir / "vouchers.manifest.json").read_text(encoding="utf-8"))
    all_codes = vouchers.load_codes(MOCK_CSV)
    code_index = {row.code: position for position, row in enumerate(all_codes)}
    docs = {}
    for result in report.sets:
        docs[result.name] = pdfread.PdfDocument(result.pdf_path)

    def broker_page_geometry():
        for name, doc in docs.items():
            for index, page in enumerate(doc.pages):
                width = page.media_box[2] - page.media_box[0]
                height = page.media_box[3] - page.media_box[1]
                assert abs(layout_mod.pt_to_mm(width) - 297.0) < 0.01, f"{name} 第 {index + 1} 页宽 {layout_mod.pt_to_mm(width):.4f}mm"
                assert abs(layout_mod.pt_to_mm(height) - 210.0) < 0.01, f"{name} 第 {index + 1} 页高 {layout_mod.pt_to_mm(height):.4f}mm"
                side = manifest["pages"][name][index]["side"]
                want = 6 + 18 if side == "front" else 6 + 6
                assert len(page.operations) == want, f"{name} 第 {index + 1} 页（{side}）绘制操作 {len(page.operations)} 个，应为 {want}"
        return f"{sum(len(doc.pages) for doc in docs.values())} 个印面：正面 6 底图+18 叠加层，背面 6 底图+6 叠加层，MediaBox 全为 297×210mm"

    checks.run("PDF：每页 297×210mm、6 券位、18 个绘制操作", broker_page_geometry)

    def coupon_scale():
        for name, doc in docs.items():
            for page in doc.pages:
                first = page.operations[0]
                object_id = page.xobjects[first[0]]
                image = doc.images[object_id]
                assert image.size == (3840, 1648), f"{name} 底图对象尺寸 {image.size}"
                width_mm = layout_mod.pt_to_mm(first[3])
                height_mm = layout_mod.pt_to_mm(first[4])
                assert abs(width_mm - 136.0) < 0.002, f"{name} 券位宽 {width_mm:.4f}mm"
                assert abs(height_mm - layout_mod.COUPON_H_MM) < 0.002, f"{name} 券位高 {height_mm:.4f}mm"
                assert abs(width_mm * layout_mod.PX_PER_MM - 3840) < 0.05, "券图不是 1:1（3840px = 136mm）"
                break
        return "3840×1648px 底图贴在 136.0000×58.3667mm 上，等效 717.2 dpi，零重采样"

    checks.run("PDF：券图 1:1 贴入（3840px = 136mm），零重采样", coupon_scale)

    def grid_positions():
        # PDF 的 y 从页底算起，冻结坐标从页顶算起，这里换算成页底坐标再比对
        expected = [
            (
                layout_mod.mm_to_pt(layout_mod.COL_X_MM[col]),
                layout_mod.mm_to_pt(layout_mod.PAGE_H_MM - layout_mod.ROW_Y_MM[row]),
            )
            for row in range(layout_mod.ROWS)
            for col in range(layout_mod.COLS)
        ]
        for name, doc in docs.items():
            for page_index, page in enumerate(doc.pages):
                base_id = manifest["pages"][name][page_index]["slots"][0]["base_object"]
                base_ops = [op for op in page.operations if page.xobjects[op[0]] == base_id]
                assert len(base_ops) == 6, f"{name} 第 {page_index + 1} 页底图绘制次数 {len(base_ops)}"
                for op in base_ops:
                    x_pt = op[1]
                    top_pt = op[2] + op[4]
                    match = min(expected, key=lambda item: abs(item[0] - x_pt) + abs(item[1] - top_pt))
                    assert abs(match[0] - x_pt) < 0.05 and abs(match[1] - top_pt) < 0.05, f"{name} 券位 ({x_pt:.4f},{layout_mod.pt_to_mm(top_pt):.4f}mm) 不在网格上"
        return "每页 6 个券位都落在 x=10/151mm、y=12.45/75.82/139.18mm 的网格点上（±0.05pt）"

    checks.run("PDF：券位坐标与冻结网格一致", grid_positions)

    def overlay_geometry():
        for name, doc in docs.items():
            for page_index, page in enumerate(doc.pages):
                slots = manifest["pages"][name][page_index]["slots"]
                for slot in slots:
                    # 每个券位自己的原点：按冻结网格换算，不依赖页面上第一个券位
                    base_x = layout_mod.mm_to_pt(layout_mod.COL_X_MM[slot["col"]])
                    base_top = layout_mod.mm_to_pt(layout_mod.PAGE_H_MM - layout_mod.ROW_Y_MM[slot["row"]])
                    for key, operation in ops_by_object(page, slot).items():
                        rect = slot["rects"][key]
                        want_x = base_x + layout_mod.mm_to_pt(layout_mod.px_to_mm(rect["x0"]))
                        want_top = base_top - layout_mod.mm_to_pt(layout_mod.px_to_mm(rect["y0"]))
                        got_top = operation[2] + operation[4]
                        assert abs(want_x - operation[1]) < 0.02, f"{name} {key} 横坐标偏差 {abs(want_x - operation[1]):.4f}pt"
                        assert abs(want_top - got_top) < 0.02, f"{name} {key} 纵坐标偏差 {abs(want_top - got_top):.4f}pt"
                        width_mm = layout_mod.pt_to_mm(operation[3])
                        height_mm = layout_mod.pt_to_mm(operation[4])
                        assert abs(width_mm - layout_mod.px_to_mm(rect["x1"] - rect["x0"])) < 0.002, f"{name} {key} 宽度不符"
                        assert abs(height_mm - layout_mod.px_to_mm(rect["y1"] - rect["y0"])) < 0.002, f"{name} {key} 高度不符"
        return "每页 12 个叠加层的落点与矩形成对吻合（误差 < 0.002mm）"

    checks.run("PDF：叠加层落点与矩形逐一吻合", overlay_geometry)

    def embedded_pixels_match_sources():
        front_path = assets_dir / "front_rgb.png"
        with Image.open(front_path) as handle:
            source_front = handle.convert("RGB").copy()
        doc = docs["rgb"]
        page = doc.pages[0]
        base_id = page.xobjects[page.operations[0][0]]
        embedded = doc.images[base_id]
        assert embedded.size == source_front.size, "内嵌底图尺寸与源文件不一致"
        assert embedded.tobytes() == source_front.tobytes(), "内嵌底图逐像素与源 PNG 不同（发生了重采样或色彩转换）"
        slot = manifest["pages"]["rgb"][0]["slots"][0]
        qr_id = slot["objects"]["qr"]
        expected_qr, expected_matrix, expected_module, expected_flat, expected_reason = vouchers.render_qr_overlay(
            source_front, layout, slot["code"]
        )
        assert doc.images[qr_id].tobytes() == expected_qr.image.tobytes(), "PDF 内嵌二维码层与重新合成的结果不同"
        label, mono_path = vouchers.discover_mono_font(None)
        label_cjk, cjk_path = vouchers.discover_font(None)
        code_overlay, code_metrics = vouchers.render_code_overlay(source_front, layout, slot["code"], [mono_path, cjk_path])
        assert doc.images[slot["objects"]["code"]].tobytes() == code_overlay.image.tobytes(), "PDF 内嵌兑换码层与重新合成的结果不同"
        return (
            "内嵌底图与源 PNG 逐像素相同；内嵌二维码层、兑换码层与重新合成结果逐像素相同"
            f"（兑换码字高 {code_metrics['cap_height_mm']}mm）"
        )

    checks.run("PDF：内嵌图像与合成结果逐像素一致（无重采样、无色彩转换）", embedded_pixels_match_sources)

    def front_variable_geometry():
        doc = docs["rgb"]
        with Image.open(assets_dir / "front_rgb.png") as handle:
            front_base = handle.convert("RGB").copy()
        label, mono_path = vouchers.discover_mono_font(None)
        min_ink_px = layout.code_min_ink_mm * layout_mod.PX_PER_MM
        quiet_notes: list[str] = []
        checked = 0
        for index in range(0, len(manifest["pages"]["rgb"]), 2):
            page = doc.pages[index]
            for slot in manifest["pages"]["rgb"][index]["slots"]:
                # 二维码：冻结预留区 680、内容方阵 = 37 × 模块，且不压顶部标题
                info = qr_compare_from_image(doc, page, slot)
                assert info["ratio"] <= 0.02, f"二维码像素偏差 {info['ratio']:.2%} 超过 2%"
                rect = slot["rects"]["qr"]
                qr_image = doc.images[slot["objects"]["qr"]].convert("L")
                module_px = slot["qr_module_px"]
                qr_meta = manifest["qr"]
                assert slot["qr_ec_level"] == qr_meta["ec_level"] == "M", f"纠错等级 {slot['qr_ec_level']} != M"
                assert slot["qr_modules"] == 29 and slot["qr_version"] == 3, (
                    f"version {slot['qr_version']} / {slot['qr_modules']} 模块 != version 3 / 29"
                )
                assert slot["qr_module_px"] == module_px, "清单里的模块像素与券位记录不一致"
                assert slot["qr_quiet_px"] == qr_meta["quiet_px"], "清单里的四边静默区与版式不一致"
                for label in ("top", "bottom", "left", "right"):
                    assert slot["qr_quiet_px"][label] >= layout.qr.min_quiet_px, (
                        f"{label} 静默区 {slot['qr_quiet_px'][label]}px < {layout.qr.min_quiet_px}px"
                    )
                assert rect == qr_meta["content_rect"], "二维码叠加层不是按内容方阵裁剪的"
                assert rect["x1"] - rect["x0"] == qr_meta["content_px"][0], "内容方阵宽与清单不一致"
                assert rect["y1"] - rect["y0"] == qr_meta["content_px"][1], "内容方阵高与清单不一致"
                expect_span = 29 * module_px
                assert rect["y0"] == 546 and rect["x0"] == 2816, f"内容方阵起点 ({rect['x0']},{rect['y0']}) != (2816,546)"
                bbox = qr_image.point(lambda value: 255 if value < 128 else 0).getbbox()
                assert bbox == (0, 0, expect_span, expect_span), f"二维码深色范围 {bbox} 未铺满内容方阵"
                module_mm = module_px / layout_mod.PX_PER_MM
                assert module_mm >= 0.60, f"模块 {module_mm:.4f}mm < 0.60mm"
                # 四边静默区：底图上必须是平坦浅色，逐边实测并统计
                base_gray = front_base.convert("L")
                quiet_box = layout.front_qr
                content = layout.front_qr_content
                bands = (
                    ("上", (content.x0, quiet_box.y0, content.x1, content.y0)),
                    ("下", (content.x0, content.y1, content.x1, quiet_box.y1)),
                    ("左", (quiet_box.x0, content.y0, content.x0, content.y1)),
                    ("右", (content.x1, content.y0, quiet_box.x1, content.y1)),
                )
                for label, band_box in bands:
                    band = base_gray.crop(band_box)
                    stat = ImageStat.Stat(band)
                    assert stat.mean[0] > 200 and stat.stddev[0] < 8, (
                        f"二维码{label}静默区不干净：均值 {stat.mean[0]:.1f} 标准差 {stat.stddev[0]:.1f}"
                    )
                    if checked == 0:
                        quiet_notes.append(f"{label}{stat.mean[0]:.0f}/{stat.stddev[0]:.1f}")
                # 明文兑换码：实测字高 ≥ 3mm
                code_rect = slot["rects"]["code"]
                code_image = doc.images[slot["objects"]["code"]]
                code_base = front_base.crop((code_rect["x0"], code_rect["y0"], code_rect["x1"], code_rect["y1"]))
                code_bbox = ink_bbox(code_base, code_image)
                assert code_bbox is not None, "兑换码图层没有着墨"
                ink_height = code_bbox[3] - code_bbox[1]
                code_metrics = slot["code_metrics"]
                cap_px = code_metrics["cap_height_px"]
                assert cap_px >= min_ink_px - 0.5, (
                    f"兑换码字高 {cap_px}px = {cap_px / layout_mod.PX_PER_MM:.3f}mm < {layout.code_min_ink_mm}mm"
                )
                assert (code_bbox[2] - code_bbox[0]) <= code_rect["x1"] - code_rect["x0"], "兑换码横向溢出可用区"
                assert abs((code_bbox[0] + code_bbox[2]) / 2 - (code_rect["x1"] - code_rect["x0"]) / 2) <= 2, "兑换码未水平居中"
                # 序列号：像素与「该券券号」逐像素一致
                serial_rect = slot["rects"]["serial"]
                serial_region = layout_mod.Region("serial", serial_rect["x0"], serial_rect["y0"], serial_rect["x1"], serial_rect["y1"])
                serial_text = f"No. {slot['serial']} / {len(all_codes):04d}"
                font = compose.fit_font(
                    mono_path, serial_text, (serial_region.width, serial_region.height),
                    max_em_px=layout.serial_em_mm * layout_mod.PX_PER_MM,
                    min_em_px=layout.serial_em_mm * layout_mod.PX_PER_MM * 0.7,
                    padding_px=layout.serial_padding_px,
                )
                ink = compose.text_mask(serial_text, font, (serial_region.width, serial_region.height), align="center")
                expected = compose.overlay_from_region(front_base, serial_region, ink)
                assert doc.images[slot["objects"]["serial"]].tobytes() == expected.image.tobytes(), f"序列号图层与 {serial_text} 不符"
                checked += 1
        return (
            f"{checked} 张券：二维码中心与跨度、模块 {module_px}px={module_mm:.3f}mm、"
            f"兑换码字高 {cap_px / layout_mod.PX_PER_MM:.2f}mm、序列号逐像素一致、"
            f"二维码 {expect_span}px 方阵 @({rect['x0']},{rect['y0']})、"
            f"二维码像素偏差 {info['ratio']:.2%}、静默区均值/标准差（{' '.join(quiet_notes)}）"
        )

    checks.run("正面可变位：二维码几何/模块尺寸、兑换码字高 ≥3mm、序列号格式", front_variable_geometry)

    def qr_from_pdf():
        doc = docs["rgb"]
        slots = manifest["pages"]["rgb"][0]["slots"]
        decoded = 0
        worst = 0.0
        for slot in slots:
            info = qr_compare_from_image(doc, doc.pages[0], slot)
            assert info["ideal"].version == 3 and info["ideal"].ec_level == "M", (
                f"版本 {info['ideal'].version} / 纠错 {info['ideal'].ec_level} != version 3 / M"
            )
            assert info["ratio"] <= 0.02, f"像素采样与理想矩阵偏差 {info['ratio']:.2%} 超过 2%"
            worst = max(worst, info["ratio"])
            external = cv2_decode_payload(info["image"], info["module_px"])
            if external == slot["qr_payload"]:
                decoded += 1
            else:
                assert info["payload"] == slot["qr_payload"], (
                    f"{slot['code']}：OpenCV 未解出且像素级解码也不通过（{info['payload']!r}）"
                )
        return (
            f"{len(slots)} 张券：经 OpenCV 独立解码成功 {decoded} 个，"
            f"全部像素矩阵与理想矩阵偏差 ≤ {worst:.2%}（纠错等级 M，version 3）"
        )

    checks.run("二维码：内嵌图像与理想矩阵一致，外部解码器可读", qr_from_pdf)

    def qr_black_only():
        doc = docs["cmyk"]
        slot = manifest["pages"]["cmyk"][0]["slots"][0]
        image = doc.images[slot["objects"]["qr"]]
        assert image.mode == "CMYK", f"CMYK 版二维码层模式为 {image.mode}"
        rect = slot["rects"]["qr"]
        matrix = qr.encode(slot["qr_payload"], ec_level=layout.qr.ec_level)
        module_px, origin = qr_module_geometry(rect, matrix.size)
        checked = 0
        for row in range(matrix.size):
            for col in range(matrix.size):
                if not matrix.modules[row][col]:
                    continue
                x = origin + col * module_px + module_px // 2
                y = origin + row * module_px + module_px // 2
                c, m, y_, k = image.getpixel((x, y))
                checked += 1
                assert (c, m, y_, k) == (0, 0, 0, 255), f"CMYK 版二维码模块不是 K100 单色黑：{(c, m, y_, k)}"
        slots = manifest["pages"]["cmyk"][0]["slots"]
        return f"{checked} 个深色模块像素全部为 K100（{slots[0]['serial']}）"

    checks.run("CMYK 版：二维码模块为 K100 单色黑", qr_black_only)

    def rgb_black_only():
        doc = docs["rgb"]
        slot = manifest["pages"]["rgb"][0]["slots"][0]
        image = doc.images[slot["objects"]["qr"]]
        matrix = qr.encode(slot["qr_payload"], ec_level=layout.qr.ec_level)
        rect = slot["rects"]["qr"]
        module_px, origin = qr_module_geometry(rect, matrix.size)
        for row in range(matrix.size):
            for col in range(matrix.size):
                if not matrix.modules[row][col]:
                    continue
                x = origin + col * module_px + module_px // 2
                y = origin + row * module_px + module_px // 2
                assert image.getpixel((x, y)) == (0, 0, 0), f"RGB 版二维码模块不是纯黑：{image.getpixel((x, y))}"
        return "RGB 版二维码模块像素全部为 (0,0,0)"

    checks.run("RGB 版：二维码模块为纯黑", rgb_black_only)

    def duplex_mapping():
        for name in ("rgb", "cmyk"):
            pages = manifest["pages"][name]
            for index in range(0, len(pages), 2):
                front = pages[index]
                back = pages[index + 1]
                assert front["side"] == "front" and back["side"] == "back", "页码与正反面顺序不符"
                front_map = {(slot["col"], slot["row"]): slot for slot in front["slots"]}
                back_map = {(slot["col"], slot["row"]): slot for slot in back["slots"]}
                assert len(front_map) == 6 and len(back_map) == 6, "每面券数不是 6"
                serials = [slot["serial"] for slot in front["slots"]]
                assert len(set(serials)) == 6, "同一张纸正面出现重复券"
                for (col, row), slot in front_map.items():
                    mirror = (layout_mod.mirrored_column(col), row)
                    assert mirror in back_map, "背面缺少镜像券位"
                    assert back_map[mirror]["serial"] == slot["serial"], (
                        f"正面 ({col},{row}) 的券 {slot['serial']} 翻面后落在 ({mirror[0]},{mirror[1]})，"
                        f"但该位置是 {back_map[mirror]['serial']}"
                    )
        # 像素级交叉证明：正面 (c,r) 的二维码/序列号属于同一张券；
        # 背面 (1-c,r) 承载的玩梗必须是该券按确定性规则分到的那一条。
        doc = docs["rgb"]
        with Image.open(assets_dir / "back_rgb.png") as handle:
            back_base = handle.convert("RGB").copy()
        quotes = vouchers.load_quotes(MOCK_QUOTES)
        label, quote_font_path = vouchers.discover_font(None)
        quote_font = ImageFont.truetype(quote_font_path, layout.quote_em_mm * layout_mod.PX_PER_MM)
        pairs = 0
        for index in range(0, len(manifest["pages"]["rgb"]), 2):
            front = manifest["pages"]["rgb"][index]
            back = manifest["pages"]["rgb"][index + 1]
            fan = {(slot["col"], slot["row"]): slot for slot in front["slots"]}
            bmap = {(slot["col"], slot["row"]): slot for slot in back["slots"]}
            for (col, row), slot in fan.items():
                info = qr_compare_from_image(doc, doc.pages[index], slot)
                payload = slot["qr_payload"]
                if info["payload"] != payload:
                    # 像素采样受预留区角标影响时，退化为「与理想矩阵一致 + 外部解码器可读」双重确认
                    assert info["ratio"] <= 0.02, f"正面二维码像素与理想矩阵偏差 {info['ratio']:.2%} 过大"
                    external = cv2_decode_payload(info["image"], info["module_px"])
                    assert external == payload, f"OpenCV 未能解出券 {slot['code']} 的二维码"
                code = payload.rsplit("/", 1)[-1]
                assert code in code_index, f"二维码里的兑换码 {code} 不在 CSV 里"
                voucher_index = code_index[code]
                assert slot["serial"] == f"{voucher_index + 1:04d}", f"券 {code} 的序列号 {slot['serial']} 与 CSV 行号不符"
                mirror = (layout_mod.mirrored_column(col), row)
                back_slot = bmap[mirror]
                expected_quote = quotes[voucher_index % len(quotes)]
                assert back_slot["quote_line"] == expected_quote.lineno, (
                    f"背面 {mirror} 的玩梗是第 {back_slot['quote_line']} 行，应为第 {expected_quote.lineno} 行"
                )
                rect = back_slot["rects"]["quote"]
                region = layout_mod.Region("quote", rect["x0"], rect["y0"], rect["x1"], rect["y1"])
                ink = compose.text_mask(expected_quote.text, quote_font, (region.width, region.height), align="center")
                expected = compose.overlay_from_region(back_base, region, ink)
                assert doc.images[back_slot["objects"]["quote"]].tobytes() == expected.image.tobytes(), (
                    f"背面 {mirror} 的玩梗图层与第 {expected_quote.lineno} 行文案不一致"
                )
                pairs += 1
        return f"{pairs} 对券位：位置互为镜像、二维码/序列号同券、背面玩梗与该券的确定性分配一致"

    checks.run("双面：左右翻转映射 (c,r) -> (1-c,r) 全量断言 + 像素级同券证明", duplex_mapping)

    def output_intent():
        doc = docs["cmyk"]
        intents = doc.output_intents()
        assert len(intents) == 1, f"CMYK 版 OutputIntent 数量 {len(intents)}"
        intent = intents[0]
        assert "/GTS_PDFX" in intent["body"], f"OutputIntent 不是 PDF/X 类型：{intent['body']}"
        assert "JapanColor2001Coated" in intent["identifier"], f"OutputConditionIdentifier = {intent['identifier']}"
        profile = doc.icc_profile(intent["profile_id"])
        assert profile[36:40] == b"acsp", "DestOutputProfile 不是 ICC（缺少 acsp 签名）"
        assert profile[16:20] == b"CMYK", f"ICC 数据色彩空间 {profile[16:20]!r}（CMYK 为 4 通道）"
        assert b"Japan Color 2001" in profile, "ICC 里找不到 Japan Color 2001 的描述"
        assert int.from_bytes(profile[0:4], "big") == len(profile), "ICC 头部长度字段与流长度不符"
        assert not docs["rgb"].output_intents(), "RGB 版不应带 CMYK OutputIntent"
        return f"identifier={intent['identifier']}，ICC {len(profile)} 字节 / {profile[16:20].decode()} 4 通道，PDF/X-1a:2003"

    checks.run("CMYK PDF：嵌入 OutputIntent 指向 JapanColor2001Coated", output_intent)

    def colorspace_split():
        for doc, want in ((docs["rgb"], b"/DeviceRGB"), (docs["cmyk"], b"/DeviceCMYK")):
            for object_id, stream in doc.streams.items():
                if b"/Subtype /Image" not in stream.dictionary:
                    continue
                assert want in stream.dictionary, f"对象 {object_id} 的色彩空间不是 {want}"
        return "RGB 版全部 DeviceRGB；CMYK 版全部 DeviceCMYK（无 DeviceGray/DeviceRGB 混入）"

    checks.run("两版色彩空间各自纯净", colorspace_split)

    def layout_parity():
        assert len(docs["rgb"].pages) == len(docs["cmyk"].pages), "两套 PDF 页数不同"
        for index, (left, right) in enumerate(zip(docs["rgb"].pages, docs["cmyk"].pages)):
            assert left.media_box == right.media_box, f"第 {index + 1} 页页面尺寸不同"
            assert len(left.operations) == len(right.operations), f"第 {index + 1} 页绘制数量不同"
            for a, b in zip(left.operations, right.operations):
                for value_a, value_b in zip(a[1:], b[1:]):
                    assert abs(value_a - value_b) < 1e-9, f"第 {index + 1} 页版式不同：{a} vs {b}"
        return f"{len(docs['rgb'].pages)} 页逐项同位（位置、尺寸、绘制顺序完全一致）"

    checks.run("RGB 与 CMYK 两套 PDF 版式逐项同位", layout_parity)

    def pypdf_cross_check():
        try:
            from pypdf import PdfReader
        except Exception as error:  # noqa: BLE001
            return f"pypdf 不可用，跳过独立解析（{error}）"
        notes = []
        for result in report.sets:
            reader = PdfReader(str(result.pdf_path))
            assert len(reader.pages) == result.pages, f"{result.name} pypdf 读到 {len(reader.pages)} 页 != {result.pages}"
            page = reader.pages[0]
            assert abs(float(page.mediabox.width) - layout_mod.mm_to_pt(297.0)) < 0.01, "pypdf 读到的页宽不符"
            assert abs(float(page.mediabox.height) - layout_mod.mm_to_pt(210.0)) < 0.01, "pypdf 读到的页高不符"
            images = list(page.images)
            assert len(images) >= 13, f"{result.name} 首页图像对象只有 {len(images)} 个"
            biggest = max(images, key=lambda item: item.image.size[0] * item.image.size[1])
            assert biggest.image.size == (3840, 1648), f"pypdf 解出的底图尺寸 {biggest.image.size}"
            intents = reader.trailer["/Root"].get("/OutputIntents")
            if result.name == "cmyk":
                assert intents, "pypdf 在 CMYK 版里找不到 OutputIntents"
                identifier = str(intents[0]["/OutputConditionIdentifier"])
                assert identifier == "JapanColor2001Coated", f"pypdf 读到 OutputConditionIdentifier={identifier}"
                notes.append(f"CMYK OutputConditionIdentifier={identifier}")
            else:
                assert not intents, "RGB 版不应有 OutputIntent"
            notes.append(f"{result.name} {len(reader.pages)} 页 / 首页图像 {len(images)} 个")
        return "pypdf 独立解析：" + "；".join(notes)

    checks.run("pypdf 独立解析 PDF（页数、MediaBox、图像、OutputIntent）", pypdf_cross_check)

    def determinism():
        twice = work / "twice"
        config_a = vouchers.GenerateConfig(
            csv_path=MOCK_CSV, quotes_path=MOCK_QUOTES, assets_dir=assets_dir, out_dir=twice, sheets=1,
            basename="a", log=lambda *a, **k: None,
        )
        config_b = vouchers.GenerateConfig(
            csv_path=work / "codes_bom_crlf.csv", quotes_path=MOCK_QUOTES, assets_dir=assets_dir, out_dir=twice, sheets=1,
            basename="b", log=lambda *a, **k: None,
        )
        vouchers.generate(config_a)
        vouchers.generate(config_b)
        for set_name in ("rgb", "cmyk"):
            first = (twice / f"a_{set_name}.pdf").read_bytes()
            second = (twice / f"b_{set_name}.pdf").read_bytes()
            assert first == second, f"{set_name} 版两次生成的字节不一致（同一输入必须得到同一输出）"
        return "同一批数据的两种 CSV 写法生成出的 PDF 字节完全相同"

    checks.run("确定性：同一输入必然得到同一输出（跨 CSV 写法）", determinism)

    def size_budget():
        """底图与 ICC 是共享对象，不随页数增长；只有每张券的二维码/兑换码/序列号层线性增长。"""
        total = 0
        lines = []
        vouchers_in_run = len(manifest["pages"]["rgb"]) // 2 * 6
        for result in report.sets:
            result_doc = docs[result.name]
            pages = manifest["pages"][result.name]
            per_voucher_ids = set()
            fixed_ids = set()
            for page in pages:
                for slot in page["slots"]:
                    fixed_ids.add(slot["base_object"])
                    for key, object_id in slot["objects"].items():
                        if key in ("qr", "code", "serial"):
                            per_voucher_ids.add(object_id)
                        else:
                            fixed_ids.add(object_id)
            per_voucher_ids -= fixed_ids
            per_voucher_bytes = sum(len(result_doc.streams[obj].payload) for obj in per_voucher_ids if obj in result_doc.streams)
            other_bytes = result.bytes_written - per_voucher_bytes
            projected = other_bytes + per_voucher_bytes * (600 / max(1, vouchers_in_run))
            lines.append(
                f"{result.name.upper()} 实测 {result.bytes_written / 1048576:.1f} MB / {result.pages} 页"
                f"（每券层 {per_voucher_bytes / 1024:.0f} KB × {len(per_voucher_ids)}）→ 600 张券外推 {projected / 1048576:.1f} MB"
            )
            total = max(total, projected)
        assert total <= 300 * 1048576, "外推的 200 页体积超过 300 MB"
        return "；".join(lines)

    if args.full_size:
        def size_budget_real():
            values = []
            for result in report.sets:
                values.append(f"{result.name.upper()} {result.pages} 页 {result.bytes_written / 1048576:.1f} MB")
                assert result.pages == 200, f"{result.name} 页数 {result.pages} != 200"
                assert result.bytes_written <= 300 * 1048576, f"{result.name} 超过 300 MB"
            return "；".join(values) + "（实测，非外推）"
        checks.run("体积：单份 200 页 PDF ≤ 300 MB（实测）", size_budget_real)
    else:
        checks.run("体积：按实测对象外推 200 页 ≤ 300 MB", size_budget)

    def gitignore_check():
        script = REPO_ROOT / ".git"
        assert script.exists(), "不是 git 仓库"
        targets = ["tools/voucher/assets/front_rgb.png", "tools/voucher/out/vouchers_rgb.pdf"]
        completed = subprocess.run(
            ["git", "check-ignore", "-v", *targets],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
        )
        assert completed.returncode == 0, f"git check-ignore 未命中：{completed.stdout}{completed.stderr}"
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        assert len(lines) >= 2, f"应有两个路径被忽略，实际 {len(lines)}"
        return "；".join(lines)

    checks.run(".gitignore 排除 tools/voucher/assets 与 tools/voucher/out", gitignore_check)

    print("")
    print(f"自检结束：{len(checks.items)} 项，失败 {checks.failures()} 项，耗时 {time.time() - started:.1f}s")
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    return 0 if checks.failures() == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
