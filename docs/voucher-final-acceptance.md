# ModelGate 实体兑换券最终验收报告（t12）

- 状态：**已验收（通过）**，遗留问题见第五节。印刷/发放前必须先处理 F1 与第七节的送印前检查清单。
- 验收范围：A 线（t1–t5：组白名单、批量上限、管理端 UI、扫码链路、API.md）与 B 线（t7–t9：兑换券生成器、600 张双面拼版 PDF、独立验收）的交叉验收。
- 依据：`docs/redeem-group-contract.md`（C1–C36，t1 冻结版）。
- 验收方式：全部在隔离环境与独立工具下完成，**未复用产出方脚本**；仓库工作区未被本轮验收改动。

---

## 一、结论

| 验收项 | 结论 | 关键证据 |
| --- | --- | --- |
| PDF 中二维码 URL 与线上路由契约一致 | 通过（附 F1 发布顺序风险） | 1200 张二维码全部独立解码，内容 100% 等于 `https://ai.ecustcic.com/r/<CODE>`；1200/1200 的 `<CODE>` 与 mock CSV 双向零差 |
| mock 码走通 扫码 → 登录 → 核销 → 额度到账 | 通过 | 真浏览器全链路：`/r/<CODE>` → 307 → 登录 → 307 → `?code=` 预填 → `POST /api/user/redeem` **201** → 页面「兑换成功。」+ 余额 888.89K/888.89K；落库 used_count=1、redeem_balances +1、redeem_redemptions +1 |
| 真实码替换 mock 的步骤已记录并演练 | 通过 | 用 12 条真实格式码的 CSV 完整跑通生成 → 独立解码 → K100 复核；生成器自检 32 项 0 失败（mock 底图与真实底图各一轮） |
| 审计报告含遗留问题清单 | 通过 | 高危 0、中危 1（发布顺序，非代码缺陷）、低危 3、建议 3（第五节） |

---

## 二、验收方法（可复现）

1. **PDF 独立解码**：用 `pypdf`（第三方 PDF 解析器）逐页抽出二维码图像对象，再用 **OpenCV 5.0 `QRCodeDetector`** 与 **pyzbar（zbar）** 两个互相独立的引擎解码；另用自写的格式信息位解析（15 位 BCH 格式位）直接读出纠错等级与掩码，不依赖产出方任何代码。
2. **真机全链路**：把当前工作区整目录复制到系统临时目录（`node_modules` 用 robocopy 实拷），用 `next dev` 起独立实例（独立 SQLite、端口 3112），用 Playwright 驱动真实 Chromium 完成扫码→登录→核销，并逐项核对数据库落库。
3. **线上只读探测**：对 `https://ai.ecustcic.com` 只做 GET 探测（不登录、不核销），确认线上路由现状。

物证（脚本与结果）留在 `tools/voucher/out/t12_verify_scratch/`：`decode_qr.py`、`sweep_qr.py`、`qr_format_bits.py`、`k100_check2.py`、`rgb_sweep.jsonl`、`cmyk_sweep.jsonl`。

---

## 三、验收项逐条结果

### 3.1 PDF 二维码 URL 与线上路由契约一致

| 检查 | 结果 |
| --- | --- |
| 两套 PDF 各 600 张券的二维码图像对象 | RGB 600、CMYK 600（共 1200） |
| zbar 独立解码 | 1200/1200 成功 |
| OpenCV 独立解码 | 1199/1200（唯一 1 张见 F4） |
| URL 格式（正则 `^https://ai\.ecustcic\.com/r/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`） | 1200/1200 全部匹配 |
| `<CODE>` 与 `tools/voucher/mock/codes_mock.csv`（600 条）双向比对 | 缺失 0、多余 0、重复 0 |
| 二维码参数（自读格式位） | 29×29 模块、纠错 M、模块 17px = 0.6021mm，与 `out/README.md` 一致 |
| CMYK 深色模块是否 K100（按模块中心像素复核） | 600 张券 **0 个深色模块非 (0,0,0,255)**；浅色模块统一 (11,18,32,0)（K=0，无墨） |
| 线上路由现状 | `GET https://ai.ecustcic.com/r/NXE7-HQDT-SMDR` → **307 → /dashboard**（即 404 兜底页重定向），**线上尚无 /r 路由** → 见 F1 |

### 3.2 mock 码全链路（扫码 → 登录 → 核销 → 额度到账）

用 **PDF 第 1 页第 1 张券二维码里解出的码 `NXE7-HQDT-SMDR`**（与印在纸上的完全一致）注入本地实例后，浏览器实测请求序列：

```
307  /r/NXE7-HQDT-SMDR                 → /login?next=%2Fr%2FNXE7-HQDT-SMDR
200  /api/auth/login                  → 登录成功
307  /r/NXE7-HQDT-SMDR                 → /dashboard/redeem?code=NXE7-HQDT-SMDR
201  /api/user/redeem                  → 核销成功
200  /api/user/redeem ×3               → 额度列表刷新
```

- 页面：「兑换成功。」+「去创建 API Key」入口；余额行 **888.89K / 888.89K**（注入的 888888 Token 额度到账）；「兑换记录」显示 `NXE7-HQDT-SMDR` 与核销时间。
- 落库核对：`redeem_codes.used_count=1`、`redeem_balances` 新增 1 行（token_quota=888888, used_tokens=0）、`redeem_redemptions` 1 行。
- URL 里的 `?code=` 在核销完成后被清除（最终停在 `/dashboard/redeem`），刷新不重复核销。
- 补充：未登录直接访问 `/dashboard/redeem?code=…` 时登录跳转保留 query，登录后同样自动核销（比契约 C22 标注的「已知边界」更好）。

### 3.3 真实码替换 mock：步骤与演练

**已演练**：用 12 条真实格式（`XXXX-XXXX-XXXX` 大写字母数字 + 连字符）、批次号 `20261019-173000-a1b2c3d4` 的 CSV，在**独立输出目录**跑完整生成流程：

- 生成：RGB 4 页 24.8MB、CMYK 4 页 32.0MB（带 OutputIntent=JapanColor2001Coated）、序列号 0001–0012、2 张纸 × 2 面 = 4 页 ✓
- 独立解码：12/12 双引擎成功，内容全部为 `https://ai.ecustcic.com/r/<新的真实码>` ✓
- CMYK 深色模块 K100：12 张券 0 个不合规 ✓
- 生成器自检：`selfcheck.py` 32 项 0 失败（mock 底图 20.0s）；`selfcheck.py --use-real-assets` 32 项 0 失败（真实底图 33.7s）✓

**可直接照做的操作步骤**见第六节。

---

## 四、与两条线交付声明的逐项核对

| 交付声明（t7/t8/t9） | 本轮独立复核 |
| --- | --- |
| 纠错 H、version 5、37 模块、629×629 | **不成立**：实为纠错 M、version 3、29 模块、493×493（自读格式位 + 图像尺寸双重确认）。产出方 `out/README.md`（送印口径）已是 M/29，`generate/README.md` 仍写 H/37 → F2 |
| 模块 17px = 0.6021mm | 成立（清单与实测一致） |
| 二维码内容 `https://ai.ecustcic.com/r/<CODE>` | 成立，1200/1200 逐字匹配 |
| CMYK 模块全为 K100 | 成立（600 张券 0 个深色模块非 (0,0,0,255)） |
| 掩码分布、无风险掩码 | 成立（本次抽读均为 mask 3/5/6；掩码 3 的一张被 OpenCV 检测器漏读 → F4） |
| A 线 `/r/<CODE>` 公开路由、扫码直达 | 成立（本地实例实测 307 → 登录 → 自动核销 201） |
| `/r/<CODE>` 指向线上域名 | URL 正确，但**线上尚未部署该路由** → F1 |

---

## 五、遗留问题清单

### 高危：0

### 中危：1

**F1｜发布顺序：线上域名尚未部署 A 线，印出来的券现在扫不通（发布风险，非代码缺陷）**

- 现象：`GET https://ai.ecustcic.com/r/<任意码>` → 307 → `/dashboard`（这是 `app/not-found.tsx` 的兜底重定向），说明线上跑的还是**没有 `/r` 路由**的旧版本；本地含 A 线的新版本行为是 307 → `/login?next=%2Fr%2F<CODE>`。
- 影响：若现在就按当前 PDF 印刷并发放，用户扫码后落到仪表盘，不会进入兑换流程（券面二维码内容本身是对的）。
- 处置：**印前/发券前必须先把 A 线（t2–t5）部署到该域名**，或把二维码域名改到已部署 A 线的域名；部署后再做一次端到端复验（本报告 3.2 的流程可直接照做）。请 captain 决策部署与印刷的先后顺序。

### 低危：3

**F2｜`tools/voucher/generate/README.md` 的二维码参数与实际交付不一致**

- 文档第四节仍写「纠错 H / version 5（37 模块）/ 629×629 / 实际方阵 (2749,478)–(3378,1107)」，实际交付是 **纠错 M / version 3（29 模块）/ 493×493 / 方阵 (2816,546)–(3309,1039)**。
- 送印口径 `tools/voucher/out/README.md` 已是正确值（M/29/0.6021mm），故不影响本次送印；建议把开发侧 README 同步，避免后续按旧参数排版或误判模块尺寸。

**F3｜生成器误报「底图没有 ColorSpace=CMYK-packed 标记」**

- `lib` 侧 `tools/voucher/generate/vouchers.py` 用 `marker != "CMYK-packed"` 精确比较，而 PNG 里的实际值是 `"CMYK-packed: R=C,G=M,B=Y,A=K"` → 每次生成都打这条提示。
- 影响仅为提示噪音：解包路径（`R=C/G=M/B=Y/A=K`）本来就是文档约定的口径，输出正确（本轮 12 张与 600 张的 K100 复核均通过）。建议改成 `startswith("CMYK-packed")`（`assets/README.md` 自己的断言就是 startswith）。

**F4｜600 张里有 1 张券的二维码 OpenCV 检测器解不出（数据无误，检测器盲点）**

- 位置：RGB 与 CMYK 的**第 41 页第 5 个券位**，序列号 **No. 0125**，兑换码 **LETR-48NB-RD2D**，掩码 3（清单标记 `qr_mask_reason=safe`），两套 PDF 同一张。
- 复核：zbar 独立解码成功（`https://ai.ecustcic.com/r/LETR-48NB-RD2D`），t9 的 zxing-wasm 亦 1200/1200 成功 → 属 OpenCV `QRCodeDetector` 对该载荷+掩码组合的盲点，不是数据缺陷。
- 建议：送印前用实际扫码枪/手机至少抽检该张与若干随机张（步骤见第七节）。

### 建议项：3

- **F5**｜限流 key 为 `resolveClientIp(headers) ?? "unknown"`（契约 C15 明确指定）：直连无反代时全部客户端共用一个桶，全站 60 秒仅 10 次兑换；部署说明里应写明「反代须透传 x-forwarded-for」。
- **F6**｜`/r` 的「空码」分支在 URL 层不可达（`/r/` → 308 → `/r` → 404 兜底），标准形二维码不受影响（承接 t11 L2，t17 已补注释说明）。
- **F7**｜当前交付件仍基于 mock 码（批次 `MOCK-20261018`，600 条）。**正式发放前必须用真实码重出并复验**（第六节步骤），否则纸上的码在系统里不存在。

---

## 六、真实码替换 mock 的操作步骤

### 6.1 导出真实兑换码

1. 管理员登录 → 管理端「兑换码」→ 填写额度/次数等 → 批量生成（单批上限 **1000**，600 张需分两批或一批 600）。
2. 从生成结果导出兑换码清单，存为 UTF-8 CSV，**两列：`兑换码,批次`**（首行可带表头，CRLF/BOM 都可）：

   ```csv
   兑换码,批次
   XXXX-XXXX-XXXX,20261019-173000-a1b2c3d4
   ```

   兑换码必须是大写字母数字 + 连字符的 12 位标准形（与二维码里的 `<CODE>` 一致）；重复码会被生成器直接报错。
   若要给不同批次分批印刷，批次列按批次填写，序列号仍按 CSV 行序从 `No. 0001 / 0600` 递增。

### 6.2 生成两套拼版 PDF

```bash
# 体检文案宽度（几秒，不出 PDF）
python tools/voucher/generate/make_vouchers.py --csv <真实兑换码.csv> --check-quotes

# 正式生成（RGB + CMYK）
python tools/voucher/generate/make_vouchers.py \
    --csv <真实兑换码.csv> \
    --quotes tools/voucher/quotes.txt \
    --assets tools/voucher/assets \
    --out tools/voucher/out
```

> 底图（`tools/voucher/assets/`）不入库，换机器时要先跑 `python tools/voucher/assets/build_assets.py` 重新生成；缺底图时生成器会直接报错，不会重采样。

### 6.3 复验（三步，缺一不可）

```bash
# 1) 生成器自检（32 项）
python tools/voucher/generate/selfcheck.py
python tools/voucher/generate/selfcheck.py --use-real-assets

# 2) 交付结构核对（页序/页数/券位/左右翻转/样张/体积）
python tools/voucher/out/verify_t8.py

# 3) 二维码逐张解码（600 张/套）+ CMYK K100 核对
python tools/voucher/out/spot_check_qr.py
```

> `verify_t8.py` / `spot_check_qr.py` 按固定路径读取 `tools/voucher/out/` 的交付件，重出后需在该目录里跑；本轮的独立复核脚本在 `tools/voucher/out/t12_verify_scratch/`（`sweep_qr.py` 走查两套全量二维码，`k100_check2.py` 复核 K100）。

### 6.4 送印前检查清单

1. `registration_sample_rgb.pdf` / `registration_sample_cmyk.pdf` 先打 2 页，**实测翻面方式**（背面券位要与正面券位背面重合；左右错开一整列＝翻面方式选反）。
2. CMYK 版送胶印、RGB 版留档；确认送印文件是 `vouchers_cmyk.pdf`。
3. 用实际扫码枪/手机抽检若干张（**务必包含 No. 0125**，见 F4），并至少抽 1 张纸质成品做一次真实扫码核销。
4. **部署顺序确认**：线上 `https://ai.ecustcic.com` 必须已含 A 线（`/r/<CODE>` 返回 307 → `/login?next=…`），否则先部署再印（见 F1）。
5. 核对 `vouchers.manifest.json` 的券号/兑换码清单与纸质序列号一致；确认批次号写对。

---

## 七、复核清单（本轮已执行，可照此复跑）

| 复核项 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| 两套 PDF 二维码全量解码 | `sweep_qr.py`（OpenCV + zbar 双引擎） | 1200/1200（OpenCV 1199，见 F4） |
| 二维码参数自读 | `qr_format_bits.py` | ec=M、29 模块、掩码 3/5/6 |
| CMYK K100 复核 | `k100_check2.py` | 深色模块 0 个非 (0,0,0,255) |
| 码表双向零差 | 比对 `mock/codes_mock.csv` | 缺失 0、多余 0、重复 0 |
| 扫码全链路 | Playwright + 本地实例 | 307→登录→307→201，余额到账，落库 3 项一致 |
| 真实码替换演练 | 生成器 + 独立解码 | 12/12 解码正确、K100 合规 |
| 生成器自检 | `selfcheck.py` / `--use-real-assets` | 各 32 项 0 失败 |
| 线上路由现状 | 只读 GET | `/r/<CODE>` → 307 → `/dashboard`（未部署 A 线，F1） |
