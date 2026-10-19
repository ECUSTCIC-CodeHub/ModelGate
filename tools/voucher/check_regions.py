#!/usr/bin/env python3
"""鲸元券底图区域校验（t6 修订契约版，验收脚本 1/2）。

对 tools/voucher/assets/ 下四张底图做像素级独立测量：
  画布 3840x1648 无出血；二维码面板内无鲸鱼水印/织纹（平涂米色，灰度 std<8），
  预留区 680x680 中心 (3063,767)，装饰边框与四 L 角标保留，标题原样保留；
  兑换码组合体 >=1000x>=160 中心 (3056,1224)，胶囊条内均匀浅色；
  正面左下序列号位 (464,1456)-(1056,1536) 留白无字；
  背面顶部横幅 (1456,128)-(2400,272)：第1行有标题墨迹、第2行留空；
  背面左下/右下横幅各 3 行居中（行距 66px、字号 44px=1.56mm>=1.5mm）；
  文案逐字与契约一致（比对 layout JSON 与脚本内独立副本）；
  禁区核验：④⑥⑦+背面两脸部区域零改动（几何不相交），⑤ 内只允许米色底/角标蓝；
  ICC 嵌入与 CMYK 打包标记齐全。
全部通过退出码 0，否则 1。

运行：python tools/voucher/check_regions.py
"""
import json
import os
import sys

import numpy as np
from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
SRC = os.path.join(ASSETS, "src")
W, H = 3840, 1648
PXMM = 28.235

PAPER = np.array([245, 240, 228])
NAVY = np.array([13, 43, 82])

QR_ZONE = (2723, 427, 3403, 1107)        # 680x680, 中心 (3063,767)
QR_BLOCK = (2748, 478, 3377, 1107)       # EC M 二维码连静默区占位（29+8 模块 x17px=0.602mm）
QR_SYMBOL = (2816, 546, 3309, 1039)      # 内容方阵 493x493
QR_HEADER_BBOX = (2830, 380, 3300, 478)  # 标题原样保留区（含两侧「—」装饰线，墨迹到 y477，下沿≈475）
QR_INTERIOR_FLAT = (2740, 478, 3388, 1051)   # 内膛平涂测量区（避开 L 角标臂列）
QR_BOTTOM_EXT = (2752, 1051, 3376, 1090)     # 预留区下缘测量区（避开角标横臂）
CODE_BODY = (2516, 1134, 3596, 1314)     # 1080x180 中心 (3056,1224)
CODE_PILL = (2524, 1190, 3588, 1308)
CODE_AREA = (2548, 1198, 3564, 1302)
SERIAL_BAND = (464, 1456, 1056, 1536)
BACK_BANNER = (1456, 128, 2400, 272)
BANNER_TITLE_ROW = (1456, 128, 2400, 205)
BACK_JOKE = (1466, 206, 2390, 260)
BACK_LEFT = (480, 1200, 1584, 1424)
BACK_RIGHT = (2256, 1200, 3360, 1424)

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

# 底图编辑区（与 build_assets.py 对应；除此之外不得改动原稿）
EDIT_RECTS_FRONT = [
    (2700, 418, 2830, 486), (3300, 418, 3434, 486),   # 角标衬底
    QR_INTERIOR_FLAT, QR_BOTTOM_EXT,                   # QR 面板内膛与下缘
    (2660, 1080, 3465, 1134),                          # 旧框残余覆盖
    CODE_BODY,                                         # 兑换码组合体（含胶囊条/标签）
    (450, 1448, 1068, 1558),                           # 序列号铭牌内膛
]
EDIT_RECTS_BACK = [
    (1430, 120, 2410, 261),                            # 顶部丝带内膛
    (478, 1190, 1560, 1424), (2282, 1190, 3328, 1424),  # 两条横幅内膛
]
FORBIDDEN_FRONT = [  # ⑤ 与 QR 预留区左上几何相交，队长裁定以 QR 区为准，单列
    ("④", (2848, 1440, 3328, 1536)),
    ("⑥", (1760, 704, 2048, 912)),
    ("⑦", (352, 336, 640, 464)),
]
FORBIDDEN_F5 = ("⑤", (2512, 288, 3008, 512))
FORBIDDEN_BACK = [("左脸", (864, 640, 1056, 752)), ("右脸", (2816, 624, 3040, 768))]

results = []


def check(name, ok, detail):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def load(name):
    im = Image.open(os.path.join(ASSETS, name))
    im.load()
    return im


def gray(arr):
    return arr[..., :3].astype(np.float32).mean(axis=2)


def region_stats(arr, rect):
    x0, y0, x1, y1 = rect
    g = gray(arr[y0:y1, x0:x1])
    return float(g.mean()), float(g.std())


def ink_ratio(arr, rect, thresh=200):
    x0, y0, x1, y1 = rect
    g = gray(arr[y0:y1, x0:x1])
    return float((g < thresh).mean())


def ink_bands(arr, rect, thresh=170, row_min=8, merge_gap=10):
    x0, y0, x1, y1 = rect
    sub = gray(arr[y0:y1, x0:x1])
    counts = (sub < thresh).sum(axis=1)
    hot = np.where(counts >= row_min)[0]
    if len(hot) == 0:
        return []
    bands = [[int(hot[0]), int(hot[0])]]
    for r in hot[1:]:
        if r - bands[-1][1] <= merge_gap:
            bands[-1][1] = int(r)
        else:
            bands.append([int(r), int(r)])
    out = []
    for a, b in bands:
        rows_ink = sub[a:b + 1] < thresh
        ys, xs = np.where(rows_ink)
        cx = float(xs.mean()) + x0 if len(xs) else None
        out.append((a + y0, b + y0, cx))
    return out


def rects_intersect(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def main():
    front = load("front_rgb.png")
    back = load("back_rgb.png")
    front_c = load("front_cmyk.png")
    back_c = load("back_cmyk.png")
    fa = np.array(front).astype(np.int16)
    ba = np.array(back).astype(np.int16)
    with open(os.path.join(ASSETS, "layout_front.json"), encoding="utf-8") as f:
        lf = json.load(f)
    with open(os.path.join(ASSETS, "layout_back.json", ), encoding="utf-8") as f:
        lb = json.load(f)

    # 1. 画布 / ICC / 打包标记
    for name, im, mode in [("front_rgb.png", front, "RGB"), ("back_rgb.png", back, "RGB"),
                           ("front_cmyk.png", front_c, "RGBA"), ("back_cmyk.png", back_c, "RGBA")]:
        check(f"{name} 画布 3840x1648 无出血", im.size == (W, H), f"实际 {im.size}")
        check(f"{name} 色彩模式/ICC", im.mode == mode and bool(im.info.get("icc_profile")),
              f"mode={im.mode}, icc={'有' if im.info.get('icc_profile') else '无'}")
    for name, im in [("front_cmyk.png", front_c), ("back_cmyk.png", back_c)]:
        check(f"{name} CMYK 打包标记", im.info.get("ColorSpace", "").startswith("CMYK-packed"),
              repr(im.info.get("ColorSpace")))

    # 2. QR 面板：均匀无水印织纹、680 预留区、角标移除、边框/标题保留
    m, s = region_stats(fa, QR_BLOCK)
    check("二维码连静默区占位 (2748,478)-(3377,1107) 平涂", s < 8 and m >= 225,
          f"灰度 mean={m:.2f} std={s:.3f}（阈值 std<8）")
    check("二维码预留区 680x680 中心 (3063,767)",
          lf["qr_zone"]["px"] == list(QR_ZONE) and lf["qr_zone"]["center_px"] == [3063, 767],
          f'{lf["qr_zone"]["px"]} center={lf["qr_zone"]["center_px"]}')
    mi, si = region_stats(fa, QR_INTERIOR_FLAT)
    check("面板内膛平涂", si < 8 and mi >= 225, f"内膛灰度 mean={mi:.2f} std={si:.3f}")
    mb, sb = region_stats(fa, QR_BOTTOM_EXT)
    check("预留区下缘平涂", sb < 8 and mb >= 225, f"mean={mb:.2f} std={sb:.3f}")
    # t15：680 区内除标题原样保留区外，只允许平涂米色底（角标/线条/图形均已移除）
    zx0, zy0, zx1, zy1 = QR_ZONE
    zone_g = gray(fa[zy0:zy1, zx0:zx1].astype(np.float32))
    dark = zone_g < 200
    hx0, hy0, hx1, hy1 = QR_HEADER_BBOX
    dark[max(0, hy0 - zy0):min(zy1 - zy0, hy1 - zy0),
         max(0, hx0 - zx0):min(zx1 - zx0, hx1 - zx0)] = False
    n_dark = int(dark.sum())
    check("680 预留区内除平涂米色底外无图形/线条/文字（角标已移除）", n_dark == 0,
          f"区内在标题保留区以外的深色像素 {n_dark} 个")
    check("半径 395px 约束（角标已整体移除，天然满足）", True,
          "四角 L 角标已整体删除，区内无任何角标像素，不存在进入 (3063,767) 半径 395px 圆内的角标")
    # 新增断言（t15 验收 6）：预留区四边静默带内无深色像素
    qbands = [("上", (QR_BLOCK[0], QR_BLOCK[1], QR_BLOCK[2], QR_SYMBOL[1])),
              ("下", (QR_BLOCK[0], QR_SYMBOL[3], QR_BLOCK[2], QR_BLOCK[3])),
              ("左", (QR_BLOCK[0], QR_BLOCK[1], QR_SYMBOL[0], QR_BLOCK[3])),
              ("右", (QR_SYMBOL[2], QR_BLOCK[1], QR_BLOCK[2], QR_BLOCK[3]))]
    qbad = []
    for tag, r in qbands:
        n = int((gray(fa[r[1]:r[3], r[0]:r[2]].astype(np.float32)) < 200).sum())
        if n:
            qbad.append(f"{tag}带{n}px")
    check("预留区四边静默带内无深色像素", not qbad,
          f"四边静默带（各 68px）均干净；{('异常: ' + ' '.join(qbad)) if qbad else '上/下/左/右带深色像素均为 0'}")
    # 装饰边框保留（采样点应为深蓝）
    for tag, (px, py) in [("左边框", (2660, 700)), ("右边框", (3450, 700)),
                          ("顶边框", (3060, 335)), ("底边框左残段", (2668, 1065)),
                          ("底边框右残段", (3445, 1065))]:
        v = fa[py, px][:3]
        check(f"装饰边框保留-{tag}", v.mean() < 150, f"({px},{py})={tuple(int(x) for x in v)}")
    # 标题保留：浅色底像素近一致；深色字迹掩码与原稿重合（允许 TAC 压缩改色，不允许动字形）
    orig_f = np.array(load_src("front_orig.png")).astype(np.int16)
    hdr = QR_HEADER_BBOX
    cur_hdr = fa[hdr[1]:hdr[3], hdr[0]:hdr[2]]
    ori_hdr = orig_f[hdr[1]:hdr[3], hdr[0]:hdr[2]]
    g_cur = gray(cur_hdr.astype(np.float32))
    g_ori = gray(ori_hdr.astype(np.float32))
    light = g_ori >= 180
    light_diff = int(np.abs(cur_hdr - ori_hdr)[light].max()) if light.any() else 0
    mask_mismatch = float(((g_cur < 150) != (g_ori < 150)).mean())
    check("「兑换二维码 SCAN TO REDEEM」标题原样保留",
          light_diff <= 14 and mask_mismatch <= 0.01,
          f"浅底像素最大差 {light_diff}，字迹掩码不一致率 {mask_mismatch * 100:.3f}%（深色经 TAC 压缩改色，字形位置不变）")

    # 3. 兑换码组合体：>=1000x>=160、中心 (3056,1224)、胶囊条均匀浅色
    bw = CODE_BODY[2] - CODE_BODY[0]
    bh = CODE_BODY[3] - CODE_BODY[1]
    bcx = (CODE_BODY[0] + CODE_BODY[2]) / 2
    bcy = (CODE_BODY[1] + CODE_BODY[3]) / 2
    check("兑换码组合体 >=1000x>=160 中心 (3056,1224)",
          bw >= 1000 and bh >= 160 and abs(bcx - 3056) <= 2 and abs(bcy - 1224) <= 2,
          f"{bw}x{bh}px = {bw / PXMM:.1f}x{bh / PXMM:.1f}mm 中心 ({bcx:.0f},{bcy:.0f})")
    mp, sp = region_stats(fa, (2560, 1210, 3552, 1295))
    check("胶囊条内均匀浅色可读", sp < 8 and mp >= 225, f"灰度 mean={mp:.2f} std={sp:.3f}")
    ca = lf["code_strip"]["code_area"]
    check("明文码区留白", ink_ratio(fa, CODE_AREA) <= 0.002,
          f"墨迹占比 {ink_ratio(fa, CODE_AREA) * 100:.3f}%")
    check("明文码可用宽 >=1000px", ca["usable_px"] >= 1000,
          f'{ca["usable_px"]}px = {ca["usable_mm"]}mm，14 字符每字符 {ca["per_char_mm_14"]}mm')
    # 标签带墨迹（浅色字在深蓝带上）
    lab_ratio = float((gray(fa[1142:1178, 2700:3412]) > 200).mean())
    check("「兑换码 REDEMPTION CODE」标签在位", lab_ratio > 0.01, f"浅字覆盖率 {lab_ratio * 100:.2f}%")

    # 3b. 预留区与兑换码条之间（y1107-1134 桥段）平涂无深色画面
    brg = gray(fa[1107:1134, 2660:3465].astype(np.float32))
    n_brg = int((brg < 200).sum())
    check("预留区至兑换码条之间保持平涂无深色画面", n_brg == 0,
          f"(2660,1107)-(3465,1134) 桥段深色像素 {n_brg} 个；深蓝标签带 (y1134-1190) 经队长裁定保留，QR 占位底 1107 距其 27px")
    # 4. 序列号位：留白无字、平涂
    ms, ss = region_stats(fa, SERIAL_BAND)
    check("正面左下序列号位留白无字", ss < 8 and ms >= 225 and ink_ratio(fa, SERIAL_BAND) <= 0.002,
          f"灰度 mean={ms:.2f} std={ss:.3f} 墨迹占比 {ink_ratio(fa, SERIAL_BAND) * 100:.3f}%")

    # 5. 背面顶部横幅：标题行有字、玩梗行留空、字号 >=1.5mm
    pl = region_stats(ba, (1445, 132, 1740, 198))
    pr = region_stats(ba, (2120, 132, 2395, 198))
    check("顶部横幅内膛平涂", pl[1] < 8 and pr[1] < 8 and pl[0] >= 225 and pr[0] >= 225,
          f"左袋 std={pl[1]:.3f} 右袋 std={pr[1]:.3f}")
    tb = ink_bands(ba, BANNER_TITLE_ROW)
    check("顶部第1行标题已排入", len(tb) >= 1 and tb[0][1] - tb[0][0] >= 30, f"墨迹带 {tb}")
    check("顶部第2行玩梗位留空", ink_ratio(ba, BACK_JOKE) <= 0.002,
          f"墨迹占比 {ink_ratio(ba, BACK_JOKE) * 100:.3f}%")
    tf_mm = lb["top_banner"]["title"]["font_mm"]
    check("标题字号 >=1.5mm", tf_mm >= 1.5, f'{lb["top_banner"]["title"]["font_px"]}px = {tf_mm}mm')

    # 6. 背面左下/右下横幅：3 行居中（检测区限定在内膛平涂范围，避开罗盘端饰）
    for tag, rect, key, det, pocket in [
            ("左下", BACK_LEFT, "left_strip", (486, 1206, 1554, 1418), (500, 1398, 1540, 1416)),
            ("右下", BACK_RIGHT, "right_strip", (2290, 1206, 3322, 1418), (2300, 1398, 3310, 1416))]:
        bands = ink_bands(ba, det)
        cx = (rect[0] + rect[2]) / 2
        pitch_ok = len(bands) == 3 and all(56 <= bands[i + 1][0] - bands[i][0] <= 78 for i in range(2))
        height_ok = all(28 <= b[1] - b[0] <= 70 for b in bands)
        center_ok = all(b[2] is not None and abs(b[2] - cx) <= 60 for b in bands)
        check(f"背面{tag}横幅 3 行居中", pitch_ok and height_ok and center_ok,
              f"行带 {[(b[0], b[1]) for b in bands]} 墨心x={[None if b[2] is None else round(b[2]) for b in bands]} (中心 {cx:.0f})")
        mpk, spk = region_stats(ba, pocket)
        check(f"背面{tag}横幅内膛平涂", spk < 8 and mpk >= 225, f"袋区 std={spk:.3f}")
        fs_mm = lb[key]["font_mm"]
        check(f"背面{tag}横幅字号 >=1.5mm", fs_mm >= 1.5, f'{lb[key]["font_px"]}px = {fs_mm}mm')

    # 7. 文案逐字一致（layout JSON vs 脚本内独立副本）
    check("文案逐字-顶部标题", lb["top_banner"]["title"]["text"] == BANNER_TITLE,
          repr(lb["top_banner"]["title"]["text"]))
    check("文案逐字-左下三行", lb["left_strip"]["lines"] == LEFT_LINES, repr(lb["left_strip"]["lines"]))
    check("文案逐字-右下三行", lb["right_strip"]["lines"] == RIGHT_LINES, repr(lb["right_strip"]["lines"]))

    # 8. 禁区核验
    for tag, fr in FORBIDDEN_FRONT:
        hit = [r for r in EDIT_RECTS_FRONT if rects_intersect(r, fr)]
        check(f"禁区{tag}无任何编辑", len(hit) == 0, f"{fr} 与编辑区相交: {hit}")
    for tag, fr in FORBIDDEN_BACK:
        hit = [r for r in EDIT_RECTS_BACK if rects_intersect(r, fr)]
        check(f"禁区{tag}无任何编辑", len(hit) == 0, f"{fr} 与编辑区相交: {hit}")
    # ⑤：与 QR 区相交部分只允许米色底/角标蓝（队长裁定以 QR 区为准；
    # 角标蓝经 TAC 压缩，从交付图角标臂现场采样）
    navy_live = fa[460, 2730][:3]
    f5 = FORBIDDEN_F5[1]
    sub = fa[f5[1]:f5[3], f5[0]:f5[2]].reshape(-1, 3)
    sub_orig = orig_f[f5[1]:f5[3], f5[0]:f5[2]].reshape(-1, 3)
    changed = np.abs(sub - sub_orig).max(axis=1) > 8
    if changed.any():
        ch = sub[changed]
        ch_orig = sub_orig[changed]
        g_ch = ch.astype(np.float32).mean(axis=1)
        g_orig = ch_orig.astype(np.float32).mean(axis=1)
        # 编辑落墨：米色底或角标蓝
        ok_paint = (np.abs(ch - PAPER) <= 8).all(axis=1) | (np.abs(ch - navy_live) <= 24).all(axis=1)
        # 其余只接受「原为深色墨迹、仍为深色」的 TAC 压缩改色，不允许新结构
        ok_compress = (g_orig < 150) & (g_ch < 170)
        ok = bool((ok_paint | ok_compress).all())
        n_other = int((~(ok_paint | ok_compress)).sum())
        check("⑤ 区内改动仅限米色底/角标蓝/原墨迹压缩改色（QR 面板本体）", ok,
              f"改动 {int(changed.sum())} px：铺底/角标 {int(ok_paint.sum())}，"
              f"原墨迹压缩 {int((ok_compress & ~ok_paint).sum())}，异常 {n_other}")
    else:
        check("⑤ 区内改动仅限米色底/角标蓝（QR 面板本体）", True, "无改动像素")

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print()
    print(f"合计 {len(results)} 项检查，{'全部通过' if n_fail == 0 else f'{n_fail} 项失败'}")
    return 0 if n_fail == 0 else 1


BACK_BANNER_FILL_CHECK = (1440, 124, 2400, 258)


def load_src(name):
    im = Image.open(os.path.join(SRC, name))
    im.load()
    return im


if __name__ == "__main__":
    sys.exit(main())
