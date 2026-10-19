#!/usr/bin/env python3
"""券面底图色彩对齐报告（t6 验收脚本 2/2）。

对 front/back 各做一次：
  1) 读 RGB 底图（sRGB）与 CMYK 底图（RGBA 打包：R=C,G=M,B=Y,A=K）；
  2) 用 JapanColor2001Coated -> sRGB（相对色度）把 CMYK 反算回 sRGB；
  3) 逐像素 CIEDE2000：阈值 mean<=2.5、p95<=5、max<=8；
  4) TAC 总墨量：阈值 max<=280%，并报告超限像素占比；
  5) 超色域像素占比（往返 dE00>2.0 视作超色域，打印口径说明）；
  6) 最差色块：320x320px 网格按 mean dE00 取前 5。
报告落盘 tools/voucher/assets/color_report.json；全部达标退出码 0，否则 1。

运行：python tools/voucher/color_report.py
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageCms

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
SRGB_ICC = os.path.join(ASSETS, "icc", "sRGB.icc")
JC_ICC = os.path.join(ASSETS, "icc", "JapanColor2001Coated.icc")

DE_MEAN_MAX = 2.5
DE_P95_MAX = 5.0
DE_MAX_MAX = 8.0
TAC_MAX = 280.0
GAMUT_DE = 2.0  # 往返 dE00 超过此值记为超色域（量化误差约 0.3，留足余量）

M_SRGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
], dtype=np.float32)
WHITE_D65 = np.array([95.047, 100.0, 108.883], dtype=np.float32)


def srgb_to_lab(rgb_u8):
    rgb = rgb_u8.astype(np.float32) / 255.0
    rgb = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = (rgb @ M_SRGB2XYZ.T) * 100.0 / WHITE_D65
    d = 6.0 / 29.0
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def delta_e00(lab1, lab2):
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    Cbar7 = Cbar ** 7
    G = 0.5 * (1.0 - np.sqrt(Cbar7 / (Cbar7 + 25.0 ** 7)))
    a1p = a1 * (1.0 + G)
    a2p = a2 * (1.0 + G)
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
    hbarp = np.where(cc == 0, hsum,
                     np.where(hadj <= 180.0, hsum / 2.0,
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


def load_packed_cmyk(name):
    im = Image.open(os.path.join(ASSETS, name))
    im.load()
    assert im.mode == "RGBA" and im.info.get("ColorSpace", "").startswith("CMYK-packed"),         f"{name} 不是 CMYK 打包 PNG"
    arr = np.array(im)
    return Image.fromarray(arr, "CMYK"), arr


def worst_patches(de, rgb, cell=320, top=5):
    h, w = de.shape
    out = []
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            blk = de[y:y + cell, x:x + cell]
            out.append({
                "rect_px": [x, y, min(x + cell, w), min(y + cell, h)],
                "mean_dE00": round(float(blk.mean()), 3),
                "max_dE00": round(float(blk.max()), 3),
                "src_rgb": [int(v) for v in rgb[y:y + cell, x:x + cell].reshape(-1, 3).mean(axis=0).round()],
            })
    out.sort(key=lambda r: -r["mean_dE00"])
    return out[:top]


def analyze(tag, rgb_name, cmyk_name, jc_to_srgb):
    rgb_im = Image.open(os.path.join(ASSETS, rgb_name)).convert("RGB")
    rgb = np.array(rgb_im)
    orig_path = os.path.join(ASSETS, "src", f"{tag == '正面' and 'front' or 'back'}_orig.png")
    drift = None
    if os.path.exists(orig_path):
        orig = np.array(Image.open(orig_path).convert("RGB"))
        if orig.shape == rgb.shape:
            d = delta_e00(srgb_to_lab(orig), srgb_to_lab(rgb))
            drift = {"mean": round(float(d.mean()), 4), "p95": round(float(np.percentile(d, 95)), 4),
                     "max": round(float(d.max()), 4),
                     "note": "交付 RGB 与原稿的 dE00 漂移（TAC 压缩所致，仅供参考不卡阈值）"}
    cmyk_im, cmyk_arr = load_packed_cmyk(cmyk_name)
    assert rgb_im.size == cmyk_im.size, f"{tag}: RGB 与 CMYK 尺寸不一致"
    roundtrip = np.array(ImageCms.applyTransform(cmyk_im, jc_to_srgb))

    lab1 = srgb_to_lab(rgb)
    lab2 = srgb_to_lab(roundtrip)
    de = delta_e00(lab1, lab2)
    de_mean = float(de.mean())
    de_p95 = float(np.percentile(de, 95))
    de_max = float(de.max())
    oog = float((de > GAMUT_DE).mean() * 100.0)

    tac = cmyk_arr.astype(np.uint16).sum(axis=2).astype(np.float32) * 100.0 / 255.0
    tac_max = float(tac.max())
    tac_mean = float(tac.mean())
    tac_over = float((tac > TAC_MAX).mean() * 100.0)

    ok = (de_mean <= DE_MEAN_MAX and de_p95 <= DE_P95_MAX and de_max <= DE_MAX_MAX
          and tac_max <= TAC_MAX)
    print(f"== {tag} ({rgb_name} vs {cmyk_name}) ==")
    print(f"  dE00:  mean={de_mean:.3f} (<=2.5)  p95={de_p95:.3f} (<=5)  max={de_max:.3f} (<=8)"
          f"  -> {'PASS' if de_mean <= DE_MEAN_MAX and de_p95 <= DE_P95_MAX and de_max <= DE_MAX_MAX else 'FAIL'}")
    print(f"  TAC:   max={tac_max:.2f}% (<=280%)  mean={tac_mean:.2f}%  超限像素占比={tac_over:.4f}%"
          f"  -> {'PASS' if tac_max <= TAC_MAX else 'FAIL'}")
    print(f"  超色域像素占比（往返 dE00>{GAMUT_DE}）: {oog:.4f}%")
    print(f"  最差色块（320px 网格，按 mean dE00 排序取前 5）:")
    patches = worst_patches(de, rgb)
    for p in patches:
        print(f"    rect={p['rect_px']} mean={p['mean_dE00']:.3f} max={p['max_dE00']:.3f} src_rgb={p['src_rgb']}")
    print()
    return ok, {
        "pair": [rgb_name, cmyk_name],
        "dE00": {"mean": round(de_mean, 4), "p95": round(de_p95, 4), "max": round(de_max, 4),
                 "thresholds": {"mean": DE_MEAN_MAX, "p95": DE_P95_MAX, "max": DE_MAX_MAX}},
        "TAC": {"max_pct": round(tac_max, 2), "mean_pct": round(tac_mean, 2),
                "over_limit_ratio_pct": round(tac_over, 5), "limit_pct": TAC_MAX},
        "out_of_gamut_ratio_pct": round(oog, 5),
        "out_of_gamut_definition": f"roundtrip dE00 > {GAMUT_DE}",
        "worst_patches": patches,
        "vs_original_drift": drift,
    }


def main():
    srgb = ImageCms.getOpenProfile(SRGB_ICC)
    jc = ImageCms.getOpenProfile(JC_ICC)
    jc_to_srgb = ImageCms.buildTransform(jc, srgb, "CMYK", "RGB",
                                         renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
    print("色彩对齐报告：JapanColor2001Coated -> sRGB 相对色度反算，逐像素 CIEDE2000")
    print()
    ok1, r1 = analyze("正面", "front_rgb.png", "front_cmyk.png", jc_to_srgb)
    ok2, r2 = analyze("背面", "back_rgb.png", "back_cmyk.png", jc_to_srgb)
    report = {
        "profile": "JapanColor2001Coated",
        "intent": "relative-colorimetric",
        "pairs": [r1, r2],
        "verdict": "pass" if (ok1 and ok2) else "fail",
    }
    with open(os.path.join(ASSETS, "color_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"汇总: {'全部达标' if ok1 and ok2 else '存在未达标项'}，报告已写入 assets/color_report.json")
    return 0 if ok1 and ok2 else 1


if __name__ == "__main__":
    sys.exit(main())
