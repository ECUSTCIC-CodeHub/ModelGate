# 兑换码 A 线接口契约（t1 冻结版）

- 状态：**已冻结**。本文件是 t2（后端）、t3（管理端 UI）、t4（扫码直达链路）的唯一实现依据；t5（API.md）与 t10/t11/t12（验收）同样以本文件为准。
- 规则：未写入本文件的字段与行为一律视为不存在。实现与本文件冲突时，以本文件为准；确需变更，先向 captain 提出修订本文件，不得在代码里自行发挥。
- 版本：1.0（2026-10-18，gateway-dev，attempt 29142218-f772-4744-8300-1ed16a013aff；内容与 attempt ec127280 落盘稿一致，经复核后冻结）
- 修订 R1（2026-10-19，批次召回）：C2 中「批量操作 500 上限不变」与 C13 的「请求与响应完全不变」已被新需求取代。`PUT`/`DELETE /api/admin/redeem-codes` 新增 `batch_id`（与 `codes`/`code` 三选一）按整批启停/删除；`codes` 批量仍限 500，`batch_id` 不受此限；停用即召回。其余契约继续有效，API 细节以 `API.md` 与本次修订为准。

契约条目编号 C1–C36，供各任务与验收引用。

---

## 1. 总览与非目标

**C1（目标）**：三条并行改动共享一套契约——
1. 兑换码可限定用户组（白名单），仅在兑换那一刻校验一次；
2. 单批生成上限 500 → 1000；
3. 扫码直达：二维码指向 `https://ai.ecustcic.com/r/<CODE>`，新增公开路由 `/r/<CODE>`，`/dashboard/redeem` 支持 `?code=` 预填并自动兑换，`POST /api/user/redeem` 加限流。

**C2（非目标 / 明确不做）**：
- 不改授权侧：`lib/services/redeem-authorization.ts`、`lib/gateway/**` 零改动；组白名单不进入 `redeem_balances`，不影响网关计费与授权判定。
- 不改 `redeem_balances`、`redeem_redemptions`、`groups`、`users` 表结构。
- 不新增任何后端接口（含券面预览接口）；`/r` 与 `/dashboard/redeem?code=` 是页面路由，不是 API。
- 批量启用/停用/删除的 `codes`「一次最多操作 500 个」上限**不变**（本契约只改生成上限）；新增的 `batch_id` 整批操作见修订 R1，不受该上限约束。
- 不为精简版（lite）做任何适配。

---

## 2. 数据层契约（t2）

**C3（新列）**：`redeem_codes` 新增 `allowed_group_ids`，存 JSON 数组字符串（升序去重的正整数），语义为「仅这些用户组的成员可兑换」。

| 位置 | 写法 |
| --- | --- |
| `lib/core/db/schema.ts`（SQLite CREATE TABLE，紧跟 `allowed_model_aliases` 后） | `allowed_group_ids TEXT DEFAULT '[]'` |
| `lib/core/db/mysql-schema.ts`（MySQL CREATE TABLE，同位置） | `allowed_group_ids TEXT DEFAULT NULL` |
| `lib/core/db/init.ts` `ensureAllColumns`（旧库平滑加列，双驱动同一 DDL） | `await db.ensureColumn("redeem_codes", "allowed_group_ids", "allowed_group_ids TEXT DEFAULT NULL");` |

不改 CREATE TABLE 既有列；MySQL TEXT 列只用 `DEFAULT NULL`（AGENTS.md 约束）。

**C4（读取语义）**：`NULL`、`''`、`'[]'`、非法 JSON、非数组 → 解析为空数组，即**不限**；数组中的非正整数项与重复项在解析时被**过滤掉**（例如 `[0, 5, 5, "x"]` 得 `[5]`，`[0]` 得 `[]` 即不限），而非把整条记录视为不限——与 `parseAllowedChannelIds` 的渠道版口径一致。历史行（迁移前）天然为 NULL，行为与旧兑换码完全一致。

**C5（写入语义）**：生成与更新时永远写入序列化后的字符串；空选写 `"[]"`，不写 NULL。

**C6（服务层新增，均在 `lib/services/redeem-codes.ts` 内，不新建文件）**：
- `parseAllowedGroupIds(raw: string | null | undefined): number[]`
- `stringifyAllowedGroupIds(ids: number[]): string`（过滤非正整数、去重、升序；风格对齐 `lib/gateway/channel-access.ts` 的渠道版本）
- `listExistingGroupIds(ids: number[]): Promise<number[]>`：`SELECT id FROM \`groups\` WHERE id IN (...) AND deleted_at IS NULL`（**不筛 enabled**，与 `listExistingChannelIds` 口径一致）
- `RedeemCodeRow` 增 `allowed_group_ids: string`（类型与 `allowed_channel_ids` 一致；历史 NULL 由 parse 容错）
- `generateRedeemCodes` 入参增 `allowedGroupIds: number[]`
- `UpdateRedeemCodeInput` 增 `allowedGroupIds?: number[]`

---

## 3. 兑换侧校验契约（t2）

**C7（校验时机与顺序）**：`redeemCodeForUser(userId, code)` 内按以下顺序判定，顺序即错误信息优先级：
1. 兑换码不存在 → 「兑换码不存在」（现状）
2. `isCodeValid`（停用 / 次数用尽 / 过期）→ 现状文案
3. **用户组白名单**（新增，见 C8）→ 「该兑换码仅限指定用户组兑换」
4. 已兑换过 / 核销事务内失败 → 现状文案

**C8（白名单判定）**：
- 取 `parseAllowedGroupIds(row.allowed_group_ids)`；为空 → 放行（不限）。
- 非空 → 查 `SELECT group_id FROM users WHERE id = ?`，用户 `group_id` 为 NULL 或不在白名单 → 拒绝（C7 的文案），**不进入核销事务，`used_count` 不变**。
- 判定是**纯 id 成员关系**：不要求该组当前 enabled/未删除，不在兑换侧做组存活性二次判定（生成时已校验过存在性）。
- 不豁免管理员：白名单对任何兑换人生效一致。
- 额度券（quota）与重置券（reset）**同样**受白名单约束。
- 校验为只读，放在进入事务之前；「校验后用户换组」的竞态接受，与渠道/模型存在性校验同一精度。

**C9（额度不携带组信息）**：`redeem_balances` 不新增组字段；用户侧响应（见 C18/C19）**不含** `allowed_group_ids`。修改白名单只影响之后的兑换，不影响已发放额度。

---

## 4. 管理 API 契约（t2）

通用：认证 `ensureAdmin`；功能开关 `requireRedeemCodeFeature`（关闭时 404，现状不变）；错误信封 `jsonError` 形状不变。

**C10（POST /api/admin/redeem-codes，生成）**：
- 请求体新增 `allowed_group_ids?: number[]`（zod：`z.array(z.number().int().positive()).optional()`）；缺省与 `[]` 均为不限。
- 校验：`listExistingGroupIds` 过滤，**丢弃无效项不报错**，响应 `warnings` 数组追加：`以下用户组不存在，已忽略: 3, 5`（id 逗号+空格分隔，与渠道/模型 warning 同款拼法）。
- `count`：zod 上限 `500 → 1000`（`z.number().int().min(1).max(1000)`）；服务层 `Math.min(500, …) → Math.min(1000, …)`，两处一致。
- `count=1001` → 400「请求参数不正确」（现状 zod 通用文案，不新增专门文案）。
- 成功响应 201 形状不变：`{ message: "已生成 N 个兑换码。", data: { batch_id, codes: string[] }, warnings?: string[] }`。

**C11（PATCH /api/admin/redeem-codes/[id]，编辑）**：
- `patchSchema`（strictObject）新增 `allowed_group_ids: z.array(z.number().int().positive()).optional()`。
- 语义：**缺省 = 不改**；`[]` = 清空为不限；非空 = 整体替换（校验存在性、丢弃无效项、去重升序落库）。可增可减可清空（只影响后续兑换，无「只增不减」约束）。
- 成功响应：`{ message: "兑换码已更新。", data: <detail>, warnings?: string[] }`（有丢弃时含组 warning，文案同 C10）。
- 其余字段（note/enabled/expires_at/max_uses/token_quota/request_quota）行为不变。

**C12（GET 列表 / 详情）**：`rc.*` 自动带出新列，行对象新增 `allowed_group_ids` **原样 JSON 字符串**（如 `"[3,7]"`、`"[]"`；历史行为 NULL 时输出 null）。后端不做解析，前端本地解析——与 `allowed_channel_ids` 现状一致。

**C13（PUT / DELETE 批量启停/删除）**：`codes`/`code` 原行为不变（`codes` 上限 500，`code` 单条不存在 404，`codes` 批量不存在忽略）；新增 `batch_id`（与 `codes`/`code` 三选一）按整批启停/删除，不受 500 上限约束；批次不存在 404 `批次不存在`。停用即召回：授权/计费侧按 `redeem_codes.enabled` 过滤，已发放未用完的定向额度失效，核销记录保留；重新启用可恢复。详见 `API.md` 与修订 R1。

---

## 5. 用户兑换 API 契约（t4）

**C14（POST /api/user/redeem 检查顺序）**：
1. 功能开关关闭 → 404（现状）
2. **限流**（新增，见 C15）→ 429
3. `ensureUser` 未登录 → 401（现状）
4. 请求体 zod（`{ code: string }`，1–64 字符）→ 400「请求参数不正确」
5. `redeemCodeForUser` → 各业务 400 / 成功 201

限流放在鉴权**之前**：未认证的穷举探测也消耗额度，且验证脚本无需伪造令牌即可测 429。

**C15（限流规格）**：实现在 `app/api/user/redeem/route.ts` 文件内（内存 Map，风格参照 `lib/auth/login-ratelimit.ts`：Map + 定时清理 + `unref()`；不新建 lib 文件）。

| 项 | 值 |
| --- | --- |
| key | `resolveClientIp(request.headers) ?? "unknown"`（`@/lib/core/client-ip`） |
| 窗口 | 60 秒滑动（`WINDOW_MS = 60_000`） |
| 上限 | 每 key 每窗口 10 次（`MAX_ATTEMPTS = 10`），第 11 次起拒绝 |
| 清理 | 每 300 秒清理过期项，`unref()` |
| 作用范围 | 仅 POST；GET 不限流 |

**C16（429 响应）**：`jsonError("兑换请求过于频繁，请稍后再试", 429, {}, { "retry-after": String(Math.ceil(剩余毫秒 / 1000)) })`。错误信封自动得 `type: "rate_limit_error"`、`code: "429"`。

**C17（兑换码归一化，唯一规则）**——函数名 `normalizeRedeemCodeInput(raw: string): string`：
1. `trim()`；2. 移除所有空白字符（`replace(/\s+/g, "")`）；3. `toUpperCase()`；4. 若结果匹配 `/^[A-Z0-9]{12}$/` → 插连字符为 `XXXX-XXXX-XXXX`；5. 其余原样返回（由后端判「兑换码不存在」）。
- **唯一实现**放在 `app/dashboard/redeem/page.tsx` 并以该名导出（命名导出，供验证脚本导入）；服务端 `getCodeByCode` 维持现状（trim + 大写），不补连字符。

**C18（成功响应，形状不变）**：
- 额度券 201：`{ message: "兑换成功。", data: { …balance, kind: "quota", allowed_channel_ids: number[], allowed_model_aliases: string[], remaining_tokens, remaining_requests, periods, active: true, inactive_reason: null } }`
- 重置券 201：`{ message: "周期用量已重置。", data: { kind: "reset", reset: true } }`

**C19（失败响应）**：业务失败 400 + 中文 reason（组拒绝文案见 C7）；限流 429（C16）；信封 `{ error: { message, type, param, code } }` 不变。

---

## 6. 页面路由契约（t4）

**C20（/r/[code]/page.tsx，新建，公开路由，server component）**：
- `export const dynamic = "force-dynamic"`。
- 逻辑（决策函数 `deepLinkTarget(profilePresent: boolean, code: string): string` **以该名导出**，组件读 cookie 判定登录态后 `redirect(deepLinkTarget(!!profile, code))`）：
  - `code = params.code.trim()`；空或长度 > 64 → `"/dashboard/redeem"`（无参跳转）；
  - 已登录 → `/dashboard/redeem?code=<encodeURIComponent(code)>`；
  - 未登录 → `/login?next=<encodeURIComponent("/r/" + code)>`。
- **不做**兑换码存在性校验（未登录统一跳登录，防枚举）、不渲染券面、不调任何 API、不做格式归一化（归一化集中在 C17）。
- 登录态判定：`getServerProfileFromCookieStore(await cookies())`（与 `app/dashboard/layout.tsx` 同源）；`/r/…` 能被 `resolveSafeNext` 接受（以 `/` 开头且非 `//`、非 /login），无需改 `safe-next.ts`。

**C21（登录回路）**：未登录扫码 → `/login?next=/r/<CODE>` → 登录成功 `window.location.href = safeNext` → 回到 `/r/<CODE>` → 此时已登录 → 转发 `/dashboard/redeem?code=<CODE>` → 自动核销。全程 next 链路由现有 `resolveSafeNext` 保证，不新增机制。

**C22（/dashboard/redeem?code= 预填 + 自动兑换）**：
- 挂载时读 `?code=`（`useSearchParams`）；有值 → `setCode(normalizeRedeemCodeInput(value))` 并**自动兑换一次**（`useRef` 哨兵防重放，兼容 React StrictMode 双执行）。
- 自动兑换完成（**无论成败**）后用 `history.replaceState` 移除 `?code=`，刷新不重兑。
- 失败：`toast.error` 显示服务端 `error.message`。
- 手动兑换：提交前同样过 `normalizeRedeemCodeInput`；输入框展示不强改格式。
- 已知边界（不作要求）：未登录直接访问 `/dashboard/redeem?code=` 时，layout 跳登录可能丢失 query（`x-request-path` 机制限制）；扫码链路因先经 `/r` 不受影响。

**C23（成功后入口）**：兑换成功（额度券与重置券均算）后在成功提示区显示链接：文案 **「去创建 API Key」**，指向 `/dashboard/keys`。重置券成功不刷新额度列表（现状）。

---

## 7. 管理端 UI 契约（t3）

**C24（字段名）**：提交与展示一律用 `allowed_group_ids`（number[]），别名为非法。

**C25（选项来源）**：`GET /api/admin/groups`（既有接口，不新增后端）。用 `id`、`name` 字段；`limit=100` 循环翻页直到取满 `paging.total`。展示所有未删除组（含停用组，停用者标注「已停用」），提交仍按 id。

**C26（生成表单，app/dashboard/redeem-codes/page.tsx）**：
- 用户组多选（样式与「限定渠道」chips 一致），标签 **「限定用户组（不选表示不限）」**；空选时**不传该字段**（与渠道/模型同款）；选中传 `allowed_group_ids: number[]`。
- 概要行追加已选组数：`已选用户组：N 个`。
- 生成数量 `Input` 的 `max` 改 1000，helper 文案 **「单批最多 1000 个」**；前后端提示一致。

**C27（编辑对话框，redeem-code-edit-dialog.tsx）**：
- 新增用户组多选，预填 `parse(row.allowed_group_ids)`（本地 JSON 解析，容错规则同 C4）。
- 保存 payload 规则：与原值（去重升序比较）相同 → 不传；不同 → 传新数组，**空选传 `[]`**（清空为不限，区别于「不传=不改」）。
- 描述文案更新：额度券/重置券描述改为明确「限定渠道/模型不可修改；限定用户组可调整」。
- 保存响应若含 `warnings`，以 `toast` 展示。

**C28（列表与详情回显）**：
- `redeem-code-types.ts`：`CodeRow` 增 `allowed_group_ids: string`；新增 `export type GroupOption = { id: number; name: string };`。
- 列表新增列「限定用户组」：组名（未知 id 回退 `#id`）以「、」连接；空数组显示 **「不限」**。
- 详情对话框同样展示；空显示 **「不限」**。

**C29（类型与解析）**：前端本地解析函数对非法 JSON/非数组返回 `[]`（对齐页面现有 `parseChannelIds` 风格）。

---

## 8. 验证脚本契约

通用约定：脚本为 Node ESM（`.mjs`），通过仓库现有 TS loader 模式（参照 `scripts/alias-loader.mjs` 与既有 `verify-*.mjs`）**直接导入真实交付模块**做断言；使用临时 SQLite 库与 `MODELGATE_EDITION=full` 环境，不依赖线上服务。每项断言打印 `PASS/FAIL <编号> <描述>`，全部通过 exit 0，任一失败 exit 1 并打印原因。

**C30（scripts/verify-redeem-group.mjs，t2 交付）**：
- G1：`allowed_group_ids=[G1]` 的码，组外用户（含无组用户）兑换 → `ok:false`、reason 精确等于「该兑换码仅限指定用户组兑换」、`used_count` 不变。
- G2：组内用户兑换 → `ok:true` 且额度券返回 balance。
- G3：缺省与 `[]` 两种生成的码 → 任意组用户可兑换。
- G4：重置券同样受白名单约束（组外拒、组内成功）。
- G5：`count=1000` 生成成功；`count=1001` 被拒（zod 400「请求参数不正确」）。
- G6：生成/编辑传 `[不存在id, G1]` → 落库值只剩 `[G1]`，响应 warnings 含「以下用户组不存在，已忽略」。
- G7：PATCH 传 `[]` → 白名单清空为不限，组外用户可兑换。

**C31（scripts/verify-redeem-deeplink.mjs，t4 交付）**：
- D1：导入页面导出的 `normalizeRedeemCodeInput`：`" abc-EFGH-jklm "`→`ABC-EFGH-JKLM`；`"abcdefghijkl"`→`ABCD-EFGH-JKLM`；含内部空白的输入被移除；非法输入原样返回。
- D2：同 IP 连续 POST：第 1–10 次非 429（未带令牌时应为 401），第 11 次 429、`error.message` 精确等于「兑换请求过于频繁，请稍后再试」、`error.type === "rate_limit_error"`、`retry-after` 头为 1–60 的整数。
- D3：导入 `deepLinkTarget`：未登录 → `/login?next=` + encodeURIComponent(`/r/<CODE>`)；已登录 → `/dashboard/redeem?code=` + encodeURIComponent(`<CODE>`)；空码与超长码 → `/dashboard/redeem`。
- D4：`POST /api/user/redeem` 响应形状抽查：业务失败 400 信封 `{ error: { message, type, param, code } }`。

---

## 9. 文档与验收对照

**C32（t5 / API.md 义务清单）**：以本文件为准更新中文 API.md——POST /api/admin/redeem-codes（新字段、count 上限 1000、warnings）、PATCH /api/admin/redeem-codes/[id]（新字段语义：缺省不改 / [] 清空）、GET 行新增字段说明、POST /api/user/redeem（429 限流、组拒绝文案、响应示例）、新增页面路由 `/r/<CODE>` 与 `/dashboard/redeem?code=` 的行为说明。

**C33（t10/t11 验收锚点）**：错误文案逐字比对 C7/C10/C16；字段名比对 C24；响应形状比对 C10–C12、C18–C19；脚本断言清单比对 C30–C31。

**C34（与 B 线的接缝，t12 用）**：二维码内容固定 `https://ai.ecustcic.com/r/<CODE>`，`<CODE>` 为标准形（大写、含连字符，`XXXX-XXXX-XXXX`）；`/r` 对大小写与空白容错（trim 后原样转发，最终由 C17 归一化），无连字符的 12 位裸码同样可兑。

**C35（用户组相关既有事实，供实现参考，不改动）**：组表为 `\`groups\``（软删除 `deleted_at`、`enabled` 开关）；用户组 id 在 `users.group_id`；管理端组列表接口已存在（C25）。

**C36（任务映射）**：

| 契约条目 | t2 | t3 | t4 |
| --- | --- | --- | --- |
| C3–C9（数据层 + 兑换校验） | 实现 | — | — |
| C10–C13（管理 API） | 实现 | 消费 | — |
| C14–C19（用户 API + 限流 + 归一化） | — | — | 实现（C17 的服务端部分无改动） |
| C20–C23（页面路由） | — | — | 实现 |
| C24–C29（管理端 UI） | — | 实现 | — |
| C30 / C31（验证脚本） | C30 | — | C31 |
