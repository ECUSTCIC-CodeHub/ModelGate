# ModelGate

> 根据[《生成式人工智能服务管理暂行办法》](http://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)的要求，请勿对中国地区公众提供一切未经备案的生成式人工智能服务。

基于 Next.js + SQLite 的多租户 LLM 网关 + 管理控制台。

## 技术栈

- Next.js (App Router + Route Handlers)
- SQLite (`better-sqlite3`)
- JWT 认证 (access + refresh token)
- 内存令牌桶限流

## 功能特性

- **多渠道管理** — 支持配置多个上游提供商，加权负载均衡 + 熔断器
- **模型别名路由** — 自动协议转换，客户端无感知
- **多协议支持：**
  - `POST /api/v1/chat/completions` — OpenAI Chat Completions
  - `POST /api/v1/chat` — Ollama Chat（`/api/chat` 兼容别名）
  - `POST /api/v1/responses` — OpenAI Responses
  - `POST /api/v1/messages` — Anthropic Claude Messages
  - `POST /api/v1/embeddings` — OpenAI Embeddings
  - `GET /api/v1/models` — 获取可用模型列表
- **用户与角色** — 管理员 / 普通用户，API Key 自助管理
- **用户组** — 组级限流 (QPS/RPM/TPM)、配额、模型白名单，支持继承机制 (`用户 > 组 > 全局默认`)
- **OIDC 单点登录** — 通用 OIDC 提供商接入，支持自动注册、通过 claim 映射用户组
- **免认证模式** — 适用于局域网单用户部署，无需登录
- **请求日志** — 记录模型、渠道、状态码、Token 用量、延迟等信息
- **用户自助** — 管理密钥、修改密码、绑定/解绑 OIDC
- **管理后台** — 渠道、模型、用户、用户组、系统设置、日志

## 安装与运行

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)，首个注册用户自动成为管理员。

## 环境变量

全部可选，均有默认值：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `JWT_ACCESS_SECRET` | `dev-access-secret-change-me` | Access Token 签名密钥 |
| `JWT_REFRESH_SECRET` | `dev-refresh-secret-change-me` | Refresh Token 签名密钥 |
| `JWT_ACCESS_EXPIRES_SECONDS` | `900` | Access Token 有效期（15 分钟） |
| `JWT_REFRESH_EXPIRES_SECONDS` | `604800` | Refresh Token 有效期（7 天） |
| `AUTH_DISABLED` | — | 设为 `1` 关闭所有认证（单用户模式） |

## 免认证模式

适用于局域网内单人使用，无需注册登录：

```bash
AUTH_DISABLED=1 pnpm dev
```

- 网关端点跳过 API Key 验证
- 控制台跳过 JWT 认证，直接以管理员身份访问
- 登录 / 注册页面自动跳转到控制台
- 自动创建内置 `noauth` 管理员用户和 API Key
- 限流、日志、配额照常生效（挂在该内置用户下）
- **不设置此变量则完全不影响现有部署**

## 数据存储

SQLite 数据库：`data/gateway.db`（首次运行自动创建）

数据表：`channels`、`models`、`users`、`groups`、`keys`、`settings`、`logs`

## 认证方式

### 账号密码

- `POST /api/auth/register` — 受 `允许账号密码注册` 设置控制
- `POST /api/auth/login` — 受 `允许账号密码登录` 设置控制
- `POST /api/auth/refresh` — 刷新令牌
- `GET /api/auth/me` — 获取当前用户信息
- `POST /api/auth/change-password` — 修改密码
- `POST /api/auth/logout` — 退出登录

用户名仅允许英文字母和数字（`[A-Za-z0-9]`），最少 3 位。

### OIDC 单点登录

在管理后台「系统设置」页面配置：

- **Issuer URL** — OIDC 提供商地址（需支持 `.well-known/openid-configuration`）
- **Client ID / Secret** — 从 OIDC 提供商获取
- **回调地址** — 设置页面中展示，复制到 OIDC 提供商配置即可
- **自动注册** — 首次 OIDC 登录时自动创建用户
- **用户组 Claim** — 通过 OIDC token 中的 claim 值自动分配用户组（如 claim `role` 值 `vip` → VIP 组）

接口：

| 端点 | 说明 |
|------|------|
| `GET /api/auth/oidc/status` | 公开接口，返回各登录方式的可用状态 |
| `GET /api/auth/oidc/authorize` | 发起 OIDC 授权流程 |
| `GET /api/auth/oidc/callback` | 处理 OIDC 提供商回调 |
| `GET /api/auth/oidc/bind` | 已登录用户绑定 OIDC 账号 |
| `POST /api/auth/oidc/unbind` | 已登录用户解绑 OIDC 账号 |

管理员可独立开关账号密码登录和 OIDC 登录，但至少需保留一种登录方式。

## 用户组

用户组定义用户继承的基线配置：

- **限流**：QPS、RPM、TPM
- **配额**：请求总量配额、Token 总量配额
- **模型白名单**：组级白名单与用户级白名单取并集

**继承优先级**：`用户设置 > 组设置 > 全局默认`。用户的限流值为 `-1` 表示继承组设置。

**OIDC 组映射**：在系统设置中配置「用户组 Claim」（如 `role`），在各用户组中配置「OIDC Claim 匹配值」（如 `premium`）。用户通过 OIDC 登录时自动分配到匹配的组，每次登录自动同步。

## 权限控制

| 接口范围 | 权限要求 |
|----------|----------|
| `/api/admin/*`、`/api/dashboard/*` | 管理员角色 |
| `/api/user/*` | 已认证用户，仅限本人资源 |
| `/api/v1/*` | API Key 认证 |

所有接口均支持两种认证方式：
- **Session 认证**：JWT Cookie（Web 控制台自动管理）
- **API Key 认证**：`Authorization: Bearer sk-gw-...` 或 `x-api-key: sk-gw-...`

## 用户 API 接入指南

用户生成的 API Key（`sk-gw-*`）除了调用网关端点外，还可以调用以下用户自助接口：

### 配额查询

```bash
curl http://localhost:3000/api/user/quota \
  -H 'Authorization: Bearer sk-gw-xxxx'
```

返回示例：

```json
{
  "total": {
    "quota_requests": 10000,
    "quota_tokens": 5000000,
    "used_requests": 128,
    "used_tokens": 45200,
    "remaining_requests": 9872,
    "remaining_tokens": 4954800
  },
  "period": {
    "period_seconds": 86400,
    "period_label": "每日",
    "quota_requests": 1000,
    "quota_tokens": 500000,
    "used_requests": 12,
    "used_tokens": 3200,
    "remaining_requests": 988,
    "remaining_tokens": 496800,
    "reset_at": "2026-05-08 00:00:00"
  },
  "rate": {
    "rpm": 60,
    "qps": 5,
    "tpm": 100000
  }
}
```

> `total` 为终身配额，`period` 为周期性配额（到期自动重置），`rate` 为实时限流参数。值为 `null` 或 `-1` 表示无限制。

### 密钥管理

```bash
# 查看所有密钥
curl http://localhost:3000/api/user/keys \
  -H 'Authorization: Bearer sk-gw-xxxx'

# 创建密钥
curl -X POST http://localhost:3000/api/user/keys \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{}'

# 启用/禁用密钥
curl -X PUT http://localhost:3000/api/user/keys/{id} \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'

# 删除密钥
curl -X DELETE http://localhost:3000/api/user/keys/{id} \
  -H 'Authorization: Bearer sk-gw-xxxx'
```

### 使用日志

```bash
curl 'http://localhost:3000/api/user/logs/chat?limit=50&offset=0' \
  -H 'Authorization: Bearer sk-gw-xxxx'
```

返回分页日志列表，包含模型、渠道、状态码、Token 用量、延迟等信息，以及汇总统计。

### 网关响应中的配额头

每次调用网关端点（`/api/v1/*`）时，响应头中会包含当前配额剩余：

```
X-Quota-Limit-Requests-Remaining: 9872
X-Quota-Limit-Tokens-Remaining: 4954800
X-Period-Quota-Requests-Remaining: 988
X-Period-Quota-Tokens-Remaining: 496800
X-Period-Quota-Reset: 2026-05-08T00:00:00.000Z
```

## 使用示例

1. 在管理后台 → API 接口管理中添加渠道（上游地址 + API Key）
2. 在管理后台 → 模型管理中创建模型别名映射
3. 创建用户和 API Key（或让用户自行注册并创建密钥）
4. 调用网关：

```bash
# 获取模型列表
curl http://localhost:3000/api/v1/models \
  -H 'Authorization: Bearer sk-gw-xxxx'

# OpenAI Chat Completions
curl http://localhost:3000/api/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "你好"}]}'

# Ollama Chat
curl http://localhost:3000/api/v1/chat \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "你好"}], "stream": false}'

# OpenAI Responses
curl http://localhost:3000/api/v1/responses \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model": "gpt-4o", "input": "你好"}'

# Anthropic Claude Messages
curl http://localhost:3000/api/v1/messages \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model": "claude-sonnet-4-6", "max_tokens": 1024, "messages": [{"role": "user", "content": "你好"}]}'

# OpenAI Embeddings
curl http://localhost:3000/api/v1/embeddings \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model": "text-embedding-3-small", "input": "你好"}'
```

## 备注

- 渠道声明支持的上游协议，每个模型映射指定使用哪种上游协议。
- 客户端可调用 Chat Completions、Ollama Chat、Responses、Claude Messages 生成端点中的任意一种，网关会在入站协议与上游协议不一致时自动转换；Embeddings 仅直通 `/embeddings`，不参与协议转换。
- 限流为单实例内存实现，不支持多实例部署。
- 全部采用软删除，记录通过 `deleted_at` 标记而非物理删除。
