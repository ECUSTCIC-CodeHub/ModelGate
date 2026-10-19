# 兑换券生成器

读「兑换码 CSV + 文案清单 txt」，产出 **A4 横向 6-up 双面拼版 PDF**（RGB 与 CMYK 两套），每张券叠四个可变位：
二维码、明文兑换码、序列号、随机玩梗。改文案只改 txt，不用改代码。

## 一、最短路径

```bash
# 1) 先体检文案宽度（几秒钟，不出 PDF）
python tools/voucher/generate/make_vouchers.py --csv tools/voucher/mock/codes_mock.csv --check-quotes

# 2) 正式生成（RGB + CMYK 两套）
python tools/voucher/generate/make_vouchers.py --csv <真实兑换码.csv> --quotes tools/voucher/quotes.txt --out tools/voucher/out

# 3) 自检（34 项，含像素级核对）
python tools/voucher/generate/selfcheck.py
```

输出：

| 文件 | 说明 |
| --- | --- |
| `tools/voucher/out/vouchers_rgb.pdf` | 屏幕/数码印刷用，DeviceRGB |
| `tools/voucher/out/vouchers_cmyk.pdf` | 胶印用，DeviceCMYK + OutputIntent(JapanColor2001Coated) |
| `tools/voucher/out/vouchers.manifest.json` | 每一页每个券位的券号、二维码内容、玩梗行号、图像对象号与矩形 |

奇数页正面、偶数页背面；左右翻转（`--flip h`）：正面 (c,r) 的券，背面印在 (1-c, r)，翻面后严格重合。

## 二、文案清单 tools/voucher/quotes.txt

纯文本，UTF-8（可带 BOM），**一行一条**，空行与 `#` 开头的注释行会被忽略：

```
用户彻底怒了。
你先别说话，我在推逻辑。
# 这是注释，不会印到券上
```

规则：

- 每一条都会在生成时按「背面横幅可用宽度 × 1.5mm 字高」量宽；超宽的条目**报错并指出行号与实测宽度**，不静默出图。
- 文案条数少于券数时按 `第 k 张券用第 (k mod N) 条` 确定性铺开，同一输入必然得到同一输出，并打印每条被使用的次数。
- 同一张纸上的 6 张券一定用 6 条不同文案；文案不足 6 条时按最大值铺开并打印告警。
- 清单为空直接报错，不会生成空白券。

## 三、兑换码 CSV

两列：`兑换码,批次`，首行可以是表头。读取用文件句柄 + `csv` 模块，**引号内的换行不会被吞**；
UTF-8（可带 BOM）、CRLF、字段两侧空格都能解析。

- **表头**：`兑换码` / `Codes` / `code` / `Code` 等常见写法都能识别；识别不到就按无表头处理，并打印一条提示。
- **逐行校验**：兑换码必须先转大写再匹配 `^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$`；不匹配时中文报错并给出**与实际文件一致的行号**。
- **查重**：归一化成大写后查重，`abcd-efgh-ijkl` 与 `ABCD-EFGH-IJKL` 判为重复并报错（带两处行号）。
- **编码**：非 UTF-8（例如 GBK 导出的 CSV）会中文报错并提示另存为「CSV UTF-8」，不会抛 traceback。
- **空文件**：直接报错，不生成空白券。

mock 数据（`tools/voucher/mock/codes_mock.csv`）与真实导出走的是同一个 `load_codes`，没有按文件名分支的逻辑。
序列号按 CSV 行序生成，从 `No. 0001 / 0600` 开始逐张递增。

## 四、四个可变位（冻结坐标，3840×1648 画布，28.2353 px/mm）

| 位 | 位置（px） | 内容 |
| --- | --- | --- |
| 正面二维码 | 静默区外框 x2748–3377 / y478–1107；内容方阵 x2816–3309 / y546–1039（493×493） | `https://ai.ecustcic.com/r/<CODE>`，纠错 M，纯黑 |
| 正面明文码 | 胶囊条 x2524–3588 / y1190–1308（可用排版区 x2548–3564 / y1198–1302） | `XXXX-XXXX-XXXX`：按实际字形自适应字号，**总宽 ≤ 可用宽的 96%（≈976px）**、**文字外接框落在胶囊条内四边各 ≥8px**、**字高 ≥2.6mm**（大写字母高度），水平居中于 x=3056 |
| 正面序列号 | x464–1056 / y1456–1536 | `No. 0001 / 0600`，1.4mm 字高 |
| 背面玩梗 | x1466–2390 / y206–260（横幅第 2 行） | 取自 quotes.txt，1.5mm 字高，924px 可用宽 |

二维码（r4 参数，与 `vouchers.manifest.json` 的 `qr` 段一致）：

- 纠错等级 **M**，**version 3 = 29×29 模块**
- 内容方阵 **493×493px**：(2816, 546)–(3309, 1039)，中心 (3062.5, 792.5)
- 模块 **17px = 0.6021mm** ≥ 0.60mm
- 四边静默区各 **68px**（= 4 个模块）：上 478–546、下 1039–1107、左 2748–2816、右 3309–3377；
  下静默区距底图深蓝标签带顶 y1134 还有 27px，左右外沿在装饰边框线 x2723 / x3403 内侧

静默区完全由底图的平涂留白提供（生成器不整平、不覆盖底图），四边实测暗像素为 0。
写出时会逐候选掩码用参考解码器试读，避免个别解码器对特定掩码的盲点（见 `vouchers.manifest.json` 里的
`qr_mask` / `qr_mask_reason`）；叠加层只画内容方阵，模块与理想矩阵的像素偏差逐张核对。

## 五、底图与颜色

`tools/voucher/assets/` 下放四张 3840×1648 PNG（**大体积 PNG/ICC 不入库**，`.gitignore` 只忽略这些；`build_assets.py`、
`layout_*.json` 与 `README.md` 仍正常入库，需要把某一版底图也入库时用 `git add -f`）：

- `front_rgb.png` / `back_rgb.png`：sRGB
- `front_cmyk.png` / `back_cmyk.png`：CMYK 按 RGBA 打包（R=C、G=M、B=Y、A=K），带 PNG 文本标记
  `ColorSpace=CMYK-packed: R=C,G=M,B=Y,A=K`（生成器按前缀 `CMYK-packed` 识别，缺标记时只提示不报错），ICC 走 iCCP

生成器对底图尺寸做硬断言，尺寸不符直接报错、**不做重采样**；CMYK 版只改 K 通道，二维码与文字都是 K100 单色黑。
OutputIntent 的 ICC 依次从 `--icc` → `tools/voucher/assets/icc/JapanColor2001Coated.icc` → CMYK 底图内嵌 ICC → Adobe 默认安装路径查找。

## 六、常用参数

| 参数 | 作用 |
| --- | --- |
| `--sheets N` | 只排前 N 张纸（联调用） |
| `--sets rgb` / `cmyk` | 只出一套 |
| `--flip v` | 改成上下翻转（默认 h 左右翻转） |
| `--font` / `--mono-font` | 指定中文字体 / 等宽字体 |
| `--on-overflow warn` | 超宽文案自动缩小字号继续（默认 error 报错停止） |
| `--layout 覆盖.json` | 覆盖区域矩形与二维码框（不改代码） |
| `--base-url` | 二维码里使用的站点地址（拼成 `<base-url>/r/<CODE>`），默认 `https://ai.ecustcic.com`；非法 URL 直接报错 |
| `--check-quotes` | 只体检文案宽度 |
| `--no-manifest` | 不写清单 JSON |

> 注意：域名越长，二维码内容越长（容量与模块尺寸挂钩）。换长域名后若报「模块小于 0.60mm」，需要加宽二维码方阵或缩短域名。

## 七、预览与自检

```bash
# 把某一页还原成 PNG 肉眼核对
python tools/voucher/generate/render_preview.py tools/voucher/out/vouchers_rgb.pdf --page 1 --dpi 130

# 完整自检（可选 --full-size 按 600 张券实测体积、--use-real-assets 用真实底图）
python tools/voucher/generate/selfcheck.py --full-size
```

自检覆盖：版式常量、二维码编码器码表与容量、二维码参数（纠错 M / version 3 / 29 模块 / 17px / 493×493 / 四边 68px）、
从 PDF 内嵌图像独立解出二维码内容、四边静默区逐边纯留白实测、下静默区到深蓝带间距、静默区是否落在底图平涂区内、
明文码的 96% 宽度 / 胶囊条内 ≥8px / 字高 ≥2.6mm 三条约束（清单里同时记录实测字高与总宽）、
CSV 健壮性（引号换行、表头变体、格式校验行号、大小写去重、GBK、空文件）、`--base-url` 默认/自定义/非法、
CMYK 的 K100 单色黑、OutputIntent/ICC、券图 1:1 零重采样、叠加层落点、正反面镜像与同券像素级证明、
文案溢出与铺开规则、序列号唯一性、两版版式同位、确定性、体积预算、
`.gitignore`（assets 下 PNG/ICC 忽略、脚本与版面 JSON 保持入库）；
另外用 pypdf 做一路独立解析（页数、MediaBox、图像、OutputIntent），与自研解析交叉核对。

底图可变位的明暗统计会一并打印（均值/标准差/暗像素占比）：底图与冻结坐标不一致时能一眼看出来
（例如玩梗行里还有画面内容、序列号带上不是空白）。
