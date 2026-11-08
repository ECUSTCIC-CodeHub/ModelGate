# 上游同步与并发重构调研（2026-11-08）

> 本文为调研产出，**不含任何代码改动**。
>
> 结论先行：上游这一个月只动了 6 个提交，其中功能性改动只有 2 组；而**本项目自身存在一个与上游无关的并发正确性缺陷**（SQLite 单连接上的事务无互斥），它才是「高并发」这个词在当前代码里真正的落点。Go 重写不会自动修掉它，但换语言确实能让这一类缺陷不再成立。建议先修缺陷，再谈重构。

---

## 一、同步基线：不是 20260709，是 20261001

你说「从提交信息 body 里的『已与xxxx上游同步』看上次同步时间」。按这个线索检索，全历史只命中一处：

| 提交 | 日期 | body |
|:---|:---|:---|
| `9b8df52` | 2026-07-10 | `已与20260709上游同步` |

**但这不是最近一次同步。** 之后在 2026-10-03 做过一轮完整同步，只是没在 commit body 里写这句话，而是留了一份独立文档 `docs/upstream-sync-20261001/`（提交 `065329f` 建文档，随后是批次一至三的实施提交）。那份文档第十节写明了「批次一至三已实施完毕，批次四跳过」。

所以真实基线是 **2026-10-01 的上游 `go` 分支 HEAD `22f3de2`**。按这个基线算，本次增量很小。

顺带一提：建议以后同步收尾时把那句「已与xxxx上游同步」补进 commit body。它是唯一能跨文档检索到的时间锚点，比翻 `docs/` 目录可靠。

---

## 二、上游这段时间更新了什么

`22f3de2..go`（`go` 现 HEAD `2a7c698`）共 **6 个提交**，全部集中在 2026-10-13 与 11-04：

| 提交 | 日期 | 类型 | 内容 |
|:---|:---|:---|:---|
| `a47b07f` | 10-13 | **功能** | Anthropic 流式 `message_delta` 补全 usage，并做本地分词兜底 |
| `54d7479` | 10-13 | 构建 | 构建时注入分支与 Commit 到镜像环境变量 |
| `c0ba75a` | 10-13 | **功能** | `/healthz` 返回 `branch` / `commit` |
| `9a073bb` | 10-13 | UI | 侧边栏显示构建分支（按你的要求，UI 跳过） |
| `f7d39a3` | 10-13 | 文档 | 同步上述三者的文档 |
| `2a7c698` | 11-04 | CI | 加 PR 自动 CR / 自动合并模板 |

UI 重构、Go 工程改动这类内容这次没有新增，不用再排除一遍。

### 2.1 `a47b07f`：流式 usage 兜底（唯一值得跟的功能修复）

**上游改法**：新增 `streamUsageMeter`，统一累计正文、推理、**工具调用名与参数**三类文本，在流结束前用本地分词补算 completion tokens；`message_start.usage.input_tokens` 为 0 时用本地 prompt 估算；Responses 编码器在上游 usage 缺失或 output 为 0 时同样兜底。

**下游状态：确认存在同源缺口，且分三处。**

| 位置 | 现状 | 后果 |
|:---|:---|:---|
| `streaming/anthropic-encode.ts` 的 `emitDone` | `message_delta.usage` 只带 `output_tokens` | 上游没给 usage 时客户端拿到 `output_tokens: 0` |
| 同上 `ensureStarted` | `message_start.usage.input_tokens` 直接取上游值 | 上游没给 → `input_tokens: 0`，客户端算不出速度 |
| `streaming/responses-encode-writer.ts` + `responses-events.ts` 的 `responseUsage` | `usage` 为 null 时返回 `undefined` | `response.completed` 无 usage 字段 |
| `streaming/chat-completions-encode.ts` 的 `localUsage` | 只算正文 + 推理，**不算工具调用** | 纯工具调用的流兜底值是错的 |

要注意一个容易误判的点：下游**账务侧**已经有完整兜底（`lib/gateway/token-usage.ts` 的 `resolveTokenUsage`，实际产出 `source: usage` 或 `local`），所以数据库里的用量是对的。缺的是**回给客户端的 SSE 里的 usage**。两者是两条路，容易看着账对就以为没问题。

这个修复不涉及架构，纯编码器内部，风险低，建议单独一批做掉。

### 2.2 `/healthz`：可选

上游 `/healthz` 返回 `status / edition / branch / commit / auth_disabled / features`，用于部署系统识别当前制品、侧边栏显示版本。

下游目前没有任何 healthz（已全仓 grep 确认），`/api/site-info` 是**最接近的替代但不适合**当健康检查——它要查 settings 表，数据库出问题时它自己先报错。

这条不是必须跟。但如果哪天要做蓝绿发布或镜像自检，加一个不查库的 `/healthz` 是合理的，顺手也能把 `branch` / `commit` 注进 Dockerfile（上游 `54d7479` 就是干这个）。

---

## 三、上游 Go 重构解决的是什么（以及不是什么）

你说「上游进行了 go 重构，由于高并发多线程的需要，我也想重构」。这个因果关系需要拆开看，因为它决定了你该不该跟着重写。

### 3.1 上游自己的文档怎么说

读 `docs/zh/architecture.md` 与 `operations.md`，能看到它的真实取舍：

- **单实例假设**：QPS/RPM/TPM 令牌桶、渠道并发租约、亲和绑定、实时指标，全在进程内存。文档原话是「**多实例会导致额度计算错乱**」。
- **SQLite 照样串行写**：`SetMaxOpenConns(4)`，注释写的是「SQLite 写入锁粒度较粗，限制连接数降低并发写入时的锁竞争」。它的架构文档里另一处还写着 `SetMaxOpenConns(1)`——文档与代码已经不一致，说明这块被反复调过。
- **并发控制全是进程内的**：`limits.ForUser` 只是把「用户 > 组 > 默认」聚合成结构体，95 行，没有并发逻辑。真正涉及并发的是 `gateway_runtime.go` 里的令牌桶、租约、熔断，全部 `sync.Mutex` 保护的内存 Map。

也就是说：**上游的 Go 重构并没有把网关变成水平扩展的多线程系统**，它换来的是「单进程内不用再担心事件循环被 CPU 活阻塞」。

### 3.2 Go 重构真正的收益

| 收益 | 对我们成立吗 |
|:---|:---|
| CPU 活（分词、bcrypt、JSON、SQLite 同步调用）不阻塞其他请求 | **成立**，这是我们当前最实在的痛点，见第五节实测 |
| 天生没有「单连接 async 事务嵌套」这类缺陷 | **成立**，见第四节 |
| 内存占用低（无 Node 运行时 + 无 tiktoken 编码表） | 成立，`js-tiktoken` 常驻约 80MB |
| 镜像小、冷启动快 | 成立 |
| 多核并行吞吐 | **不成立**：SQLite 写入串行，且限流/租约都是进程内状态，多核吃不满 |

### 3.3 一个需要说清楚的事实

网关的主路径是 **流式转发**，属于 IO 密集。Node 单线程在这种场景下并不吃亏——它只是把等待交给事件循环。实测 `better-sqlite3` 单条同步语句事务约 **4.3µs**，2 万次串行写入 87ms，这个量级远超本项目的实际请求量。

所以「高并发」在本项目里不是「需要多线程」，而是三件具体的事：

1. 共享状态没有互斥（第四节）
2. CPU 活跑在主线程上（第五节）
3. 慢客户端没有被背压约束（第五节）

这三件事**换语言不是唯一解**，其中第 1 件换语言确实能根治，第 2 件可以把活挪走，第 3 件是纯实现问题。

---

## 四、发现一个 P0：SQLite 单连接上的事务没有互斥

这是本次调研最重要的产出，且**与上游同步无关**——是我们自己的缺陷。

### 4.1 缺陷本体

`lib/core/db/sqlite-adapter.ts` 的 `transaction()` 直接在**同一个** `better-sqlite3` 连接上执行 `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`，但没有任何互斥或串行队列。

而 `better-sqlite3` 是同步 API，事务内的 `tx.execute()` 返回 `Promise.resolve(...)`（微任务），事务外的 `query/queryOne/execute` 返回 `setImmediate(...)`（宏任务）。于是：

- 两个事务如果在**同一条微任务链**上紧邻发起，第二个 `BEGIN` 会撞上第一个未提交的事务；
- 更糟的是，事务持锁期间任何**事务外的**写都会落进别人的事务里。

### 4.2 实测（用仓库里真实的 `lib/core/db/sqlite-adapter.ts` 编译后跑）

用真实适配器 + 真实调用形态（`addUsage()` 后紧跟 `insertChatLog()`，两者都是 fire-and-forget，与 `gateway-handler.ts` 第 649-651 行的写法逐字一致）：

```text
--- 单次结算的 BEGIN/COMMIT 顺序（打印真实 exec 调用）---
   EXEC BEGIN TRANSACTION
   EXEC BEGIN TRANSACTION      ← 两个事务同时在开
 usage FAIL: cannot start a transaction within a transaction
   EXEC COMMIT
 log committed
rows: logs=1  usage=0
```

30 次结算的结果：

| 场景 | logs | usage | 失败 |
|:---|:---|:---|:---|
| 完整版（`periodQuota` 开，`addUsage` 先有一次宏任务读） | 30 / 30 | 60 / 60 | 0 |
| 精简版（`periodQuota` 关，`addUsage` 只有微任务） | 30 / 30 | **0 / 60** | 30 |

触发条件是「两个事务之间没有任何宏任务」。矩阵实测：

| A 的 await | B 的 await | 结果 |
|:---|:---|:---|
| 微任务 | 微任务 | **相撞**（120 行期望，实际 60） |
| 微任务 | 一次宏任务读 | 正常 |
| 一次宏任务读 | 微任务 | 正常 |
| 宏任务 | 宏任务 | 正常 |

这解释了为什么它平时不炸：完整版里 `resolveScheduledMultiplier()` 那次 `queryOne` 恰好把两个事务错开了。**它现在能跑，靠的是一个偶然的 await 时序。** 精简版（`modelGateFeatures.periodQuota === false` 时 `resolveScheduledMultiplier` 直接 return fallback）就没这个掩护。

### 4.3 比「写失败」更糟的一种情况

事务外的事务落进别人的事务里，然后别人 `ROLLBACK`：

```text
A rolled back: A 失败 | B ok
最终存活的行: []
❌ B 的写入被 A 的 ROLLBACK 一并回滚
```

这是**数据丢失**，而且 B 那边会认为自己成功了。

### 4.4 还有一处：裸调用会变成 unhandledRejection

`insertChatLog()` 在 **22 处全部是裸调用**（0 处 `await`、0 处 `.catch`）。`addUsage()` 内部有 try/catch（`usage-accounting.ts` 第 241 行），`insertChatLog` 没有。实测直接抛：

```text
unhandledRejection: cannot start a transaction within a transaction  ×30
```

Node 默认对 unhandledRejection 是抛错终止进程。当前生产没崩，说明这条路径还没被稳定触发；但一旦触发条件成立（精简版、或以后有人在两个写之间删掉那次 await），**代价是进程退出**。

### 4.5 为什么 MySQL 版没这个问题

`lib/core/db/mysql-adapter.ts` 的 `transaction()` 先 `acquire()` 独占一条连接，再 `beginTransaction()`，各事务天然隔离。所以这个缺陷是 **SQLite 单连接 + 异步事务接口** 这个组合特有的。

### 4.6 修法

不管后面走不走 Go，这条都得先修。三种方案：

| 方案 | 做法 | 代价 |
|:---|:---|:---|
| **A. 单一写队列（推荐）** | 进程内一条串行队列，所有写事务排队执行；读仍可并发 | 改动集中在 `sqlite-adapter.ts`，约百行；热点写会有排队延迟，但实测单事务 4.3µs，量级完全够 |
| B. 事务级互斥锁 | 只让 `transaction()` 互斥 | 更小，但**挡不住事务外的写**落进事务里（4.3 节的问题依旧） |
| C. 事务体内禁止宏任务 await | 约定 + 静态检查 | 治不了根，且靠人守 |

建议 A。顺带把 `insertChatLog` 的 22 处裸调用补上 `.catch`（或统一塞进写队列的兜底）。

---

## 五、并发体检：阻塞点按实测排序

用真实依赖在 Node 26 上测的阻塞时长（这些都是**同步占住事件循环**的时间）：

| 操作 | 阻塞时长 | 频次 | 备注 |
|:---|:---|:---|:---|
| `bcrypt.hash` cost=10 | **87 ~ 94ms** | 每次注册/改密 | `bcryptjs` 是纯 JS 实现，4 个并发共 341ms |
| dashboard 三个重查询（20 万行 logs） | **177ms** | 每次打开首页 | 分时聚合 77ms + 排行 40ms + 区间统计 37ms |
| tiktoken 编码 512KB prompt | **69ms** | 每个请求算 prompt tokens | 128KB 13.6ms、32KB 4.5ms、2KB 0.3ms |
| 25 次 `await` 数据库往返 | 0.05ms | 每请求 | **不是瓶颈**，可以放心忽略 |

排序很清楚：**bcrypt > dashboard 重查询 > 大 prompt 分词 > 数据库 await**。

另外两处结构性隐患：

- **流式没有背压**：全仓 12 处 `new ReadableStream` 里没有一处实现 `pull()` 或检查 `desiredSize`，`controller.enqueue()` 一路向前 push。慢客户端会把这些块堆在内存里。
- **限流桶无容量上界**：`lib/gateway/ratelimit.ts` 的 `buckets` Map 既不清理也不淘汰，键是 `user:<id>:rpm` 这类，条目数受用户数上界约束，风险有限但没兜底；`lib/auth/login-ratelimit.ts` 有 5 分钟清理但无 `MAX_KEYS`，`user/redeem` 那处有 `MAX_KEYS = 10_000`——三处口径不一致。

---

## 六、重构方案

### 6.1 路线选择

| | 路线 A：TypeScript 内加固 | 路线 B：Go 重写 |
|:---|:---|:---|
| 解决 4 节的 P0 | ✅ 修 SQLite 写队列 | ✅ 连接池天然隔离 |
| 解决 bcrypt 阻塞 | ✅ 挪到 worker / 换 cost | ✅ 天然 |
| 解决 dashboard 重查询 | ✅ 加结果缓存（上游 `dashboardResultCache` 可直接借鉴：10s TTL + inflight 去重 + 容量上界 + 驱逐最早到期项） | ✅ 但同一套优化还是得写 |
| 解决 tiktoken 阻塞 | ⚠️ 挪 worker 或只在必要时算 | ✅ 天然 |
| 保留自研功能 | ✅ 零改动 | ❌ 8k 行后端要逐行重写 |
| 工作量 | 约 10 ~ 15 人日 | 30 ~ 50 人日（含前端 SPA 化） |
| 风险 | 低，可分批独立上线 | 高，须一次性切换，双存储尤其麻烦 |

**建议走 A。** 理由不是「Node 更好」，而是：

1. 4 节的 P0 是两个路线共同的必修课，先修它，无论后面怎么选都不亏；
2. 五节实测显示真正的瓶颈是 **bcrypt 和 dashboard 重查询**，这两个在 Go 里也要单独优化，不是语言红利；
3. 上游 Go 版**只支持 SQLite**（`faq.md` 明确写「不支持 MySQL / PostgreSQL」），我们有 MySQL 双驱动 560 行；照抄上游等于要自己重写一遍 MySQL 支持；
4. 自研功能 8k 行（见第七节），重写期间无法与上游保持同步，会失去「跟随上游」这个既定节奏。

如果最终仍决定走 B，第三节的收益表可以直接当立项依据，但请把第七节的清单当硬约束。

### 6.2 路线 A 的分批

**批次零：止血（1 人日，建议立刻做）**

| 项 | 落点 |
|:---|:---|
| SQLite 写事务串行队列 | `lib/core/db/sqlite-adapter.ts` |
| `insertChatLog` 22 处补 `.catch` | `gateway-handler.ts`(8) · `queued-upstream-response.ts`(7) · `multipart-gateway-handler.ts`(4) · `passthrough-handler.ts`(3) |
| 补一条回归断言：并发 N 次结算后 logs 与 usage 行数都对得上 | 照 `scripts/verify-*.mjs` 的形态 |

**批次一：流式 usage 兜底（1 ~ 2 人日）**
跟上游 `a47b07f`，按 2.1 节四处落点改。

**批次二：阻塞点削减（3 ~ 5 人日）**

| 项 | 落点 | 收益 |
|:---|:---|:---|
| dashboard 结果缓存 | `app/api/dashboard/summary`、`model-metrics`、`admin/quota-overview` | 首页 177ms 阻塞 → 命中缓存近 0 |
| bcrypt 挪出主线程 | `lib/auth/auth.ts` | 登录/注册 87ms → 不阻塞 |
| tiktoken 只在必要时算 | `gateway-handler.ts` 的 `countPromptTokensForRoute` | 大 prompt 请求 69ms → 仅流式+需要 usage 时 |

**批次三：请求级缓存与结构（3 ~ 5 人日）**

一次请求里 `getUserGroup` / `listRedeemScopes` / `getEffectiveLimits` / `getGatewaySettings` 会被重复查多轮（`filterGrantedRows`、`checkQuota`、`checkChannelQuota` 各查一次）。做法：请求上下文里挂一个短 TTL 的 memo，同一请求内复用。注意别做成跨请求的长缓存，否则改配置要等 TTL。

**批次四：背压与容量上界（1 ~ 2 人日）**
流式 `pull()` 实现背压；三处限流表统一 `MAX_KEYS` + 淘汰。

**批次五：可选功能（按需）**
`/healthz` + 构建信息注入。

---

## 七、重构必须保留的自研功能清单

这些是上游**完全没有**的东西（已用 `git grep` 逐项确认过上游 `internal/` 里零命中），任何重构都得原样搬过去：

| 功能 | 后端行数 | 上游是否有 |
|:---|:---|:---|
| 兑换码（批次/用户组限定/定向额度/扫码直达 `/r/{code}`） | 1623 | 无 |
| 邮件通知（多发送器/失败补发/公告群发） | 1898 | 无 |
| 多档周期配额（`period_cycles` + 组档继承 + 交回组档） | 893 | 无（上游只有单档 `period_quota`） |
| Copilot 兼容（工具名策略/推理预算） | 562 | 有，但版本不同 |
| MySQL 双驱动 | 560 | **无，明确不支持** |
| 图片 multipart（`/images/edits`） | 434 | 走 other 透传 |
| Ollama 兼容（三种鉴权传参） | 721 | 有 |
| 模型配额与三级兜底（模型/视觉/额度） | 318 | 无 |
| 系统公告 | 226 | 有基础版 |
| UA 限制（全站/渠道/模型三级） | 184 | 无 |
| 分时倍率 | 176 | 无 |
| 站点信息 / 个性化设置 | 97 | 无 |

合计约 **8k 行后端**。契约面（`API.md` 3699 行）里「仅下游有」的端点有 36 个，也是硬约束。

---

## 八、建议的执行顺序

1. **批次零**先做，它跟上游同步无关，是纯粹的缺陷修复，且风险最低、收益最直接。
2. 做完批次零再决定要不要重启 Go 重写的讨论——那时候你手里会有「修完之后的真实并发表现」，比现在拍脑袋准。
3. 批次一跟上游保持同步，赶上 `a47b07f`。
4. 批次二、三按需，不着急。
5. `/healthz` 等到真需要蓝绿发布时再说。

---

## 九、局限

- 第四节的复现是用**仓库真实适配器**编译后在 Node 26 上跑的，调用形态逐字对齐 `gateway-handler.ts`，但没有在完整 Next.js 运行时下跑端到端。触发条件的判断（「两个事务间无宏任务」）来自时序分析 + 矩阵实测，若生产上有其他 await 插入会改变触发概率——但**缺陷本身不依赖触发概率**，缺的是互斥。
- 第五节的阻塞时长是在本机测的单点数据，logs 表按 20 万行造的，你的实际数据量会影响 dashboard 那几项。
- 上游 `go` 分支仍在动，本文按 `2a7c698`（2026-11-04）为准。
- 工作量估算按「熟悉本项目的人」为基准，不含前端改动。
