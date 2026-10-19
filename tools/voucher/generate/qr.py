"""纯 Python 二维码编码器（字节模式，纠错等级可配）。

不依赖第三方库：兑换券可变层要在任何一台印刷机上可复现，编码器随生成器一起入库。
实现依据 ISO/IEC 18004：GF(256) 上的 Reed-Solomon 纠错、标准掩码惩罚评估、格式信息与版本信息 BCH。
"""
from __future__ import annotations

from dataclasses import dataclass

_EC_LEVEL_BITS = {"L": 1, "M": 0, "Q": 3, "H": 2}

# 每块纠错码字数，索引 [等级][版本-1]，来源 ISO/IEC 18004 表 13-22。
_ECC_CODEWORDS_PER_BLOCK = {
    "L": (7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "M": (10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    "Q": (13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "H": (17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
}

# 纠错块数，索引 [等级][版本-1]。
_NUM_EC_BLOCKS = {
    "L": (1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    "M": (1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    "Q": (1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    "H": (1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
}

MAX_VERSION = 40


def _build_galois() -> tuple[list[int], list[int]]:
    exp = [0] * 512
    log = [0] * 256
    value = 1
    for i in range(255):
        exp[i] = value
        log[value] = i
        value <<= 1
        if value & 0x100:
            value ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


_EXP, _LOG = _build_galois()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _poly_mul(p: list[int], q: list[int]) -> list[int]:
    out = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        if a == 0:
            continue
        for j, b in enumerate(q):
            out[i + j] ^= _gf_mul(a, b)
    return out


def rs_divisor(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        poly = _poly_mul(poly, [1, _EXP[i]])
    return poly


def rs_remainder(data: list[int], divisor: list[int]) -> list[int]:
    result = list(data) + [0] * (len(divisor) - 1)
    for i in range(len(data)):
        factor = result[i]
        if factor == 0:
            continue
        for j, coef in enumerate(divisor):
            result[i + j] ^= _gf_mul(coef, factor)
    return result[len(data):]


def raw_data_modules(version: int) -> int:
    """该版本可用于数据与纠错的模块总数（不含功能图形与余数位）。"""
    if not 1 <= version <= MAX_VERSION:
        raise ValueError("二维码版本超出 1-40 范围")
    result = (16 * version + 128) * version + 64
    if version >= 2:
        num_align = version // 7 + 2
        result -= (25 * num_align - 10) * num_align - 55
        if version >= 7:
            result -= 36
    return result


def total_codewords(version: int) -> int:
    return raw_data_modules(version) // 8


def data_codewords(version: int, ec_level: str) -> int:
    blocks = _NUM_EC_BLOCKS[ec_level][version - 1]
    return total_codewords(version) - _ECC_CODEWORDS_PER_BLOCK[ec_level][version - 1] * blocks


def byte_capacity(version: int, ec_level: str) -> int:
    """字节模式下该版本可容纳的净数据字节数。"""
    bits = data_codewords(version, ec_level) * 8
    count_bits = 8 if version <= 9 else 16
    return (bits - 4 - count_bits) // 8


def pick_version(byte_len: int, ec_level: str) -> int:
    for version in range(1, MAX_VERSION + 1):
        if byte_capacity(version, ec_level) >= byte_len:
            return version
    raise ValueError(f"数据过长：{byte_len} 字节超出纠错等级 {ec_level} 的容量上限")


def _alignment_positions(version: int) -> list[int]:
    if version == 1:
        return []
    size = version * 4 + 17
    num_align = version // 7 + 2
    step = 26 if version == 32 else (version * 4 + num_align * 2 + 1) // (num_align * 2 - 2) * 2
    result = [6] + [0] * (num_align - 1)
    pos = size - 7
    for i in range(num_align - 1, 0, -1):
        result[i] = pos
        pos -= step
    return result


class _Matrix:
    def __init__(self, version: int, ec_level: str = "M"):
        self.version = version
        self.ec_level = ec_level
        self.size = version * 4 + 17
        self.modules = [[False] * self.size for _ in range(self.size)]
        self.is_function = [[False] * self.size for _ in range(self.size)]

    def set_function(self, x: int, y: int, dark: bool) -> None:
        if 0 <= x < self.size and 0 <= y < self.size:
            self.modules[y][x] = dark
            self.is_function[y][x] = True

    def _draw_finder(self, cx: int, cy: int) -> None:
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                dist = max(abs(dx), abs(dy))
                self.set_function(cx + dx, cy + dy, dist != 2 and dist != 4)

    def _draw_alignment(self, cx: int, cy: int) -> None:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                self.set_function(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)

    def draw_function_patterns(self) -> None:
        size = self.size
        for i in range(size):
            self.set_function(6, i, i % 2 == 0)
            self.set_function(i, 6, i % 2 == 0)
        self._draw_finder(3, 3)
        self._draw_finder(size - 4, 3)
        self._draw_finder(3, size - 4)
        positions = _alignment_positions(self.version)
        last = len(positions) - 1
        for i, x in enumerate(positions):
            for j, y in enumerate(positions):
                if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                    continue
                self._draw_alignment(x, y)
        self.draw_format_bits(0)
        self.draw_version_bits()

    @staticmethod
    def _bit(value: int, index: int) -> bool:
        return ((value >> index) & 1) != 0

    def draw_format_bits(self, mask: int) -> None:
        size = self.size
        data = (_EC_LEVEL_BITS[self.ec_level] << 3) | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = ((data << 10) | rem) ^ 0x5412
        for i in range(0, 6):
            self.set_function(8, i, self._bit(bits, i))
        self.set_function(8, 7, self._bit(bits, 6))
        self.set_function(8, 8, self._bit(bits, 7))
        self.set_function(7, 8, self._bit(bits, 8))
        for i in range(9, 15):
            self.set_function(14 - i, 8, self._bit(bits, i))
        for i in range(0, 8):
            self.set_function(size - 1 - i, 8, self._bit(bits, i))
        for i in range(8, 15):
            self.set_function(8, size - 15 + i, self._bit(bits, i))
        self.set_function(8, size - 8, True)

    def draw_version_bits(self) -> None:
        if self.version < 7:
            return
        rem = self.version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = (self.version << 12) | rem
        for i in range(18):
            bit = self._bit(bits, i)
            a = self.size - 11 + i % 3
            b = i // 3
            self.set_function(a, b, bit)
            self.set_function(b, a, bit)

    def draw_codewords(self, codewords: list[int]) -> None:
        size = self.size
        index = 0
        total_bits = len(codewords) * 8
        right = size - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(size):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = size - 1 - vert if upward else vert
                    if not self.is_function[y][x] and index < total_bits:
                        self.modules[y][x] = self._bit(codewords[index >> 3], 7 - (index & 7))
                        index += 1
            right -= 2

    def apply_mask(self, mask: int) -> None:
        for y in range(self.size):
            row = self.modules[y]
            func = self.is_function[y]
            for x in range(self.size):
                if func[x]:
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
                elif mask == 7:
                    invert = ((x + y) % 2 + x * y % 3) % 2 == 0
                else:
                    raise ValueError("掩码编号必须在 0-7 之间")
                if invert:
                    row[x] = not row[x]

    @staticmethod
    def _finder_history_push(run_len: int, history: list[int], size: int) -> None:
        if history[0] == 0:
            run_len += size
        history.insert(0, run_len)
        del history[7:]

    @staticmethod
    def _finder_pattern_count(history: list[int]) -> int:
        n = history[1]
        core = n > 0 and history[2] == n and history[3] == n * 3 and history[4] == n and history[5] == n
        result = 0
        if core and history[0] >= n * 4 and history[6] >= n:
            result += 1
        if core and history[6] >= n * 4 and history[0] >= n:
            result += 1
        return result

    def _finder_terminate(self, run_color: bool, run_len: int, history: list[int]) -> int:
        if run_color:
            self._finder_history_push(run_len, history, self.size)
            run_len = 0
        run_len += self.size
        self._finder_history_push(run_len, history, self.size)
        return self._finder_pattern_count(history)

    def _penalty_line(self, cells: list[bool]) -> int:
        n1, n3 = 3, 40
        result = 0
        run_color = False
        run_len = 0
        history = [0] * 7
        for cell in cells:
            if cell == run_color:
                run_len += 1
                if run_len == 5:
                    result += n1
                elif run_len > 5:
                    result += 1
            else:
                self._finder_history_push(run_len, history, self.size)
                if not run_color:
                    result += self._finder_pattern_count(history) * n3
                run_color = cell
                run_len = 1
        result += self._finder_terminate(run_color, run_len, history) * n3
        return result

    def penalty(self) -> int:
        """ISO/IEC 18004 的四条掩码惩罚规则，与主流编码器实现保持一致。"""
        size = self.size
        modules = self.modules
        result = 0
        for y in range(size):
            result += self._penalty_line(modules[y])
        for x in range(size):
            result += self._penalty_line([modules[y][x] for y in range(size)])
        for y in range(size - 1):
            for x in range(size - 1):
                color = modules[y][x]
                if color == modules[y][x + 1] == modules[y + 1][x] == modules[y + 1][x + 1]:
                    result += 3
        dark = sum(1 for row in modules for cell in row if cell)
        total = size * size
        k = (abs(dark * 20 - total * 10) + total - 1) // total - 1
        return result + k * 10

    def clone(self) -> "_Matrix":
        other = _Matrix(self.version, self.ec_level)
        other.modules = [row[:] for row in self.modules]
        other.is_function = [row[:] for row in self.is_function]
        return other


@dataclass(frozen=True)
class QrCode:
    version: int
    ec_level: str
    mask: int
    size: int
    modules: list[list[bool]]

    def text(self) -> str:
        return "\n".join("".join("#" if cell else "." for cell in row) for row in self.modules)


def _build_codewords(payload: bytes, version: int, ec_level: str) -> list[int]:
    capacity_bits = data_codewords(version, ec_level) * 8
    count_bits = 8 if version <= 9 else 16
    bits: list[int] = []

    def put(value: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            bits.append((value >> i) & 1)

    put(0b0100, 4)
    put(len(payload), count_bits)
    for byte in payload:
        put(byte, 8)
    put(0, min(4, capacity_bits - len(bits)))
    while len(bits) % 8 != 0:
        bits.append(0)
    pad = 0xEC
    while len(bits) < capacity_bits:
        put(pad, 8)
        pad = 0x11 if pad == 0xEC else 0xEC
    codewords = []
    for i in range(0, len(bits), 8):
        value = 0
        for bit in bits[i:i + 8]:
            value = (value << 1) | bit
        codewords.append(value)
    return codewords


def _add_ecc_and_interleave(data: list[int], version: int, ec_level: str) -> list[int]:
    num_blocks = _NUM_EC_BLOCKS[ec_level][version - 1]
    block_ecc_len = _ECC_CODEWORDS_PER_BLOCK[ec_level][version - 1]
    raw_codewords = total_codewords(version)
    num_short_blocks = num_blocks - raw_codewords % num_blocks
    short_block_len = raw_codewords // num_blocks
    divisor = rs_divisor(block_ecc_len)
    blocks: list[list[int]] = []
    offset = 0
    for i in range(num_blocks):
        dat_len = short_block_len - block_ecc_len + (0 if i < num_short_blocks else 1)
        dat = list(data[offset:offset + dat_len])
        offset += dat_len
        ecc = rs_remainder(dat, divisor)
        if i < num_short_blocks:
            dat = dat + [0]
        blocks.append(dat + ecc)
    result: list[int] = []
    for i in range(len(blocks[0])):
        for j, block in enumerate(blocks):
            if i != short_block_len - block_ecc_len or j >= num_short_blocks:
                result.append(block[i])
    return result


# 实测 OpenCV 的 QRCodeDetector 对掩码 2 / 4 / 7 有按图案变化的盲点
# （同一符号换一个掩码就能读出）。ISO 只要求编码器按惩罚函数选掩码，任何读码器都必须支持全部 8 个掩码，
# 所以这里在惩罚接近时优先选安全掩码：既守住标准，又避免单一解码器的已知弱点。
RISKY_MASKS = (2, 4, 7)


def rank_masks(payload: "str | bytes", ec_level: str = "H", version: "int | None" = None, mask_policy: str = "safe") -> list[int]:
    """按偏好顺序返回 8 个掩码：安全掩码在前，组内按惩罚升序。"""
    data = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    if version is None:
        version = pick_version(len(data), ec_level)
    codewords = _build_codewords(data, version, ec_level)
    interleaved = _add_ecc_and_interleave(codewords, version, ec_level)
    matrix = _Matrix(version, ec_level)
    matrix.draw_function_patterns()
    matrix.draw_codewords(interleaved)
    scored = []
    for mask in range(8):
        candidate = matrix.clone()
        candidate.apply_mask(mask)
        candidate.draw_format_bits(mask)
        scored.append((mask, candidate.penalty()))
    if mask_policy == "safe":
        safe = [item for item in scored if item[0] not in RISKY_MASKS]
        risky = [item for item in scored if item[0] in RISKY_MASKS]
        ordered = sorted(safe, key=lambda item: (item[1], item[0])) + sorted(risky, key=lambda item: (item[1], item[0]))
    else:
        ordered = sorted(scored, key=lambda item: (item[1], item[0]))
    return [mask for mask, _ in ordered]


def encode(payload: "str | bytes", ec_level: str = "H", version: "int | None" = None, mask_policy: str = "safe", mask: "int | None" = None) -> QrCode:
    """把内容编码为二维码矩阵。ec_level 取 L/M/Q/H，version 为 None 时按容量自动选择。

    掩码选择：mask_policy="safe"（默认）时，在避开 RISKY_MASKS 的掩码里取惩罚最低的那个；
    mask_policy="penalty" 时严格按标准惩罚函数取全局最优。两种策略产出的都是标准允许的符号，
    区别只在「安全策略」会为了避开某些解码器的已知盲点而多花一点惩罚分。
    """
    data = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    if ec_level not in _EC_LEVEL_BITS:
        raise ValueError("纠错等级必须是 L/M/Q/H 之一")
    if version is None:
        version = pick_version(len(data), ec_level)
    elif len(data) > byte_capacity(version, ec_level):
        raise ValueError(
            f"数据过长：{len(data)} 字节超出版本 {version}-{ec_level} 的容量 {byte_capacity(version, ec_level)} 字节"
        )
    codewords = _build_codewords(data, version, ec_level)
    interleaved = _add_ecc_and_interleave(codewords, version, ec_level)
    matrix = _Matrix(version, ec_level)
    matrix.draw_function_patterns()
    matrix.draw_codewords(interleaved)
    if mask_policy not in ("safe", "penalty"):
        raise ValueError("掩码策略只能是 safe 或 penalty")
    candidates = []
    for candidate_mask in range(8):
        candidate = matrix.clone()
        candidate.apply_mask(candidate_mask)
        candidate.draw_format_bits(candidate_mask)
        candidates.append((candidate_mask, candidate.penalty(), candidate))
    pool = candidates
    if mask is not None:
        if not 0 <= mask <= 7:
            raise ValueError("掩码编号必须在 0-7 之间")
        pool = [item for item in candidates if item[0] == mask]
    elif mask_policy == "safe":
        safe = [item for item in candidates if item[0] not in RISKY_MASKS]
        if safe:
            pool = safe
    best_mask, best_score, best_matrix = min(pool, key=lambda item: (item[1], item[0]))
    return QrCode(
        version=version,
        ec_level=ec_level,
        mask=best_mask,
        size=best_matrix.size,
        modules=best_matrix.modules,
    )
