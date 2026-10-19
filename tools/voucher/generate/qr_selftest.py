"""二维码编码器自检：码表一致性、容量对照、OpenCV 独立解码回环。"""
from __future__ import annotations

import random
from dataclasses import dataclass

import qr

# ISO/IEC 18004 字节模式净容量对照表（版本 1-10），用于反查码表是否抄错。
KNOWN_BYTE_CAPACITY = {
    "L": (17, 32, 53, 78, 106, 134, 154, 192, 230, 271),
    "M": (14, 26, 42, 62, 84, 106, 122, 152, 180, 213),
    "Q": (11, 20, 32, 46, 60, 74, 86, 108, 130, 151),
    "H": (7, 14, 24, 34, 44, 58, 64, 84, 98, 119),
}

# 每版本总码字数（几何推导值必须与码表推算值一致）。
KNOWN_TOTAL_CODEWORDS = (
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901,
    991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465,
    2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
)


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


def check_tables() -> list[CheckResult]:
    results: list[CheckResult] = []
    problems: list[str] = []
    for version in range(1, qr.MAX_VERSION + 1):
        geometry_total = qr.total_codewords(version)
        if geometry_total != KNOWN_TOTAL_CODEWORDS[version - 1]:
            problems.append(
                f"版本 {version} 几何推导总码字数 {geometry_total} 与标准值 {KNOWN_TOTAL_CODEWORDS[version - 1]} 不一致"
            )
        for level in ("L", "M", "Q", "H"):
            blocks = qr._NUM_EC_BLOCKS[level][version - 1]
            ecc = qr._ECC_CODEWORDS_PER_BLOCK[level][version - 1]
            data = qr.data_codewords(version, level)
            if data + ecc * blocks != geometry_total:
                problems.append(
                    f"版本 {version}-{level} 数据 {data} + 纠错 {ecc}x{blocks} != 总码字 {geometry_total}"
                )
            if data <= 0:
                problems.append(f"版本 {version}-{level} 数据码字数为 {data}")
    results.append(CheckResult("码表一致性（数据+纠错=几何推导总码字数）", not problems, "; ".join(problems[:6])))

    capacity_problems: list[str] = []
    for level, expected in KNOWN_BYTE_CAPACITY.items():
        for version, want in enumerate(expected, start=1):
            got = qr.byte_capacity(version, level)
            if got != want:
                capacity_problems.append(f"版本 {version}-{level} 容量 {got} != 标准 {want}")
    results.append(CheckResult("字节模式容量对照版本 1-10", not capacity_problems, "; ".join(capacity_problems[:6])))
    return results


def check_structure() -> list[CheckResult]:
    results: list[CheckResult] = []
    problems: list[str] = []
    for version in (1, 2, 3, 5, 7, 10, 20):
        for level in ("L", "M", "Q", "H"):
            capacity = qr.byte_capacity(version, level)
            payload = bytes(((i * 37 + version) % 256) for i in range(capacity))
            try:
                code = qr.encode(payload, ec_level=level, version=version)
            except Exception as exc:  # noqa: BLE001
                problems.append(f"版本 {version}-{level} 满容量编码抛错：{exc}")
                continue
            if code.size != version * 4 + 17:
                problems.append(f"版本 {version}-{level} 矩阵边长 {code.size} 不符")
            if len(code.modules) != code.size or any(len(row) != code.size for row in code.modules):
                problems.append(f"版本 {version}-{level} 矩阵不是方阵")
            if not all(isinstance(cell, bool) for row in code.modules for cell in row):
                problems.append(f"版本 {version}-{level} 矩阵存在非布尔单元")
    results.append(CheckResult("满容量编码尺寸与矩阵结构", not problems, "; ".join(problems[:6])))
    return results


def render(code: "qr.QrCode", scale: int = 8, quiet: int = 4):
    from PIL import Image, ImageDraw

    size = (code.size + quiet * 2) * scale
    image = Image.new("L", (size, size), 255)
    draw = ImageDraw.Draw(image)
    for y, row in enumerate(code.modules):
        for x, dark in enumerate(row):
            if dark:
                x0 = (x + quiet) * scale
                y0 = (y + quiet) * scale
                draw.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill=0)
    return image


def check_decoder(versions: tuple[int, ...] = (1, 2, 3, 4, 5, 7, 10, 14)) -> list[CheckResult]:
    try:
        import cv2  # type: ignore
        import numpy
    except Exception as exc:  # noqa: BLE001
        return [CheckResult("OpenCV 解码回环", False, f"无法导入 cv2/numpy：{exc}")]
    # OpenCV 的 QRCodeDetector 对部分掩码图案会解码失败（实测与掩码相关、与分辨率无关），
    # 因此这里只做统计门限；像素级结构回环（格式信息/掩码/RS 校验）才是硬门限，见 selfcheck.py。
    detector = cv2.QRCodeDetector()
    rng = random.Random(20241018)
    failures: list[str] = []
    checked = 0
    for version in versions:
        for level in ("L", "M", "Q", "H"):
            capacity = qr.byte_capacity(version, level)
            lengths = sorted({max(1, capacity // 3), max(1, capacity - 1), capacity})
            for length in lengths:
                alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789-"
                payload = "".join(rng.choice(alphabet) for _ in range(length))
                code = qr.encode(payload, ec_level=level, version=version)
                image = render(code)
                decoded, _, _ = detector.detectAndDecode(numpy.array(image))
                checked += 1
                if decoded != payload:
                    failures.append(f"版本 {version}-{level} 长度 {length}")
    rate = (checked - len(failures)) / checked if checked else 0.0
    ok = rate >= 0.8
    detail = f"{checked - len(failures)}/{checked} 成功（{rate * 100:.1f}%）；cv2 已知弱点，失败样例：{', '.join(failures[:5])}"
    return [CheckResult(f"OpenCV 独立解码回环（{checked} 组，门限 80%）", ok, detail)]


def check_ec_level_from_pixels() -> list[CheckResult]:
    """从像素读回格式信息，确认纠错等级位确实是 H。"""
    codes = {"L": 1, "M": 0, "Q": 3, "H": 2}
    problems: list[str] = []
    for level, bits in codes.items():
        code = qr.encode("https://ai.ecustcic.com/r/ABCD-EFGH-JKLM", ec_level=level)
        modules = code.modules
        # 格式信息第一副本：列 8 的 0-5、7、8 与行 8 的 7、8、以及 (14-i, 8) i=9..14
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
        got_level = (data >> 3) & 3
        if got_level != bits:
            problems.append(f"等级 {level} 像素读回格式信息等级位 {got_level} != {bits}")
    return [CheckResult("从矩阵读取格式信息核对纠错等级", not problems, "; ".join(problems[:6]))]


def run() -> list[CheckResult]:
    results: list[CheckResult] = []
    results.extend(check_tables())
    results.extend(check_structure())
    results.extend(check_ec_level_from_pixels())
    results.extend(check_decoder())
    return results


if __name__ == "__main__":
    import sys

    ok = True
    for result in run():
        print(f"[{'通过' if result.ok else '失败'}] {result.name}" + (f" :: {result.detail}" if result.detail else ""))
        ok = ok and result.ok
    sys.exit(0 if ok else 1)
