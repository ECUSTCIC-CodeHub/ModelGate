# 上游 Go 分支功能变更分析报告（面向 ModelGate Next.js 下游移植）

分析对象：`upstream/go`（https://cnb.cool/Bring/Project/Gateways/ModelGate），HEAD = `22f3de2`（2026-10-01）。
下游：本仓库 `D:\Documents\ecustcic\ModelGate`（Next.js + TypeScript，main 线）。

> 说明：上游 `go` 分支是完整 Go 重写，本文只提取**产品级功能语义**，供下游用 TypeScript 重新实现，不抄 Go 代码。
> 所有结论均通过 `git show <hash>` 读取实际 diff 验证，未验证的推测会显式标注。

---

## 集群一：日志清理（2026-08-10 引入，2026-10-01 修补）

涉及提交：

| 提交 | 日期 | 标题 |
|:---|:---|:---|
| `49de906` | 2026-08-10 | feat(settings): 新增日志保留天数与自动清理开关配置 |
| `3eca061` | 2026-08-10 | feat(api): 新增手动清理日志接口 POST /api/admin/logs/cleanup |
| `5cca9ef` | 2026-08-10 | feat(logcleanup): 新增日志定时自动清理调度器 |
| `457b01f` | 2026-08-10 | feat(web): 设置页新增日志清理卡片 |
| `1feaead` | 2026-08-10 | docs: 补充日志清理功能的 API 与架构文档 |
| `305ecbe` | 2026-10-01 | fix(logcleanup): Stop 等待在途清理完成 |
| `cc5e988` | 2026-10-01 | fix(web): 日志清理确认弹窗按已保存的保留天数描述影响范围 |

### 1.1 功能语义

上游的日志清理是**两条互相独立的执行路径，共用同一个保留天数口径**：

1. **定时自动清理**：进程内后台调度器，**固定每小时轮询一次**系统设置；仅当「自动清理开关 = 开」**且**「保留天数 > 0」时，才执行一次删除。开关或天数任一不满足就直接 return，不做任何查询甚至不构建 SQL。
2. **管理员手动清理**：`POST /api/admin/logs/cleanup`，可带 `days` 覆盖系统设置；不带 `days` 时回落到系统设置的 `log_retention_days`，两者都无效（缺失或 ≤ 0）返回 400。

关键语义点：

- **保留天数 0 = 不限制**（不是「删全部」）。`CleanupLogsOlderThan(retentionDays <= 0)` 直接返回 `(0, nil)`，一条都不删。这同时也让「误配置导致清库」在数据层被兜住，而不只是靠调用方判断。
- 删除条件固定为 `created_at < datetime('now', '-N days')`，即**按写入时间**而非 id。上游是 SQLite 专线（GORM + glebarez/sqlite），直接用了 SQLite 的 `datetime()` 函数，**没有 MySQL 分支**（与下游不同，见 1.6）。
- 删除是**单条 DELETE 语句全量删除，没有分批、没有批次间 sleep**。上游的 `usage_hourly` 汇总表独立于日志保留策略，所以删日志不影响已汇总的排行（e18293b 文档明确写了这点）。
- 清理**不覆盖 email_send_log**（下游的 `pruneOldEmailLogs` 在上游没有对应物）。

### 1.2 配置项 / 设置键

存储位置：`settings` 表（`key`/`value`/`updated_at`），值均为字符串。

| 设置键 | 类型 | 默认值 | 校验 | 说明 |
|:---|:---|:---|:---|:---|
| `log_retention_days` | int（`GatewaySettings` 里是 `int64`，JSON 输出为 number） | `"0"` | 0–3650 的**整数**，`math.Trunc(value) != value` 即拒绝 | 日志保留天数，0 表示不限制 |
| `log_auto_cleanup_enabled` | bool（对外 JSON 为 number 0/1） | `"0"`（关闭） | 交叉校验：置 1 时要求 `next.LogRetentionDays > 0` | 是否开启每小时自动清理 |

上游 seed 位置（`internal/store/sqlite/settings.go` 的 `defaultSettings`）：

```go
{"log_retention_days", "0"},
{"log_auto_cleanup_enabled", "0"},
```

输入侧（`GatewaySettingsInput`）用指针类型区分「未传」与「传 0」：`LogRetentionDays *float64`、`LogAutoCleanupEnabled *bool`。

**交叉校验的精确顺序**（`buildSettingUpdates`）：

```go
setBool("log_auto_cleanup_enabled", input.LogAutoCleanupEnabled, &next.LogAutoCleanupEnabled)
if next.LogAutoCleanupEnabled == 1 && next.LogRetentionDays <= 0 {
    return nil, current, fmt.Errorf("开启定时清理前需先设置保留天数")
}
```

注意它校验的是 `next`（合并后的结果值），因此「同一次 PUT 里同时把 retention 设成 7、开关设成 true」是合法的——测试 `TestRouterLogRetentionSettingsAndCleanup` 正是这么用的。反过来「同一次 PUT 里 retention=0 + enabled=true」返回 400。

读取侧容错：`nonNegativeInt(values["log_retention_days"], 0)` —— 解析失败或负数回落 0；`boolInt(values["log_auto_cleanup_enabled"], false)` —— 只有 `"1"` 为真。

### 1.3 数据库改动

**本集群没有任何 DDL 改动。** 两个设置项走既有 `settings` 表的 key-value 行，`seedDefaultSettings` 插入默认行，不需要新表新列。日志表 `logs` 已存在 `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` 和 `idx_logs_created_at` 索引，删除条件正好可命中。

### 1.4 API 改动

**`POST /api/admin/logs/cleanup`**（新增）

- 认证：管理员。未认证返回 401（路由测试验证）。
- 请求体**可选**，且允许**完全空 body**：`ShouldBindJSON` 的错误被 `errors.Is(err, io.EOF)` 放行。
- 请求体 schema：`{"days": <number>}`，`Days *float64`。
- `days` 校验：`value <= 0 || value > 3650 || value != float64(int64(value))` → 400 `"请求参数不正确"`。注意与设置项不同，这里 **显式拒绝 0**（`<= 0`），因为传 0 无意义。
- `days` 缺省时的回落链：读 `h.app.Settings.RawGatewaySettings()`（**绕过 30 秒缓存**，读库实时值）→ 若 `LogRetentionDays <= 0` 返回 400 `"请先设置日志保留天数或传入 days 参数"`。
  - 读设置失败 → 500 `"读取系统设置失败"`。
- 执行失败 → 500 `"清理日志失败"`。
- 成功响应：

```json
{ "message": "日志清理成功。", "data": { "deleted": 128, "days": 30 } }
```

注意 `data.days` 回显的是**实际生效的天数**（传入值或设置值），不是回显请求。

`internal/store/sqlite/chat_logs.go` 的数据层函数：

```go
// CleanupLogsOlderThan 删除 created_at 早于 retentionDays 天前的日志，返回删除行数。
// retentionDays <= 0 时不执行任何删除。
func (db *DB) CleanupLogsOlderThan(retentionDays int64) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	result := db.Gorm.Exec("DELETE FROM logs WHERE created_at < datetime('now', ?)", fmt.Sprintf("-%d days", retentionDays))
	if result.Error != nil {
		return 0, result.Error
	}
	return result.RowsAffected, nil
}
```

天数是 `fmt.Sprintf("-%d days")` 格式化进参数占位符的，不存在注入（days 已被整型校验）。

### 1.5 调度 / 任务细节

`internal/logcleanup/scheduler.go`：

- 常量 `defaultCheckInterval = time.Hour`。构造函数 `New(db, settingsService)` 固定 1 小时；`NewWithInterval(...)` 仅供测试注入短间隔。
- `Start()` 起一个 goroutine；`run()` 用 `time.NewTicker(s.interval)`。
- **不在启动时立即执行一次**——代码里有明确注释：「不在启动时立刻删除，给应用初始化和配置加载留出完整的一个轮询周期」。这点与下游「启动 1 分钟后首清」不同。
- 每分钟 tick 到来时调 `runOnce()`；`runOnce` 每次都**重新读设置**（`RawGatewaySettings`），所以改设置最多 1 小时生效，不需要重启。
- 单飞语义：`run()` 是在 ticker 的同一 goroutine 里**同步**调用 `s.runOnce()`，因此天然不会并发重入；若一次删除跑超过 1 小时，ticker 会丢 tick 而不是叠起第二个删除。
- `Stop()` 用 `chan struct{}` + `select/default` 保证**可重复调用不 panic**（重复 close 会 panic，所以先探测）。
- **`305ecbe` 的关键修复**：`Stop()` 现在会 `s.wg.Wait()`，等待在途清理 goroutine 退出。原始缺陷是「关停时清理仍占用已关闭数据库连接」的窗口——`Stop` 只发信号就返回，主进程继续走 `db.Close()`，在途的 DELETE 会打到已关闭的连接。修法：`Start()` 里 `s.wg.Add(1)`，`run()` 里 `defer s.wg.Done()`，`Stop()` 关闭 stop 信号后 `wg.Wait()`。
- main.go 装配：

```go
cleanupScheduler := logcleanup.New(db, settings.NewService(db))
cleanupScheduler.Start()
defer cleanupScheduler.Stop()
```

- 错误处理：读设置失败 / 执行失败都只 `log.Printf` 后 return，不影响网关运行；删除 0 条不打印日志（`if deleted > 0`）。
- 无并发限流、无批次、无 yield，删除就是一条大 DELETE。日志量大时这是长时间持有写锁的操作——上游靠的是 SQLite WAL + `busy_timeout(30000)`。

### 1.6 与下游已有实现的差异（重点）

下游已有：`lib/data/log-cleanup.ts` + `log_retention_days` 设置（提交 `7aba7a8` / `3d76626` / `1ac5db8`）。

| 维度 | 下游现状 | 上游 `go` | 差异性质 |
|:---|:---|:---|:---|
| 保留天数设置键 | `log_retention_days` | `log_retention_days` | **一致** |
| 默认值 | 0（`1ac5db8` 改为不删） | 0 | **一致** |
| 取值范围校验 | 0–3650 整数 | 0–3650 整数 | **一致** |
| 0 的语义 | 0 关闭清理 | 0 不限制 | **一致** |
| **自动清理开关** | **无**。只要 `days > 0` 就定时清理，不能单独关掉定时而保留天数 | `log_auto_cleanup_enabled`，与天数解耦 | **上游新增，需移植** |
| **手动清理 API** | **无** | `POST /api/admin/logs/cleanup`，支持 `days` 覆盖 | **上游新增，需移植** |
| **执行频率** | 启动后 1 分钟首清，之后每 **6 小时** | **纯每小时**，且**不在启动时立即执行** | **语义差异** |
| **分批删除** | 有：每批 5000 条，批间 `sleep 400ms` 让出写锁 | 无：单条 DELETE 全删 | 下游更稳健 |
| **MySQL 兼容** | 有：`NOW() - INTERVAL N DAY`，并用派生表子查询绕过 MySQL 同表删除限制 | 无 MySQL 分支（Go 版只有 SQLite） | 下游**必须保留**自己的做法 |
| **email_send_log 清理** | 有 `pruneOldEmailLogs` | 无 | 下游保留 |
| 重启/关停安全 | `setTimeout/setInterval().unref()`，不等待在途 | `Stop()` 等 WaitGroup 收敛在途清理 | 上游补的是一致性问题，Next.js 下形态不同 |
| 前端卡片 | 日志保留天数卡片（`log-retention-settings-card.tsx`） | 保留天数 + 定时清理开关 + 立即清理按钮 三件套 | **上游多出 2 项 UI** |
| 确认弹窗 | — | 按**已保存**天数描述影响范围 | 上游补的 UX 缺陷 |
| 清理任务每次重读设置 | 是（`readRetentionDays` 每轮从 settings 表读） | 是 | **一致** |

**对下游而言，真正"新增"的只有三件事**：

1. 新增设置键 `log_auto_cleanup_enabled`（默认 `"0"`，布尔，seed 进 settings）。语义是「是否允许定时任务自动删」。下游现在没有这个开关，只要用户设了天数就会每 6 小时自动删——这本身就是一个应该补的能力：用户可能只想保留"设置天数以便手动清理"，不想让后台偷偷删。
2. 新增 `POST /api/admin/logs/cleanup`（可传 `days`）。下游已有 `pruneOldLogs(db, days)` 这个可复用的数据层函数，接口层是薄封装。
3. 「立即清理」按钮 + 二次确认弹窗，且确认文案必须读**已保存**值（`cc5e988` 的教训）。

**上游没做、下游不必跟的**：单条大 DELETE（下游分批更好）、去掉 email 日志清理。

### 1.7 移植到 TypeScript 的要点与工作量

要点：

- **设置层**：`GATEWAY_KEYS` 加 `log_auto_cleanup_enabled`；`DEFAULTS` 加 `log_auto_cleanup_enabled: 0`；`GatewaySettings` 类型加字段；`readGatewaySettingsFromDb` 加 `map.get(...) === "1" ? 1 : 0`；`setGatewaySettings` 加 `if (input.log_auto_cleanup_enabled !== undefined) values.log_auto_cleanup_enabled = ...`。**注意下游 `DEFAULTS` 常量目前不含 `log_retention_days`**（它单列在 `GATEWAY_KEYS` + `retentionDays()` 里），保持一致风格即可。
- **交叉校验**：在 settings PUT 路由里加「开关为 true 且合并后 retention ≤ 0 → 400」的校验。下游校验在哪一层需要按现有 `app/api/admin/settings/route.ts` 的 zod schema 决定——zod 单字段 `superRefine` 拿不到 DB 里的旧值，所以**这一条必须放在拿到合并结果之后**，不能纯靠 zod。
- **清理任务**：`startLogRetentionJob` 现在的 `if (days > 0)` 要改成 `if (enabled && days > 0)`，`readRetentionDays` 旁边加一个 `readAutoCleanupEnabled`（或一次读两个 key）。
- **手动清理接口**：新建 `app/api/admin/logs/cleanup/route.ts`，`POST`，管理员守卫（复用 `ensureAdmin` 之类的现有守卫），body 允许为空，days 校验 1–3650 整数，缺省回落设置值，返回 `{ message, data: { deleted, days } }`。**沿用下游 `pruneOldLogs`（分批 + MySQL/SQLite 分支）**，不要照搬上游的单条 DELETE。
- **一个需要明确决策的点**：下游的清理任务同时删 `logout` 和 `email_send_log`。手动接口应该只删 `logs` 还是两个都删？上游只删 `logs`。建议手动接口复用 `pruneOldLogs` 只删 `logs`，与上游对齐，并在 API.md 说明。
- **前端**：在既有 `log-retention-settings-card.tsx` 里加开关 + 立即清理按钮；确认弹窗读已保存值（下游有 `savedForm` 之类的状态吗——需要确认；没有就要引入，或用 form 的 initial 快照）。
- **API.md**：新增端点文档（AGENTS.md 要求）。

工作量估计：**0.5–1 人日**。设置层 + 调度器改动约 1 小时；新 API route 约 1 小时；前端卡片与确认弹窗约 2 小时；API.md + 自测约 1 小时。风险低——数据层已具备，主要是接口与开关的串联。

---

## 集群二：用量排行（2026-08-17 ~ 2026-10-01）

涉及提交（按时间顺序）：

| 提交 | 日期 | 标题 |
|:---|:---|:---|
| `039f909` | 2026-07-09 | feat(dashboard): 支持大盘筛选与用户排行 |
| `47ae3af` | 2026-07-09 | feat(dashboard): 添加用户排名列 |
| `b5a45f5` | 2026-07-09 | feat(dashboard): 为 Top 用户添加系统排名字段 |
| `740ba40` | 2026-08-17 | feat(settings): 新增仪表盘用量排行开关 |
| `cc05d5f` | 2026-08-17 | perf(dashboard): 优化仪表盘聚合查询降低数据库压力 |
| `986a721` | 2026-08-27 | feat(web): 新增用量排行页并充实首页概览 |
| `18495df` | 2026-09-27 | feat(dashboard): 用量排行未开启时用户侧不展示页面 |
| `e18293b` | 2026-09-27 | feat(dashboard): 用量排行改为后台按小时增量汇总 |
| `1a1dcad` | 2026-09-27 | feat(dashboard): 用量排行未开启时对所有角色隐藏菜单与页面 |
| `3f9c052` | 2026-10-01 | fix(dashboard): 修复结果缓存键与容量驱逐缺陷 |
| `9aebe35` | 2026-10-01 | fix(dashboard): 复制缓存命中的 top-usage 响应 |

### 2.1 功能语义

演进分四段，最终形态是**「后台小时间汇总表 + 只读汇总表的排行查询 + 全局开关」**：

**第一段（07-09，`039f909`/`47ae3af`/`b5a45f5`）**：仪表盘支持筛选，Top 用户排行引入 `system_rank`。`system_rank` 的核心语义是「先在全量用户范围内排名，再按用户名过滤，过滤后名次不重新编号」——否则管理员搜某个用户会看到它永远是第 1 名。实现是把 filters 里的 `User` 从排名查询里摘掉放进外层 `WHERE`。

**第二段（08-17，`740ba40`）**：新增总开关 `dashboard_top_usage_enabled`（**默认开启**）。关闭后 `GET /api/dashboard/top-usage` 直接返回 `{"data": {}}`（此时还没有 `enabled` 字段），且 `log-stats` 只算 summary、跳过 facets。同时把 `DashboardLogStats` 拆成 `DashboardLogSummaryFiltered` + 独立的 `DashboardLogFacets`，让跳过 facets 成为可能。

**第三段（08-17~08-27，`cc05d5f`/`986a721`）**：性能 + 页面拆分。`top-usage` 响应加 `enabled` 标记；前端新增独立路由 `/dashboard/usage`，把筛选卡与 Top 模型/渠道/用户表从首页搬到该页；首页精简。服务端加 10 秒结果缓存 + 并发合并（singleflight 语义）。

**第四段（09-27，`e18293b`，最核心）**：`top-usage` **不再实时扫日志表**，改为查后台增量汇总的 `usage_hourly` 小时汇总表。新增 `internal/usagerollup` 调度器。响应加 `updated_at` 与 `refresh_minutes`。`log-stats` **彻底移除 facets**（前端已不用）。设置加 `dashboard_top_usage_refresh_minutes`。

**开关关闭时的最终语义**（`1a1dcad` 定稿）：

- `GET /api/dashboard/top-usage` → `{"data": {"enabled": false}}`，**其余字段一个都不返回**，且不执行任何查询。
- `GET /api/dashboard/profile` → `usage_ranking_enabled: false`。
- 前端：**所有角色**（含管理员）都隐藏「用量排行」菜单项；直接访问 `/dashboard/usage` 重定向回首页。`18495df` 曾让管理员保留占位提示，`1a1dcad` 把占位页删掉改成对所有角色一致隐藏。

**汇总表与日志保留解耦**：文档明确「汇总表独立于日志保留策略，日志被清理后已汇总的排行仍然保留」。这是 `usage_hourly` 存在的重要理由之一。

### 2.2 配置项 / 设置键

| 设置键 | 类型 | 默认值 | 可选值 | 说明 |
|:---|:---|:---|:---|:---|
| `dashboard_top_usage_enabled` | bool（JSON number 0/1） | `"1"`（开启） | — | 用量排行总开关 |
| `dashboard_top_usage_refresh_minutes` | int | `"60"` | 仅 `5` / `15` / `60` / `1440` | 后台汇总间隔（分钟） |

`seedDefaultSettings` 追加：

```go
{"dashboard_top_usage_enabled", "1"},
{"dashboard_top_usage_refresh_minutes", "60"},
```

校验（`e18293b`）：

```go
if input.DashboardTopUsageRefreshMin != nil {
    value := *input.DashboardTopUsageRefreshMin
    if math.Trunc(value) != value || !UsageRefreshMinutesAllowed(int64(value)) {
        return nil, current, fmt.Errorf("请求参数不正确")
    }
    ...
}
```

读取侧用白名单收敛（`usageRefreshMinutes`）：解析失败或不在白名单一律回落 60。这一点很重要——**它是有界的枚举，不是任意正整数区间**，前端是 `<Select>` 下拉（每 5 分钟 / 每 15 分钟 / 每 1 小时 / 每 1 天）。

注意默认值语义：`dashboard_top_usage_enabled` 默认 1（与 `log_auto_cleanup_enabled` 默认 0 相反），且 `readGatewaySettings` 用 `boolInt(values[...], true)`——**缺 key 时视为开启**。早期 `740ba40` 的实现 `dashboardTopUsageEnabled()` 里也是「key 不存在返回 true」，`e18293b` 改成统一走 settings 后保持了默认开启。

### 2.3 数据库改动（重点：`usage_hourly` 完整 DDL）

`internal/store/sqlite/schema.go` 的 `baseSchemaSQL` 中新增（`e18293b`）：

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
```

索引（同一次提交，加在 `baseSchemaSQL` 末尾的索引块里）：

```sql
CREATE INDEX IF NOT EXISTS idx_usage_hourly_user_hour ON usage_hourly(user_id, hour);
```

字段语义：

| 列 | 类型 | 含义 |
|:---|:---|:---|
| `hour` | TEXT | 汇总小时桶，`strftime('%Y-%m-%d %H:00:00', l.created_at)` 格式字符串（UTC，因为上游日志 `created_at` 为 `CURRENT_TIMESTAMP` 即 UTC） |
| `user_id` | INTEGER | 日志的 `user_id` |
| `model_alias` | TEXT，非空默认 `''` | 日志 `COALESCE(model_alias, '')`；不是 `NULL` 而是空串，因为要参与主键 |
| `real_model` | TEXT，非空默认 `''` | 同上 |
| `channel_id` | INTEGER，非空默认 `0` | `COALESCE(channel_id, 0)`；日志里 `channel_id` 可空，映射为 0 表示未路由到渠道 |
| `outcome` | TEXT | `'failed'` / `'success'` / `'other'` 三值 |
| `request_count` | INTEGER | 该桶的请求数 |
| `total_tokens` | INTEGER | `COALESCE(SUM(total_tokens), 0)` |
| `latency_sum` | INTEGER | 仅累加**成功**请求的 `latency_ms`（`status_code < 400`） |
| `latency_count` | INTEGER | 仅计数**成功且有 `latency_ms`** 的行，供算平均 |

`outcome` 的判定直接复用了日志侧的成功/失败定义（`internal/store/sqlite/dashboard.go`）：

```go
func logFailureCondition(alias string) string {
	return logColumn(alias, "channel_id") + " IS NOT NULL AND " + logColumn(alias, "status_code") + " >= 400 AND " + logColumn(alias, "status_code") + " != 429"
}

func logSuccessCondition(alias string) string {
	return logColumn(alias, "channel_id") + " IS NOT NULL AND " + logColumn(alias, "status_code") + " < 400"
}
```

即：**无渠道（`channel_id IS NULL`）→ `'other'`；有渠道且 429 → `'other'`；有渠道且 ≥400 且 ≠429 → `'failed'`；有渠道且 <400 → `'success'`**。网关本地拦截（无 channel）和 429 被排除在成功/失败二分之外，与仪表盘 `success_rate` 的口径一致。

**水位持久化不新建表**，而是复用 `settings` 表存两个 key（`internal/store/sqlite/usage_rollup.go`）：

```go
const (
	usageRollupCursorKey    = "usage_rollup_last_log_id"
	usageRollupUpdatedAtKey = "usage_rollup_updated_at"
	usageRollupBatchSize    = 20000
	usageModelNameSQL       = "COALESCE(NULLIF(h.model_alias, ''), NULLIF(h.real_model, ''), '-')"
)
```

- `usage_rollup_last_log_id`：已汇总到的最大日志 id 水位，字符串化整数。
- `usage_rollup_updated_at`：最近一次**完整**汇总完成的 UTC 时间，`time.RFC3339`。

> 注意这两个 key **没有加进 `defaultSettings`**（`settings.go` 只加了 `dashboard_top_usage_enabled` / `dashboard_top_usage_refresh_minutes`），它们是运行时按需 upsert 的。

`UsageRollupState` 结构：

```go
type UsageRollupState struct {
	LastLogID int64
	UpdatedAt string
}
```

下游若用 MySQL，需注意 `usage_hourly` 的等效建表：`hour` 用 `VARCHAR`、主键 6 列会超 MySQL 索引长度限制吗——`VARCHAR(255)` × 2 (model_alias/real_model) 若用 utf8mb4 会达 2040 字节 ×2，加上其他列，**很可能超过 InnoDB 3072 字节主键上限**。建议下游把 `model_alias`/`real_model` 限制为 `VARCHAR(191)` 或用哈希列，或改用自增 id 主键 + 唯一索引。**这一点上游没有处理（上游只有 SQLite），属于下游移植时必须自行决策项，我无法从上游代码中得到答案。**

### 2.4 API 改动

**`GET /api/dashboard/top-usage`**

- 认证：用户（JWT/Cookie 或 API Key）。
- 查询参数：`user`（仅管理员）、`model`、`channel`（仅管理员）、`start_date`、`end_date`、`tz_offset`、`status`，语义与 `GET /api/dashboard/logs` 一致。
- **`key` 与 `ip` 不在汇总维度内，传入会被忽略**（文档明说）。
- 时间范围按小时桶过滤，**精度为小时**（`h.hour >= ?` / `h.hour < ?`）。
- 开关关闭时：`{"data": {"enabled": false}}`，其余字段不返回，不执行查询。
- 开关开启时响应：

```json
{
  "data": {
    "enabled": true,
    "refresh_minutes": 60,
    "updated_at": "2026-09-27T08:00:00Z",
    "top_models": [
      { "model_name": "gpt-4", "request_count": 500, "total_tokens": 100000 }
    ],
    "top_channels": [
      { "channel_name": "openai-main", "request_count": 500, "total_tokens": 100000 }
    ],
    "top_users": [
      { "user_id": 1, "username": "admin", "system_rank": 1, "request_count": 500, "failed_requests": 5, "total_tokens": 100000, "avg_latency_ms": 500 }
    ]
  }
}
```

- `updated_at` 尚未完成首次汇总时为 `null`（`payload := gin.H{"updated_at": nil}`，仅当 `state.UpdatedAt != ""` 才覆盖）。
- `top_users` 仅管理员返回。
- 每个榜单 `LIMIT 10`。
- 排序：模型/渠道按 `total_tokens DESC, request_count DESC`；用户按 `system_rank ASC`（其内部定义为 `RANK() OVER (ORDER BY total_tokens DESC, request_count DESC, user_id ASC)`）。
- 渠道排行**只统计 `outcome = 'success'`**（源码注释：「渠道排行只统计成功路由的请求，与日志中的成功判定保持一致」）。模型与用户排行统计全部 outcome。
- 结果服务端缓存 10 秒。

**`GET /api/dashboard/log-stats`**

- `e18293b` 彻底移除了 `facets`，现在只返回 `{"summary": {...}}`。
- 之前 `740ba40`/`cc05d5f` 时代的形态是 `{"summary": ..., "facets": ...}`，`facets.TopUsers` 对非管理员置 null。

`summary` 结构（`DashboardLogSummary`）：

```go
type DashboardLogSummary struct {
	TotalRequests          int64   `json:"total_requests"`
	FailedRequests         int64   `json:"failed_requests"`
	TotalTokens            int64   `json:"total_tokens"`
	CacheReadTokens        int64   `json:"cache_read_tokens"`
	AvgLatencyMS           float64 `json:"avg_latency_ms"`
	AvgFirstTokenLatencyMS float64 `json:"avg_first_token_latency_ms"`
	AvgOutputTPS           float64 `json:"avg_output_tps"`
}
```

**`GET /api/dashboard/profile`**（`1a1dcad` 新增字段）

```go
type profileResponse struct {
	auth.SafeUser
	UsageRankingEnabled bool `json:"usage_ranking_enabled"`
}
```

`usage_ranking_enabled = current.DashboardTopUsageEnabled == 1`。同一个 handler 里现在也要读一次 `RawGatewaySettings`（失败 → 500 `"读取系统设置失败"`）。

**`GET /api/dashboard/summary`**：`986a721` 把筛选卡与 Top 表从首页移除、首页补充存量指标。注意 summary 里的 Top 查询在 `e18293b` 中是**从 dashboard.go 删掉**的（`internal/store/sqlite/dashboard.go` 减 171 行、`dashboard_test.go` 减 156 行），Top 计算整体迁移到 `usage_rollup.go`。

### 2.5 调度 / 任务细节（`internal/usagerollup/scheduler.go` + `usage_rollup.go`）

**调度器参数**：

- `defaultTickInterval = time.Minute`——调度器**每分钟 tick 一次**，但**不是每分钟都汇总**。真正的间隔由 `dashboard_top_usage_refresh_minutes` 决定，`RunIfDue()` 每 tick 检查是否到期。
- **到期判定基于持久化的 `updated_at`，不基于进程内计时器**：

```go
state, err := s.db.UsageRollupState()
...
interval := time.Duration(current.DashboardTopUsageRefreshMin) * time.Minute
if last, err := time.Parse(time.RFC3339, state.UpdatedAt); err == nil && s.now().Sub(last) < interval {
	return
}
```

源码注释：「以持久化的上次汇总时间判断是否到期，重启后不会立即重复汇总，也不会漏掉到期的一轮」。若 `updated_at` 为空（首次）或解析失败，条件不成立 → **立即执行**（首轮汇总）。

- 开关关闭时 `RunIfDue` 在第一步就 `return`——**停止汇总**，但不清理已有汇总数据。
- `Stop()` 只 `close(s.stop)`，**没有 WaitGroup**（与 `logcleanup` 的 `305ecbe` 修复不同）。这是上游的一个**遗留不一致**：usage rollup 的在途汇总同样可能撞上已关闭的连接。可以视作上游未修的同类缺陷，移植到 TypeScript 时按下游的进程模型处理即可。

**增量汇总算法**（`RollupUsage`）：

```go
const usageRollupBatchSize = 20000
```

1. 读水位 `state.LastLogID`。
2. `SELECT COALESCE(MAX(id), 0) FROM logs` 取 `maxID`。
3. `for cursor := state.LastLogID; cursor < maxID;` 每批 `[cursor+1, min(cursor+20000, maxID)]`，**每批一个独立事务**（源码注释：「每批独立事务以缩短写锁占用」）。
4. 批内 SQL：`INSERT ... SELECT ... FROM logs WHERE l.id > ? AND l.id <= ? GROUP BY 1,2,3,4,5,6`，带 `ON CONFLICT (hour, user_id, model_alias, real_model, channel_id, outcome) DO UPDATE SET request_count = request_count + excluded.request_count, ...`（**幂等累加**）。
5. 同一事务里 upsert `usage_rollup_last_log_id = next`，保证「水位推进」与「数据写入」原子。
6. 全部批次完成后，在事务外 upsert `usage_rollup_updated_at = time.Now().UTC().Format(time.RFC3339)`。

**为什么用 id 水位不会漏数**（源码注释原文）：「日志只插入不更新，且 SQLite 单写者保证已提交的最大 id 之前没有未提交的行，因此 id 水位不会漏数」。这是一个依赖 SQLite 单写者特性的论证——**下游如果跑 MySQL 或 SQLite WAL 多写者，这个前提需要重新论证**（MySQL 下 AUTO_INCREMENT 也可能出现「id 已分配但事务未提交」，导致水位跳过未提交行 → 永久漏数）。**这是移植时最重要的正确性风险点，上游没有解决，因为它只有 SQLite。**

**查询层**（`buildUsageQuery`）在 `usage_hourly` 上复现日志筛选的可汇总维度：

- 支持：`user_id`（域隔离）、`filters.User`（LIKE 用户名，需 join `users`）、`filters.Model`（`h.model_alias LIKE ? OR h.real_model LIKE ?`）、`filters.Channel`（join `channels`）、`filters.Start`（`h.hour >= ?`）、`filters.EndNext`（`h.hour < ?`）、`filters.Status`（`h.outcome = ?`）。
- 不支持：`IP`、`Key`（源码注释：「IP 与 Key 不在汇总维度内，不参与筛选」）。
- 用户名过滤在 Top 用户里特殊处理：先清空 `filters.User` 做全量排名，再在外层 `WHERE username LIKE ? ESCAPE '\'` 过滤，从而保住 `system_rank` 的真实名次。

**Top 渠道的两段式查询**（避免全表 join 回查名称）：

```sql
SELECT COALESCE(c.name, '-') AS channel_name, t.request_count, t.total_tokens
FROM (SELECT h.channel_id, SUM(...) ... GROUP BY h.channel_id ORDER BY ... LIMIT 10) t
LEFT JOIN channels c ON c.id = t.channel_id
ORDER BY t.total_tokens DESC, t.request_count DESC
```

**模型名归一**：`COALESCE(NULLIF(h.model_alias, ''), NULLIF(h.real_model, ''), '-')`——优先 alias，退到 real_model，再退到 `'-'`。

### 2.6 缓存细节（`cc05d5f` + `3f9c052` + `9aebe35`）

`internal/http/dashboard_cache.go`：

- `dashboardCacheTTL = 10 * time.Second`，`dashboardCacheMaxLen = 512`。
- 结构：`map[string]dashboardCacheEntry` + `inflight map[string]chan struct{}`，并发合并（同一 key 的并发请求只有一个真正执行 fetch，其余等 channel 关闭后重试循环命中缓存）。
- 不缓存错误（`storeLocked` 只在 `err == nil` 时写）。
- 缺容：写满时先清理已过期条目。

三个已修缺陷，都是移植时应当直接避开的坑：

1. **`9aebe35`——共享 map 并发写**。`top-usage` 缓存命中后返回的是**共享的 `gin.H`**，原实现直接 `payload["enabled"] = true` 写入共享对象 → 并发读写同一 map → Go fatal error（不可恢复）。修法：**先浅拷贝再写**。

   ```go
   payload := gin.H{"enabled": true, "refresh_minutes": current.DashboardTopUsageRefreshMin}
   for key, value := range cached.(gin.H) {
       payload[key] = value
   }
   ```

   （`e18293b` 把它写成了复用同一个 `cached` 对象，`9aebe35` 修回来。）

2. **`3f9c052`——缓存键含任意长度自由文本**。原键 `scope + "|" + owner + "|" + fmt.Sprintf("%+v", filters)`，filters 里内嵌用户输入的 `User`/`Model` 等自由文本，任意认证用户可用随机筛选串撑爆缓存内存。修法：

   ```go
   digest := sha256.Sum256([]byte(fmt.Sprintf("%+v|%s", filters, strings.Join(extra, "|"))))
   parts := append([]string{scope, owner, hex.EncodeToString(digest[:8])}, extra...)
   ```

   即 **sha256 取前 8 字节 hex** 再参与键构造。

   同一提交还修了：缓存写满且无过期条目时**驱逐最早到期的条目**（原实现直接 `return` 放弃写入 → 任意用户填满缓存后可让缓存全局失效，等于 DoS）；`logstats` 键**加入用量排行开关状态**（否则管理员切换开关后旧键结果与新语义不一致仍被命中）；`sweepmetrics` 时间窗 `Truncate(time.Minute)`（原为秒级精度，每个请求都生成新键，缓存等于失效还制造大量短命条目）。

   注意 `dashboardCacheKey` 里 `parts` 同时包含 `digest` 与 `extra`，所以 `logstats` 的 enabled 标记既在哈希里也在明文键里——功能上冗余但无副作用。

3. **`cc05d5f`——SQLite 连接池与 pragma**（顺带的性能改动，与排行无直接关系但同批）：
   - `maxOpenConns = 4`（原 `SetMaxOpenConns(1)`）。
   - `busy_timeout` / `journal_mode(WAL)` 从「连接上 Exec」改为**通过 DSN 的 `_pragma` 参数**（`url.Values`），因为 `PRAGMA` 是连接级设置，而连接池有 4 条连接，旧的 Exec 方式只影响当时取到的那条连接。

### 2.7 与下游已有实现的差异

**关键差异：下游根本没有独立的用量排行接口。** 下游把 Top 排行做在 `GET /api/dashboard/summary` 里（`app/api/dashboard/summary/route.ts` 末尾返回 `top_models` / `top_channels` / `top_users`），前端在 `app/dashboard/_home/dashboard-top-usage-tables.tsx` 渲染，`app/dashboard/page.tsx` 引用。

| 维度 | 下游现状 | 上游 `go` | 差异性质 |
|:---|:---|:---|:---|
| 端点上 | Top 排行内嵌在 `GET /api/dashboard/summary` 响应 | 独立端点 `GET /api/dashboard/top-usage` | **架构差异，下游需新建端点** |
| 排行计算时机 | 每次请求实时聚合 `logs` 表 | 后台按小时增量汇总到 `usage_hourly`，接口只读汇总表 | **上游核心新增** |
| `usage_hourly` 汇总表 | 不存在 | 存在，见 2.3 DDL | **上游核心新增** |
| 全局开关 | 无（有 `top_users_visible` 控制普通用户是否可见 Top 用户，语义不同） | `dashboard_top_usage_enabled`，默认开 | **上游新增** |
| 刷新间隔设置 | 无 | `dashboard_top_usage_refresh_minutes`，5/15/60/1440，默认 60 | **上游新增** |
| 响应里的数据时效信息 | 无 | `updated_at` + `refresh_minutes` | **上游新增** |
| 独立用量排行页 | 无（在首页） | `/dashboard/usage` | **上游新增** |
| 菜单按开关隐藏 | 无 | profile 返回 `usage_ranking_enabled`，全角色隐藏 | **上游新增** |
| `log-stats` facets | 下游的 `GET /api/dashboard/logs` 是分页日志，下游没有独立的 log-stats 端点形态需确认 | `facets` 已删除，只返回 summary | 需按下游实际结构判断 |
| `system_rank` | **没有**。已验证：`git grep -n "system_rank" -- app lib components` 在下游工作区无任何命中；下游 `dashboard-model.ts` 的 `top_users` 类型为 `{ user_id, username, request_count, failed_requests, total_tokens, avg_latency_ms }`；`git branch -a --contains b5a45f5` 显示该提交**只存在于 `remotes/upstream/go`** | 有 `system_rank`，语义为「先全量排名再按用户名过滤，过滤后名次不重编号」 | **上游新增，下游完全没有，需移植** |
| 结果缓存 10 秒 + 并发合并 | 需确认下游是否已有 | 有 | 上游新增 |
| `top_users_visible` | 有（控制普通用户是否可见 Top 用户） | 上游对应的是 `dashboard_top_usage_enabled`（总开关，含隐藏菜单）| **两者语义不同，不是替代关系** |
| `overview_global` | 有（普通用户是否看站点级概览） | 未在本次集群出现 | 各自独立 |

**一个必须澄清的点**：下游的 `top_users_visible` 和上游的 `dashboard_top_usage_enabled` **不是同一个东西**。前者只控制「普通用户能否看到 Top 用户榜」，后者是「是否做用量排行聚合 + 是否展示用量排行页」。移植时应**新增** `dashboard_top_usage_enabled`，不要复用它替换 `top_users_visible`。

### 2.8 移植到 TypeScript 的要点与工作量

**这是本次分析中工作量最大、风险最高的部分。**

要点：

1. **建表**：`usage_hourly` 加到 `lib/core/db/schema.ts`（SQLite）与 `lib/core/db/mysql-schema.ts`（MySQL）。按 AGENTS.md，新增 DB 列用 `ensureColumn` 不改 CREATE TABLE——但这是**新表**，走两套 CREATE TABLE 即可（MySQL 建表注意 `TEXT/BLOB` 不能用非空字面量默认值，需 `DEFAULT NULL`；不过这里是 `VARCHAR`/`TEXT` 的选择问题，见下）。
   - **MySQL 主键长度问题必须在本步解决**：6 列复合主键含两个可能较长的模型名字段。建议 `model_alias`/`real_model` 用 `VARCHAR(191)`，或加自增 id 主键 + `UNIQUE KEY`，或对模型名做哈希列。**上游未提供答案（只有 SQLite）。**
2. **水位持久化的正确性论证**：上游依赖「SQLite 单写者 → 已提交的最大 id 之前没有未提交行」。下游同时支持 MySQL。MySQL 下 `SELECT MAX(id)` 可能取到未提交事务的 id，水位跳过 → 永久漏数。**可行的缓解**：水位取 `MAX(id)` 时对 `logs` 表做 `FOR UPDATE` 无意义；更实际的做法是把水位推进改为**按时间上界**（只汇总 `created_at < now() - safety_margin` 的行，如 5 分钟前的），或水位滞后再推进（`next = min(maxID_computed, ...)` 并保留回看窗口）。**上游没有处理这一点，我无法从代码中给出上游的答案——这是需要下游自行决策的设计问题。**
3. **调度器**：新建 `lib/data/usage-rollup.ts`，形态可参考既有 `log-cleanup.ts`：
   - 每分钟 tick，读取设置里的 refresh_minutes，对比持久化的 `usage_rollup_updated_at` 决定是否真正执行。
   - 开关关闭 → 直接 return。
   - 分批 20000，每批独立事务 + 水位原子推进（TS 的 `db.transaction` 可用）。
   - 完成整轮后写 `updated_at = new Date().toISOString()`。
   - **注意下游的进程模型**：Next.js 可能在 dev 下热重载、在多实例下多进程并发跑同一任务。下游 `log-cleanup.ts` 用模块级 `started`/`running` 布尔防重入。多实例场景下两个进程同时汇总同一批 id 会**重复累加**（ON CONFLICT 是加法而非幂等覆盖）→ 数据翻倍。**这是本移植最危险的点。** 缓解：让水位推进用「条件更新」做乐观锁（`UPDATE settings SET value = ? WHERE key = ? AND value = ?`，只有行数=1 才认为拿到批），或引入基于 DB 的租约/锁。上游因为是单进程 Go 服务没有这个问题。**我无法从上游代码得到答案。**
4. **设置**：`GATEWAY_KEYS` 加两个键，`DEFAULTS` 加 `dashboard_top_usage_enabled: 1` 与 `dashboard_top_usage_refresh_minutes: 60`，类型加字段，读取用白名单收敛（`[5,15,60,1440]` 之外回落 60），写入校验白名单，seed 默认行。
5. **新端点 `GET /api/dashboard/top-usage`**：新建 `app/api/dashboard/top-usage/route.ts`。行为：开关关 → `{data:{enabled:false}}`；开 → 读 `usage_hourly` 出三个榜 + `updated_at` + `refresh_minutes` + `enabled:true`。需要 `parseLogFilters` 的等价物（下游有没有统一的筛选解析工具，需要确认）。
6. **`summary` 里下沉 Top 排行**：把 `app/api/dashboard/summary/route.ts` 里的 `top_models`/`top_channels`/`top_users` 三块查询**移到新端点**，summary 只保留基础汇总 + `hourly_tokens` + 并发估算（对齐上游「避免聚合拖慢首屏」的设计）。**这是一个破坏性 API 变更**——下游的 `dashboard-model.ts` 类型与 `dashboard-top-usage-tables.tsx` 都要跟着改。
7. **`profile` 加 `usage_ranking_enabled`**：改 `app/api/dashboard/profile/route.ts` 与前端 `Profile` 类型 + 菜单渲染。
8. **前端新页 `/dashboard/usage`**：把 `dashboard-top-usage-tables.tsx` 从首页搬到新页，加筛选卡、`updated_at`/`refresh_minutes` 的时效说明文案（「数据更新于 X，每 Y 自动汇总，时间筛选精确到小时」）、`enabled === false` 时重定向回首页（上游 `1a1dcad` 定稿：所有角色一致隐藏，不留占位页）。
9. **`system_rank`**：Top 用户的排名必须是「先全量排名再按用户名过滤」——直接在 SQL 里用窗口函数 `RANK() OVER (...)` 优于应用层编号。**注意下游 MySQL 版本要求**（窗口函数需 MySQL 8.0+）。若下游要兼容 MySQL 5.7，需要在应用层实现等价逻辑（先查全量排名再过滤）。**需确认下游 MySQL 最低版本要求。**
10. **缓存**：10 秒 TTL + 并发合并 + **命中后不得修改共享对象**（`9aebe35` 的教训——JS 里不是崩溃而是串数据，同样要避免）+ 缓存键哈希 + 满容驱逐最早到期项。若下游用 Next.js 的 `unstable_cache` 或内存 Map，需自行实现等价语义。

工作量估计：**4–7 人日**，其中：
- 建表 + 汇总算法 + 水位持久化：1–1.5 人日（含 MySQL 主键与水位正确性决策）
- 调度器 + 多实例安全：0.5–1 人日
- 新端点 + summary 拆分：1 人日
- 设置层 + profile：0.5 人日
- 前端新页 + 菜单 + 首页回退：1–1.5 人日
- 文档 + 测试：0.5–1 人日

**建议分阶段**：先做「设置开关 + 独立 top-usage 端点（仍实时查 logs）」，把架构对齐（风险低、可快速见效）；汇总表 + 后台调度作为第二阶段单独评审，因为它引入了多实例正确性与 MySQL 水位这两个上游未解决的问题。

---

## 附：无法确证 / 需要下游自行决策的点

1. **`usage_hourly` 的 MySQL 建表形态**：上游只有 SQLite，无 MySQL 分支。主键长度、字段类型需下游自行设计。
2. **id 水位在 MySQL 下的行级正确性**：上游的论证仅对 SQLite 单写者成立，MySQL 需另行处理（时间上界 / 回看窗口 / 乐观锁）。
3. **多实例部署下的汇总重复累加**：上游单进程无此问题。下游若多实例，`ON CONFLICT ... DO UPDATE SET x = x + excluded.x` 的加法累加会翻倍，需要 DB 级锁或幂等键。
4. **下游是否有 `log-stats` 端点**：下游的 `app/api/dashboard/logs/route.ts` 是分页日志查询，未确认是否有独立的统计端点。上游 `log-stats` 的 `facets` 移除是否有下游对应物需确认。
5. **下游 MySQL 最低版本**：决定 `system_rank` 能否用窗口函数。
6. **上游 `usagerollup.Scheduler.Stop()` 没有 WaitGroup**（`logcleanup` 有，`305ecbe` 修的），属于上游遗留的不一致，我按代码如实记录但未找到对应的修复提交。
