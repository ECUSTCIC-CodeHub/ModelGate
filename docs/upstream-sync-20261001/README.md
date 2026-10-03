# 上游同步分析报告（20260709 → 20261001）

> 本目录为上游同步调研产出，**均为分析文档，未产生任何代码改动**。
>
> | 文档 | 内容 |
> |:---|:---|
> | **README.md**（本文） | 总览：基线确认、分类、优先级、建议批次、字段契约汇总 |
> | [downstream-defect-audit.md](./downstream-defect-audit.md) | **最值得先读**：逐条对照你的代码核对上游 36 个修复，含文件行号证据、8 项待验证清单、两个强行为变更 |
> | [log-cleanup-and-usage-ranking.md](./log-cleanup-and-usage-ranking.md) | 日志清理（与下游差异比对的结论）、用量排行重构（含 MySQL/多实例风险） |
> | [channel-affinity-and-custom-headers.md](./channel-affinity-and-custom-headers.md) | 渠道亲和性、渠道级自定义 Header（含失效字段清单、注入顺序） |
> | [gateway-rescan-and-prompt-injection.md](./gateway-rescan-and-prompt-injection.md) | 预算化多轮重扫、上下文超限回放、系统提示词注入、请求体上限 |
>
> README 第三、四节的「下游状态」列已按 `downstream-defect-audit.md` 的核对结果更新：标注**确认存在**的项均已对过你的实际代码（含行号），并修正了最初基于抽查的两处误判（`a5f90b9`、`2179adb`）。

## 一、同步基线与范围确认

在你的 git 历史中检索提交 body 里的「上游同步」字样，只命中一处：

| 提交 | 日期 | 标记 |
|:---|:---|:---|
| `9b8df52` | 2026-07-10 | `feat(dashboard): 仪表盘新增 Top 用户排行（仅管理员）`，body 末行 `已与20260709上游同步` |

**结论：上次同步基线为 2026-07-09/10。** 更早的合并记录是 `1dd631c`（2026-06-03，合并上游 v2.17.2），与本次无关。

### 上游分支情况（重要）

上游 `https://cnb.cool/Bring/Project/Gateways/ModelGate` 只有两个代码分支：

| 分支 | HEAD | 最后提交 | 说明 |
|:---|:---|:---|:---|
| `go` | `22f3de2` | 2026-10-01 | **活跃开发分支**，Go 重写版 |
| `nextjs` | `0848ae8` | 2026-06-15 | 旧 Next.js 实现，**已停止维护，早于你的同步点** |

`nextjs` 分支停在 2026-06-15，**晚于该日期的所有上游改动都只存在于 Go 重构分支上**，没有任何 Next.js 实现可以参考。因此下文所有条目都是**语义级移植**（按功能、字段、行为重新用 TypeScript 实现），不存在可直接 cherry-pick 的提交。

### 变更总量

基线至今上游 `go` 分支共 **187 个提交**（含合并）。按你的要求分类：

- **功能性更新**：约 60 项（详见第三、四节）
- **UI/样式重构（按你的要求跳过）**：液态玻璃视觉、极简现代设计语言、设置页信息架构重构、渠道页拆分组件、DatePicker、分页器组件等约 30 项
- **Go 专属工程改动（与你无关）**：CI 覆盖率流水线、交叉编译、`cmd/seed` 测试数据、dev 代理、GORM 日志等约 25 项

---

## 二、总体结论与建议优先级

上游这两个半月的改动可归为四档：

**第一档｜强烈建议跟进（网关正确性与安全）**
协议转换的一批修复（2026-10-01 集中落地）几乎全部是**协议层实现无关的正确性缺陷**。已逐条对照你的实际代码核实：**大部分确认为下游同源缺陷**，其中若干处（`09068a8` 图片、`ec31db4` 流式 finish、`dfc4ab7` 软删除组、`17a3b96` tool_choice）**下游比上游修复前更严重**。安全修复同理 —— `77bf9ed`、`6cf905e`、`3be07c1` 为 P0 确认项。

> 详细核对结果（含文件行号）见 [downstream-defect-audit.md](./downstream-defect-audit.md)。

**一处需发布沟通的强行为变更**：`3be07c1` OIDC 回调绑定 `public_base_url`（**安全问题**：授权码劫持）—— 上游改法是「未配置直接报错」。注意你的实现**只信任 `requestUrl` 的 origin、不读 `x-forwarded-proto`**，故上游「proto 头注入 scheme」的子缺陷对你不适用，风险高低取决于部署形态（反代是否透传 Host）。建议改**白名单校验**而非硬报错，并把必填提示前移到设置保存时。**行动项：先确认生产是否已配置该值** —— 已配置则本条仅为代码卫生。

（注：`1423bc2` 的 `app_id` **不是行为变更**，之前并列在此处有误导。那是上游修**自己的 bug**：原来错比 `issuer_url`，导致带 `app_id` 的事件全部失效；现改为比对 `oidc_client_id`。你零校验、功能不受影响，只需按「**空值放行、非空校验 Client ID**」新增一层纵深防御 —— 若粗暴要求必须匹配，会把没发该字段的正常发送方全部挡掉。）

**第二档｜建议跟进（明确的功能增强）**
渠道级自定义 Header（纯增量，风险最低）、模型级前置系统提示词注入、请求体上限开关、渠道分组、渠道模型批量管理、OIDC subject 搜索、Webhook 用户状态同步。多为独立小功能，可分批做。

**第三档｜按需评估（大型功能，投入高）**
预算化多轮重扫（含上下文超限回放）、渠道亲和性、用量排行重构。这三个是上游这轮最重的功能，前者直接影响 Agent 类客户端体验，但实现复杂度很高。

**第四档｜与你现有实现重叠，只需补缺口**
日志清理 —— 经逐项比对，你已实现核心语义，**只缺 3 处**（`log_auto_cleanup_enabled` 开关、手动清理接口、前端按钮），不是重写。

> **一处需要纠正的初始判断**：用量排行**不属于**「已有实现」档。你目前把 Top 排行内嵌在 `GET /api/dashboard/summary` 里，**没有独立的 `top-usage` 端点**（已用 `git grep` 确认）。上游那套是全新架构，且含一次破坏性 API 变更，详见 5.7。

---

## 三、第一档：协议转换修复（重点）

全部集中在上游 2026-10-01 的一轮加固。**这些都是协议语义问题，与 Go/TS 实现无关，建议逐条自查。**

### 3.1 图片跨协议双向损坏（`09068a8`）— 最高优先级

- **缺陷**：中间协议 `ContentPart` 缺少 base64 图片字段，Anthropic 的 base64/url 图片退化为 `unknown` 块被**静默丢弃**；Chat 的 `data:` URL 内联图片转 Anthropic 时生成**非法的 url source**。
- **正确行为**：`ContentPart` 增加 base64 图片字段；Anthropic base64/url ↔ Chat/Responses 的 `data:` URL 双向正确转换。
- **下游**：你已有 `lib/gateway/normalized-message/detect-image.ts` 与 `content.ts`，**需重点核对** base64 与 data:URL 两条路径是否完整。

### 3.2 跨协议扩展字段未按目标协议过滤（`0c18ad1`）

- **缺陷**：`Extra` 中的源协议私有字段被透传给目标上游，如 Anthropic 的 `top_k`、Chat 的 `seed`，**触发严格上游 400**。
- **正确行为**：跨协议转换时按目标协议白名单过滤；同协议路径仍原样保留扩展字段。
- **下游**：你有 `protocol-adapters/protocol-extra.ts`，需检查是否按目标协议白名单过滤。

### 3.3 `max_completion_tokens` 未建模，o 系模型跨协议失败（`f210e44`）

- **缺陷**：Chat 请求缺省 `max_tokens` 时未读取 `max_completion_tokens`，该字段作为**未知参数透传给 Anthropic 等严格上游**。
- **正确行为**：读取 `max_completion_tokens` 填入中间协议 `MaxTokens`，并从 `Extra` 剔除。
- **下游**：高概率同样存在，o 系模型用户会直接遇到 400。

### 3.4 流式解码把上游错误事件当噪声忽略（`ada95de`）

- **缺陷**：Chat 错误块、Anthropic `error` 事件、Responses `response.failed` 被忽略，统一**误报为「流在完成信号前结束」**。
- **正确行为**：终止转发并返回携带上游 message 的错误。
- **影响**：排障体验极差，上游真实错误被掩盖。**建议优先修**。

### 3.5 其它协议修复（逐条自查）

| 提交 | 缺陷 | 正确行为 | 下游状态 |
|:---|:---|:---|:---|
| `146b6eb` | Anthropic 历史转 Chat 时向 messages 注入 thinking 块与非标准 reasoning 字段，严格上游 400 | 请求方向剥离，响应方向 ThinkingEnabled 行为不变 | **确认存在**，`chat-completions-request.ts:1063` 与上游修复前逐字对应 |
| `6f18246` | `length` 截断语义跨协议丢失 | 中间协议 `StopReason` 增加 length；Chat length / Anthropic max_tokens / Responses incomplete+max_output_tokens 双向映射；**截断优先于工具调用** | **确认存在**，`intermediate.ts:434-442` 只有 2 个取值；Responses 输出恒为 `completed` |
| `6520c9a` | 多条 system/developer 消息只保留第一条 | 以空行拼接进 Responses 的 `instructions` | **确认存在**，`responses-request.ts:1231-1277` 根本没有 `instructions` 输出 |
| `6882b79` | Anthropic `tool_result` 同消息内的兄弟内容块被丢弃 | 展开工具结果后按原 role 追加为下一条消息 | **确认存在**，`anthropic.ts` 的 `continue` 丢弃 `textParts`。**改动量约一行** |
| `8ec9fd8` | Responses 推理 `summary_text` 块丢失，o 系/gpt-5 系可见推理系统性为空 | 非流式聚合 + 流式新增 `response.reasoning_summary_text.delta` 分支 | 未验证 |
| `ec31db4` | Chat 流式 `finish_reason` 立即发 finish，**真实 usage 后到被丢** | finish 延迟到 `[DONE]` 或读循环结束 | **确认存在且比上游修复前更弱**：`[DONE]` 分支 `continue` 且 `done` 后不补发 → 只有 `[DONE]` 无 `finish_reason` 的上游**完全不产生 finish 事件** |
| `17a3b96` | `tool_choice: none` 转 Anthropic 仅省略字段，但 Anthropic 缺省为 auto | none 时同时省略 tools 列表 | **确认存在且更糟**：`tools.ts:209` 返回 `{type:"none"}`，是 Anthropic **不存在的取值**，严格端点 400 |
| `a5f90b9` | Anthropic `stop_sequences` 未映射到 Chat 的 `stop` | 承接映射 | **确认存在**，`chat-completions-request.ts:1109` 无回退（此前判断有误，已更正） |
| `67c529c` | 跨 chunk 边界的 `\r`+`\n` 组成 CRLF，帧被破坏后静默丢弃 | 拼接前剥离跨块 CRLF；逐行 `TrimSuffix` 残余 CR | **确认存在**，四个解码器全是整块内 `replace`，且无 `TrimSuffix` 兜底 |
| `b9ae580` | `TrimLeft` 剥掉全部前导空格，纯文本多行 data 缩进畸变 | 改为 `TrimPrefix` 单空格 | **确认存在且更糟**，下游全用 `.trimStart()` |
| `251f533` | 工具空参数 `null` schema 被严格上游拒绝；o1/o3/o4 未映射 `o200k_base` | 补空 object schema；词表修正 | 部分：仅 Anthropic 方向有兜底，Chat/Responses 方向仍可为 `null`；词表待验证 |

### 3.6 下游无需移植的项（防护已强于上游修复）

- `3da32d2` 登出反斜杠开放重定向：你的 `lib/shared/safe-next.ts` 在**原始与 decode 后各校验一次**，并做 `new URL` origin 归一化，覆盖面**强于**上游。
- `75a836e` 公告 Markdown 链接白名单：你用 DOMPurify + 显式 `ALLOWED_TAGS`/`ALLOWED_ATTR`，其内置 URI 安全策略**强于**上游的字符串前缀白名单。
- `c77ea0b` 的**过期条目清扫**部分：你已有 `setInterval(...).unref()`。

**一处方向被反转的项**：`2179adb` 流式超时 —— 你的 `proxy.ts` 里 `fetch()` 在响应头到达即 resolve、`finally { clearTimeout }` 立即执行，故总超时实际**只约束到响应头**，长流**不会**被截断（与上游 bug 相反）。但**上游挂死（发完头就不发数据）会无限期挂住，无任何看门狗**。**你需要移植的是「空闲看门狗」这一半，而不是「去掉总超时」。**

**一处易误读项**：`f04440b` 才是 webhook 签名的最终状态 —— 优先按标准串（不含 `app_id`）校验，失败且 `app_id` 非空才回退扩展串。你只实现标准串，**与上游修复后一致，不是缺陷**。

---

## 四、第一档：安全修复（下游确认状态）

| 提交 | 缺陷 | 正确行为 | 下游状态 |
|:---|:---|:---|:---|
| `77bf9ed` | 改密后旧令牌仍有效，攻击者持有的会话可续期 | users 表加 `token_version`，签发与校验比对，改密递增 | **P0 确认**：全仓 `token_version` **零命中**，是彻底的裸 JWT，旧 refresh token 仍可续期默认 7 天 |
| `6cf905e` | 渠道列表/更新响应**明文回传上游 api_key** | 返回脱敏值；回传脱敏值视为未修改；`probe-models` 支持传 `channel_id` | **P0 确认**：有权限即返回完整明文；`probe-models` 的 schema **没有 `channel_id`**，强制前端回传明文 |
| `3be07c1` | OIDC `redirect_uri` 基于**可伪造的 Host** 推导 | 固定取 `public_base_url`，未配置直接报错 | **P0 确认**：`lib/auth/oidc.ts` 未配置时回退 `new URL(requestUrl).origin`。**强行为变更，需发布沟通** |
| `dfc4ab7` | 软删除用户组未释放 UNIQUE 名称，同名组无法重建 | 软删除时改写 name；启动清理历史残留 | **确认且比上游更糟**：应用层查重只看 `deleted_at IS NULL` 认为同名可用 → 撞 DB UNIQUE 报 **500**（上游是静默失败） |
| `f7e484d` | 周期配额重置时间格式字典序比较错误 | `datetime()` 归一化 | **确认存在**（`channel-quota.ts:26`、`model-quota.ts:26` 同模式）。MySQL 是 DATETIME 不受影响，**SQLite 侧受影响**；用户级配额待验证 |
| `09068a8` | 图片跨协议双向损坏 | 中间协议承载 base64/media_type | **确认存在且更糟**：`anthropic.ts:64-71` 把裸 base64 当 `image_url`，**随后又重复 push 一次** → 同一张图产出 1 个错误 image part + 1 个 unknown part |
| `9e96d2a` | 排队超时竞态下已授予租约未归还，并发容量被逐步侵蚀 | 非阻塞回收已进通道的租约 | **确认存在**（`channel-runtime.ts` 的 timeout 分支 filter 是空操作） |
| `b5a6ab1` | Webhook 事件 ID 去重 | 15 分钟窗口内同一 id 返回 200 并跳过 | **确认缺失**：只有时间戳 + 签名校验，**零去重** |
| `1423bc2` | Webhook 未校验 `app_id`（上游此处原是**自身 bug**：错比 `issuer_url` 致带 `app_id` 事件全失效，改为比 `oidc_client_id`） | 非空时比对 OIDC Client ID | **确认缺失**：`app_id` 只在类型定义里，**从未被读取**。**非安全漏洞**（签名已验证），缺的是纵深防御。新增时须**空值放行、非空才校验**，否则挡掉正常发送方 |
| `1c4f1ac` | 业务 4xx 计入熔断，多用户连续 400 误熔断健康渠道 | 仅 5xx/401/403/429 计入 | **确认存在**：`channel-runtime.ts` 的 `complete({ok:false})` 必增失败计数，无 `completeNeutral` 等价方法；`gateway-handler.ts` 6 处调用一刀切 |
| `327cef2` | `/api/ollama/<token>/` 路径段是 API Key，**明文落访问日志** | 落日志前掩码 | 未验证 |
| `3fd4f36` | `base_url` 配 `user:pass@` 时凭据随错误信息泄露进日志 | 剥离 userinfo | **部分确认**：`probe-models` 与 `testUpstreamModel` 有 `error.message` 直出路径；其余 handler 待复核 |
| `ec9e3ec` | 改密接口无限流可爆破；用户不存在时不返回等价耗时；超长密码 | 复用登录限流；哑哈希比较；统一 8-72 位 | **确认存在**：改密无 `checkLoginRateLimit`；登录 `if (!user) return 401` 短路；zod 只有 `.min(8)` 无 `.max(72)` |
| `c77ea0b` | 登录限流无条件信任转发头 | 受信代理口径 | **部分**：清扫已有；`client-ip.ts` **无受信代理边界**。是否需要移植**取决于部署形态**（EdgeOne 等平台会覆写这些头） |
| `6c64e40` | JWKS 未知 kid 拒绝登录 | 强制刷新 JWKS 重试 | 待验证 |
| `75a836e` | 公告链接未过滤协议 | 白名单 | **无需移植**，已强于上游 |
| `41c1ead` | `/api` 非网关路径可被超大 JSON 打爆内存 | 统一 4MB 限制 | **网关侧你做得更好**（`readBodyCapped` 防 content-length 伪造）；**非网关侧未发现任何限制**，待逐一核对 |
| `1332542` | 计费乘法向零截断造成系统性少计 | 四舍五入 + 溢出钳制 | **部分**：你已用 `Math.round` ✅；**溢出钳制缺失**，且钳制顺序与上游相反 |
| `b449c36` | 用量累加失败静默吞掉 | 统一记录日志 | **确认存在**：`gateway-handler.ts` 5 处 `addUsage(...)` 均未 await/catch，失败即 unhandled rejection |

---

## 五、第二档：功能增强

### 5.1 渠道级自定义 Header（`09331d9` + `f53cd4b`）— **建议最先做**

- **语义**：渠道可配 `custom_headers`（键值对），附加到该渠道**所有**上游请求，含真实转发、模型测试、模型列表探测。`other` 透传路径下**自定义 Header 覆盖客户端同名透传值**。
- **校验**（`internal/gateway/headers/headers.go`）：最多 **20** 对；名称 ≤128 字符、值 ≤2048 字符；名称须为 HTTP token 字符（`a-z A-Z 0-9` + `` !#$%&'*+-.^_`|~ ``）。
- **黑名单**（大小写不敏感，19 项）：`authorization` / `x-api-key` / `api-key` / `host` / `content-length` / `transfer-encoding` / `connection` / `upgrade` / `proxy-authorization` / `proxy-authenticate` / `via` / `te` / `trailer` / `cookie` / `content-type` / `user-agent` / `anthropic-version` / `anthropic-beta` / `accept-encoding`。
- **中文错误文案**：`自定义 Header 最多 20 对` / `自定义 Header 名称不合法或超过 128 字符：X` / `自定义 Header 不允许配置 X` / `自定义 Header X 的值超过 2048 字符`。
- **存储**：`channels` 表 `custom_headers TEXT`。**注意**：上游只面向 SQLite 故写 `DEFAULT ''`；你按 `AGENTS.md` 约定 MySQL 须写 `DEFAULT NULL`，两套 schema 各按自身语法。
- **联动**：`Channel`/`CreateChannelInput`/`UpdateChannelInput`/`GatewayRoute`/`AdminModelTestTarget` 全加该字段；**三条 SELECT 必须补列**（`FindModelTestTarget`、`FirstEnabledChannelForChannel`、`ListGatewayRoutes`）—— 最易遗漏，漏了注入拿不到值。
- **API**：POST/PUT `/api/admin/channels` 接受对象并**整份替换**（PUT 字段缺席保持原值，`{}` 或 `null` 整份清空）；**注意请求是 object、响应是 JSON 字符串的类型不对称契约，须保持**。`probe-models` 接受请求体传入的 `custom_headers` 且**不读取渠道已存配置**（无状态探测）。`/healthz` 的 features 增 `custom_headers`。
- **f53cd4b 修的两个真实缺陷（务必一并移植）**：
  1. 新增 `Normalize`（`Validate` 变为其薄包装），**保存与探测时修剪名称与值的首尾空白** —— 否则 `"  X-Pad  "` 落库后 `Set` 会致请求失败（表现为 502）。
  2. 前端正则 `+-.` 字符区间展开**意外放行逗号**，须写 `+\-.` 或把 `-` 放末尾。
- **注入顺序**：标准路径先 `ApplyIf(custom)` 后设 `Content-Type`/`x-api-key`（托管字段永远胜出）；`other` 路径为客户端透传 → multipart boundary → 自定义覆盖 → `Authorization`/`x-api-key` 最后。
- **门控**：上游对精简版走 features 三层静默忽略。你按 `AGENTS.md`「不必为精简版补门控」处理即可。
- **工作量**：约 5-6 人日。**建议最先做** —— 纯增量，不动选路，风险最低。

### 5.2 模型级前置系统提示词注入（`f20b3e8`）

- **语义**：`models` 表新增 `system_prompt` 列，转发前**按上游协议**注入，**前置合并**且保留客户端已有 system，**不原地修改原始请求**（重试切渠道后按新模型配置重新注入）。
- **按协议注入位置**：
  - `chat_completions`：合并到首条 system 消息；无 system 时头部插入
  - `responses`：合并到 `instructions`（`prompt + "\n\n" + existing`）
  - `anthropic_messages`：合并到顶层 `system`；字符串直接拼，blocks 形态**前插纯文本块**（保留原 block 的 `cache_control` 等标注）
  - `embeddings` / `other`：无 system 概念，**不注入**
- **注入内容计入上游 prompt tokens；本地 token 预估基于客户端原始请求，不含注入内容**（已声明行为，非 bug）。
- **上游缺陷，不要照抄**：`injectResponsesSystem` 只处理 string 形态的 `instructions`，非字符串（数组/对象）会被判空后**直接覆盖、丢失原内容**，且上游无测试覆盖。建议你保留原内容或不注入。
- **上游另一处空白**：`system_prompt` **未做长度校验**。
- **下游关键漏点**：路由查询（等价 `ListGatewayRoutes`）必须 SELECT 该列，否则注入拿不到值。
- **工作量**：约 4-5.5 人日，与其它项完全独立。

### 5.2b 请求体上限 50MB + 开关（`e87e474` + `d5ed330`）

- 上限 10MB → **50MB**，覆盖 OpenAI/Anthropic/Ollama/other 全部入口。
- **50MB 是代码常量 `gatewayMaxBodyBytes`，不是设置项**；设置页只有开关，不能改数值，前端文案硬编码 50MB。
- 新设置 `request_size_limit_enabled`，默认 **开启**。上游**未给该键加 seed 行**（与其它 6 个 sweep 键都有 seed 不一致），首次读取用代码默认 true，直到管理员显式保存才落库。
- 三处硬编码你已有：`lib/gateway/gateway-handler.ts:96`、`lib/gateway/ollama-handler.ts:195`、`lib/gateway/passthrough-handler.ts:41`。
- **d5ed330 溢出修复（核心）**：关闭开关时上限为 `math.MaxInt64`，调用点统一用「上限+1」给 `MaxBytesReader`，**+1 溢出为负数导致拒绝所有请求**。新增 `gatewayBodyReadLimit` 做溢出保护。**TS 不会复现同样溢出**（`MAX_SAFE_INTEGER+1` 丢精度而非变负），建议用 `Infinity`/`null` 表示无限制并在所有比较点显式处理。
- 边界：设置读取失败也视为**关闭限制（fail-open）**，是有意取向。
- **工作量**：约 1.5-2.5 人日，独立、低风险、**最快见效**。

### 5.3 渠道分组（`49f53c7` + `494634e`）

- `channels` 表加 `group_name TEXT`，最长 **64** 字符，保存去首尾空白。
- **仅用于列表组织，不参与请求路由**（这点很关键）。
- 纯管理界面功能，工作量小。

### 5.4 渠道模型批量管理与搜索（`f2cf465` + `6c83ecc`）

- 模型抽屉支持复选框/全选、批量禁用、批量删除；搜索框按 alias/真实模型/渠道名模糊过滤。
- 附带上游 `6c83ecc`「移除非免费模型」功能。
- 纯前端，工作量小。

### 5.5 从 models.dev 预填充渠道（`848bd70`）

- 渠道表单增加入口，拉 `https://models.dev/api.json`，按 `npm` 类型推导协议：
  - `@ai-sdk/anthropic` → `anthropic_messages`
  - `@ai-sdk/openai` → `chat_completions` + `responses`
  - 其它 → `chat_completions`
- 模型协议推导：id/name 含 `embedding` → `embeddings`；输出 modality 非纯 text → `other`；否则首选协议。
- `sessionStorage` 缓存。前端独立功能，工作量小。
- 附带修复：`useModalLayer` 焦点陷阱在 Drawer 叠加 Dialog 时互相抢焦点。

### 5.6 日志清理（`49de906`/`3eca061`/`5cca9ef`/`457b01f`/`305ecbe`/`cc5e988`）

**经与你的 `lib/data/log-cleanup.ts`、`lib/core/settings.ts`、`lib/core/db/init.ts` 逐项比对：核心语义已高度一致**（同设置键 `log_retention_days`、同默认 0、同 0-3650 整数范围、同「0 = 不删」、同每轮重读设置）。**这不是重写，是补三块缺口**：

1. **`log_auto_cleanup_enabled` 开关**（上游默认关）—— 你现在只要 `days > 0` 就每 6 小时自动删，**无法「设了天数但只手动清理」**，这是真实能力缺口。上游交叉校验 `enabled && days <= 0` → 400「开启定时清理前需先设置保留天数」；校验的是**合并后的值**，故同一次 PUT 同时设 `retention=7 + enabled=true` 合法。
2. **`POST /api/admin/logs/cleanup`** —— 空 body 被放行；`days` 可选且**显式拒绝 0**（1-3650）；缺省时回落设置值（用 `RawGatewaySettings` 绕过缓存）；两者均无效返回 400。响应 `{message, data:{deleted, days}}`，`days` 回显实际生效值。
3. **前端「立即清理」按钮 + 按已保存值描述影响范围的确认弹窗**（`cc5e988` 的教训）。

**不要跟的上游做法**：
- 上游是**单条大 DELETE、无分批、无批次间 sleep**；你的 5000 条分批 + 400ms 让出**更好**，保留。
- 上游**只有 SQLite 分支**；你必须保留自己的 MySQL `NOW() - INTERVAL` + 派生表子查询写法。
- 上游**不清理 `email_send_log`**；你有，建议保留。

**调度语义差异**：上游**不在启动时立即执行**（注释称「给应用初始化和配置加载留出完整一个轮询周期」），纯每小时 tick；你是「启动 1 分钟后首清，之后每 6 小时」。`305ecbe` 修的是 Go 进程关停一致性（`Stop()` 需 `wg.Wait()` 等在途清理），Next.js 下形态不同，但精神值得参考。

**需你决策**：手动清理接口只删 `logs`，还是也删 `email_send_log`？上游只删 `logs`。

> **决策结果（2026-10-03）**：**两张表都删**。保留期到了定时任务迟早也会删掉 `email_send_log`，手动清理只删一半会让用户困惑。属对上游的**有意偏离**，已在 `API.md` 注明。

**工作量：0.5-1 人日。**

### 5.7 用量排行重构（`e18293b`/`986a721`/`740ba40`/`18495df`/`1a1dcad`/`cc05d5f`/`b5a45f5`/`47ae3af`）

**关键发现：你目前没有 `top-usage` 端点。** 你把 Top 排行内嵌在 `GET /api/dashboard/summary` 响应里（返回 `top_models`/`top_channels`/`top_users`），前端在 `app/dashboard/_home/dashboard-top-usage-tables.tsx` 渲染。已用 `git grep` 确认无任何 `top-usage` 路由。

因此上游这套「独立端点 + 独立页 + 后台小时汇总」对你是**全新架构，且包含一次破坏性 API 变更**（把 summary 里的三个 Top 字段下沉到新端点），不是增量改进。另外 `system_rank`（「先全量排名再按用户名过滤，名次不重编号」）已验证下游**完全没有**；注意你的 `top_users_visible` 与上游 `dashboard_top_usage_enabled` **不是同一个东西**，应新增而非替换。

上游做法：后台按日志 **id 水位**增量汇总到 `usage_hourly`：

```sql
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  model_alias TEXT NOT NULL DEFAULT '',
  real_model TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, user_id, model_alias, real_model, channel_id, outcome)
);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_user_hour ON usage_hourly(user_id, hour);
```

- `outcome` 三值 `'failed'|'success'|'other'`，判定复用日志侧定义：无 channel→`other`，429→`other`，≥400 且≠429→`failed`，<400→`success`。`latency_sum`/`latency_count` **只累加 status_code < 400** 的成功行。渠道排行**只统计 `outcome='success'`**，模型/用户榜统计全部。
- 模型名归一：`COALESCE(NULLIF(model_alias,''), NULLIF(real_model,''), '-')`。
- **水位不建表**，复用 `settings` 两个 key（未加入 defaultSettings，运行时 upsert）：`usage_rollup_last_log_id`、`usage_rollup_updated_at`。批大小 **20000**，每批独立事务。
- 调度器**每分钟 tick**，靠持久化 `updated_at` + refresh_minutes 判断到期（非进程内计时器），故重启既不重复汇总也不漏到期轮。
- 设置：`dashboard_top_usage_enabled` 默认开（**缺 key 视为开**）；`dashboard_top_usage_refresh_minutes` **仅白名单 5/15/60/1440**，范围外一律回落 60。
- 端点：`GET /api/dashboard/top-usage` —— 关时返回 `{"data":{"enabled":false}}`（其余字段一个不返回，零查询）；开时返回 `{enabled, refresh_minutes, updated_at, top_models, top_channels, top_users}`，各榜 LIMIT 10。`key`/`ip` 筛选**被忽略**，时间筛选**精度到小时**，`updated_at` 首轮前为 `null`。`GET /api/dashboard/profile` 增 `usage_ranking_enabled`。`log-stats` 的 facets **彻底移除**，只返回 `{summary}`。
- 开关关闭时前端**所有角色**（含管理员）隐藏菜单 + 直接访问重定向。
- 缓存相关已修缺陷（移植时直接避开）：**不得修改共享缓存对象**（原实现往共享 `gin.H` 写字段 → Go 并发 map 读写 fatal error）；**缓存键必须哈希**（原键含用户输入自由文本，任意认证用户可用随机筛选串撑爆内存）；**缓存满且无过期项时须驱逐最早到期项**（原实现放弃写入 → 可让缓存全局失效，DoS）；缓存键须含开关状态；时间窗须 `Truncate` 到分钟。

#### ⚠️ 两个上游未解决、你必须自行决策的正确性风险

1. **id 水位在 MySQL 下会永久漏数。** 上游论证原文依赖「日志只插入不更新，且 **SQLite 单写者**保证已提交的最大 id 之前没有未提交的行」。你同时支持 MySQL，`SELECT MAX(id)` 可能取到未提交事务的 id，水位跳过后那些行**永远不会被汇总**。需改为时间上界（只汇总 `created_at < now() - 安全余量`）或保留回看窗口。
2. **多实例部署下会重复累加。** `ON CONFLICT ... DO UPDATE SET x = x + excluded.x` 是**加法**非幂等覆盖，两个进程同时汇总同一批 id → 数据翻倍。上游是单进程 Go 服务无此问题；你的 `log-cleanup.ts` 用模块级 `started`/`running` 布尔，多实例下无效。需 DB 级乐观锁（`UPDATE settings SET value=? WHERE key=? AND value=?` 判行数）或租约。

另：**MySQL 主键长度** —— 6 列复合主键含两个模型名字段，utf8mb4 下很可能超 InnoDB 3072 字节上限。上游只有 SQLite 未处理。建议 `VARCHAR(191)` 或自增 id 主键 + UNIQUE KEY。

#### 建议分两阶段

- **第一阶段（风险低、见效快）**：设置开关 + 独立 `top-usage` 端点（**仍实时查 logs**）+ summary 拆字段 + 前端迁移。先把架构对齐，不引入汇总表。
- **第二阶段（单独评审）**：`usage_hourly` + 后台调度，需先解决上述两个正确性问题。

**工作量：第一阶段约 2-3 人日；第二阶段约 2-4 人日。**

### 5.8 其它中小功能

| 来源 | 功能 | 说明 |
|:---|:---|:---|
| `682f877` | 用户列表按 OIDC subject 搜索 | `keyword` 同时匹配 `username` 或 `oidc_subject`，极小改动 |
| `f2cf294` | Webhook 同步用户状态 | 新增 `user.status_change` 事件，`new_status=blocked/active` 禁用/启用用户；**禁用用户仍可被后续 Webhook 定位**以支持解封同步 |
| `2a316a6` | OIDC 与 keys 热路径补索引 | 性能 |
| `45f66eb` | 日志表查询索引 | 性能 |
| `e87e474`+`d5ed330` | 请求体上限 10MB→**50MB** + 开关 | 新增 `request_size_limit_enabled`（默认开启）；上游修了「关闭开关后上限溢出为负数导致**所有请求被拒**」的 bug，移植时注意溢出保护 |
| `fbd7195` | 数值配置全串解析 | `12abc` 不再被静默解析为 `12`；dashboard `tz_offset` 钳制 ±24 小时防乘法溢出 |
| `6c2597c` | 全新安装默认用户组 `enabled=1` | 否则默认组查不到、组级限流不生效 |
| `1332542` | 计费乘法改四舍五入 | 消除 float64 截断的**系统性少计**；溢出钳制到 int64 上界 |
| `f7e484d` | 周期配额重置时间格式归一化 | `period_reset_at` 字典序比较下旧格式（空格分隔）恒小于 RFC3339 的 `T`，导致**当日首个请求误重置** |
| `dfc4ab7` | 软删除用户组时改写名称 | 否则 UNIQUE 约束使同名组无法重建，启动失败 |
| `1c4f1ac` | 业务 4xx 不计入熔断 | 仅 5xx/401/403/429 计入；**多用户连续 400 会误熔断健康渠道** |
| `2179adb` | 流式转发不再被渠道超时整程截断 | 流式改用无总超时客户端 + 块间空闲看门狗；非流式维持总超时 |
| `9e96d2a` | 归还排队超时竞态下的并发租约 | 否则渠道并发容量被逐步侵蚀至耗尽 |
| `b449c36` | 用量累加失败记日志 | 不再静默吞掉，配额偏差可排查 |
| `110778b`/`d2e4c70` | npm 依赖漏洞 | 路径遍历、DoS、react-router XSS（CVE-2026-53667） |

---

## 六、第三档：大型功能（需评估投入）

### 6.1 渠道亲和性（`f98f53a`，2026-08-24）

**默认关闭。** 以「API Key ID + 请求别名 + 路由类型」为键：

- **路由族**（`affinityRouteFamily`）只有 3 类：`text` / `embeddings` / `other`。Chat Completions / Anthropic / Responses **全部归 text 共享**，embeddings 与 other 各自独立命名空间。
- **无任何数据库改动** —— 全内存状态，设置项走既有 KV 表。
- **没有走 features 门控**（与自定义 Header 不同），完整版/精简版都生效。
- **精确失效字段清单（易错点）**：渠道仅 `BaseURL`/`APIKey`/`Enabled` 变化才失效；模型仅 `Alias`/`RealModel`/`ChannelID`/`UpstreamProtocol`/`Enabled` 变化才失效。**权重、max_concurrency、timeout、system_prompt 等运行参数变化保留绑定。**
- **选路关键细节**：仅 `attempt == 0` 用绑定，重试后一律加权随机；先按 `{ChannelID, RealModel}` 去重取最高分（平局取小 ModelID），**保证同一请求不重复尝试同一 target**。
- **403/404 特殊处理**：它们不在重试集合（`401,429,500,502,503,504`）内，故需在**最终响应阶段补记**失败，否则熔断关闭时坏渠道会粘到 TTL 过期。
- **并发排队规则（核心 fix）**：绑定目标并发满时，仍有备用尝试则用非阻塞 `tryAcquire` 快速失败换目标；**已是最后一次尝试（含关闭重试）则退回排队**，与未开启亲和一致。
- **并发协议**：`epoch`（关闭功能时 ++，拒绝晚到回调回写）+ `generation`（拒绝过期快照覆盖）；单 Mutex，无后台 goroutine，60s 惰性清理，10 万条目上限 fail-open。**JS 单线程下 epoch/generation 仍然必要**（await 会让出控制权）。
- 常量：`channelAffinityDefaultTTL=60m`、`channelAffinityCooldown=15s`、`channelAffinityCleanupInterval=1m`、`channelAffinityMaxEntries=100000`。
- 日志 metadata 增加 `routing.affinity`（**只记枚举，不泄露 channel_id/model_id/real_model**），日志页新增「上游拒绝」标签。
- 新增设置：`channel_affinity_enabled`（默认 false）、`channel_affinity_ttl_minutes`（默认 60，范围 1-1440 且须整数，错误 `请求参数不正确`）。

**移植要点**：核心是进程内并发安全的内存状态机。上游 627 行 Go + 1453 行测试。**最大风险**是你的 `lib/gateway/upstream-routing.ts` 现用 `excludedModelIds: Set<number>`（model.id 粒度），而亲和要求 `{channelId, realModel}` 粒度 + target 去重，**属选路重构**。必须保证「关闭时行为与现状逐字一致」（上游有专门的兼容性测试覆盖，建议照做）。
**工作量：约 7-9 人日。**

### 6.2 预算化多轮重扫（`ca3ef1a`，2026-08-29，含 9-24 的回放修复簇）

这是上游这轮**最复杂**的功能，重写了网关重试内核。

- **默认关闭。** 开启后文本/嵌入协议（`chat_completions`/`responses`/`anthropic_messages`/`embeddings`）进入「单轮覆盖全部渠道 + 预算内多轮重扫」模式；**Other 透传不生效**。
- **开关矩阵**：
  | `upstream_retry_enabled` | `upstream_retry_sweep_enabled` | 文本/嵌入行为 |
  |:---|:---|:---|
  | 0 | 任意 | 单次尝试，错误直接透传 |
  | 1 | 0 | 现状：≤`max_attempts` 次瞬时码换渠道重试 |
  | 1 | 1 | 单轮全部渠道 + 预算内多轮重扫 + 分类重试 + 聚合错误 |
- **单轮全覆盖**：第一轮遍历全部可用目标，不受 `max_attempts` 限制；等待期间不持有渠道并发租约。
- **轮间等待**：`wait = min(1s × 2^(round-1), 15s)`，带 `Retry-After` 时取较大值（上限 30s），截断到剩余预算，等待期间监听客户端取消。
- **错误体分类**：`model_not_found` / `context_exceeded` / `parameter_unsupported` 三类签名；无签名保持现状透传。
- **流式语义**：受 `min(total budget, stream budget)` 约束（首包前）；首次进入轮间等待即提交 SSE 头，每 **10s** 发 `: keep-alive`；首包后断流补发错误块（无 `[DONE]`）并立即解绑渠道。
- **上下文超限回放**（设计意图值得注意）：整轮失败且出现过 `context_exceeded` 时 —— 未写出任何字节则**回放首个原始 4xx**（状态码与错误体逐字节）；已写出字节则改发 SSE 错误块。**目的：让 Claude Code / Codex 等 Agent 工具直接进入上下文压缩流程，而不是对 502 盲重试烧光预算后中止会话。**
- **新设置**（6 个，已核实精确默认与校验）：
  | 键 | 默认 | 校验 |
  |:---|:---|:---|
  | `upstream_retry_sweep_enabled` | 关 | 布尔 |
  | `upstream_retry_sweep_budget_seconds` | **120** | 10-300，须整数 |
  | `upstream_retry_sweep_stream_budget_seconds` | **30** | 1-120，须整数 |
  | `gateway_alert_webhook_url` | "" | 空或 http(s) 且 host 非空 |
  | `gateway_alert_webhook_min_interval_seconds` | **300** | 60-3600，须整数 |
  | `dashboard_sweep_metrics_enabled` | 关 | 布尔 |

  **双重夹紧**：读取侧 `positiveInt` 给默认，生效前 `resolveSweepSettings` 再 clamp 到 10-300 / 1-120。流式实际预算 = `min(Budget, StreamBudget)`。
- **新端点**：`GET /api/dashboard/sweep-metrics`（近 24h 聚合：请求放大倍数、平均轮数、outcome 分布、Top 失败渠道）
- 日志 metadata 增加 `routing.sweep`（rounds/outcome/attempts/heartbeats，attempts 超 16 条截断）
- **警告（上游原文）**：本功能**全局生效**，非 agent 消费者同样受影响；确定性错误多数场景与现状耗时接近，**瞬时故障会从快速失败变为预算内等待**。建议同时开启熔断。

**移植要点**：涉及 `gateway_common.go` +401 行、`gateway_sweep.go` 501 行、约 2800 行测试（含 915 行集成测试）。**工作量：约 14-18 人日**（轮循环与并发租约/亲和/熔断的交互是最大风险），且会显著改动你现有的 `lib/gateway/gateway-handler.ts` 重试逻辑。**建议单独立项，不要混在普通同步里。**

#### 6.2b 上下文超限回放（`de86992` + 9-24 修复簇，依赖 6.2）

**整轮失败且过程中出现过 `context_exceeded` 时，不回聚合 502，而是把首个该签名尝试的原始 4xx 状态码与错误体逐字节回放**，让 Claude Code / Codex / DSH 等 Agent 工具直接进入上下文压缩流程，而非对 502 盲重试烧光预算中止会话。

**无新增配置项、无开关、无 DB 改动、无新端点**，完全依赖 sweep 开关。

**必须按最终形态实现，不要逐提交回放历史**（中间版本已被上游自己判定为死代码删除）。最终形态关键点：

- **触发门控（最重要）**：要求 `outcome ∈ {exhausted, signature_abort, budget_exhausted}`。**`client_cancelled` 不回放**（否则把客户端取消伪装成上下文超限）。三处出口（SSE 事件 / `c.Data` 回放 / 日志状态覆写）统一走该门控。
- `ctxReplay` 只记录**第一个** `context_exceeded` 的原始响应。
- 常量：回放体上限 **32KB**（初版 2048 被判定过小，真实超限 JSON 可超 3KB）、合成 message 上限 **4096**。
- ≤32KB 原样回放，Content-Type **强制** `application/json`（不透传上游 SSE 型）。>32KB 降级合成：按 UTF-8 边界截断，合成 `{"error":{code:"context_length_exceeded",type:"invalid_request_error"[,message]}}`；原 error 是对象则以其为基底覆写 message，message 为**非文本形态时 `delete` 而非伪造**，保留 code/param/request_id。
- message 提取**最终只剩 `error.message` 单次嵌套**，取不到返回空；写出侧 `displayMessage()` 兜底为状态码默认说明。**绝不把整段 JSON 原文当 message。**
- **关键前提**：`{"error":"文本"}`、数组 error、顶层 message 三种形态在**分类阶段即得无签名透传**（Go struct 解码失败），**永远到不了回放构造**。**TS 若用宽松解析会与 Go 分叉。**
- 已写字节判定统一为 `Writer.Written()`，覆盖心跳/流转发/垫片/未来所有写出点。SSE 已提交则改发 `code=context_length_exceeded` 错误事件（不发 `[DONE]`），日志此时**维持聚合失败状态码**。
- 修掉的可达缺陷：流式请求下渠道返回 SSE 型 Content-Type 的 400 时，零字节早停回放会把 `text/event-stream` 透传给裸 JSON，客户端 SSE 解析器卡住。

**TS 难点**：UTF-8 安全截断（JS `slice` 按 UTF-16 切，与 Go 字节语义不同）、`bytesWritten` 标志需自建、必须 JSON 重建而非文本截断。
**工作量：约 4-5 人日（依赖 6.2）。**

---

## 七、第四档：上游设置项汇总（移植时的字段契约）

上游新增/变更的系统设置键（含默认值）：

| 设置键 | 默认 | 说明 |
|:---|:---|:---|
| `log_retention_days` | 0 | 已有 |
| `log_auto_cleanup_enabled` | false | **下游缺失**，见 5.6 |
| `dashboard_top_usage_enabled` | true | 用量排行总开关（缺 key 视为开） |
| `dashboard_top_usage_refresh_minutes` | 60 | 仅白名单 5/15/60/1440 |
| `channel_affinity_enabled` | false | 渠道亲和性 |
| `channel_affinity_ttl_minutes` | 60 | 1-1440，须整数 |
| `upstream_retry_sweep_enabled` | false | 多轮重扫 |
| `upstream_retry_sweep_budget_seconds` | **120** | 10-300，须整数 |
| `upstream_retry_sweep_stream_budget_seconds` | **30** | 1-120，须整数 |
| `gateway_alert_webhook_url` | "" | 告警 webhook，http(s) 校验 |
| `gateway_alert_webhook_min_interval_seconds` | **300** | 60-3600，须整数 |
| `dashboard_sweep_metrics_enabled` | false | 重扫指标 |
| `request_size_limit_enabled` | true | 请求体上限 50MB（上游未加 seed 行） |

数据库改动汇总：

| 表 | 列 | 说明 |
|:---|:---|:---|
| `channels` | `custom_headers TEXT` | 自定义 Header（JSON）；MySQL 须 `DEFAULT NULL` |
| `channels` | `group_name TEXT` | 分组，最长 64，不参与路由 |
| `models` | `system_prompt TEXT` | 前置系统提示词 |
| `users` | `token_version` | 改密后撤销令牌 |
| 新表 | `usage_hourly` | 用量排行小时汇总（DDL 见 5.7） |
| `settings` | 新增若干键 | 另有两个水位 key 运行时 upsert，未加入 defaultSettings |

所有列变更上游均走 `ensureColumn` 幂等补齐，与你的约定一致。

---

## 八、建议的同步批次

拆成四批，各批可独立提交。**批次内已按「风险最低 / 依赖最少」排序，建议按序推进。**

> **批次一、二开工前建议先做一件事：抽公共基础设施，避免逐条打补丁。**
> - 共用 **SSE 帧读取器** —— 一次覆盖 `67c529c` + `b9ae580` + `ec31db4`（你的四个解码器当前各自重复同一段有缺陷的解析逻辑）
> - 共用 **图片互转工具**（`parseImageDataURL` / `dataURLForImage` / `anthropicImageSource`）—— 覆盖 `09068a8`
> - 共用 **脱敏工具**（`maskApiKey` / `redactUrlCredentials` / Ollama 路径掩码）—— 覆盖 `6cf905e` + `3fd4f36` + `327cef2`
> - 共用 **请求体限读** —— 覆盖 `41c1ead`，可直接复用你 `passthrough-handler.ts` 现成的 `readBodyCapped`
>
> 另外**中间协议字段扩展应一次规划**：`length` 完成语义、图片 base64/media_type、`StopSequences` 双向承接三者都触及 `IntermediateRequest`/`IntermediateResponse`/`NormalizedContentPart` 类型定义，合并为一次协议层重构比分散改更安全。
>
> **回归测试优先覆盖**：截断语义三协议 6 个方向；图片双向；SSE 边界（单帧内 CRLF / 跨 chunk CRLF / data 多前导空格 / 纯文本多行 data）；熔断（连 5 个 400 不打开、连 3 个 500 应打开）；流式超时（**长流不被截断** + **挂死流被取消** —— 这两个用例在你当前实现下都会失败，是验证移植到位的关键）。

1. **批次一（安全，优先）**：`77bf9ed` token_version、`6cf905e` 密钥脱敏、`3be07c1` OIDC 回调、`327cef2` 日志掩码、`b5a6ab1` webhook 去重、`1423bc2` app_id 校验、`ec9e3ec` 密码三缺口、`41c1ead` 请求体限制。
2. **批次二（协议正确性）**：第 3.1-3.5 节确认项，优先 `09068a8`（图片）、`6f18246`（length）、`ec31db4`（finish/usage）、`67c529c`+`b9ae580`（SSE）、`0c18ad1`（黑名单改白名单）、`f210e44`（max_completion_tokens）。
3. **批次三（中小功能，按此顺序）**：
   - 请求体上限 50MB + 开关（1.5-2.5 人日，最快见效）
   - 模型级系统提示词注入（4-5.5 人日，独立）
   - 渠道级自定义 Header（5-6 人日，纯增量）
   - 渠道分组、渠道模型批量管理、models.dev 预填充、OIDC subject 搜索、Webhook 用户状态、日志清理三缺口
   - 其它小修：熔断 4xx 口径（`1c4f1ac`，6 个调用点）、周期配额时间格式（`f7e484d`，涉两张表）、排队租约归还（`9e96d2a`）、流式空闲看门狗（`2179adb`，**只移植看门狗那一半**）、软删除组名释放（`dfc4ab7`）、用量累加日志（`b449c36`）、计费溢出钳制
4. **批次四（大功能，单独立项，复杂度递增）**：
   - 用量排行第一阶段（独立端点 + 开关，仍实时查，2-3 人日）
   - 渠道亲和性（7-9 人日）
   - 用量排行第二阶段（`usage_hourly` 汇总，需先解决 MySQL 水位与多实例重复累加）
   - 预算化多轮重扫（14-18 人日）+ 上下文超限回放（4-5 人日，依赖前者）

---

## 十、本轮执行结果（2026-10-03）

批次一至三已实施完毕，**批次四经用户决策跳过**（用量排行/渠道亲和/预算化重扫均为 3-18 人日的大型功能，按第 6 节的建议单独立项）。

**已实施**（每项独立 commit，均为语义移植，无 Next.js 参考实现）：

| 批次 | 内容 |
|:---|:---|
| 一 | token_version、渠道密钥脱敏、OIDC 回调绑定、Ollama 令牌掩码、webhook 去重与 app_id 校验、密码验证三缺口、非网关请求体限制 |
| 二 | 图片 base64、length 截断、流式 finish/usage、SSE 解析、扩展字段白名单、max_completion_tokens |
| 三 | 请求体上限 50MB + 开关、系统提示词注入、渠道自定义 Header、渠道分组、模型批量管理、models.dev 预填充、OIDC subject 搜索、webhook 用户状态、日志清理三缺口 |

**批次一/二的逐项落点**（复核时可直接按此定位，均已实测存在）：

| 项 | 落点 |
|:---|:---|
| `token_version` | `users` 列 + `auth.ts` 签发/校验比对 + 三处改密路径递增 |
| 渠道密钥脱敏 | `lib/shared/redact.ts` 的 `maskApiKey` / `redactUrlCredentials` |
| OIDC 回调绑定 | 回调校验 state 与绑定关系 |
| webhook 去重 + `app_id` | `webhook-dedup.ts`；**`app_id` 校验必须先于去重**，否则来源不匹配的事件会先占用标记 |
| 图片 base64 | `normalized-message/content.ts`（data URL ↔ base64 ↔ `media_type` 三向） |
| length 截断 | `intermediate.ts` 双向映射 + `responses-response.ts` + 流式 `incompleteReason` |
| `max_completion_tokens` | `chat-completions-request.ts`、`token-estimate.ts`、`protocol-extra.ts` |
| 请求体上限开关 | `settings.ts` 的 `request_size_limit_enabled` |

**Ollama 令牌掩码（`327cef2`）最终判定为不需要移植**（已实测而非推断）：该上游修复针对「鉴权失败时把 path 中的 token 写进日志」。本项目的 token 是经 `withPathToken()` 塞进合成 header 的，**从不进入日志或错误响应**；`checkApiKeyAuth` 只返回 `reason`（`missing`/`invalid`），全部 6 处调用点均映射为**静态中文文案**，不回显 URL 或 token。故无泄漏面。

**第三档小修的实施结论**（逐项实测，非仅静态判断）：

| 上游提交 | 结论 |
|:---|:---|
| `1c4f1ac` 业务 4xx 不计熔断 | **修复**，新增 `countsAsChannelFailure`，3 处状态推导调用点全部改对 |
| `f7e484d` 周期配额格式 | **修复**，新增 `period-reset.ts`，旧 RFC3339 值的字典序缺陷已消除 |
| `dfc4ab7` 软删除组名 | **修复**，并补了默认组缺失时的自愈 |
| `b449c36` 用量累加日志 | **修复**，fire-and-forget 的 unhandledRejection 改为限频记录 |
| `1332542` 计费四舍五入 | **本已满足**，`cleanFloat` 仅在整数值 1e-6 内收敛，不截断、无系统性少计 |
| `9e96d2a` 排队租约归还 | **本已满足**，超时等待者被移出队列并标记 settled，容量不泄漏 |
| `2179adb` 流式空闲看门狗 | **本已满足**，`finally` 中的 `clearTimeout` 使超时仅覆盖连接+响应头，长流不被截断 |
| `fbd7195` 数值全串解析 | **不适用**，本项目用 `z.number()`（非 `z.coerce`），`12abc` 被拒绝；且无 `tz_offset` |
| `6c2597c` 默认组 enabled | **本已满足**，实测全新安装 `enabled=1` |

**审计**：共 9 轮独立 subagent 审计，第 9 轮**通过（256 项断言全绿，无高危、无中危）**。前 8 轮累计发现并修复 3 高危 + 8 中危，其中数据丢失风险 2 项（日志清理时区基准、周期配额永不重置）。

### 批次四的最终处置：不做

经复核本项目的实际形态，批次四三项**均判定为不实施**，理由与上游功能设计无关，而取决于本站点的规模与既有架构：

| 项 | 判定 | 依据 |
|:---|:---|:---|
| 6.1 渠道亲和性 | **不做** | 本站每个别名最多 2 个可用渠道（27 个别名仅 1 个，9 个有 2 个）。亲和按设计会在 `attempt == 0` 覆盖加权分配，将用户粘到单一渠道，**在 2 渠道场景下直接削弱按权重分摊成本的能力**，而缓存收益前提（上游按前缀计费）对站内多数国内模型不成立。且需把选路从 `excludeModelIds`（模型粒度）重构为 `{channelId, realModel}` 粒度，属高风险改动 |
| 6.2 预算化多轮重扫 | **不做** | 其核心卖点是「单轮遍历全部渠道、不受 `max_attempts` 限制」，而本站最多 2 个候选、`upstream_retry_max_attempts = 3` 已覆盖全部候选；且 `upstream-routing.ts` 用 `excludeModelIds` 累积已试目标，遍历完即自然终止，**等价能力已经存在**。剩余差异只是把快速失败换成预算内等待（最长 120s），对本站是净损失 |
| 6.2b 上下文回放 | **不做** | 曾实现后实测回退。上游需要它是因为其聚合逻辑会把「整轮失败」统一返回 502，从而把 400 伪装成 502；而本站 `shouldRetryUpstreamStatus(400)` 为 `false`，400/403/404/409/413/422 **一律不重试、原样透传上游响应**，不存在被伪装成 502 的路径。强行回放反而可能把携带超限字样的 429（限流）误判为上下文超限 |

**唯一遗留**：6.2 的「确定性错误分类」若将来有需要，可作为独立小改（识别 `context_length_exceeded` 等签名后不重试），无需引入重扫内核。

**同轮额外修复**：复核过程中发现 OIDC 的 JWKS 缓存 5 分钟且无失效入口，**身份提供商轮换签名密钥后 5 分钟内所有人无法登录**（已实测复现）。已修复并配套抑制伪造 `kid` 造成的刷新放大，详见提交 `2189583`、`076f651`、`57e9bd7`、`072672e` 与 `API.md` 的 JWKS 说明。

---

## 九、说明与限制

- 上游 `nextjs` 分支已于 2026-06-15 停止维护，**本次所有改动都无 Next.js 参考实现**，均为语义移植。文中 DDL、字段名、默认值、校验规则均直接取自上游 Go 代码与 `docs/zh/api.md`，可直接作为契约使用。
- 第三、四节的「下游状态」列已按 [downstream-defect-audit.md](./downstream-defect-audit.md) 更新，标注**确认存在**的项均已对照你的实际代码（含文件行号）。**最初基于抽查的两处判断已被修正**：`a5f90b9`（原以为你已实现，实为缺失）、`2179adb`（移植方向被反转，你需要的只是空闲看门狗）。
- 该审计自身列有 **8 项待验证清单**（如 o 系模型词表、JWKS kid 重试、用户级配额、非网关路由体大小限制等），相关行已标注「待验证」而非断言，建议独立复核。
- 上游 UI 重构与 Go 工程改动已按你的要求排除，未纳入本文。
- 本目录文档均为分析产出。**第十节的执行结果表在实施完成后补写**，其余正文保留分析时的原始判断，未回改。
