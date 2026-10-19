#!/usr/bin/env python3
"""鲸元券底图修复与版面填充（t6 修订契约版，RGB + CMYK 双版本）。

唯一底图来源：assets/src/front_orig.png / back_orig.png
（即用户提供的 C:/Users/ChenXu233/Downloads/正面.png 与 背面.png，只读，不修改）。
禁止自绘占位图：本脚本只做定点清除/铺平/加宽与定稿文案排入。

修复清单（对应队长 7 条返工项）：
  正面 —— 保留二维码面板的装饰边框与标题（像素不动）；清除面板内部鲸鱼水印与
          斜纹织纹，填纸面米色 #F5F0E4；四个 L 形角标按 680x680 预留区
          （中心 3063,767）重绘于区四角；QR 实际绘制方阵 624x624
          (2752,480)-(3376,1104) 全平涂，避开标题下缘 y475；
          兑换码白条保留「深蓝标签带+米色胶囊条」形制，整体加宽到
          1080x180、中心 (3056,1224)；左下序列号铭牌 (464,1456)-(1056,1536)
          只铺平内部留白，不放字（生成器叠加）。
  背面 —— 顶部横幅内膛铺平，第1行写「鲸元券兑换须知」，第2行留空（玩梗位）；
          左下/右下横幅保留雕花框与罗盘端饰，内膛铺平后三行居中写入定稿文案；
          背面不放任何编号（原右侧面部高光区不动）。
  全局 —— Lab 域迭代 TAC 压缩（目标 <=276%）；JapanColor2001Coated 相对色度
          转换；CMYK 以 RGBA 打包（R=C,G=M,B=Y,A=K）存 PNG 并嵌 ICC。

禁区（契约核验过，不放任何文字/图形）：
  正面 (2848,1440)-(3328,1536) / (2512,288)-(3008,512) / (1760,704)-(2048,912)
       / (352,336)-(640,464)；背面 (864,640)-(1056,752) / (2816,624)-(3040,768)。
  注：680 预留区左上角 (2723,427) 落在正面⑤禁区内，系契约自身几何相交，
  该处只有平涂米色底与 L 角标（属二维码面板本体），无其他内容。

运行：D:/programming/python3.13/python.exe tools/voucher/assets/build_assets.py
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageCms, PngImagePlugin

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
W, H = 3840, 1648
PXMM = 28.235

SRGB_ICC = os.path.join(HERE, "icc", "sRGB.icc")
JC_ICC = os.path.join(HERE, "icc", "JapanColor2001Coated.icc")

F_SONG = "C:/Windows/Fonts/simsun.ttc"        # 宋体，贴合钞票雕刻风

PAPER = (245, 240, 228)   # F5F0E4 纸面米色（≈队长给定 #F2EDE0 附近，略提亮利于扫码）
NAVY = (13, 43, 82)       # 0D2B52 原稿油墨深蓝（采样自旧蓝带/框线）

# ---------- 冻结几何（半开区间 [x0,y0,x1,y1)） ----------
QR_ZONE = (2723, 427, 3403, 1107)        # 二维码预留区 680x680，中心 (3063,767)
QR_CLEAN_FIELD = (2690, 478, 3434, 1134)  # QR 干净场（标题下沿 475 至深蓝带顶 1134，全平涂）
QR_BLOCK = (2748, 478, 3377, 1107)       # EC M 二维码连静默区实际占位 629x629（29+8 模块 x17px=0.602mm）
QR_SYMBOL = (2816, 546, 3309, 1039)      # 内容方阵 29x17=493px，中心 y=792
QR_FLAT_RECT = (2744, 474, 3381, 1111)  # t19：平涂收窄为 QR_BLOCK 四边外扩 4px，拱形边框/花纹复原
STRIP_BRIDGE = (2660, 1080, 3465, 1134)  # 旧兑换码框残余覆盖

CODE_BODY = (2516, 1134, 3596, 1314)     # 兑换码组合体 1080x180，中心 (3056,1224)，深蓝标签带
CODE_PILL = (2524, 1190, 3588, 1308)     # 米色胶囊条
CODE_AREA = (2548, 1198, 3564, 1302)     # 明文码绘制区（可用宽 1016px）
CODE_LABEL_Y = 1142                      # 标签白色字 on 深蓝带

SERIAL_BAND = (464, 1456, 1056, 1536)    # 序列号位（底图不放字）
SERIAL_FILL = (450, 1448, 1068, 1558)    # 铭牌内膛铺平范围

BACK_BANNER = (1456, 128, 2400, 272)     # 背面顶部横幅
BACK_BANNER_FILL = (1430, 120, 2410, 261)  # 丝带内膛铺平
BANNER_TITLE_Y = 140
BACK_JOKE = (1466, 206, 2390, 260)       # 玩梗行预留（留空）
BACK_LEFT = (480, 1200, 1584, 1424)      # 左下横幅（文字区）
BACK_LEFT_FILL = (478, 1190, 1560, 1424)  # 左框内膛（避开罗盘端饰）
BACK_RIGHT = (2256, 1200, 3360, 1424)    # 右下横幅
BACK_RIGHT_FILL = (2282, 1190, 3328, 1424)

STRIP_FONT_PX = 44                        # 1.557mm >= 1.5mm
STRIP_PITCH = 66
STRIP_FIRST_TOP = 1218

LEFT_LINES = [
    "① 扫码或访问 ai.ecustcic.com",
    "② 登录并完成校园网认证",
    "③ 输入兑换码，额度即时到账",
]
RIGHT_LINES = [
    "面额 50,000,000 计费 Token",
    "仅限校园网认证用户 · 每人限兑一张",
    "一码一次，兑换即作废，遗失不补",
]
BANNER_TITLE = "鲸元券兑换须知"
CODE_LABEL = "兑换码 REDEMPTION CODE"

TAC_TARGET = 276.0

M_SRGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
], dtype=np.float64)
M_XYZ2SRGB = np.array([
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
], dtype=np.float64)
WHITE_D65 = np.array([95.047, 100.0, 108.883], dtype=np.float64)


def srgb_to_lab(rgb):
    rgb = rgb / 255.0
    rgb = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = (rgb @ M_SRGB2XYZ.T) * 100.0 / WHITE_D65
    d = 6.0 / 29.0
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    return np.stack([116.0 * f[..., 1] - 16.0,
                     500.0 * (f[..., 0] - f[..., 1]),
                     200.0 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_srgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0
    d = 6.0 / 29.0
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f > d, f ** 3, 3 * d * d * (f - 4.0 / 29.0)) * WHITE_D65
    rgb = (xyz / 100.0) @ M_XYZ2SRGB.T
    rgb = np.where(rgb <= 0.0031308, rgb * 12.92,
                   1.055 * np.power(np.clip(rgb, 0, None), 1 / 2.4) - 0.055)
    return np.clip(rgb * 255.0, 0, 255)


def fill(d, rect, color):
    """半开区间填充。"""
    d.rectangle((rect[0], rect[1], rect[2] - 1, rect[3] - 1), fill=color)


def font(size):
    return ImageFont.truetype(F_SONG, size)


def draw_centered(d, cx, y, text, fnt, color, max_w, what):
    w = fnt.getlength(text)
    assert w <= max_w, f"{what} 溢出: {w:.0f}px > {max_w}px"
    d.text((cx - w / 2, y), text, font=fnt, fill=color, anchor="la")
    return w


def tac_of(arr, to_cmyk):
    cmyk = np.array(ImageCms.applyTransform(Image.fromarray(arr.astype(np.uint8)), to_cmyk))
    return cmyk.astype(np.float64).sum(axis=2) * 100.0 / 255.0


def delta_e00(lab1, lab2):
    """CIEDE2000，逐像素。"""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar7 = ((C1 + C2) / 2.0) ** 7
    G = 0.5 * (1.0 - np.sqrt(Cbar7 / (Cbar7 + 25.0 ** 7)))
    a1p, a2p = a1 * (1.0 + G), a2 * (1.0 + G)
    C1p = np.hypot(a1p, b1)
    C2p = np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360.0
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360.0
    dLp = L2 - L1
    dCp = C2p - C1p
    cc = C1p * C2p
    dh = h2p - h1p
    dh = np.where(cc == 0, 0.0, np.where(dh > 180.0, dh - 360.0, np.where(dh < -180.0, dh + 360.0, dh)))
    dHp = 2.0 * np.sqrt(cc) * np.sin(np.radians(dh) / 2.0)
    Lbarp = (L1 + L2) / 2.0
    Cbarp = (C1p + C2p) / 2.0
    hsum = h1p + h2p
    hadj = np.abs(h1p - h2p)
    hbarp = np.where(cc == 0, hsum, np.where(hadj <= 180.0, hsum / 2.0,
                     np.where(hsum < 360.0, (hsum + 360.0) / 2.0, (hsum - 360.0) / 2.0)))
    T = (1.0 - 0.17 * np.cos(np.radians(hbarp - 30.0))
         + 0.24 * np.cos(np.radians(2.0 * hbarp))
         + 0.32 * np.cos(np.radians(3.0 * hbarp + 6.0))
         - 0.20 * np.cos(np.radians(4.0 * hbarp - 63.0)))
    dtheta = 30.0 * np.exp(-(((hbarp - 275.0) / 25.0) ** 2))
    Cbarp7 = Cbarp ** 7
    Rc = 2.0 * np.sqrt(Cbarp7 / (Cbarp7 + 25.0 ** 7))
    Sl = 1.0 + 0.015 * (Lbarp - 50.0) ** 2 / np.sqrt(20.0 + (Lbarp - 50.0) ** 2)
    Sc = 1.0 + 0.045 * Cbarp
    Sh = 1.0 + 0.015 * Cbarp * T
    Rt = -np.sin(np.radians(2.0 * dtheta)) * Rc
    dL = dLp / Sl
    dC = dCp / Sc
    dH = dHp / Sh
    return np.sqrt(dL * dL + dC * dC + dH * dH + Rt * dC * dH)


def roundtrip_de(cur, to_cmyk, jc_to_srgb):
    """cur(uint8 RGB) -> CMYK -> sRGB 的逐像素 dE00。"""
    cmyk = np.array(ImageCms.applyTransform(Image.fromarray(cur.astype(np.uint8)), to_cmyk))
    back = np.array(ImageCms.applyTransform(Image.fromarray(cmyk, "CMYK"), jc_to_srgb))
    return delta_e00(srgb_to_lab(cur.astype(np.float64)),
                     srgb_to_lab(back.astype(np.float64)))


def _eval_pixels(pix, to_cmyk, jc_to_srgb):
    """pix (N,3) uint8 -> (tac%, roundtrip dE00)。"""
    cmyk = np.array(ImageCms.applyTransform(
        Image.fromarray(pix.reshape(-1, 1, 3)), to_cmyk)).reshape(-1, 4)
    tac = cmyk.astype(np.float64).sum(axis=1) * 100.0 / 255.0
    back = np.array(ImageCms.applyTransform(
        Image.fromarray(cmyk.reshape(-1, 1, 4), "CMYK"), jc_to_srgb)).reshape(-1, 3)
    de = delta_e00(srgb_to_lab(pix.astype(np.float64)), srgb_to_lab(back.astype(np.float64)))
    return tac, de


def normalize_pixels(arr, to_cmyk, jc_to_srgb, tac_target=TAC_TARGET,
                     de_thresh=3.0, max_iter=24):
    """TAC/色域联合压缩（Lab 域、逐像素迭代）：
    TAC 超限 -> 提亮+降彩；往返 dE00 超阈 -> 降彩。单像素同时满足两约束才放行。
    目标 TAC<=276%（硬阈值 280% 留余量）、dE00<=3（硬阈值 8 留余量）。"""
    cur = arr.copy().astype(np.uint8)
    tac_all = tac_of(cur, to_cmyk)
    de_all = roundtrip_de(cur, to_cmyk, jc_to_srgb)
    mask = (tac_all > tac_target) | (de_all > de_thresh)
    n0 = int(mask.sum())
    print(f"  联合压缩: 待处理 {n0} px ({n0 / mask.size * 100:.2f}%)"
          f"（TAC>{tac_target:.0f}: {int((tac_all > tac_target).sum())}，"
          f"dE00>{de_thresh}: {int((de_all > de_thresh).sum())}）")
    idx = np.where(mask)
    it = 0
    while len(idx[0]) and it < max_iter:
        it += 1
        px = cur[idx]
        tac_m, de_m = _eval_pixels(px, to_cmyk, jc_to_srgb)
        over_tac = tac_m > tac_target
        over_de = de_m > de_thresh
        lab = srgb_to_lab(px.astype(np.float64))
        lab[..., 0] = np.minimum(lab[..., 0] + np.where(over_tac, 4.0, 0.0), 100.0)
        scale = np.where(over_tac, 0.94, 1.0) * np.where(over_de, 0.90, 1.0)
        lab[..., 1] *= scale
        lab[..., 2] *= scale
        cur[idx] = np.round(lab_to_srgb(lab)).astype(np.uint8)
        bad = over_tac | over_de
        if not bad.any():
            break
        idx = (idx[0][bad], idx[1][bad])
    tac2 = tac_of(cur, to_cmyk)
    de2 = roundtrip_de(cur, to_cmyk, jc_to_srgb)
    print(f"  联合压缩完成: {it} 轮，TAC max={tac2.max():.1f}%，dE00 max={de2.max():.2f} "
          f"mean={de2.mean():.3f}，残差 {int(((tac2 > tac_target) | (de2 > de_thresh)).sum())} px")
    assert tac2.max() <= 280.0, "TAC 压缩未收敛到 280% 以内"
    assert de2.max() <= 8.0, "色域压缩未收敛到 dE00<=8"
    return cur, {"normalized_px": n0, "iters": it}


def repair_front():
    im = Image.open(os.path.join(SRC, "front_orig.png")).convert("RGB")
    d = ImageDraw.Draw(im)

    # QR 面板：装饰拱形边框、两侧花纹、标题全部原样保留；
    # 平涂仅限 QR_BLOCK 外扩 4px（清鲸鱼水印/斜纹/旧角标，静默区全净）
    fill(d, QR_FLAT_RECT, PAPER)
    fill(d, STRIP_BRIDGE, PAPER)

    # 兑换码组合体：深蓝标签带 + 米色胶囊条（保留原形制，仅加宽），中心 (3056,1224)
    # 深蓝带顶 1134 距 QR 占位底 1107 留 27px，不侵入静默区（t15 队长裁定保留）
    d.rounded_rectangle((CODE_BODY[0], CODE_BODY[1], CODE_BODY[2] - 1, CODE_BODY[3] - 1),
                        radius=14, fill=NAVY)
    f_lab = font(30)
    draw_centered(d, 3056, CODE_LABEL_Y, CODE_LABEL, f_lab, PAPER,
                  CODE_BODY[2] - CODE_BODY[0] - 80, "兑换码标签")
    d.rounded_rectangle((CODE_PILL[0], CODE_PILL[1], CODE_PILL[2] - 1, CODE_PILL[3] - 1),
                        radius=58, fill=PAPER, outline=NAVY, width=2)

    # 序列号铭牌：只铺平内膛留白，不放字
    fill(d, SERIAL_FILL, PAPER)
    return im


def repair_back():
    im = Image.open(os.path.join(SRC, "back_orig.png")).convert("RGB")
    d = ImageDraw.Draw(im)

    # 顶部横幅：丝带内膛铺平，第1行写定稿标题，第2行留空（玩梗位）
    fill(d, BACK_BANNER_FILL, PAPER)
    f_title = font(STRIP_FONT_PX)
    draw_centered(d, (BACK_BANNER[0] + BACK_BANNER[2]) / 2, BANNER_TITLE_Y,
                  BANNER_TITLE, f_title, NAVY,
                  BACK_BANNER[2] - BACK_BANNER[0] - 40, "顶部横幅标题")

    # 左下/右下横幅：保留雕花框与罗盘端饰，内膛铺平，三行居中写入定稿文案
    f_line = font(STRIP_FONT_PX)
    for rect, fl, lines in ((BACK_LEFT, BACK_LEFT_FILL, LEFT_LINES),
                            (BACK_RIGHT, BACK_RIGHT_FILL, RIGHT_LINES)):
        fill(d, fl, PAPER)
        cx = (rect[0] + rect[2]) / 2
        for i, line in enumerate(lines):
            draw_centered(d, cx, STRIP_FIRST_TOP + i * STRIP_PITCH, line, f_line,
                          NAVY, rect[2] - rect[0] - 96, f"横幅第{i+1}行")
    return im


def mm(v):
    return round(v / PXMM, 2)


def rect_mm(r):
    return {"px": list(r), "mm": [mm(r[2] - r[0]), mm(r[3] - r[1])]}


def write_layouts():
    front = {
        "canvas": {"px": [W, H], "mm": [mm(W), mm(H)], "px_per_mm": PXMM, "bleed": "none"},
        "source": "assets/src/front_orig.png（用户原稿，只读）",
        "qr_zone": {**rect_mm(QR_ZONE), "center_px": [3063, 767],
                    "note": "二维码预留区 680x680；区内仅平涂米色底（t15 起四角 L 角标移除，"
                            "无任何图形线条；标题按契约原样保留在 y<=475）；装饰边框原样保留"},
        "flat_rect": {**rect_mm(QR_FLAT_RECT),
                      "note": "t19：唯一平涂区=QR_BLOCK 外扩 4px；矩形之外面板装饰拱形边框/"
                              "两侧花纹/角部纹样与原稿逐像素一致"},
        "qr_clean_field": {**rect_mm(QR_CLEAN_FIELD),
                           "note": "QR 周边干净区域（仅供生成器参考，不再整片平涂）"},
        "qr_block": {**rect_mm(QR_BLOCK),
                     "symbol_px": list(QR_SYMBOL),
                     "note": "EC M：29 模块+四边 4 模块静默区，模块 17px=0.602mm；"
                             "内容 493px 中心 (3063,792)，静默区 68px 四边无深色"},
        "code_strip": {**rect_mm(CODE_BODY), "center_px": [3056, 1224],
                       "label": CODE_LABEL,
                       "code_area": {**rect_mm(CODE_AREA),
                                     "usable_px": CODE_AREA[2] - CODE_AREA[0],
                                     "usable_mm": mm(CODE_AREA[2] - CODE_AREA[0]),
                                     "per_char_px_14": (CODE_AREA[2] - CODE_AREA[0]) / 14,
                                     "per_char_mm_14": mm((CODE_AREA[2] - CODE_AREA[0]) / 14)},
                       "pill": rect_mm(CODE_PILL),
                       "note": "深蓝标签带+米色胶囊条（t15 裁定保留）；明文码由生成器叠加"},
        "serial_band": {**rect_mm(SERIAL_BAND), "center_px": [760, 1496],
                        "note": "序列号位留白（底图不放字）；格式 No. 0001 / 0600，"
                                "字高 >=1.4mm(>=40px) 居中，由生成器叠加"},
    }
    back = {
        "canvas": {"px": [W, H], "mm": [mm(W), mm(H)], "px_per_mm": PXMM, "bleed": "none"},
        "source": "assets/src/back_orig.png（用户原稿，只读）",
        "top_banner": {**rect_mm(BACK_BANNER),
                       "title": {"text": BANNER_TITLE, "row_px": [BACK_BANNER[0], 128,
                                  BACK_BANNER[2], 205], "font_px": STRIP_FONT_PX,
                                 "font_mm": mm(STRIP_FONT_PX), "font": "SimSun"},
                       "joke_reserve": {**rect_mm(BACK_JOKE),
                                        "note": "第2行 y205-272 留空，玩梗由生成器叠加"}},
        "left_strip": {**rect_mm(BACK_LEFT), "lines": LEFT_LINES, "font": "SimSun",
                       "font_px": STRIP_FONT_PX, "font_mm": mm(STRIP_FONT_PX),
                       "line_pitch_px": STRIP_PITCH, "first_line_top": STRIP_FIRST_TOP,
                       "align": "center"},
        "right_strip": {**rect_mm(BACK_RIGHT), "lines": RIGHT_LINES, "font": "SimSun",
                        "font_px": STRIP_FONT_PX, "font_mm": mm(STRIP_FONT_PX),
                        "line_pitch_px": STRIP_PITCH, "first_line_top": STRIP_FIRST_TOP,
                        "align": "center"},
        "serial_note": "背面不放编号；序列号位在正面左下横带 (464,1456)-(1056,1536)",
    }
    with open(os.path.join(HERE, "layout_front.json"), "w", encoding="utf-8") as f:
        json.dump(front, f, ensure_ascii=False, indent=2)
    with open(os.path.join(HERE, "layout_back.json"), "w", encoding="utf-8") as f:
        json.dump(back, f, ensure_ascii=False, indent=2)


def save_outputs(arr, tag, srgb_bytes, jc_bytes, to_cmyk, jc_to_srgb):
    arr, norm = normalize_pixels(arr, to_cmyk, jc_to_srgb)
    rgb_im = Image.fromarray(arr)
    rgb_im.save(os.path.join(HERE, f"{tag}_rgb.png"), icc_profile=srgb_bytes, optimize=True)
    cmyk = np.array(ImageCms.applyTransform(rgb_im, to_cmyk))
    tac = cmyk.astype(np.uint16).sum(axis=2) * 100.0 / 255.0
    print(f"  {tag}_cmyk.png: TAC max={tac.max():.1f}% >280% 占比={(tac > 280).mean() * 100:.4f}%")
    assert tac.max() <= 280.0
    packed = Image.fromarray(cmyk)  # RGBA 打包: R=C,G=M,B=Y,A=K
    info = PngImagePlugin.PngInfo()
    info.add_text("ColorSpace", "CMYK-packed: R=C,G=M,B=Y,A=K")
    info.add_text("ICC", "JapanColor2001Coated")
    packed.save(os.path.join(HERE, f"{tag}_cmyk.png"), icc_profile=jc_bytes,
                pnginfo=info, optimize=True)
    return norm


def main():
    with open(SRGB_ICC, "rb") as f:
        srgb_bytes = f.read()
    with open(JC_ICC, "rb") as f:
        jc_bytes = f.read()
    srgb_prof = ImageCms.getOpenProfile(SRGB_ICC)
    jc_prof = ImageCms.getOpenProfile(JC_ICC)
    to_cmyk = ImageCms.buildTransform(srgb_prof, jc_prof, "RGB", "CMYK",
                                      renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
    jc_to_srgb = ImageCms.buildTransform(jc_prof, srgb_prof, "CMYK", "RGB",
                                         renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)

    print("正面修复:")
    front = np.array(repair_front())
    norm_f = save_outputs(front, "front", srgb_bytes, jc_bytes, to_cmyk, jc_to_srgb)
    print("背面修复:")
    back = np.array(repair_back())
    norm_b = save_outputs(back, "back", srgb_bytes, jc_bytes, to_cmyk, jc_to_srgb)
    write_layouts()
    print(f"完成。联合压缩像素: 正面 {norm_f['normalized_px']}，背面 {norm_b['normalized_px']}")


if __name__ == "__main__":
    main()
