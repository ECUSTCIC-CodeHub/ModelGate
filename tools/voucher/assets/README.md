# 鲸元券底图（t6 产物）

以用户原稿（深度求索银行·鲸元券，3840x1648）为唯一底图做定点修复，产出 RGB + CMYK 双版本印刷级底图。
画布 3840x1648 px（28.235 px/mm，约 136.0x58.4 mm），四周不加出血。

## 文件

| 文件 | 说明 |
| --- | --- |
| front_rgb.png / back_rgb.png | sRGB 底图，内嵌 sRGB ICC |
| front_cmyk.png / back_cmyk.png | CMYK 底图（JapanColor2001Coated），**RGBA 通道打包** |
| layout_front.json / layout_back.json | 版面几何与文案契约（生成器按此叠加可变层） |
| color_report.json | ΔE00 / TAC / 最差色块 / 超色域占比 / 对原稿漂移 |
| build_assets.py | 构建脚本（修复 + TAC/色域联合压缩 + 双版本导出） |
| icc/JapanColor2001Coated.icc、icc/sRGB.icc | 转换与嵌入用 ICC |
| src/front_orig.png、src/back_orig.png | 用户原稿只读副本（构建输入，勿改） |

## CMYK PNG 打包约定（Pillow 不能直接写 CMYK 模式 PNG）

PNG 文件为 RGBA 模式，四通道依次为 C、M、Y、K（R=C, G=M, B=Y, A=K），
iCCP 块嵌入 JapanColor2001Coated，PNG text 块带 ColorSpace=CMYK-packed 标记。
读取：

    import numpy as np
    from PIL import Image
    im = Image.open("front_cmyk.png")
    assert im.info["ColorSpace"].startswith("CMYK-packed")
    cmyk = np.array(im)            # [...,0]=C [...,1]=M [...,2]=Y [...,3]=K
    icc = im.info["icc_profile"]   # JapanColor2001Coated，可作 PDF/X OutputIntent

## 可变位最终矩形（半开区间 px，与 layout_*.json 一致）

- 二维码预留区 QR_ZONE = (2723,427)-(3403,1107)，680x680，中心 (3063,767)；
  区内仅平涂米色底——t15 起四角 L 角标整体移除，无任何图形/线条侵入静默区；
  装饰边框、深蓝标签带、标题「兑换二维码 SCAN TO REDEEM」全部原样保留。
- 二维码连静默区实际占位 QR_BLOCK = (2748,478)-(3377,1107)（EC M、29 模块、
  模块 17px=0.602mm）：内容方阵 (2816,546)-(3309,1039)，四边静默区各 68px，
  全部落在平涂米色上（check_regions.py 有四边静默带无深色像素断言）。
- t19 起平涂范围收窄为 FLAT_RECT = (2744,474)-(3381,1111)（QR_BLOCK 外扩 4px），
  面板装饰拱形边框、两侧花纹、角部纹样与原稿逐像素一致（仅 QR 实际需要的
  方块内平涂）；矩形外区域与原稿的差异校验断言已加入 check_regions.py。
- 兑换码组合体 CODE_BODY = (2516,1134)-(3596,1314)，1080x180，中心 (3056,1224)；
  深蓝标签带（「兑换码 REDEMPTION CODE」）+ 米色胶囊条；
  明文码绘制区 CODE_AREA = (2548,1198)-(3564,1302)，可用宽 1016px=35.98mm。
- 序列号位 SERIAL_BAND = (464,1456)-(1056,1536)，平涂留白（底图不放字）；
  生成器写「No. 0001 / 0600」，字高 >=1.4mm（>=40px），居中 (760,1496)。
- 背面玩梗行 BACK_JOKE = (1466,206)-(2390,260)，留白（横幅第 2 行）。
- 背面两条横幅的三行文案已在底图写死（逐字见 layout_back.json）。

## 重建与校验

    python tools/voucher/assets/build_assets.py   # 重建四张底图 + layout JSON
    python tools/voucher/check_regions.py         # 区域/版面校验（46 项）
    python tools/voucher/color_report.py          # ΔE00/TAC/色域报告

色彩口径：RGB->CMYK 与 CMYK->sRGB 均为 JapanColor2001Coated 相对色度；
交付前对原稿做了 Lab 域逐像素联合压缩（TAC 目标 <=276%，往返 dE00 目标 <=3），
最深处油墨蓝因此略有提亮（对原稿漂移统计见 color_report.json 的 vs_original_drift，
这是 TAC<=280% 印刷约束的必要代价）。
