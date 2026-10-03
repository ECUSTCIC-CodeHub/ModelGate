# ModelGate 上游功能分析报告：渠道亲和性 与 渠道级自定义 Header

分析对象：`upstream/go`（Go 重写分支），下游 `main`（Next.js + TypeScript，最后同步约 2026-07-09）。

## 0. 分支归属结论（已验证）

| 提交 | 日期 | 所在分支 | 是否在 Next.js 实现中 |
| --- | --- | --- | --- |
| `f98f53a` 渠道亲和性 | 2026-08-24 | 仅 `upstream/go` | 否 |
| `09331d9` 渠道级自定义 Header | 2026-09-29 | 仅 `upstream/go` | 否 |
| `f53cd4b` 自定义 Header 评审修复 | 2026-09-29 | 仅 `upstream/go` | 否 |

验证命令与结果：

```
git branch -a --contains f98f53a   ->  remotes/upstream/go
git branch -a --contains 09331d9   ->  remotes/upstream/go
git branch -a --contains f53cd4b   ->  remotes/upstream/go
git log --all --oneline --grep="亲和性"        ->  398e372, f98f53a（均 go）
git log --all --oneline --grep="自定义 Header"  ->  f53cd4b, 09331d9（均 go）
git log upstream/nextjs --oneline --grep="亲和" ->  空
git log upstream/nextjs --oneline --grep="Header" -> 空
git log -1 upstream/nextjs -> 0848ae8 Mon Jun 15 14:45:41 2026 +0800 合并来自 main 的合并请求 #42
```

**结论明确**：`upstream/nextjs` 分支最后一个提交停在 2026-06-15，早于这两个功能（8 月 / 9 月），且按关键词搜索无任何命中。因此**上游不存在这两个功能的 Next.js 实现可供参考或 cherry-pick**，下游必须依据 Go 实现的产品语义自行用 TypeScript 重写。这也意味着没有"上游 JS 代码"可以直接抄，语义必须从 Go 源码与文档反推（本报告已完成这一步）。

---

# 功能一：渠道亲和性（Channel Affinity）

提交 `f98f53a`，PR #61，22 个文件、+2492/-55。

## 1.1 功能语义

渠道亲和性是**进程内（in-memory）的粘性路由**：同一调用方对同一模型别名的请求，在首次路由成功后固定复用同一个完整上游目标，从而命中上游的 KV / Prompt Cache，降低延迟与成本。

精确语义（来自 `internal/http/gateway_affinity.go` 与 `docs/zh/gateway.md`）：

- **亲和键（隔离维度）** = `API Key ID + 客户端请求的 model alias + 路由类型`。
  - `affinityKey{KeyID int64, Alias string, RouteFamily affinityRouteFamily}`，`valid()` 要求 `KeyID > 0 && Alias != "" && RouteFamily != ""`。
  - 路由类型只有三类：`affinityRouteText = "text"`、`affinityRouteEmbeddings = "embeddings"`、`affinityRouteOther = "other"`。`affinityRouteFamilyForProtocol()` 把 `protocolEmbeddings` 映射为 embeddings、`protocolOther` 映射为 other、**其余全部（Chat Completions / Anthropic Messages / Responses）统一归入 text**。即文本类协议共享同一份亲和状态，嵌入与通用透传各自独立命名空间。
- **绑定目标（值是完整三元组）** = `model_id + channel_id + real_model`（`affinityTarget{ModelID, ChannelID, RealModel}`，`affinityTargetMatchesRoute` 用整个结构体做相等比较）。注意粒度比渠道更细：同一渠道的不同 `real_model` 是两个不同目标。
- **首次请求**：无绑定时按既有动态评分做加权随机选择（与未开启亲和完全一致的算法），成功后把该目标写入绑定。
- **后续请求**：命中绑定时优先使用绑定目标，**即使它的当前评分低于其他候选**（`TestPickAffinityGatewayRoutePrefersBindingRegardlessOfLowerScore` 专门验证）。
- **滑动有效期（sliding TTL）**：默认 60 分钟，可配 1–1440 分钟。每次成功都会刷新 `LastSuccessAt`（`recordSuccess` 中 `state.Binding.LastSuccessAt = s.now()`），因此活跃会话不会过期。
- **失败迁移**：绑定目标**连续失败 3 次**后解除绑定，并对该键下的 `channel_id + real_model` 冷却 15 秒（`channelAffinityCooldown = 15 * time.Second`）。
- **前两次失败**：允许在现有重试次数内临时使用备用目标（`temporary_fallback`），但**不会覆盖原绑定**。
- **进程内、不持久化**：`newChannelAffinityStore()` 在 `NewRouter` 中创建，注释与文档均明确"不写 SQLite、不启动后台协程"，服务重启后绑定全部丢失，多实例部署各自独立。

## 1.2 配置项 / 字段

新增两项系统设置，落在既有 `settings` key-value 表（**无 DDL，无新表**）：

| 设置键 | 类型 | 默认值 | 取值范围 | 校验 |
| --- | --- | --- | --- | --- |
| `channel_affinity_enabled` | boolean（存储为 `"0"`/`"1"`） | **`0`（关闭）** | - | 无额外校验 |
| `channel_affinity_ttl_minutes` | int | **`60`** | 1–1440，且必须为整数 | 越界或非整数返回 `请求参数不正确` |

Go 侧对应结构：

```go
// internal/settings/service.go - GatewaySettings
ChannelAffinityEnabled    int64 `json:"channel_affinity_enabled"`
ChannelAffinityTTLMinutes int64 `json:"channel_affinity_ttl_minutes"`

// - GatewaySettingsInput（请求体，指针表示可选）
ChannelAffinityEnabled    *bool    `json:"channel_affinity_enabled"`
ChannelAffinityTTLMinutes *float64 `json:"channel_affinity_ttl_minutes"`
```

默认值通过 `internal/store/sqlite/settings.go` 的 `defaultSettings` 种子写入：

```go
{"channel_affinity_enabled", "0"},
{"channel_affinity_ttl_minutes", "60"},
```

读取时的兜底：`boolInt(values["channel_affinity_enabled"], false)`、`positiveInt(values["channel_affinity_ttl_minutes"], 60)`。

校验逻辑（注意 float 传入、整数要求）：

```go
if input.ChannelAffinityTTLMinutes != nil {
    value := *input.ChannelAffinityTTLMinutes
    if value < 1 || value > 1440 || math.Trunc(value) != value {
        return nil, current, fmt.Errorf("请求参数不正确")
    }
    next.ChannelAffinityTTLMinutes = int64(value)
    values["channel_affinity_ttl_minutes"] = fmt.Sprintf("%d", int64(value))
}
```

**重要：亲和性没有走 `features` 特性集门控**。`internal/features/features.go` 在 `f98f53a` 中**未被修改**（对比 `09331d9` 增加了 `CustomHeaders`）。`maskForEdition` 也未对亲和字段做任何处理，因此**完整版与精简版都会返回并接受这两个设置**。我确认这是代码事实，而非疏漏遗漏——`gateway_common.go` 中的启用判定直接用 `settings.ChannelAffinityEnabled == 1`，无 edition 判断。

运行时常量（`internal/http/gateway_affinity.go`）：

```go
channelAffinityDefaultTTL      = 60 * time.Minute
channelAffinityCooldown        = 15 * time.Second
channelAffinityCleanupInterval = time.Minute
channelAffinityMaxEntries      = 100_000
```

`channelAffinityTTL(minutes int64)` 在 `minutes < 1 || minutes > 1440` 时回退到 60 分钟。

## 1.3 数据库改动

**无 schema 改动。** 没有新列、没有新表。

- 设置项复用既有 `settings` 的 key-value 表，仅新增两行种子数据。
- 亲和状态全部在进程内存（`map[affinityKey]*affinityState` + `sync.Mutex`），明确不落库。
- 唯一"持久化"的是写进既有日志表的 `metadata` 字段（若该列不存在则不复用——Go 侧 `GatewayLogInput.Metadata` 是既有字段），追加一个 `routing.affinity` 子对象。这是**既有字段的内容扩展，不是 schema 变更**。

## 1.4 API 改动

**没有新增端点。** 改动都在既有端点的请求/响应字段与语义上：

1. `GET /api/settings`（或 Go 侧对应的读取系统设置端点）响应体新增：
   ```json
   "channel_affinity_enabled": false,
   "channel_affinity_ttl_minutes": 60
   ```
   注意文档示例里读取返回的是 **boolean**（`false`），而 Go 内部是 int64 `0/1` —— 说明序列化层做了 `0/1 -> boolean` 的转换，移植时应对齐。
2. `PUT /api/settings`（更新系统设置）请求体接受上述两字段，`ttl` 越界/非整数返回 `请求参数不正确`。
3. **网关日志 `metadata` 新增 `routing.affinity` 对象**（见下），日志列表/详情接口的 `metadata` 结构因此扩展。
4. 管理端副作用（非新端点，是既有端点行为变化）：
   - `PUT /api/admin/channels/:id`：若渠道身份字段变化则 `invalidateChannel`
   - `DELETE /api/admin/channels/:id`：`invalidateChannel`
   - `PUT /api/admin/models/:id`：若模型身份字段变化则 `invalidateModel`
   - `DELETE /api/admin/models/:id`：`invalidateModel`

**身份变化判定（精确字段列表，来自 `channelAffinityIdentityChanged` / `modelAffinityIdentityChanged`）**：

```go
// 渠道：BaseURL / APIKey / Enabled 变化才失效
existing.BaseURL != input.BaseURL || existing.APIKey != input.APIKey || existing.Enabled != input.Enabled

// 模型：Alias / RealModel / ChannelID / UpstreamProtocol / Enabled 变化才失效
existing.Alias != input.Alias || existing.RealModel != input.RealModel ||
existing.ChannelID != input.ChannelID || existing.UpstreamProtocol != input.UpstreamProtocol ||
existing.Enabled != input.Enabled
```

**明确保留绑定的字段**：渠道 `weight`、`max_concurrency`、`timeout`、`user_agent`、`proxy_url`，模型 `weight`、`max_concurrency`、`system_prompt` 等运行参数变化**不清除绑定**（commit body：「权重和运行参数变化继续保留现有绑定」）。

另外，当 `PUT /api/settings` 把 `channel_affinity_enabled` 置为 false 时，会调用 `h.app.ChannelAffinity.clear()` 清空全部状态并递增 `epoch`（用于拒绝晚到的完成回调回写）。

## 1.5 选路 / 行为细节

### 选路算法（`pickAffinityGatewayRoute`）

```
if attempt == 0 && snapshot.Found:
    遍历 routes，找到与绑定目标完全相等且未被 excluded 的第一条 -> 直接返回 (route, preferred=true, ok=true)
否则:
    -> pickWeightedGatewayRoute(...) 返回 (route, preferred=false)
```

即**只有第 0 次尝试（首次尝试）才使用绑定**；进入重试后一律走加权随机。

### 加权随机算法（`pickWeightedGatewayRoute`）

1. **先按 `upstreamTargetKey{ChannelID, RealModel}` 去重**。同一目标可能有多个 `model_id`（同渠道同真实模型被多条模型记录引用），只保留评分最高的一条；评分相同时保留 `ModelID` 更小的一条（`weight > current.weight || (weight == current.weight && route.ModelID < current.route.ModelID)`）。这保证了"同一请求不会重复尝试相同的 `channel_id + real_model`"。
2. 过滤条件：`excluded[target]` 为真、或 `store.coolingDown(key, target)` 为真、或 `runtime.score(route, circuitBreakerEnabled) <= 0` 的候选被剔除。
3. 对剩余候选按权重累加，取 `threshold := store.randomValue() * total`，遍历累加至 `threshold < accumulated` 返回该候选；浮点兜底返回最后一个候选。
4. 无候选或 `total <= 0` 时返回 `ok=false`，外层 `break` 结束重试循环。

`store.randomValue()` 做了边界保护：`< 0` 返回 0，`>= 1` 返回 `math.Nextafter(1, 0)`，避免浮点越界。

### 失败计数（计入 `ConsecutiveFailures` 的全部来源）

`recordFailure` 的调用点与 reason 标签：

| reason | 触发位置 |
| --- | --- |
| `capacity` | `tryAcquire` 返回容量不足（仅 preferred 且非最后一次尝试时） |
| `circuit_open` | `tryAcquire` 返回熔断打开（同上条件） |
| `transport_error` | `sendGatewayUpstream` 返回 err |
| `response_error` | standard 路径读上游 body 失败；other 路径 `resp != nil` 的 err |
| `retryable_status` | 上游返回可重试状态码（401/429/500/502/503/504） |
| `stream_error` | 流式 relay 出错 |
| `upstream_status` | 最终响应为 **403 或 404**（`channelAffinityFailureStatus`） |

`retryableUpstreamStatus` 集合：`401, 429, 500, 502, 503, 504`。

**403/404 的特殊处理**（该提交的 fix 部分）：这两个状态码**不在**重试集合内，所以不会触发重试循环，原本也不会被 `recordFailure` 记账，会导致"熔断关闭时坏渠道粘住直到 TTL 过期"。修复方式是在最终响应阶段补记：

```go
func channelAffinityFailureStatus(status int) bool {
    return status == http.StatusForbidden || status == http.StatusNotFound
}
```

`recordFailure` 有幂等保护：`r.preferredFailed` 标志确保**一个请求内对绑定目标只记一次失败**。

### 并发额度与排队（关键边界，来自该提交的 fix 部分）

`channelRuntimeStore` 新增 `tryAcquire`（非阻塞）：

```go
func (s *channelRuntimeStore) tryAcquire(channelID int64, maxConcurrency int64, circuitBreakerEnabled bool) channelAcquireResult
```

- 熔断打开 -> `{reason: "circuit_open"}`
- `state.inFlight >= s.effectiveLimitLocked(state)` -> `{reason: "capacity"}`
- 否则 `grantLeaseLocked(channelID, state, false)` 立即发放租约（不排队）

调用规则（standard 与 other 两条路径一致）：

```go
if preferred && attempt+1 < maxAttempts {
    leaseResult = defaultChannelRuntime.tryAcquire(...)   // 快速失败，立即回退备用目标
} else {
    leaseResult = defaultChannelRuntime.acquire(ctx, ...) // 退回排队，与未开启亲和一致
}
```

即：**绑定目标并发已满时，若还有备用尝试则不等队列立刻换目标；若已是最后一次尝试（含关闭自动重试，此时 `maxAttempts == 1`）则退回排队等待并发额度**，避免开启亲和后行为比未开启时更差。`tryAcquire` 失败时也会给绑定目标记一次失败（reason `capacity` 或 `circuit_open`）。

### 并发安全机制

- **`epoch`**：`clear()` 时递增。`recordSuccess` / `recordFailure` / `bindIfAbsent` 在加锁后先比较 `snapshot.Epoch != s.epoch`，不等则整个 mutation 作废。这实现了"关闭功能时清空状态并防止晚到请求回写"。
- **`generation`**：每次状态变化递增。快照携带 generation，回写时若 `state.Generation != snapshot.Generation` 则丢弃，防止并发请求互相覆盖。`bindIfAbsent` 还要求 `state.Binding == nil`，保证"首次成功竞争只有一个赢家"（`TestChannelAffinityStoreConcurrentFirstSuccessHasOneWinner`）。
- **惰性清理 `cleanupLocked`**：最多每 60 秒执行一次全表扫描；清理已到期冷却项、已过期绑定，并删除既无绑定又无冷却的状态。`skip` 参数用于跳过当前刚访问过的 key（避免刚查到的绑定被立刻清掉）。
- **容量上限**：`maxEntries = 100_000`。达到上限时 `bindIfAbsent` 直接返回未应用（**fail-open**，即放弃绑定而非报错）；`lookup` 仍能命中已有绑定。
- 全程单个 `sync.Mutex` 保护，无后台 goroutine。

### 命中有效性校验（`lookup`）

命中的绑定在返回前必须通过两道检查，不过则就地清除并递增 generation：

- `!state.Binding.LastSuccessAt.Add(ttl).After(now)` -> 清空，`Reason = "expired"`
- 绑定目标不在本次的 `routes` 候选集合中 -> 清空，`Reason = "route_changed"`

第二道检查意味着**权限收窄、模型/渠道被禁用或删除会自动使绑定失效**，因为 `routes` 是权限过滤后的候选集。

### 日志元数据

`gatewayAffinityMetadata` 合并进既有 `metadata` JSON：

```go
type gatewayAffinityMetadata struct {
    Lookup       string `json:"lookup"`
    Outcome      string `json:"outcome"`
    Reason       string `json:"reason,omitempty"`
    FailureCount int    `json:"failure_count"`
}
```

写入路径 `root["routing"]["affinity"]`，与既有 `token_usage` 同级共存（`metadata(base *string)` 会解析 base JSON 后合并，解析失败则原样返回 base）。文档明确「不泄露路由身份」——**只记状态枚举，不记 channel_id / model_id / real_model**。

`lookup` 取值：`hit` / `miss`。
`outcome` 取值：`unbound` / `bound` / `kept` / `temporary_fallback` / `migrated` / `cleared`。
`reason` 取值：`success` / `all_failed` / `transport_error` / `retryable_status` / `capacity` / `circuit_open` / `response_error` / `stream_error` / `upstream_status`。

outcome 语义（`recordSuccess` / `recordFailure` / `markAllFailed`）：

| outcome | 含义 |
| --- | --- |
| `unbound` | 未命中绑定，且本次成功但未能建立绑定（被并发抢占或达到容量上限） |
| `bound` | 未命中绑定，成功建立了新绑定 |
| `kept` | 命中绑定且继续使用/保留该绑定 |
| `temporary_fallback` | 命中绑定但本次临时走了备用目标（前两次失败），绑定未被覆盖 |
| `migrated` | 绑定已被清除（连续 3 次失败），本次成功重新绑定到新目标 |
| `cleared` | 绑定本轮被清除 |

## 1.6 Web 前端改动

- `web/src/pages/settings.tsx`：新增「渠道亲和性」`ToggleRow` 与「亲和有效期（分钟）」数字输入；有效期输入在开关关闭时 `disabled`；表单默认 `channel_affinity_enabled: false`、`channel_affinity_ttl_minutes: 60`。
- `web/src/pages/logs.tsx`：新增 `AffinityBadge` 组件，读取 `row.metadata?.routing?.affinity`，在状态列渲染类似 `亲和 命中 保持 成功 ×2` 的标签，悬停 Tooltip 展示原始字段。附带三张中英映射表（outcome / lookup / reason），以及 outcome 到主题色的映射。

## 1.7 移植到 TypeScript 的要点与工作量

### 要点

1. **存储位置**：单进程语义在 Next.js 下需要特别处理。Next.js 的 Route Handler 在开发/无状态部署下可能多进程或按请求冷启动，必须用 `globalThis` 缓存（下游已有此惯例，见 AGENTS.md 的 JWT 密钥约定）承载 `Map` 状态；多实例部署下亲和性天然不生效，需在文档中如实说明，与上游一致。
2. **无 DB 迁移**：只需在 `lib/core/settings.ts` 的 `DEFAULTS` 与 `init.ts` 的种子列表中加入两个键。下游 `DEFAULTS` 目前无这两项，读取需带兜底 `false` / `60`。
3. **选路改造点**：下游现有 `lib/gateway/upstream-routing.ts` 逻辑使用 `excludedModelIds: Set<number>`（按 model.id 排除），而亲和性的排除粒度是 `{channelId, realModel}` 且要求**同一请求不重复尝试同一 `channel_id + real_model`**。移植时需要把排除集合换成 target 级，并加入"按 target 去重取最高分"这一步——这是行为差异最大的地方，不能只加一层绑定判断。
4. **协议族映射**：下游协议种类比 Go 侧多（含 Ollama）。上游只定义三类，Chat Completions / Anthropic / Responses / Ollama 全部归 `text` 共享亲和。需要明确决策：Ollama 是并入 `text`（与上游对齐）还是单列一族（语义上更合理）。**上游对此未定义，属于需要下游自行决策的点。**
5. **并发语义**：下游的 `lib/gateway/channel-runtime.ts` 若已实现队列，需要新增"非阻塞 tryAcquire"等价物，并实现"仅在有备用尝试时快速失败、最后一次尝试退回排队"的规则。这条 fix 是核心，漏掉会导致开启亲和后并发满时直接返回失败。
6. **身份失效钩子**：需在下游的渠道/模型 PUT、DELETE 处理里加入精确的字段比对（字段清单见 1.4），注意**权重与运行参数变化不得清除绑定**。
7. **403/404 记账**：下游若有独立的"最终响应"处理阶段，需在其中补记亲和失败，否则熔断关闭时坏渠道会粘住。
8. **日志元数据**：下游日志已有 `metadata` 概念（`token_usage`），需按同样方式合并 `routing.affinity`，且**不要写入 channel_id / model_id / real_model**（上游刻意不泄露路由身份）。
9. **过期与清理**：需要实现滑动 TTL、15 秒冷却、60 秒惰性清理间隔、100k 条目 fail-open 上限。
10. **`epoch` / `generation` 并发协议**：JS 单线程下没有真正的数据竞争，但 `await` 会让出控制权，晚到的完成回调仍可能回写已清空的状态。**这两个计数器在 TS 下仍然必要**，不能因为"JS 是单线程"而省略。

### 工作量估计

| 部分 | 估计 |
| --- | --- |
| 亲和状态存储 + TTL/冷却/清理/GC（`lib/gateway/channel-affinity.ts`） | 1–1.5 天 |
| 选路集成（target 级排除、去重、加权随机、绑定优先） | 1–1.5 天 |
| `tryAcquire` + 排队规则改造 | 0.5–1 天 |
| 失败记账（全部 reason 点 + 403/404） | 0.5 天 |
| 设置项 + 管理端失效钩子 | 0.5 天 |
| 日志元数据 + 前端设置 UI + 日志标签 | 1 天 |
| 测试（上游有 14 个单元 + 7 个集成测试可参照） | 1.5–2 天 |
| 文档（`API.md`、网关文档） | 0.5 天 |
| **合计** | **约 7–9 人日** |

风险点：选路重构可能影响**未开启亲和的现有行为**，必须保证关闭时行为与改造前逐字节一致（上游专门有 `TestGatewayChannelAffinityRouteFamiliesAndDisabledCompatibility` 覆盖这一点，下游应照做）。

---

# 功能二：渠道级自定义 Header（Channel Custom Headers）

提交 `09331d9`（PR #97）+ `f53cd4b`（PR #98 评审修复），共 32 + 13 个文件。

## 2.1 功能语义

允许管理员为**每个渠道**配置一组自定义 HTTP Header，网关在向该渠道发起的所有上游请求中附加这些 Header。典型用途：OpenRouter 的 `HTTP-Referer` / `X-Title`、第三方网关的追踪或计费标识 Header。

作用范围（`docs/zh/gateway.md` 新增章节「渠道出站 Header」）：

- 附加到该渠道的**所有**上游请求：真实转发、模型测试（`/api/admin/channels/:id/test`、`/api/admin/models/:id/test`）、模型列表探测（`/api/admin/channels/probe-models`）。
- 网关托管的出站 Header（如 `Authorization`、`Content-Type`、协议默认 `User-Agent`）**不受影响**——这些名字在配置时就被黑名单拦截。
- 在 `other` 原样中转协议下，自定义 Header **优先级高于客户端透传的同名 Header**（`copyOtherRequestHeaders` 先复制客户端 Header，再 `ApplyIf` 覆盖，然后才设置网关托管的 `Authorization` / `x-api-key`）。
- 精简版完全忽略该字段（保存与转发都不生效）。

## 2.2 配置项 / 字段

### Header 校验规则（`internal/gateway/headers/headers.go`，权威定义）

```go
const (
    maxCount    = 20
    maxNameLen  = 128
    maxValueLen = 2048
)
```

黑名单（19 项，大小写不敏感，共 19 个 key）：

```
authorization, x-api-key, api-key,
host, content-length, transfer-encoding,
connection, upgrade, proxy-authorization,
proxy-authenticate, via, te, trailer,
cookie, content-type, user-agent,
anthropic-version, anthropic-beta, accept-encoding
```

名称合法性：必须是 HTTP token 字符集。`isTokenChar` 允许 `a-z A-Z 0-9` 以及 `` !#$%&'*+-.^_`|~ ``。

> **注意 `f53cd4b` 修正的一个前端 bug**：前端正则原先把 `+-.` 放进了字符类造成区间展开（`+` 到 `.` 之间包含 `,`），意外放行了逗号。修复说明见 commit body「修正 Header 名称正则中 +-. 字符区间意外放行逗号的问题」。**移植前端正则时必须写成 `+\-.` 或把 `-` 放在字符类末尾**，否则会与后端规则不一致。

### `Normalize`（`f53cd4b` 新增，重要行为）

`f53cd4b` 把 `Validate(input) error` 重构为：

```go
func Normalize(input map[string]string) (map[string]string, error)   // 新：校验并修剪，返回规范化副本
func Validate(input map[string]string) error                          // 变为 Normalize 的薄包装
```

`Normalize` 的行为：

1. `len(input) > 20` -> 错误 `自定义 Header 最多 20 对`
2. 对每个键值 `strings.TrimSpace` 修剪名称与值
3. `trimmedName == "" || !validHeaderName(trimmedName) || len(trimmedName) > 128` -> 错误 `自定义 Header 名称不合法或超过 128 字符：<原名>`
4. `blockedHeaderNames[strings.ToLower(trimmedName)]` -> 错误 `自定义 Header 不允许配置 <修剪后名称>`
5. `len(trimmedValue) > 2048` -> 错误 `自定义 Header <名称> 的值超过 2048 字符`
6. **返回以 `trimmedName` 为键、`trimmedValue` 为值的规范化 map**

修复原因（commit body）：「后端新增 Normalize，保存与探测时修剪 Header 名称与值的首尾空白，避免带空格键落库导致请求 502」。

**这是一个真实的安全/稳定性问题**：`"  X-Pad  ": "  v  "` 在只 `Validate` 的旧实现下会原样落库，之后 `http.Header.Set("  X-Pad  ", ...)` 在 Go 的 `net/http` 中会 panic 或导致请求构造失败（表现为 502）。修复后落库为 `{"X-Pad":"v"}`。

回归测试（`internal/http/router_test.go` 新增）：

```go
trimmedReq := ... `{"name":"trimmed-headers", ... "custom_headers":{"  X-Pad  ":"  v  "}}`
// 期望 201，且响应体包含 `"custom_headers":"{\"X-Pad\":\"v\"}"`
```

### 序列化格式

```go
func Stringify(input map[string]string) string  // 空 map -> ""；json.Marshal 失败 -> ""
func Parse(raw string) map[string]string        // "" 或纯空白 -> nil；解析失败 -> nil；空对象 -> nil
```

**存储为 JSON 文本**（不是一行一个 header）。示例：`{"HTTP-Referer":"https://app.example","X-Title":"Cline"}`。

### 应用函数

```go
func Apply(header *http.Header, raw string)                       // Parse 后按键名排序逐个 Set
func ApplyIf(header *http.Header, raw string, enabled bool)        // enabled=false 时直接返回
```

`Apply` **先对 key 排序再 `Set`**（`sort.Strings(keys)`），保证确定性（可测试、可复现）。使用 `Set` 而非 `Add`，即同名单值覆盖。

## 2.3 数据库改动

**新增 1 列**（`internal/store/sqlite/columns.go`）：

```go
{"channels", "custom_headers", "custom_headers TEXT DEFAULT ''"},
```

| 项 | 值 |
| --- | --- |
| 表 | `channels` |
| 列名 | `custom_headers` |
| 类型 | `TEXT` |
| 默认值 | `''`（空字符串） |
| 可空 | 依 SQLite 语义总是可空，但 Go 侧 `Channel.CustomHeaders` 是 `string`（非指针），空值即 `""` |
| 迁移方式 | `ensureColumn`（幂等，不改 CREATE TABLE） |

排序：该行加在 `ensureModernColumns` 列表的**末尾**，说明是追加式迁移。

> **对下游的直接提示**：AGENTS.md 明确「MySQL 建表时 `TEXT`/`BLOB` 列不可用非空字面量默认值（如 `DEFAULT ''`），需写 `DEFAULT NULL`；SQLite 版无此限制」。上游 Go 版只面向 SQLite 所以写了 `DEFAULT ''`；**下游是双库（`lib/core/db/schema.ts` + `lib/core/db/mysql-schema.ts`），移植时必须按各自语法书写**。下游 `init.ts:301-302` 的既有写法 `"user_agent TEXT DEFAULT ''"` 可作 SQLite 参照。

### Go 侧联动字段（移植时的核对清单）

```
internal/store/sqlite/types.go    Channel.CustomHeaders      string `gorm:"column:custom_headers" json:"custom_headers"`
internal/store/sqlite/channels.go CreateChannelInput.CustomHeaders string
internal/store/sqlite/channels.go UpdateChannelInput.CustomHeaders string
internal/store/sqlite/models.go   GatewayRoute.CustomHeaders      string `gorm:"column:custom_headers"`
internal/store/sqlite/models.go   AdminModelTestTarget.CustomHeaders string
```

**三条 SQL SELECT 都补了 `c.custom_headers`**（这是容易漏的点）：

- `FindModelTestTarget`
- `FirstEnabledModelForChannel`
- `ListGatewayRoutes`（`Select(...)` 中 `c.user_agent, c.proxy_url, c.custom_headers`）

`CreateChannel` 的 insert map 与 `UpdateChannel` 的 update map 都加入了 `"custom_headers": input.CustomHeaders`，即**PUT 为整份替换语义**（非合并）。

## 2.4 API 改动

**无新增端点。** 三个既有端点的请求/响应扩展：

### 1. `POST /api/admin/channels`（创建渠道）

请求体新增可选字段：

```json
{
  "name": "...", "base_url": "...", "api_key": "...",
  "custom_headers": {"HTTP-Referer": "https://app.example", "X-Title": "Cline"},
  ...
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `custom_headers` | object | 否 | `{}` | 键值对最多 20 个；名称最长 128 字符、值最长 2048 字符；黑名单大小写不敏感；精简版忽略该字段 |

响应中 `custom_headers` 以**字符串**返回（DB 列原样）：

```json
"custom_headers": "{\"HTTP-Referer\":\"https://app.example\",\"X-Title\":\"Cline\"}"
```

**注意类型不对称**：请求是 object，响应是 JSON 字符串。这是必须移植的契约细节。

校验失败返回 **400**，错误信息为中文，直接来自 `Validate`/`Normalize` 的 `fmt.Errorf`：
- `自定义 Header 最多 20 对`
- `自定义 Header 名称不合法或超过 128 字符：<name>`
- `自定义 Header 不允许配置 <name>`
- `自定义 Header <name> 的值超过 2048 字符`
- 非 object 类型 -> 通用 `请求参数不正确`

### 2. `PUT /api/admin/channels/:id`（更新渠道）

**整份替换语义**（文档原文）：

> `custom_headers` 字段缺席保持原值，传空对象 `{}` 或 `null` 整份清空。

Go 实现对应 `parseCustomHeaders(c, fields, existing.CustomHeaders)`：`present == false` 时返回 `fallback`（即库中原值）。

### 3. `POST /api/admin/channels/probe-models`（探测模型列表）

请求体新增：

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx",
  "user_agent": "OpenAI/JS 6.39.0",
  "proxy_url": "",
  "custom_headers": {"X-Title": "Cline"}
}
```

**`f53cd4b` 修正的语义（重要）**：commit body 明确「probe-models 的 `custom_headers` 说明改为**按请求体传入，不读取渠道已存配置**」。即这个端点是**纯无状态探测**——它接受调用方传入的 header，不会去数据库读某个已有渠道的配置。文档已按此修正。

`f53cd4b` 还调整了注入顺序：`headers.ApplyIf(...)` 从 `user_agent` 设置**之前**移到**之后**。原因是 `user-agent` 在黑名单里根本不可能被配置，原顺序会造成"自定义 Header 可以覆盖 UA"的误导性阅读；移动后语义为"自定义 Header 最后应用，但黑名单保证它不可能碰到托管字段"。这是可读性修正，行为无变化（因为 UA 被黑名单拦截）。

### 4. `POST /api/admin/channels/:id/test` 与 `POST /api/admin/models/:id/test`（模型测试）

文档补充：「测试请求会携带渠道自定义 Header，与真实转发一致」。实现上 `testUpstreamModel` 从普通函数改为方法 `(h adminHandlers) testUpstreamModel`，以便读取 `h.app.Config.Edition` 传入特性开关；`routeFromTestTarget` 补上 `CustomHeaders: target.CustomHeaders`。

### 5. `GET /healthz`（特性枚举）

`internal/features/features.go` 新增：

```go
type Features struct {
    OIDC          bool `json:"oidc"`
    PeriodQuota   bool `json:"period_quota"`
    Announcement  bool `json:"announcement"`
    Webhook       bool `json:"webhook"`
    CustomHeaders bool `json:"custom_headers"`   // 新增
}

func FromEdition(edition config.Edition) Features {
    enabled := edition == config.EditionFull
    return Features{
        OIDC: enabled, PeriodQuota: enabled, Announcement: enabled,
        Webhook: enabled, CustomHeaders: enabled,   // 全部随 full 派生
    }
}
```

`/healthz` 的 `features` 字段自动多出 `custom_headers`。**`CustomHeaders` 与亲和性不同，是走 edition 门控的**：`enabled := edition == config.EditionFull`，精简版恒为 `false`。

### 精简版的三层防护

```go
// 1. 管理接口：静默丢弃，保留库中原值
func (h adminHandlers) parseCustomHeaders(c *gin.Context, fields map[string]json.RawMessage, fallback string) (string, bool) {
    if !features.FromEdition(h.app.Config.Edition).CustomHeaders {
        return fallback, true    // 不报错，直接返回原值
    }
    ...
}

// 2. 探测接口：置 nil
} else {
    input.CustomHeaders = nil
}

// 3. 转发注入：ApplyIf 的 enabled 参数
headers.ApplyIf(&req.Header, route.CustomHeaders, customHeadersEnabled)
```

`ApplyIf` 在 `enabled == false` 时直接 return，不解析 raw。**全部注入点**都用 `features.FromEdition(h.app.Config.Edition).CustomHeaders` 传入。

## 2.5 选路 / 行为细节

自定义 Header **不参与选路**，只影响出站请求构造。需要精确掌握的注入点与顺序：

### 标准协议路径 `sendGatewayUpstream`（`internal/http/gateway_common.go`）

```go
req, err := http.NewRequestWithContext(...)
if err != nil { ... }
headers.ApplyIf(&req.Header, route.CustomHeaders, customHeadersEnabled)   // <-- 注入点
req.Header.Set("Content-Type", "application/json")                        // 之后才是托管字段
if upstreamProto == protocolAnthropic {
    req.Header.Set("x-api-key", route.APIKey)
    ...
}
```

**托管字段在自定义 Header 之后设置**，因此托管字段总能胜出（双保险：黑名单已拦截 + 设置顺序在后）。

### `other` 原样中转路径 `copyOtherRequestHeaders`（`internal/http/gateway_other.go`）

```go
for key, values := range c.Request.Header {   // 1. 先复制客户端透传 Header
    if !forwardOtherHeader(key) { continue }
    ...
}
if !forwardOtherHeader("Content-Type") {      // 2. multipart 重建的 boundary
    req.Header.Set("Content-Type", contentType)
}
headers.ApplyIf(&req.Header, route.CustomHeaders, customHeadersEnabled)  // 3. 自定义覆盖同名透传值
req.Header.Set("Authorization", "Bearer "+route.APIKey)                  // 4. 托管认证最后，永远胜出
req.Header.Set("x-api-key", route.APIKey)
```

**顺序是这条功能最关键的语义**：自定义 Header 在客户端透传之后、网关托管认证之前。

### 模型列表探测 `requestModelsList`

```go
req.Header.Set("Authorization", "Bearer "+apiKey)
req.Header.Set("x-api-key", apiKey)
req.Header.Set("Accept", "application/json")
if userAgent != "" { req.Header.Set("User-Agent", userAgent) }
headers.ApplyIf(&req.Header, customHeaders, customHeadersEnabled)   // f53cd4b 移到此处
```

注意这里的 `Authorization` / `x-api-key` 在**自定义 Header 之前**设置。由于黑名单拦截，二者不会冲突；但**移植时若放宽黑名单，这个顺序会导致自定义 Header 覆盖探测用的 API Key**。这是一个需要在 TS 实现中保持一致的顺序依赖。

### 边界情况汇总

| 情况 | 行为 |
| --- | --- |
| `custom_headers` 为 `null`（PUT） | 整份清空（按文档；Go 侧 `rawHeaderMap` 对 `null` 的 `json.Unmarshal` 到 `map[string]string` 会得到 `nil` map 且 `err == nil`，`Stringify(nil)` 返回 `""`） |
| `custom_headers` 为 `{}`（PUT） | 整份清空 |
| `custom_headers` 非 object（如数组、字符串） | 400 `请求参数不正确` |
| 库中存了无法解析的 JSON | `Parse` 返回 `nil`，`Apply` 静默跳过，不影响转发 |
| Header 名重复（大小写不同） | 后端 map 天然去重；**前端 `headerError` 显式报错** `Header 名称重复：<name>` |
| 名称/值带首尾空白 | 保存时修剪（`Normalize`）；前端提交前也修剪（`compactHeaders`） |
| 精简版收到该字段 | 静默忽略，不报错，保留库中原值 |

## 2.6 Web 前端改动

- **新增组件 `web/src/components/header-editor.tsx`**：键值行编辑器，含 `headerError(name, value, existing)` 导出函数与 `HeaderEditor` 组件。
  - 前端常量硬编码 `maxHeaders = 20`、`maxNameLength = 128`、`maxValueLength = 2048`，并注释 `// 与后端 internal/gateway/headers/headers.go 的规则保持一致，改动需两处同步。`
  - **`f53cd4b` 的重要重构**：原来用 `Record<string,string>` 派生行，导致无法同时存在多个空行（空名行会被 Object 键去重吃掉）。改为 `useState` 维护**有序数组** `entries`，配合 `emitted` ref 检测外部 value 变化时重新同步（避免编辑中被父组件回写覆盖）。
  - 删除 `entriesToHeaders` 导出，改为内部 `compactEntries`（去空名行 + 修剪）。
  - 内联重复校验按**行索引排除自身**（`others` 过滤 `i !== index`），而不是旧实现的"按名字过滤"。
- `web/src/pages/channels/channel-settings-drawer.tsx`：
  - 新增导出 `parseHeadersField(value: unknown): Record<string,string> | undefined`（解析后端 JSON 字符串列，失败回退 undefined）
  - 新增 `compactHeaders`（提交前修剪）
  - 新增 `customHeadersEnabled` prop；关闭时不渲染编辑器、不提交该字段
  - 提交前用 `headerError` 做一轮预校验，避免保存后才收到 400
- `web/src/pages/channels/channel-models-drawer.tsx`：新增 `customHeadersEnabled` prop；探测模型请求体按门控附加 `custom_headers`
- `web/src/pages/channels.tsx`：并行请求中新增 `apiFetch("/healthz")`，读取 `features.custom_headers`；注释 `// 缺省 feature 按支持处理，兼容尚未返回 features 的服务端版本。` 即 `featureData.custom_headers !== false`
- `web/src/pages/channels/shared.tsx`：`ChannelForm` 新增 `custom_headers?: Record<string, string>`
- `web/src/lib/admin-types.ts`：`Channel` 新增 `custom_headers?: string`（**注意是 string，因为存的是 JSON 文本**）

## 2.7 移植到 TypeScript 的要点与工作量

### 要点

1. **DB 迁移是最大差异点**。上游只需追加一行 `ensureColumn`；下游是双库（SQLite + MySQL），且 AGENTS.md 规定 MySQL 的 TEXT 列不可用 `DEFAULT ''`，需写 `DEFAULT NULL`。需要改：
   - `lib/core/db/init.ts`（`ensureColumn`）
   - `lib/core/db/mysql-schema.ts`（CREATE TABLE）
   - `lib/core/db/schema.ts`（若为 SQLite CREATE TABLE）
   - `lib/core/db/types.ts`（`Channel` 接口）
2. **类型不对称必须保持**：请求/响应字段 `custom_headers` 请求是 object、响应是 JSON 字符串。下游若已有渠道序列化层，需确认不会被自动 JSON.parse 掉。前端 `parseHeadersField` 是必需的适配器。
3. **Normalize 不能省**。只做校验不修剪会重现上游那个 502 问题。Node 的 `fetch`/`undici` 对非法 header 名的行为与 Go 不同（可能抛 `TypeError` 而非 502），但同样是运行时故障。修剪 + token 字符校验都要有。
4. **前端正则**：`+-.` 区间陷阱必须在 TS 里修掉（上游 `f53cd4b` 才修）。
5. **注入顺序**：三处注入点的"自定义 Header 相对托管字段的位置"必须与上游一致，尤其 `other` 路径的"自定义 > 客户端透传，但 < 网关托管认证"。
6. **黑名单集中管理**：下游 AGENTS.md 要求「`lib` 下按职责分类」「可拆成组件或协议模块的大文件要拆薄」。建议新建 `lib/gateway/custom-headers.ts` 承载常量、校验、`normalize`/`stringify`/`parse`/`apply`，与上游 `internal/gateway/headers` 包一一对应。
7. **特性开关**：下游已有 `lib/core/features.ts`，需新增 `custom_headers` 并按 `MODELGATE_EDITION` 派生。注意 AGENTS.md 说「精简版不再主动维护：新增功能无需为精简版补门控或保证行为一致，`features.ts` 的精简版开关保留但不强制维护」——**这是下游与上游的明确分歧**，可自行决定是否加门控。但若要加，必须像上游一样覆盖全部注入点（否则会出现"UI 隐藏了但转发还在发"的不一致）。
8. **`/healthz` 需要暴露 features**：前端 `channels.tsx` 依赖它决定是否渲染编辑器。下游需确认 `/healthz`（或 `/api/version`）是否已返回 features；若没有，可以选择降级为"总是显示"。
9. **三个探测/测试端点都要注入**，这是最容易漏的部分（上游 commit body 专门强调「模型测试与探测模型接口同步注入，行为与真实流量一致」）。
10. **`lib/core/http.ts` / `upstream-proxy.ts` 是转发收口**，改这里可以覆盖大部分标准协议路径；`other` 透传路径（下游对应 `passthrough-handler.ts`）需要单独处理。

### 工作量估计

| 部分 | 估计 |
| --- | --- |
| DB 迁移（双库）+ 类型定义 + SELECT 补列 | 0.5 天 |
| `lib/gateway/custom-headers.ts`（校验/规范化/序列化/应用） | 0.5 天 |
| 渠道管理 API（POST/PUT，含整份替换与 400 文案） | 0.5 天 |
| 转发注入（标准 + other 透传 + 顺序语义） | 0.5 天 |
| 模型测试 / probe-models 注入 | 0.5 天 |
| features 开关 + `/healthz` | 0.25 天 |
| 前端 `HeaderEditor` 组件（含有序数组重构与正则修复） | 0.5–1 天 |
| 渠道抽屉 / 模型抽屉 / 类型接入 | 0.5 天 |
| 测试（上游 2 个测试文件 + `router_test.go` 回归） | 1 天 |
| 文档（`API.md` + 网关文档） | 0.25 天 |
| **合计** | **约 5–6 人日** |

---

# 三、两功能对比与移植建议

| 维度 | 渠道亲和性 | 渠道级自定义 Header |
| --- | --- | --- |
| 提交 | `f98f53a`（PR #61） | `09331d9`（PR #97）+ `f53cd4b`（PR #98） |
| 数据库改动 | **无** | **有**：`channels.custom_headers TEXT DEFAULT ''` |
| 新 API 端点 | 无 | 无 |
| 设置项 | `channel_affinity_enabled`(false) / `channel_affinity_ttl_minutes`(60) | 无 |
| 特性（edition）门控 | **无**（完整版与精简版都生效） | **有**：`features.custom_headers`，仅完整版 |
| 状态位置 | 进程内存（不持久化） | 数据库 |
| 复杂度 | 高（并发协议、选路重构、重试交互） | 中（校验 + 注入 + 顺序） |
| 主要风险 | 改变既有选路行为、并发语义回归 | 未修剪导致请求失败、漏注入点、双库默认值语法 |
| 工作量 | 约 7–9 人日 | 约 5–6 人日 |

**建议移植顺序：自定义 Header 先行。** 理由：它是纯增量（新列 + 新校验 + 注入点），不改动既有选路逻辑，回归风险低；而亲和性会重构 `excluded` 集合的粒度（从 model.id 改为 `{channelId, realModel}`），必须保证关闭时行为与现状完全一致，适合在 Header 功能稳定后再做。

**两功能的独立关联点**：`custom_headers` 是渠道身份字段之一吗？——**不是**。`channelAffinityIdentityChanged` 只比对 `BaseURL / APIKey / Enabled`，修改 `custom_headers` 不会使亲和绑定失效。这是一个合理的语义（换 Header 不改变上游端点身份），但如果下游认为 Header 变化可能影响上游路由行为，需要显式决策。**上游未对此作说明，属于未定义区域。**

---

# 四、不确定与需下游决策的点（已明确标注，未作臆测）

1. **Ollama 协议的路由族归属**：上游只定义 `text`/`embeddings`/`other` 三族，下游有 Ollama。上游代码中 Ollama 不存在，**无法从上游确定应归入哪一族**。
2. **多实例部署下的亲和性**：上游是单进程 Go 服务，文档明说"仅保存在当前进程内"。Next.js 的多实例/无服务器部署下亲和性会退化为"几乎不生效"，**上游未提供分布式方案**，下游需自行决定是接受该限制还是改用 Redis 等共享存储。
3. **`GET /api/settings` 响应中 `channel_affinity_enabled` 的类型**：文档示例是 boolean（`false`），Go 内部是 int64（`0`/`1`），转换发生在序列化层，但我在 Go 的 `render` 层未逐行验证该转换的具体实现位置。**移植时以下游现有 settings 端点的既有布尔字段（如 `dashboard_top_usage_enabled`）的序列化方式为准即可**，不必照搬上游内部表示。
4. **`custom_headers` 变化是否需要失效亲和绑定**：上游未定义（见上）。
5. **精简版门控策略**：下游 AGENTS.md 明确精简版不再需要补门控，与上游"完整版/精简版严格区分"的策略不同。移植时按下游约定处理即可，但需注意若加门控就要覆盖全部注入点。
6. **`Parse` 对 `null` 的处理路径**：我依据 Go 的 `json.Unmarshal` 语义推断 `null` -> `nil` map -> `Stringify` -> `""`（即整份清空），这与文档「传空对象 `{}` 或 `null` 整份清空」一致，但我**没有找到专门针对 `null` 的单元测试**来直接证实。文档是权威表述，实现路径为合理推断。
