# 上游 Gateway 功能移植分析报告（Next.js 侧）

分析对象：`upstream/go` 分支（Go 重写）中的 4 组功能提交，目标是提取**产品级功能语义**，供下游 Next.js/TypeScript 版 ModelGate 重新实现。

下游仓库：`D:\Documents\ecustcic\ModelGate`，当前 HEAD `57ca2a9`（2026-10-02，redeem 修复），最后同步上游约 2026-07-09。

## 0. 结论速览：老 Next.js 分支是否存在这些功能

`upstream/nextjs` 分支最后一次提交为 `0848ae8`（2026-06-15，合并 main 的 MR #42），早于全部 4 组功能提交。

验证命令与结果：

| 检查项 | 命令 | 结果 |
|:---|:---|:---|
| 重扫 | `git log --all --oneline --grep="重扫"` | 命中 6 条，**全部在 go 分支**（`ca3ef1a`/`de86992`/`8331bd0`/`2d37363`/`398e372`/`30bd3c7`），nextjs 分支无 |
| 回放 | `git log --all --oneline --grep="回放"` | 命中 12 条，**全部在 go 分支** |
| 提示词 | `git log --all --oneline --grep="提示词"` | 命中 `f20b3e8`（go），另两条 `b5bf56c`/`f04a854` 与系统提示词无关 |
| 请求体 | `git log --all --oneline --grep="请求体"` | 命中 `e87e474`（go） |
| `git grep system_prompt upstream/nextjs` | — | 无命中 |
| `git grep upstream_retry_sweep upstream/nextjs` | — | 无命中 |
| `git grep request_size_limit upstream/nextjs` | — | 无命中 |

**结论：4 组功能在 old Next.js 分支一律不存在，全部是 Go 重写期间新增。下游没有任何可 cherry-pick 的代码或可回退的兼容逻辑，全部需要从零实现。** 唯一的交集点是请求体上限：nextjs 分支与下游当前代码都是硬编码 `10 * 1024 * 1024`（`upstream/nextjs:lib/gateway/gateway-handler.ts:61`、`upstream/nextjs:lib/gateway/ollama-handler.ts:195`；下游对应 `lib/gateway/gateway-handler.ts:96`、`lib/gateway/ollama-handler.ts:195`、`lib/gateway/passthrough-handler.ts:41` 的 `MAX_BODY_BYTES`）。

下游当前代码中 `system_prompt`、`upstream_retry_sweep`、`request_size_limit` 三个关键字均无命中，即这 4 组功能完全未落地。

---

## 1. `ca3ef1a` 预算化多轮重扫（budgeted multi-round rescan）

- 提交：`ca3ef1a6e5062e2af800b52857c705a6d117655f`，2026-08-29，PR #65
- 变更规模：31 文件，+3705 / −88
- 主要新增文件：`internal/http/gateway_sweep.go`（501 行）、`internal/http/gateway_alerts.go`（134 行）、`internal/http/dashboard_sweep_test.go`、`internal/http/gateway_sweep_integration_test.go`（915 行）

### 1.1 功能语义

在既有「按瞬时状态码换渠道重试」之上，新增一种**预算驱动的多轮全渠道重扫**模式：

1. **单轮全覆盖**：开启后第一轮不再受 `upstream_retry_max_attempts` 限制，按现有选路器遍历**全部**可用目标，直到目标耗尽。等待期间**不持有渠道并发租约**（避免长等待占满并发）。
2. **错误体分类换渠道**：除既有瞬时状态码（429/5xx）外，对「换渠道可能解决」的 4xx 按错误体特征分类，分类命中则记一次尝试并换下一个目标；未命中（`sigNone`）保持现状**透传**（保守默认，不消耗预算重扫）。
3. **轮循环**：一轮扫完无成功则按指数退避等待后进入下一轮，直到**总预算**耗尽。
4. **同签名早停**：同一请求内 ≥2 个**不同目标**出现同一可换渠道签名时，立即终止剩余轮次（避免全渠道 context 超限这类确定性错误多轮慢失败）。
5. **聚合错误**：多目标全败返回 502 聚合并列出各渠道状态与签名；**单目标保持透传**（上游状态码与响应体原样）。
6. **出站告警**：全轮耗尽/早停/预算耗尽时向配置的 webhook 投递告警（按 alias 节流）。
7. **流式保活**：轮间等待提交 SSE 头并周期发 `: keep-alive` 心跳；首包后断流补发错误块并加速驱逐亲和绑定。
8. **观测**：请求日志 metadata 新增 `routing.sweep`；新增仪表盘指标端点。

生效范围（文档明写）：文本/嵌入协议（`chat_completions`、`responses`、`anthropic_messages`、`embeddings`）；**Other 透传不生效**。

### 1.2 开关矩阵（`docs/zh/gateway.md` 明写）

| `upstream_retry_enabled` | `upstream_retry_sweep_enabled` | 文本/嵌入行为 | Other 透传行为 |
|:---|:---|:---|:---|
| 0 | 任意 | 单次尝试，错误直接透传 | 现状 |
| 1 | 0 | 现状：≤`max_attempts` 次瞬时码换渠道重试 | 现状 |
| 1 | 1 | 单轮 = 全部渠道 + 预算内多轮重扫 + 分类重试 + 聚合错误 | 现状（不受影响） |

代码印证（`gateway_common.go` `newSweepRunState`）：先读 `RawGatewaySettings()`，`UpstreamRetryEnabled != 1` 直接返回空 state（`active=false`），再判 `sweep.Enabled`。

### 1.3 配置项 / 字段（精确键名与默认值）

`internal/settings/service.go` 的 `GatewaySettings` / `GatewaySettingsInput` 新增 6 个字段（JSON tag 即设置键）：

| 设置键（JSON tag） | Go 字段 | 类型 | 默认值 | 校验范围 | 设置页 |
|:---|:---|:---|:---|:---|:---|
| `upstream_retry_sweep_enabled` | `UpstreamRetrySweepEnabled` | int64 / `*bool` | **0（关闭）** | 布尔 | 开关 |
| `upstream_retry_sweep_budget_seconds` | `UpstreamRetrySweepBudget` | int64 / `*float64` | **120** | **10–300**，且必须为整数（`math.Trunc(value) != value` 报错） | 数字输入 |
| `upstream_retry_sweep_stream_budget_seconds` | `UpstreamRetrySweepStreamBudget` | int64 / `*float64` | **30** | **1–120**，整数 | 数字输入 |
| `gateway_alert_webhook_url` | `GatewayAlertWebhookURL` | string / `*string` | `""` | 空或 `http`/`https` 且 host 非空（`url.Parse` 校验） | 文本输入 |
| `gateway_alert_webhook_min_interval_seconds` | `GatewayAlertWebhookMinInterval` | int64 / `*float64` | **300** | **60–3600**，整数 | 数字输入 |
| `dashboard_sweep_metrics_enabled` | `DashboardSweepMetricsEnabled` | int64 / `*bool` | **0（关闭）** | 布尔 | 开关 |

非法值统一 `return nil, current, fmt.Errorf("请求参数不正确")`。

默认值同时 seed 进设置表（`internal/store/sqlite/settings.go` `defaultSettings`）：

```go
{"upstream_retry_sweep_enabled", "0"},
{"upstream_retry_sweep_budget_seconds", "120"},
{"upstream_retry_sweep_stream_budget_seconds", "30"},
{"gateway_alert_webhook_url", ""},
{"gateway_alert_webhook_min_interval_seconds", "300"},
{"dashboard_sweep_metrics_enabled", "0"},
```

**双重夹紧**：读取侧 `positiveInt(..., 120)` 保证下限 >0；真正生效前 `resolveSweepSettings` 再做一次 `clampSweepInt64`：总预算夹到 **10–300s**，流式预算夹到 **1–120s**。即 DB 被人为写坏也不会无限重试。

`resolveSweepSettings` 产出内部结构：

```go
type sweepSettings struct {
    Enabled      bool
    Budget       time.Duration
    StreamBudget time.Duration
}
```

流式请求实际预算 = `min(Budget, StreamBudget)`（`newSweepRunState` 中 `minDuration`），且 `state.streaming = true`。判定依据是 `h.adapter.streamRequested(body)`。

### 1.4 数据库改动

**无新列、无新表。** 只有 settings 键值表的 seed 数据新增 6 行（键值对，非 schema 变更）。日志侧复用既有 `logs.metadata`（TEXT，存 JSON）承载 `routing.sweep`，无 DDL。

Go 侧索引优化仅是查询语句加 `metadata LIKE '%"sweep"%'` 预筛（`DBDashboardSweepLogs`），未加索引。

### 1.5 API 改动

**新增端点：`GET /api/dashboard/sweep-metrics`**（注册于 `registerDashboardAPI`，`internal/http/dashboard_routes.go`）

- 认证：用户（JWT/Cookie 或 API Key），走 `requireWebUser` + `userFilterID`（普通用户只看自己，管理员看全量）
- 开关关闭时**不执行聚合查询**，直接 `render.OK(c, {"data":{"enabled": false}})`
- 开启时聚合**近 24 小时**带 `routing.sweep` 的日志行，经 `dashboardResults` 缓存（缓存键 `sweepmetrics|<userFilterKey>|<windowStart>`，含窗口起点避免跨窗口脏缓存；`formatUserFilterKey` 对 nil 用户返回 `"admin"`）

响应字段（`sweepMetricsResult`）：

| 字段 | 类型 | 语义 |
|:---|:---|:---|
| `enabled` | bool | 开关状态；false 时其余字段不返回 |
| `amplification` | float64 | `Σ(尝试次数) / sweep 生效请求数`，保留 2 位小数（`math.Round(x*100)/100`） |
| `avg_rounds` | float64 | 平均轮数，2 位小数 |
| `rounds_histogram` | map[string]int64 | 轮数 → 请求数 |
| `outcome_counts` | map[string]int64 | outcome → 数量 |
| `top_channels` | array | `{channel_id, channel, failed_attempts, top_signature}`，按失败尝试数降序（同数按 channel_id 升序），**最多 10 个**；仅统计 `signature != ""` 的尝试 |

**设置端点变更**：`GET/PUT /api/admin/settings`（既有端点）的请求/响应体新增上述 6 个字段，无需新端点。

### 1.6 关键算法 / 边界细节

#### 1.6.1 错误签名分类器（`classifyUpstreamError`）

三类签名 + 短语表（匹配 `strings.ToLower` 后的 `strings.Contains`）：

| 签名常量 | 值 | 短语 |
|:---|:---|:---|
| `sigModelNotFound` | `"model_not_found"` | `model_not_found`、`deployment_not_found` |
| `sigContextExceeded` | `"context_exceeded"` | `context_length_exceeded`、`context length`、`context_window`、`maximum context`、`prompt is too long`、`input too long` |
| `sigParameterUnsupported` | `"parameter_unsupported"` | `unknown_parameter`、`unsupported_parameter`、`unsupported parameter`、`unknown field`、`unknown_argument` |
| `sigNone` | `""` | 未匹配 |

关键实现细节：

- 只解析 `{"error": {"code","type","message"}}` 三字段，**`code`/`type` 优先于 `message`**（先遍历 code、type，都无命中才看 message）。
- 三字段均为 `interface{}` 并经 `valueToString` 转字符串——非字符串形态（数字、对象、数组）会 `json.Marshal` 后再匹配，故 `code: 4001` 之类也能命中。
- JSON 解析**失败（`parseErr != nil`）时**：仅当 `status == 404` 返回 `sigModelNotFound`，否则 `sigNone`。这是给「非 JSON 的 404 页」的兜底。
- **关键前提（`8331bd0` 明确锁定的不可达形态）**：`classifyUpstreamError` 把 `error` 解入 struct，因此 `{"error":"文本"}`（字符串解不进 struct → 返回类型错误）、`error` 为数组、顶层 `message` 三种形态在**分类阶段即得 `sigNone` 并透传**，永远走不到回放构造。这一点对移植很重要：TS 实现如果用 `any` 宽松解析，会与 Go 行为分叉。

#### 1.6.2 退避等待（`sweepWait`）

```
wait = 1s << (round - 1)              // 基数 1s，倍率 2
if wait > 15s || wait <= 0 { wait = 15s }   // 上限 sleepCeiling = 15s
if hint > 0 {
    if hint > 30s { hint = 30s }      // Retry-After 上限 sweepRetryAfterCap = 30s
    if hint > wait { wait = hint }    // 取两者较大
}
if remaining > 0 && wait > remaining { wait = remaining }  // 截断到剩余预算
if wait < 0 { wait = 0 }
```

`round < 1` 时夹到 1（避免左移负数）。

**`Retry-After` 解析（`retryAfterDuration`）**：先 `Sscanf("%d")` 试整数秒（**负值视为无效返回 false**），再依次试 `http.TimeFormat`、`time.RFC1123`、`time.RFC850`；日期解析出的 `delay < 0`（已过期）返回 false；空串返回 false。即非法值一律当「无 hint」而非报错。

**目标级 ineligible 标记（`markIneligible`）**：

```go
remaining := s.deadline.Sub(s.controller.now())
if hint >= remaining {
    s.ineligible[target] = s.controller.now().Add(hint)
}
```

即只有当 `Retry-After` 提示的恢复时间**达到或超过剩余预算**时，才把该目标标记为「后续轮次跳过」；否则仅作为轮间退避 hint。`runSweepRound` 开头检查 `ineligible`，未到期则同时排除该 target 与 channel。

#### 1.6.3 同签名早停（`signatureTracker`）

- `counts map[errorSignature]map[upstreamTargetKey]bool`——**按目标去重**，重复尝试同一目标不累计。
- `Record` 忽略 `sigNone`。
- `ShouldAbort()`：任一签名对应 `len(targets) >= 2` 即 true。
- `abortSignature()`：按 `sweepClassifierRules` 的**声明顺序**返回首个满足 `>=2` 的签名（顺序保证确定性：model_not_found → context_exceeded → parameter_unsupported）。

#### 1.6.4 轮循环终止条件（`forwardWithSweep`）

```
for round := 1; ; round++ {
    roundResult := runSweepRound(...)
    if roundResult.done { ... return }
    remaining := deadline - now()
    if remaining <= 0        → outcome = budget_exhausted, 返回
    wait := sweepWait(round, roundResult.roundHint, remaining)
    if wait <= 0             → outcome = budget_exhausted, 返回
    if sweepWaitWithHeartbeat(...) 返回错误 → outcome = client_cancelled, 返回
    // 本轮一个目标都没试过 且 当前无 ineligible 且 从未尝试过任何目标 → 快速失败
    if roundResult.noCandidate && !hasIneligible(now) && len(attempts) == 0
                             → outcome = exhausted, 返回
    if now() >= deadline     → outcome = budget_exhausted, 返回
    sweep.rounds = round + 1
}
```

关键边界：
- 睡眠**之后**重新判定剩余预算（不是睡眠前），所以预算是硬上限。
- 「从未尝试即全部不可选（前置熔断/冷却）」保持**快速失败**；「已尝试过（自己把渠道打到熔断/冷却）」则在预算内等待恢复窗口。这是 `ca3ef1a` 内部第 3 个子提交修正的语义。
- 熔断恢复窗口文档写为：「熔断 15s、亲和冷却 15s 可恢复」。

`runSweepRound` 内的 `outcome` 赋值路径：`sigNone` 的 4xx → `sweepSuccess`（透传，`done=true`）；有签名 → `sweepExhausted` 并 continue；`ShouldAbort()` → `sweepSignatureAbort` + `abortMessage` + `done=true`；流式/非流式成功 → `sweepSuccess`。`attempt == 0` 时无候选 → `noCandidate=true`；`attempt > 0` 时无候选 → `sweepExhausted`。

#### 1.6.5 聚合错误文案（`aggregateExhaustedMessage`）

```
全部上游渠道尝试失败（%d 轮 / %d 目标）：<ch1 status [sig]; ch2 status [sig]; ...>
```
标签格式 `fmt.Sprintf("%s %d", attempt.Channel, attempt.Status)`，有签名时追加 `" " + signature`。**超过 `maxSweepAggregateTargets = 8` 时截断**为前 8 条 + `fmt.Sprintf(" …等 %d 个", len(labels))`（注意 `len(labels)` 是未截断总数）。

`finishSweepFailure` 边界：`len(sweep.attempts) <= 1` 时**不聚合**——有 cause 返回 cause，否则返回 `"上游请求失败"`。这保证「单目标」语义是透传而非聚合。

#### 1.6.6 流式语义

- **心跳**：`sweepHeartbeatInterval = 10 * time.Second`，心跳文本 `": keep-alive\n\n"`（SSE 注释行）。`sweepWaitWithHeartbeat` 在首次进入等待时**立即**发第一个心跳，之后每 10s 补发；每次发送前若 `!sseCommitted` 则先提交 SSE 头（`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`、`Status(200)`）。非流式或 `wait <= 0` 直接 `sleep`。
- **可取消睡眠**：`defaultSweepSleep` 按 **≤500ms（`sweepSleepSlice`）** 切片，每片 `select` 监听 `ctx.Done()`，取消时 `timer.Stop()` 并返回 `ctx.Err()`。
- **SSE 错误块**：`writeSweepErrorEventPayload` 输出 `data: {json}\n\n`，**刻意不发 `[DONE]`**，让客户端把流视为中断。
  - 通用错误块：`type="upstream_error"`、`code="stream_interrupted"`，message 追加 `（已尝试 %d 轮 / %d 个渠道）`——但若 message 已含「全部上游渠道尝试失败」则不追加（避免重复后缀）。
  - 上下文超限错误块：`type="invalid_request_error"`、`code="context_length_exceeded"`（见第 2 节）。
- **单事件垫片**：`writeSweepSingleEventShim` 把非流式成功结果包装为 `data: <body>\n\n` + `data: [DONE]\n\n`，用于「SSE 头已提交但胜出的是非流式响应」的场景。
- **断流错误块 + 亲和驱逐**：`relayStreamResponse` 中 `relayErr != nil && c.Writer.Written() && result.sweep.active` 时补发错误块并 `result.affinity.recordInterrupt(result.route, "stream_interrupted")`（立即解绑，15s 冷却）。**门控到 sweep 开启**，关闭时严格保持历史静默断流行为。
- **已写字节判定**：各处统一用 `c.Writer.Written()`（`52d2a99` 从仅覆盖心跳的 `sseCommitted` 统一过来），覆盖心跳、流转发、垫片及任何未来写出点。

#### 1.6.7 日志 metadata（`routing.sweep`）

```go
type sweepMetadata struct {
    Rounds     int                  `json:"rounds"`
    BudgetMS   int64                `json:"budget_ms"`
    WaitedMS   int64                `json:"waited_ms"`
    ElapsedMS  int64                `json:"elapsed_ms"`
    Outcome    string               `json:"outcome"`
    Heartbeats int                  `json:"heartbeats,omitempty"`
    Attempts   []sweepAttemptRecord `json:"attempts,omitempty"`
    Truncated  bool                 `json:"truncated,omitempty"`
}
type sweepAttemptRecord struct {
    Round     int    `json:"round"`
    ChannelID int64  `json:"channel_id"`
    Channel   string `json:"channel"`
    Status    int    `json:"status"`
    Signature string `json:"signature"`
}
```

- 嵌入位置：`{"routing": {"sweep": {...}}}`，与既有 `routing.affinity` 并列——`mergeSweepMetadata` 解析既有 metadata JSON，取/建 `routing` 对象，写入 `sweep` 键。历史非 JSON metadata 无法合并时**丢弃 base、直接落 sweep**。
- **`outcome == ""` 时直接返回 base（不写）**——所以首轮成功、零尝试的请求不产生「重扫 0 轮」噪音徽标（`sweepMetadataValue` 中 `outcome == sweepSuccess && len(attempts) == 0` 返回空结构）。
- **attempts 超 `sweepMaxLoggedAttempts = 16` 截断**并置 `truncated = true`；nil 时置空数组（保证 JSON 输出 `[]` 而非 `null`）。
- `budget_ms` 在流式请求时写 `min(Budget, StreamBudget)`。
- `rounds` 与 attempt 的 `round` 均 `maxInt(x, 1)` 保底 1。

outcome 枚举值（`sweepOutcome`）：`success`、`exhausted`、`signature_abort`、`budget_exhausted`、`client_cancelled`。

#### 1.6.8 出站告警（`internal/http/gateway_alerts.go`）

- **节流**：`channelAlertStore` 按 alias 记 `last map[string]time.Time`（`sync.Mutex` 保护），`now.Sub(last) < interval` 则不再通知。`interval <= 0` 或 store 为 nil 一律不通知。
- **触发条件**：`dispatchSweepAlertForResult` 中 `outcome ∈ {exhausted, signature_abort, budget_exhausted}`；`sweep == nil || !active` 直接返回。
- **载荷（FR-7，`gatewayAlertPayload`）**：

  | 字段 | 类型 | 说明 |
  |:---|:---|:---|
  | `event` | string | 固定 `"gateway.upstream_exhausted"` |
  | `timestamp` | string | `time.Now().UTC().Format(time.RFC3339)` |
  | `alias` | string | 模型别名 |
  | `rounds` | int | 轮数 |
  | `duration_ms` | int64 | 耗时 |
  | `attempted` | array | `{channel, status, code}`，`code` = 签名字符串 |

  **刻意不含用户/Key 标识**（隐私要求，有专门测试锁定）。
- **投递**：`postGatewayAlert`，`http.Client{Timeout: 5s}`，`Content-Type: application/json`；`webhook_secret` 非空时附 `X-ModelGate-Signature` = HMAC-SHA256(secret, body) 的 hex；`resp.StatusCode >= 300` 视为失败。**异步 goroutine 尽力投递，失败仅 `gatewayLogf` 记日志、不重试、不阻塞请求**。

#### 1.6.9 与「流式静默截断」的耦合（同一 PR 内的子提交）

`ca3ef1a` 还修了一个独立 bug：`RelayStream` 原先在上游提前结束时伪造成 `finish reason=stop` + `[DONE]` 并计为成功。改为：上游在协议终止信号（`finish_reason`/`[DONE]`、`message_stop`、`response.completed`）之前结束**一律返回流错误**，走既有 `relayErr` 路径触发错误事件、亲和加速驱逐与熔断计数。chat/anthropic 适配器把 `[DONE]` 视为终止信号；responses 删除截断伪造并把 `response.incomplete` 映射为 `finish length`。涉及 `internal/gateway/protocol/stream.go`、`stream_chat.go`、`stream_anthropic.go`、`stream_responses.go`。

这块与重扫无直接依赖，但**下游若未实现同样语义，第 2 节的「流式错误块」与「不伪造成功」组合行为会不一致**，建议一并评估。

### 1.7 移植到 TypeScript 的要点与工作量

**要点**

1. **不需要 schema 迁移**，只需在设置默认值表（下游 `lib/core/db/settings-seed.ts` 与 `lib/core/settings.ts` 的 `DEFAULTS`）加 6 个键，并在设置读取/校验层加边界检查。下游已有 `ensureColumn` 约定，此处用不上。
2. **设置校验必须双向**：读取侧给默认值，写入侧拒绝越界并返回「请求参数不正确」；再实现一次运行时 clamp（10–300 / 1–120）——上游是刻意双保险，不要省略。
3. **重试循环要重构而非叠加**。下游当前 `lib/gateway/gateway-handler.ts:129-130` 是 `maxRouteAttempts = retryEnabled ? max(1, upstream_retry_max_attempts) : 1` 的单轮 for 循环。建议抽出独立的 sweep 模块（对应上游 `gateway_sweep.go`），把纯函数（分类器、退避、签名统计、元数据构建）与 IO 循环分开，便于单测。
4. **分类器必须严格复刻「error 必为对象」的解析方式**。Go 用 struct 解码使字符串/数组/顶层形态在分类阶段即透传；TS 若用 `body.error?.code ?? body.error?.type ?? body.error?.message` 的宽松链式取值，会在 `{"error":"..."}` 上得到 `undefined`（同 Go 行为，OK），但如果写成「先 JSON.parse 再对整段文本做短语匹配」就会**扩大命中范围**，与上游行为分叉。上游为此专门加了 `TestClassifyUpstreamErrorReachableForms` 七项形态表。
5. **`c.Writer.Written()` 等价物**：Next.js Route Handler 里没有 Gin 的写字节计数。需要在流式回写路径自己维护一个 `bytesWritten` 标志（心跳写、流转发写、垫片写都要置位），并以此为唯一判定依据。上游踩过两套判定不一致的坑（`52d2a99`）。
6. **可注入时钟**：下游若沿用 vitest，需要 `now()` / `sleep()` 注入点，否则退避与预算测试会变慢或 flaky。上游 `sweepController` 就是这个模式。
7. **`Retry-After` 解析**：JS 的 `Date.parse` 对 RFC850 支持不可靠，建议显式实现三段解析，并保持「负值/过期/非法一律视为无 hint」。
8. **SSE 层**：心跳（`: keep-alive\n\n`）、错误块（无 `[DONE]`）、单事件垫片（带 `[DONE]`）三种写出需要在下游 SSE 编码器里显式支持。下游 `lib/gateway` 已有协议分离的流式转换，建议按现有边界各自实现。
9. **`routing.sweep` 元数据**：下游日志 metadata 已用 `routing.affinity` 结构，直接扩展同一 JSON 即可。注意 16 条截断、空 outcome 不写、`budget_ms` 流式取 min。
10. **仪表盘端点**：下游已有 `dashboardResultCache` 等价物可复用；缓存键必须含窗口起点。

**工作量估计**

| 子项 | 估计 |
|:---|:---|
| 设置字段 + seed + 校验 + 设置页 UI | 1–1.5 人日 |
| 纯函数层（分类器/退避/Retry-After/签名统计/聚合文案/metadata） | 1.5–2 人日 |
| 轮循环 + 单轮全覆盖改造（含租约、亲和、熔断交互） | 3–4 人日 |
| 流式（心跳/错误块/垫片/断流驱逐） | 2–3 人日 |
| 出站告警（节流/HMAC/异步投递） | 0.5–1 人日 |
| 仪表盘端点 + 前端卡片 + 日志徽标 | 2 人日 |
| 单测与集成测试（上游对应约 1300 行测试） | 3–4 人日 |
| 文档（`API.md` + gateway 文档 + 客户端集成文档） | 0.5 人日 |
| **合计** | **约 14–18 人日** |

**风险点**：轮循环与下游既有并发租约/亲和/熔断的交互是最容易出错的部分（上游为此写了 915 行集成测试）。建议先落地「关闭时行为零变化」的回归测试，再打开开关。

---

## 2. `de86992` 上下文超限回放 + 周边修复簇

- 主提交：`de869922ff126c87ab6713201e9883d82ecd9101`，2026-09-24
- 修复簇：`7782fa3` → `e6ca727` → `c296ec9` → `2e0e037` → `a6d8cac` → `1ddcbbf` → `3aed0e5` → `8331bd0` → `52d2a99`（均为 2026-09-24，PR #85 / #87 两批）
- 主提交仅改 3 文件 +191/−2；整簇累计约 +350 行，绝大多数是行为修正与测试

### 2.1 功能语义

**问题**：多轮重扫把「上下文超限」也当成可换渠道的错误。当所有渠道都返回上下文超限时，网关返回聚合 502，下游 Agent Harness（Claude Code / Codex / DSH）无法识别这是「上下文太长」，只能对着 502 盲重试，烧光重试预算后**中止整个会话**。

**解决**：整轮失败（耗尽/早停/预算耗尽）且过程中**出现过 `context_exceeded` 签名**时，不返回聚合 502，而是把**首个**该签名尝试的**原始 4xx 状态码与错误体**回放给客户端，让 harness 识别并进入上下文压缩流程。

上游把这一取舍明确写入文档：「回放门槛维持『出现过 context_exceeded 即回放』的产品决策，设计取舍（宁可多一次压缩也不让 harness 烧光重试后中止会话）」。

设计意图原文（`docs/zh/gateway.md`）：

> 上下文超限是唯一客户端可自救的错误（压缩会话上下文），原样回放让 Agent Harness（Claude Code / Codex / DSH 等）直接进入其上下文压缩流程，而不是对着 502 盲重试烧光重试预算后中止会话。即便其余渠道只是暂时不可用（5xx/429）导致「误判」，重扫预算内的多轮等待本身就是等待恢复机制——整个预算跑完仍失败，说明短时间恢复概率低，多一次压缩的代价远小于会话中止。

### 2.2 配置项 / 字段

**无新增设置项、无新增开关。** 回放完全复用第 1 节的 `upstream_retry_sweep_enabled`（关闭重扫则不存在 `ctxReplay`，行为不变）。

### 2.3 数据库改动

**无。** 仅改写 `logs.status` / `logs.error_message`（复用既有列），轮次明细仍在 `logs.metadata.routing.sweep`。

### 2.4 API 改动

**无新端点、无新字段。** 改动体现在**响应语义**：

- 非流式、且连接上尚未写出任何字节：返回**上游原始 4xx 状态码 + 原始错误体逐字节**，`Content-Type` 统一为 `application/json`。
- 已写出过字节（心跳、流转发、垫片等）：HTTP 状态已无法改写，改为追加 SSE 错误事件：

  ```json
  {"error": {"message": "<上游原文文本>", "type": "invalid_request_error", "code": "context_length_exceeded"}}
  ```
  同样**不发 `[DONE]`**。

客户端集成文档新增错误表行（`docs/zh/client-integration.md`）：

> | 400 等上游 4xx | 上游原始错误回放（开启多轮重扫时） | 整轮重扫失败且过程中出现过上下文超限（`context_exceeded`）时，不返回聚合 502，而是逐字节回放首个超限渠道的原始 4xx 与错误体；Agent 客户端应按上下文超限处理（压缩会话后重试） |

### 2.5 关键算法 / 边界细节

#### 2.5.1 触发条件（`contextReplayForFailure` —— 最重要的一条）

```go
func (s *sweepRunState) contextReplayForFailure() *sweepContextReplay {
    if s == nil || s.ctxReplay == nil { return nil }
    switch s.outcome {
    case sweepExhausted, sweepSignatureAbort, sweepBudgetOut:
        return s.ctxReplay
    }
    return nil
}
```

- `ctxReplay` 只是「**任一轮出现过 `context_exceeded`**」的标记（`runSweepRound` 中 `signature == sigContextExceeded && sweep.ctxReplay == nil` 时记录**第一个**）。
- **必须叠加 outcome 门控**：`client_cancelled`（或 `success`）即使过程出现过 context_exceeded 也**不回放**，否则会把「客户端主动取消」伪装成「请求侧上下文超限」。
- 三个出口**统一**调用该方法：SSE 事件、`c.Data` 回放、日志状态覆写。这是 `2e0e037` 修正的核心。

#### 2.5.2 回放构造（`newSweepContextReplay`，最终形态）

常量：

| 常量 | 值 | 用途 |
|:---|:---|:---|
| `sweepContextReplayBodyLimit` | **32 * 1024（32KB）** | 逐字节回放的体积上限（`c296ec9` 从 2048 提到 32KB） |
| `sweepContextMessageLimit` | **4096（4KB）** | 降级合成时携带的上游文本截断上限 |
| `sweepContextFallbackMessage` | `"prompt is too long: context length exceeded"` | 兜底短语（**注意**：`8331bd0` 删除了对它的使用，见下） |

逻辑：

```
body == ""                         → nil（无回放）
len(body) <= 32KB                  → 原样回放；contentType 传参已废弃，统一 application/json
len(body) >  32KB                  → 降级为合成错误体（见下）
```

**体积上限的取值理由（`c296ec9`）**：原注释以「挡代理 HTML」为由设 2048，但该理由不成立——分类器只认解析后的 `error.code/type/message`，HTML 到不了回放构造；而**真实上游带长 message 的超限 JSON 可超 3KB**，会被静默丢弃退回聚合 502。故上限仅用于限制**病态**超大错误体。

**>32KB 降级合成（`1ddcbbf` + `3aed0e5` + `8331bd0` 的最终形态）**：

1. `message = sweepContextMessageFromBody(body)`，若 `len > 4096` 则 `truncateRunes(message, 4096) + "…"`。
2. `truncateRunes`：**按字节预算截断但在 UTF-8 边界回退**（`for limit > 0 && !utf8.RuneStart(s[limit]) { limit-- }`），避免把多字节字符切成孤立首字节——严格解码的客户端不会拿到替换字符（有 CJK 用例 + `utf8.ValidString`/`json.Valid` 断言）。
3. 合成体形状：
   - 默认 `{"error": {"code": "context_length_exceeded", "type": "invalid_request_error"[, "message": <截断文本>]}}`（`message == ""` 时不放 `message` 键）。
   - 若原 body 的 `error` 可解为**对象**：以其为基底，`message != ""` 时**覆写** `message`，`message == ""` 时 **`delete(errorObject, "message")` 而非伪造空串**——`code`/`param`/`request_id` 等诊断字段全部保留。
   - 其余形态（`error` 为字符串/数组等）：走默认最小形态。

  > 说明：`1ddcbbf` 曾加过「`error` 为字符串时保留 `{"error":"文本"}` 形状」的分支，但 `8331bd0` 认定该形态在**分类阶段**就返回 `sigNone` 并透传、**永远到不了回放构造**，属死代码，已整体删除。**最终代码只处理 `error` 为对象的情况。** 这是移植时最容易照抄历史文档而做错的一点。

#### 2.5.3 message 提取（`sweepContextMessageFromBody`，最终形态）

`8331bd0` 后**只剩单次嵌套提取**：

```go
func sweepContextMessageFromBody(body string) string {
    var envelope struct {
        Error   json.RawMessage `json:"error"`
        Message string          `json:"message"`
    }
    if err := json.Unmarshal([]byte(body), &envelope); err == nil {
        if msg := rawErrorMessage(envelope.Error); msg != "" { return msg }
        if envelope.Message != "" { return envelope.Message }
    }
    return ""
}
```

注意最终代码里 `rawErrorMessage` 只保留 `{"error":{"message":"..."}}` 一次嵌套解包，**返回空字符串**而非原文。

**写出兜底（`displayMessage`，`3aed0e5`）**：

```go
func (r *sweepContextReplay) displayMessage() string {
    if r == nil { return "" }
    if r.message != "" { return r.message }
    return statusErrorMessage(r.status)   // 按状态码给默认说明
}
```

SSE 事件与日志两处消费点统一走它。**绝不把整段 JSON 原文伪造成 message**——截断后的 JSON 伪文本对 harness 文本匹配与人工阅读都是噪音。

#### 2.5.4 已写字节判定（`52d2a99`）

从 `sseCommitted`（仅覆盖轮间等待心跳一种写出途径）**统一为 `c.Writer.Written()`**，覆盖心跳、流转发、单事件垫片及任何未来写出点。五处一致切换：

1. 失败出口的 SSE 分支
2. `writeGatewayResponse` 的 4xx 透传分支
3. 响应转换失败分支
4. 单事件垫片分支
5. 日志状态覆写

**修的可达缺陷**：流式请求下渠道返回 SSE 型 `Content-Type` 的 400 上下文错误时，零字节早停回放会把 `text/event-stream` 透传给裸 JSON，客户端 SSE 解析器会卡住或丢事件。修复：**回放 Content-Type 统一为 `application/json`**（错误体经分类器保证必为可解析 JSON），并删掉因此死掉的 `contentType` 字段与构造参数。**最终 `sweepContextReplay` 只有 3 个字段：`status`、`body`、`message`。**

#### 2.5.5 非回放透传出口的同类归一（`e6ca727`）

新增 `jsonBodyContentType`：上游把**可解析 JSON 正文**配上 `text/event-stream` 返回时归一为 `application/json`，非 JSON 正文保持原样。接入两个 `c.Data` 出口：

1. 未分类 4xx 的原样透传
2. 非流式成功响应

闭合了 PR87 仅覆盖回放路径的同类缺陷。

#### 2.5.6 日志一致性

- 回放生效（`contextReplayForFailure() != nil`）且 **`!sseCommitted`** 时：`status = replay.status`，`message = replay.displayMessage()`，消除「400 + 全部上游渠道尝试失败」的自相矛盾；轮次明细保留在 `metadata.sweep`。
- SSE 已提交时客户端拿到的是 **200 + 错误事件**，日志**维持聚合失败状态码**（不加 `!sseCommitted` 门控会记成回放的 4xx，是 `7782fa3` 修的）。
- `sweep metadata` 与告警投递**不受回放影响**。

#### 2.5.7 该修复簇的完整时间线（便于理解为何代码与文档有多个版本）

| 提交 | 关键改动 |
|:---|:---|
| `de86992` | 初版：2048 上限，`message = body` 兜底，回放无 outcome 门控 |
| `7782fa3` | 日志状态加 `!sseCommitted` 门控；抽出共用 SSE 事件写出器；补文档 |
| `e6ca727` | 非回放透传出口同样归一 SSE 型 Content-Type |
| `c296ec9` | 上限 2048 → 32KB；message 兜底改为错误对象提取 |
| `2e0e037` | 新增 `contextReplayForFailure` outcome 门控；>32KB 由「整体丢弃」改为「降级合成」 |
| `a6d8cac` | message 回退链补 `{"error":"文本"}`/顶层 message/原文；合成体保留诊断字段；日志 error_message 对齐 |
| `1ddcbbf` | 截断改 `truncateRunes`（UTF-8 边界）；保留 error 字符串形态 |
| `3aed0e5` | 提取不到文本返回空 + `displayMessage` 按状态码兜底；非文本 message 用 `delete` 而非伪造 |
| `8331bd0` | 删除不可达形态分支（字符串 error/数组/顶层 message），锁定「error 必为对象」 |
| `52d2a99` | 已写字节判定统一为 `Writer.Written()`；回放 Content-Type 统一 `application/json` |

**移植建议：直接按最终形态（`52d2a99` 之后）实现，不要逐提交回放历史。** 中间几个版本的行为（如保留 `{"error":"文本"}` 形状）已被上游自己判定为死代码。

### 2.6 移植到 TypeScript 的要点与工作量

**要点**

1. **核心是「顺序 + 门控」两件事**：只记录**第一个** `context_exceeded` 的原始响应；回放必须门控到 `outcome ∈ {exhausted, signature_abort, budget_exhausted}`。前者防止后续渠道的错误覆盖首个；后者防止客户端取消被伪装。
2. **UTF-8 安全截断**：JS 的 `String.prototype.slice` 按 UTF-16 code unit 切，与 Go 的字节+`RuneStart` 语义不同。建议按字节预算遍历并用 `TextEncoder`/`Buffer` 切，避免切断代理对（surrogate pair）。这是最容易做错的一处，务必补 CJK + emoji 用例。
3. **JSON 重建而非文本截断**：>32KB 时绝不能直接切 JSON 字符串（会破坏解析）。必须 `JSON.parse` 出 `error` 对象，改/删 `message`，再 `JSON.stringify`。
4. **`displayMessage` 兜底**：需要下游 `statusErrorMessage(status)` 的等价函数（上游用在 `3aed0e5`）。
5. **已写字节标志**：Next.js Route Handler 中没有 `Writer.Written()`。必须在流式回写路径维护单一 `bytesWritten` 布尔量，所有写出点（心跳、转发、垫片、错误块）统一置位，并**只**用它做判定。
6. **Content-Type 归一**：两处出口都要做——回放出口强制 `application/json`；未分类透传与非流式成功出口做「可解析 JSON 则归一」。
7. **不要实现 `{"error":"字符串"}` 分支**：与 Go 一致，该形态在分类阶段即 `sigNone` 透传。

**工作量估计**

| 子项 | 估计 |
|:---|:---|
| 回放构造（含 UTF-8 截断、合成体、Content-Type 归一） | 1 人日 |
| 三处出口接入（SSE 事件 / `c.Data` 回放 / 日志覆写） | 0.5–1 人日 |
| outcome 门控与 `ctxReplay` 记录点 | 0.5 人日 |
| 测试（长消息、code-only、非文本形态、超限降级、CJK 边界、SSE 型 400、客户端取消） | 1.5–2 人日 |
| 文档（`API.md` + 客户端集成错误表 + gateway 文档） | 0.5 人日 |
| **合计** | **约 4–5 人日**（依赖第 1 节已落地） |

**注意**：本功能强依赖第 1 节的重扫循环（`ctxReplay` 是 sweep state 的字段）。若不做第 1 节，本功能无从谈起。

---

## 3. `f20b3e8` 模型级前置系统提示词注入

- 提交：`f20b3e8b91372c71afb2437a6e04a2cc66955c28`，2026-09-28
- 变更：15 文件，+406 / −7
- 新增文件：`internal/gateway/protocol/system_prompt.go`（86 行）、`internal/gateway/protocol/system_prompt_test.go`（110 行）、`internal/http/gateway_system_prompt_test.go`（120 行）

### 3.1 功能语义

在**模型**维度配置一段「前置系统提示词」。配置后，网关在**协议转换完成后**，按**上游协议**把该提示词注入到发往上游的请求体中。

- **前置合并**：注入内容排在客户端已有 system 内容**之前**，**保留客户端已有 content**（不是替换）。
- **不污染原始请求**：不原地修改客户端原始 body。Go 里对 chat 的同协议透传场景专门做了 map 拷贝，避免污染「重试复用的原始请求」。
- **重试切换渠道后重新注入**：注入发生在**每次渠道尝试**时，按当次路由的模型配置注入。
- **管理端模型测试同样注入**：`POST /api/admin/models/:id/test` 的探测请求也走同一注入逻辑，便于验证实际效果。
- 用户可见行为：调用某模型时，上游收到的请求带上了管理员配置的 system 前置内容。

### 3.2 配置项 / 字段

**字段名：`system_prompt`**（模型级，非系统设置）

| 属性 | 值 |
|:---|:---|
| 所属实体 | `models` 表（模型） |
| API 字段名 | `system_prompt` |
| 类型 | string |
| 默认 | `""`（空字符串，不注入） |
| 长度限制 | 代码中**未发现**显式长度校验（无 max 检查，未验证是否为 DB 层限制）——**这点上游代码中确实没有约束，属明确说明的空白** |
| 规范化 | 创建/更新时 `strings.TrimSpace(value)` 去首尾空白 |
| 清空方式 | PUT 时传空字符串可清空注入配置 |

`InjectSystemPrompt(body, target Protocol, prompt string)` 的 `prompt == "" || body == nil` 时**直接返回原 body**。

获取字段的辅助函数（`systemPromptField`）返回 `(value string, present bool, valid bool)`：字段不存在返回 `("", false, true)`；存在但非字符串 → `render.Error(400, "请求参数不正确")` 并返回 valid=false。

### 3.3 数据库改动

**新增 1 列**：

| 表 | 列名 | 类型 | 默认值 | 可空 |
|:---|:---|:---|:---|:---|
| `models` | `system_prompt` | `TEXT` | `''` | 代码未显式声明 NULL 语义 |

上游通过列补齐机制声明（`internal/store/sqlite/columns.go` `ensureModernColumns`）：

```go
{"models", "system_prompt", "system_prompt TEXT DEFAULT ''"},
```

**下游移植注意**：`AGENTS.md` 明确约定 MySQL 的 `TEXT` 列不可用非空字面量默认值，需写 `DEFAULT NULL`；SQLite 版无此限制。因此下游应写成：

- SQLite schema：`system_prompt TEXT DEFAULT ''`
- MySQL schema：`system_prompt TEXT DEFAULT NULL`

并按约定用 `ensureColumn` 补列，**不改 `CREATE TABLE`**。这与上游 Go 版（SQLite/GORM）写法不同，是有意差异。

Go 侧 model 结构新增字段（`internal/store/sqlite/types.go` `Model`、`models.go` 的 `CreateModelInput`/`UpdateModelInput`/`GatewayRoute`/`AdminModelTestTarget`）：

```go
SystemPrompt string `gorm:"column:system_prompt" json:"system_prompt"`
```

`GatewayRoute` 也带上 `SystemPrompt`，即**路由查询要 SELECT 该列**（`ListGatewayRoutes` 的 Select 列表加了 `m.system_prompt`），这是运行时注入的数据来源。两处测试目标查询（`FirstEnabledModelForChannel`、`FindModelTestTarget`）的 Select 也加了 `m.system_prompt`。

### 3.4 API 改动

**无新端点**，三个既有端点新增字段：

| 端点 | 改动 |
|:---|:---|
| `POST /api/admin/models` | 请求体新增可选 `system_prompt`（string，默认 `""`） |
| `PUT /api/admin/models/:id` | 请求体新增可选 `system_prompt`；**传空字符串可清空** |
| `POST /api/admin/models/:id/test` | 行为变更：模型配置了 `system_prompt` 时探测请求同样注入 |
| 模型详情/列表响应 | 新增 `system_prompt` 字段（`Model` 的 json tag） |

`buildUpdateModelInput` 的默认值取自 `existing.SystemPrompt`，即**未传该字段时保持原值**（PATCH 语义）。

`docs/zh/api.md` 变更：

```
| system_prompt | string | 否 | "" | 模型级前置系统提示词；保存时去除首尾空白 |
```
> `system_prompt` 传空字符串可清空注入配置。

响应示例增加 `"system_prompt": "你是一只乐于助手的猫娘"`。

网关行为说明章节新增：

> - **系统提示词注入:** 模型配置 `system_prompt` 后，请求在协议转换完成后按上游协议注入该前置提示词
>   - `chat_completions` 上游：前置合并到首条 `system` 消息，无 `system` 消息时在头部插入
>   - `responses` 上游：前置合并到 `instructions` 字段
>   - `anthropic_messages` 上游：前置合并到顶层 `system` 字段（文本块形态时在 blocks 头部插入）
>   - `embeddings` / `other` 上游：没有 system 概念，不注入
>   - 注入发生在每次渠道尝试时，重试切换渠道后按新模型的配置重新注入
>   - 注入内容会计入上游返回的 prompt tokens；本地 token 预估基于客户端原始请求，不包含注入内容

**前端**：`web/src/lib/admin-types.ts` 加字段；`web/src/pages/channels/model-form-dialog.tsx` 新增系统提示词输入框；`channel-models-drawer.tsx`、`shared.tsx` 相应调整。

### 3.5 关键算法 / 边界细节

#### 3.5.1 `InjectSystemPrompt` 分发

```go
switch target {
case ChatCompletions: return injectChatSystem(body, prompt)
case Responses:       return injectResponsesSystem(body, prompt)
case Anthropic:       return injectAnthropicSystem(body, prompt)
default:              return body   // embeddings / other 不注入
}
```

调用点在网关的两条路径（`forwardSinglePass` 与 `runSweepRound`）**同一位置**：`adaptRequestBody` 之后、Copilot 归一化之前。

```go
if route.SystemPrompt != "" {
    upstreamBody = protocol.InjectSystemPrompt(upstreamBody, protocol.Protocol(route.UpstreamProtocol), route.SystemPrompt)
}
```

#### 3.5.2 `injectChatSystem`（chat_completions）

- 遍历 `messages`，找**第一个** `role == "system"` 的消息：
  - **拷贝**该消息 map（`make(map[string]interface{}, len(msg)+1)`），`merged["content"] = prependTextContent(msg["content"], prompt)`，再**拷贝整个 messages 数组**替换该 index。传 `body["messages"] = next`。
  - 返回。**只处理第一条 system**，后续 system 消息不动。
- 没有 system 消息时：`body["messages"] = append([]interface{}{system}, messages...)`，即头部插入 `{"role":"system","content":prompt}`。
- 边界：`asArray(body["messages"])` / `asRecord(item)` 对非预期类型返回空/nil，`continue` 跳过（不 panic）。

#### 3.5.3 `prependTextContent`（chat 的 content 合并）

| content 形态 | 结果 |
|:---|:---|
| string 且非空 | `prompt + "\n\n" + value` |
| string 且空 | `prompt` |
| `[]interface{}`（多模态 blocks） | 头部插入 `{"type":"text","text":prompt}`，原 blocks 保留 |
| 其他 | `prompt` |

#### 3.5.4 `injectResponsesSystem`（responses）

```go
existing := asString(body["instructions"])
if existing == "" { body["instructions"] = prompt; return body }
body["instructions"] = prompt + "\n\n" + existing
```

注意：**只处理 string 形态**的 `instructions`。若 `instructions` 是数组/对象（Responses API 支持 instructions 为数组），`asString` 返回 `""`，会**直接覆盖为 prompt**，丢失原内容。**这是上游代码中的一个潜在数据丢失点，下游移植时应明确决策（建议：至少不要覆盖，或显式记录该假设）。**

#### 3.5.5 `injectAnthropicSystem`（anthropic_messages）

```go
switch existing := body["system"].(type) {
case []interface{}:  // blocks 形态：前插纯文本块，保留原 block 上的 cache_control 等标注
    block := map[string]interface{}{"type": "text", "text": prompt}
    body["system"] = append([]interface{}{block}, existing...)
case string:
    if existing == "" { body["system"] = prompt } else { body["system"] = prompt + "\n\n" + existing }
default:             // 无 system / 其他类型
    body["system"] = prompt
}
```

关键：blocks 形态用**前插新块**而非拼接文本，从而保留原有 block 上的 `cache_control` 等标注（对 prompt caching 很重要）。

#### 3.5.6 「不原地修改原始请求」

`injectChatSystem` 的注释原文：

> 同协议透传时消息 map 与客户端原始 body 共享，拷贝后再合并避免污染重试复用的原始请求。

即：当输入协议与上游协议都是 chat 时，`adaptRequestBody` 可能返回共享引用，若不拷贝，第二次渠道尝试会把 prompt 重复拼接（`prompt\n\nprompt\n\noriginal`）。**下游 TS 实现必须注意浅拷贝 `messages` 数组与目标 message 对象**——JS 的对象引用语义比 Go 更容易踩这个坑。

相反，`injectResponsesSystem` / `injectAnthropicSystem` 直接对顶层字段赋值，未做拷贝——但这两个分支只改顶层标量/新数组，不影响原始 message 对象，风险较低（**这一点是推断，上游代码未明确说明**）。

#### 3.5.7 token 计费

文档明写：注入内容**计入上游返回的 prompt tokens**；但**本地 token 预估基于客户端原始请求，不包含注入内容**。即 `usage.Source == "local"` 时低估 prompt tokens。这是已声明的行为，非 bug。

### 3.6 移植到 TypeScript 的要点与工作量

**要点**

1. **DB 列**：按 `AGENTS.md` 约定用 `ensureColumn` 补 `models.system_prompt`；SQLite `TEXT DEFAULT ''`，MySQL `TEXT DEFAULT NULL`。两套 schema 分别书写。
2. **路由查询要带上该列**：下游 `lib/gateway` 的路由/model 查询（等价 `ListGatewayRoutes`）必须 SELECT `system_prompt`，否则注入拿不到值。这是最容易漏的一步。
3. **注入位置**：必须在「输入协议 → 中间协议 → 输出协议」转换**之后**（`AGENTS.md` 的协议组织约定），且在 Copilot 归一化之前。下游若在中间协议层注入，会导致跨协议场景（如入站 chat、上游 anthropic）注入错位置。
4. **按上游协议分发**：三个分支（chat / responses / anthropic）语义不同，不要统一处理。下游已有按协议拆分的适配器模块，建议在各自的出站适配器里实现 `injectSystemPrompt`，而不是放进 `openai-adapter.ts`（`AGENTS.md` 明确禁止其作为全局网关）。
5. **浅拷贝**：chat 分支必须拷贝 messages 数组与目标 message 对象。JS 里建议直接构造新对象，不要 `Object.assign` 原对象。
6. **responses 的 `instructions` 非字符串形态**：上游会静默覆盖。下游应显式决策——建议至少保留原内容（如 `Array.isArray(instructions)` 时前插一个 `{type:"input_text", text: prompt}`，或退化为不注入）。**上游此处行为应视为缺陷，不要盲目照抄。**
7. **管理端模型测试**：`POST /api/admin/models/:id/test` 也要注入，否则测试与真实流量行为不一致。
8. **前端**：模型表单加输入框（多行文本），渠道初始模型创建也支持。

**工作量估计**

| 子项 | 估计 |
|:---|:---|
| DB 列（两套 schema + ensureColumn）+ 类型/查询/CRUD 打通 | 0.5–1 人日 |
| 三协议注入逻辑 + 单元测试 | 1–1.5 人日 |
| 网关两条路径（单轮 + 重扫轮）接入 | 0.5 人日 |
| 管理端测试端点接入 | 0.25 人日 |
| 前端（模型表单 + 抽屉 + 类型） | 0.5–1 人日 |
| 集成测试（含重试不重复注入、跨协议注入位置） | 1 人日 |
| 文档（`API.md`） | 0.25 人日 |
| **合计** | **约 4–5.5 人日** |

**独立性**：本功能与第 1、2 节无依赖，可独立并行开发，是 4 组里**最容易单独立项**的一项。

---

## 4. `e87e474` 请求体上限 50MB + 开关，及 `d5ed330` 溢出修复

- `e87e4749898b9a49557cb88cc87b6649b6f62870`，2026-09-27，8 文件 +56/−14
- `d5ed3308f4a96b9ede3bd38d599dba72ab602a7d`，2026-09-27，5 文件 +47/−3

### 4.1 功能语义

1. 网关请求体上限从 **10MB** 调到 **50MB**，覆盖 **OpenAI、Anthropic、Ollama 与 other 协议**全部入口。
2. 新增设置项 `request_size_limit_enabled`（**默认开启**），可在设置页关闭以**完全解除**请求体大小限制。
3. 关闭后由上游自行处理（可能占用更多内存）。
4. `d5ed330` 修复：关闭开关时上限取 `math.MaxInt64`，**加一后溢出为负数**，导致 `MaxBytesReader` 拒绝**所有**请求（413）；新增溢出保护。

用户可见行为：
- 开关开启：>50MB 请求返回 **413 请求体过大**。
- 开关关闭：网关不再返回 413，请求体大小由上游裁决。

### 4.2 配置项 / 字段

| 设置键 | Go 字段 | 类型 | 默认值 | 校验 |
|:---|:---|:---|:---|:---|
| `request_size_limit_enabled` | `RequestSizeLimitEnabled` | int64 / `*bool` | **1（开启）** | 布尔 |

读取：`RequestSizeLimitEnabled: boolInt(values["request_size_limit_enabled"], true)`
写入：`setBool("request_size_limit_enabled", input.RequestSizeLimitEnabled, &next.RequestSizeLimitEnabled)`

**大小常量**（非设置项，硬编码）：

```go
const gatewayMaxBodyBytes = 50 * 1024 * 1024   // 10MB → 50MB
```

**注意**：50MB 是代码常量，**不是设置项**。设置页只提供「开启/关闭」开关，不能改具体数值。前端文案硬编码「50MB」。

### 4.3 数据库改动

**无。** 仅设置键值表新增 1 个 seed 键 `request_size_limit_enabled`。上游 `defaultSettings` 中本提交**未**显式加该 seed 行（只有 `boolInt` 默认值 + `setBool`），因此**首次读取时用代码默认值 true，直到管理员显式保存过该设置才落库**——这点与第 1 节 6 个键（都有 seed 行）不同，是移植时需要注意的差异。

### 4.4 API 改动

**无新端点。** `GET/PUT /api/admin/settings` 新增 `request_size_limit_enabled` 字段。

`docs/zh/api.md` 变更：

```
| request_size_limit_enabled | boolean | 是否开启网关请求体大小限制（50MB），默认开启；关闭后不再限制请求体大小，由上游自行处理 |
```

响应示例中 `"request_size_limit_enabled": 1` / `true`。

**前端**（`web/src/pages/settings.tsx`）：新增「请求大小限制」卡片 + `ToggleRow`：

- 标题：`请求大小限制`
- 描述：`限制网关单个请求的请求体大小，默认 50MB，图文等多模态请求可能超过旧默认值。`
- 开关标题：`开启请求体大小限制`
- 开关描述：`开启后超过 50MB 的请求会被网关拒绝（413）。关闭后不再限制请求体大小，由上游自行处理，可能占用更多内存。`
- 表单默认值 `request_size_limit_enabled: true`；回填时 `settings.request_size_limit_enabled === undefined || asBool(...)`（未定义视为 true）。

### 4.5 关键算法 / 边界细节

#### 4.5.1 上限解析（`gatewayBodyLimit`）

```go
func gatewayBodyLimit(app App) int64 {
    settings, err := app.Settings.RawGatewaySettings()
    if err != nil || settings.RequestSizeLimitEnabled != 1 {
        // 开关关闭或读取失败时不限制请求体大小，由上游自行裁决。
        return math.MaxInt64
    }
    return gatewayMaxBodyBytes
}
```

**边界**：设置读取**失败也视为关闭限制**（fail-open，不 fail-closed）。这是有意的可用性取向。

#### 4.5.2 溢出保护（`d5ed330` 的核心）

`MaxBytesReader` 的用法是「限制 = 上限 + 1」，读完后比较 `len(rawBody) > limit` 来区分「正好等于上限」与「超限」。当 `limit == math.MaxInt64` 时 `+1` 溢出为 `MinInt64`（负数），`MaxBytesReader` 会**立刻拒绝所有请求**。

修复引入 `gatewayBodyReadLimit`（`internal/http/gateway_helpers.go`）：

```go
func gatewayBodyReadLimit(app App) int64 {
    limit := gatewayBodyLimit(app)
    if limit == math.MaxInt64 {
        // math.MaxInt64 加一会溢出为负数，导致 MaxBytesReader 拒绝所有请求。
        return limit
    }
    return limit + 1
}
```

调用点（3 处）统一改造：

| 位置 | 文件 | 说明 |
|:---|:---|:---|
| 主网关入口 | `internal/http/gateway_common.go` `handle` | `bodyLimit := gatewayBodyLimit(h.app)`，`MaxBytesReader(c.Writer, body, bodyLimit+1)`，比较 `int64(len(rawBody)) > bodyLimit` |
| Ollama chat | `internal/http/gateway_routes.go` `ollamaChat` | 改用 `gatewayBodyReadLimit(h.app)` |
| other 协议 | `internal/http/gateway_other.go` `parseOtherGatewayRequest(c, bodyLimit int64)` | 内联溢出保护：`readLimit := bodyLimit; if readLimit != math.MaxInt64 { readLimit++ }` |

**注意 `gateway_other.go` 是内联而非调用 `gatewayBodyReadLimit`**——因为该函数的 `bodyLimit` 是参数传入（便于测试注入），上游选择了内联重复。移植时可统一为一个 helper。

回归测试：`TestGatewayRequestSucceedsWithSizeLimitDisabled`（`internal/http/router_test.go`），设置 `request_size_limit_enabled = 0` 后普通请求应得 200。

#### 4.5.3 比较类型的坑

`e87e474` 同时把 `len(rawBody) > gatewayMaxBodyBytes` 改为 `int64(len(rawBody)) > bodyLimit`——因为 `bodyLimit` 现在是 `int64`（可能为 `MaxInt64`），而 Go 的 `len()` 返回 `int`。在 64 位平台上两者等宽，但显式转换更安全。TS 里对应 `Buffer.byteLength` / `contentLength` 的比较，注意 `Number.MAX_SAFE_INTEGER` 上限。

#### 4.5.4 下游当前状态

下游三处硬编码 10MB：

| 下游文件 | 行 | 内容 |
|:---|:---|:---|
| `lib/gateway/gateway-handler.ts` | 96 | `if (contentLength > 10 * 1024 * 1024)` |
| `lib/gateway/ollama-handler.ts` | 195 | `if (contentLength > 10 * 1024 * 1024)` |
| `lib/gateway/passthrough-handler.ts` | 41 / 80 / 85 | `const MAX_BODY_BYTES = 10 * 1024 * 1024`，`contentLength > MAX_BODY_BYTES`，`readBodyCapped(request, MAX_BODY_BYTES)` |

**移植注意**：下游是 `Content-Length` 预检 + `readBodyCapped` 边读边限，而上游 Go 是 `MaxBytesReader` 统一读。语义差异点：
- 上游对**无 `Content-Length`**（chunked）的请求也会受限；下游只靠 `readBodyCapped` 兜住，需要确认覆盖完整。
- 关闭开关时下游不能简单把 constant 设成 `Infinity`——`readBodyCapped` 若做累加比较可能同样溢出或行为异常，需要显式分支（照抄上游的「MaxInt64 不 +1」思路）。

### 4.6 移植到 TypeScript 的要点与工作量

**要点**

1. **三处入口统一改造**：`gateway-handler.ts`、`ollama-handler.ts`、`passthrough-handler.ts`（后者兼顾 multipart）。建议抽一个 `resolveBodyLimit(settings): number` 的共享 helper，避免三处各写一遍。
2. **不要用 `Number.MAX_SAFE_INTEGER` 表示「无限制」后无条件 `+1`**：这正是上游踩的坑。显式 `if (limit === UNLIMITED) return limit;`。JS 里 `Number.MAX_SAFE_INTEGER + 1` 不会变负数（会得到 `9007199254740992`，精度丢失但仍是正数），所以**不会复现 Go 的溢出 bug**，但会引入精度问题；建议用 `Infinity` 或显式 null 表示无限制，并在所有比较点处理。
3. **设置读取失败 fail-open**：与上游一致，读设置异常时视为「不限制」，不要 fail-closed 把所有请求 413。
4. **同时更新多模态相关文案**：前端描述提到「图文等多模态请求可能超过旧默认值」，下游设置页应同步。
5. **`API.md` 同步**：新增 `request_size_limit_enabled` 字段说明，并修订既有的「413 请求体过大 = 超过 10 MiB 上限」描述——**下游 `API.md` 与客户端集成文档里若有 10MB 字样需一并改**（上游在 `7782fa3` 中顺带改了 client-integration 的错误表，但该行仍写 10 MiB，属上游文档残留不一致；下游移植时应写 50MB 或按开关状态描述）。
6. **`content-length` 缺失场景**：确认下游 `readBodyCapped` 覆盖 chunked 请求。

**工作量估计**

| 子项 | 估计 |
|:---|:---|
| 设置字段 + seed/默认 + 校验 | 0.25 人日 |
| 三处入口改造 + 共享 helper | 0.5–1 人日 |
| 设置页开关 UI | 0.25 人日 |
| 回归测试（开启拒 413 / 关闭放行 / 无 content-length） | 0.5 人日 |
| 文档（`API.md` + 客户端集成 + 设置页文案） | 0.25 人日 |
| **合计** | **约 1.5–2.5 人日** |

**独立性**：与前三项完全无耦合，是**性价比最高、风险最低**的一项，建议优先落地。

---

## 5. 汇总

### 5.1 各功能依赖与建议顺序

```
f20b3e8 系统提示词注入      ── 独立        ── 4–5.5 人日   ← 建议第 1 个做
e87e474 + d5ed330 请求体上限 ── 独立        ── 1.5–2.5 人日 ← 建议第 2 个做（最快见效）
ca3ef1a 预算化多轮重扫      ── 基础能力     ── 14–18 人日   ← 第 3 个，需重点投入
de86992 上下文超限回放簇    ── 依赖 ca3ef1a ── 4–5 人日     ← 第 4 个，随重扫一起交付
```

合计约 **24–31 人日**。

### 5.2 数据库改动汇总

| 改动 | 对象 | 类型 | 默认 | 可空 | 来源 |
|:---|:---|:---|:---|:---|:---|
| 新列 `system_prompt` | `models` 表 | TEXT | `''`（SQLite）/ `NULL`（MySQL，按下游约定） | 见左 | `f20b3e8` |
| 新设置键 ×6 | settings 键值表 | — | 见 1.3 | — | `ca3ef1a` |
| 新设置键 ×1 | settings 键值表 | — | `1`（无 seed 行） | — | `e87e474` |

**无新表**。日志侧全部复用 `logs.metadata`（TEXT/JSON）+ `logs.status` + `logs.error_message`。

### 5.3 API 改动汇总

| 类型 | 端点 | 改动 |
|:---|:---|:---|
| 新增 | `GET /api/dashboard/sweep-metrics` | 重扫指标聚合，1 个开关控制 |
| 变更 | `GET/PUT /api/admin/settings` | +7 个字段（6 from ca3ef1a，1 from e87e474） |
| 变更 | `POST /api/admin/models` | +`system_prompt` |
| 变更 | `PUT /api/admin/models/:id` | +`system_prompt`（空串清空） |
| 变更 | `POST /api/admin/models/:id/test` | 行为变更：注入 `system_prompt` |
| 变更 | 所有网关端点 | 响应语义变更：回放原始 4xx / SSE `context_length_exceeded` 错误块 / 413 阈值 10MB→50MB |

### 5.4 上游 `nextjs` 分支结论（复核）

**确认不存在**，全部为 Go 重写期间新增。`upstream/nextjs` 最后一提交 `0848ae8`（2026-06-15）早于最早的 `ca3ef1a`（2026-08-29）两个半月。关键字检索（重扫/回放/提示词/请求体/system_prompt/upstream_retry_sweep/request_size_limit）在 nextjs 分支零命中。**下游无历史代码可参考，全部需从零实现。**

### 5.5 上游自身的已知不一致 / 需下游决策的点

以下均为**读代码后确认的**、上游未解决的问题，移植时应显式决策而非照抄：

1. **`injectResponsesSystem` 覆盖非字符串 `instructions`**（3.5.4）：`asString` 对非字符串返回 `""`，导致直接覆盖、丢失原内容。上游无测试覆盖该形态（已核查 `system_prompt_test.go` 未见）。**建议下游保留原内容或不注入。**
2. **`request_size_limit_enabled` 无 seed 行**（4.3）：与第 1 节 6 个键的 seed 方式不一致，属上游疏漏。
3. **客户端集成文档中的 10 MiB 残留**（4.6 第 5 点）：`e87e474` 改了上限却未更新该行（`7782fa3` 改动的是同一文件的相邻行）。下游移植时应一并修正。
4. **`system_prompt` 无长度校验**（3.2）：上游代码中未见 max 长度检查，超长提示词会原样入库并注入。

### 5.6 关键常量速查（便于 TS 复刻）

| 常量 | 值 | 来源 |
|:---|:---|:---|
| `gatewayMaxBodyBytes` | `50 * 1024 * 1024` | `e87e474` |
| `sweepWaitBase` | `1s` | `ca3ef1a` |
| `sweepWaitCeiling` | `15s` | `ca3ef1a` |
| `sweepRetryAfterCap` | `30s` | `ca3ef1a` |
| `sweepSleepSlice` | `500ms` | `ca3ef1a` |
| `sweepHeartbeatInterval` | `10s` | `ca3ef1a` |
| `sweepHeartbeatText` | `": keep-alive\n\n"` | `ca3ef1a` |
| `sweepMaxLoggedAttempts` | `16` | `ca3ef1a` |
| `maxSweepAggregateTargets` | `8` | `ca3ef1a` |
| `sweepContextReplayBodyLimit` | `32 * 1024` | `c296ec9` |
| `sweepContextMessageLimit` | `4096` | `2e0e037` |
| `gatewayAlertTimeout` | `5s` | `ca3ef1a` |
| 重扫总预算 clamp | `10–300` 秒 | `ca3ef1a` |
| 流式预算 clamp | `1–120` 秒 | `ca3ef1a` |
| 告警节流 clamp | `60–3600` 秒 | `ca3ef1a` |
| 仪表盘指标窗口 | 近 24 小时 | `ca3ef1a` |
| `top_channels` 上限 | `10` | `ca3ef1a` |

---

## 附：验证命令清单

```bash
# 提交与范围
git log -1 --format=%B ca3ef1a
git show --stat ca3ef1a
git show --stat de86992

# 关键源码
git show ca3ef1a:internal/http/gateway_sweep.go
git show 8331bd0:internal/http/gateway_sweep.go          # 回放最终形态前一步
git show 52d2a99:internal/http/gateway_sweep.go          # 回放最终形态
git show f20b3e8:internal/gateway/protocol/system_prompt.go
git show ca3ef1a:internal/http/gateway_alerts.go
git show ca3ef1a:internal/settings/service.go
git show ca3ef1a:internal/http/dashboard_routes.go

# 文档（上游中英双语）
git show ca3ef1a -- docs/zh/gateway.md docs/zh/architecture.md
git show 7782fa3 -- docs/zh/gateway.md docs/zh/client-integration.md
git show 8331bd0 -- docs/zh/gateway.md
git show 52d2a99 -- docs/zh/gateway.md

# nextjs 分支核验（应无命中）
git grep -l "system_prompt" upstream/nextjs
git grep -l "upstream_retry_sweep" upstream/nextjs
git grep -l "request_size_limit" upstream/nextjs
git log -1 --format="%h %ad %s" --date=short upstream/nextjs

# 下游现状（应无命中）
git grep -l "system_prompt\|upstream_retry_sweep\|request_size_limit" HEAD
git grep -n "10 \* 1024 \* 1024" HEAD -- lib
```
