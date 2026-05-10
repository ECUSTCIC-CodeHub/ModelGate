# ModelGate API 文档

## 概述

ModelGate 是一个 LLM 网关，提供 OpenAI 兼容的 API 端点，支持用户管理、配额控制和多渠道路由。

**Base URL:** `http://your-domain:3000`

## 认证方式

### Web 认证

管理后台和仪表盘接口使用 JWT Bearer Token 或 HTTP-only Cookie：

```
Authorization: Bearer <access_token>
```

通过 `/api/auth/login` 或 `/api/auth/register` 获取 Token。

### API Key 认证

网关端点（`/api/v1/*`）使用 API Key：

```
Authorization: Bearer sk-gw-xxxxx
```

或

```
x-api-key: sk-gw-xxxxx
```

---

## 认证接口

### POST /api/auth/login

账号密码登录。

**认证:** 无

**请求体:**
```json
{
  "username": "admin",
  "password": "your-password"
}
```

**响应 (200):**
```json
{
  "message": "登录成功。",
  "user": { "id": 1, "username": "admin", "role": "admin" },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

> 登录限流：每个 IP 每分钟最多 5 次尝试，超出返回 429。

---

### POST /api/auth/register

注册新账号。首个注册用户自动成为管理员。

**认证:** 无

**请求体:**
```json
{
  "username": "newuser",
  "password": "12345678"
}
```

**响应 (201):**
```json
{
  "message": "注册成功。",
  "user": { "id": 2, "username": "newuser", "role": "user" },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

| 字段 | 类型 | 规则 |
|:---|:---|:---|
| username | string | 仅英文字母和数字，3-32 位 |
| password | string | 最少 8 位 |

---

### POST /api/auth/refresh

使用 Refresh Token 刷新 Access Token。

**认证:** 无

**请求体:**
```json
{
  "refresh_token": "eyJ..."
}
```

也可通过 `vlm-refresh-token` Cookie 自动传递。

**响应 (200):**
```json
{
  "message": "令牌刷新成功。",
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

---

### POST /api/auth/logout

清除认证 Cookie，退出登录。

**认证:** 无

**响应 (200):**
```json
{ "ok": true, "message": "已登出。" }
```

---

### GET /api/auth/me

获取当前登录用户信息。

**认证:** 用户

**响应 (200):**
```json
{
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

---

### POST /api/auth/change-password

修改当前用户密码。

**认证:** 用户

**请求体:**
```json
{
  "current_password": "旧密码",
  "new_password": "新密码至少8位"
}
```

**响应 (200):**
```json
{ "ok": true, "message": "密码修改成功。" }
```

---

## 管理接口 - 系统设置

### GET /api/admin/settings

获取系统设置。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "系统设置获取成功。",
  "data": {
    "registration_enabled": 1,
    "password_login_enabled": 1,
    "upstream_retry_enabled": 1,
    "upstream_retry_max_attempts": 3,
    "upstream_circuit_breaker_enabled": 1,
    "public_base_url": "",
    "announcement_content": ""
  }
}
```

### PUT /api/admin/settings

更新系统设置。

**认证:** 管理员

**请求体:**
```json
{
  "registration_enabled": true,
  "password_login_enabled": true,
  "upstream_retry_enabled": true,
  "upstream_retry_max_attempts": 3,
  "upstream_circuit_breaker_enabled": true,
  "public_base_url": "https://your-domain.com",
  "announcement_content": "# 欢迎"
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| registration_enabled | boolean | 是否允许注册 |
| password_login_enabled | boolean | 是否允许密码登录 |
| upstream_retry_enabled | boolean | 是否开启上游自动重试 |
| upstream_retry_max_attempts | 1-10 | 最大重试次数 |
| upstream_circuit_breaker_enabled | boolean | 是否开启上游熔断 |
| public_base_url | string | 对外服务域名 |
| announcement_content | string | 系统公告内容（支持 Markdown，最长 5000 字符） |

---

## 管理接口 - 用户管理

### GET /api/admin/users

分页查询用户列表，支持搜索和排序。

**认证:** 管理员

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|:---|:---|:---|:---|
| limit | 1-100 | 20 | 每页数量 |
| offset | int | 0 | 偏移量 |
| keyword | string | | 按用户名搜索 |
| group_id | int / "all" | | 按用户组筛选 |
| sort_by | string | created_at | 排序字段：`created_at` / `used_requests` / `used_tokens` / `username` |
| sort_dir | string | desc | 排序方向：`asc` / `desc` |

**响应 (200):**
```json
{
  "data": [
    {
      "id": 1,
      "username": "admin",
      "role": "admin",
      "group_id": 1,
      "group_name": "default",
      "rpm": -1, "qps": -1, "tpm": -1,
      "quota_tokens": null, "quota_requests": null,
      "used_tokens": 1234, "used_requests": 56,
      "allowed_model_aliases": [],
      "note": null,
      "enabled": 1,
      "created_at": "2026-05-08 00:00:00",
      "group_rpm": -1, "group_qps": -1, "group_tpm": -1,
      "group_quota_requests": null, "group_quota_tokens": null,
      "effective_rpm": -1, "effective_qps": -1, "effective_tpm": -1,
      "effective_quota_requests": null, "effective_quota_tokens": null
    }
  ],
  "paging": { "limit": 20, "offset": 0, "total": 1 },
  "sorting": { "sort_by": "created_at", "sort_dir": "desc" }
}
```

### POST /api/admin/users

创建用户。

**认证:** 管理员

**请求体:**
```json
{
  "username": "newuser",
  "password": "12345678",
  "role": "user",
  "group_id": 1,
  "enabled": true,
  "rpm": -1, "qps": -1, "tpm": -1,
  "quota_tokens": null,
  "quota_requests": null,
  "allowed_model_aliases": [],
  "note": "备注"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| username | string | 是 | | 仅英文字母和数字，3-32 位 |
| password | string | 是 | | 最少 8 位 |
| role | string | 否 | user | `admin` / `user` |
| group_id | int/null | 否 | 默认组 | 用户组 ID |
| enabled | bool | 否 | true | 是否启用 |
| rpm / qps / tpm | int | 否 | -1 | 速率限制，-1 表示继承组设置 |
| quota_tokens / quota_requests | int/null | 否 | null | 总量配额，null 表示继承组设置 |
| allowed_model_aliases | string[] | 否 | [] | 可访问的模型白名单 |
| note | string | 否 | null | 备注，最长 500 字符 |

### PUT /api/admin/users/:id

更新用户，所有字段可选。

**认证:** 管理员

**请求体:**
```json
{
  "role": "admin",
  "enabled": true,
  "rpm": 100,
  "new_password": "新密码",
  "reset_usage": "all"
}
```

| reset_usage 值 | 效果 |
|:---|:---|
| `"all"` | 重置总量 + 周期用量 |
| `"total"` | 仅重置总量用量 |
| `"period"` | 仅重置周期用量 |

### DELETE /api/admin/users/:id

软删除用户。不能删除最后一个启用的管理员。

**认证:** 管理员

**响应 (200):**
```json
{ "ok": true, "message": "用户删除成功。" }
```

---

## 管理接口 - 用户组

### GET /api/admin/groups

获取用户组列表。

**认证:** 管理员

**查询参数:** `limit`（1-100，默认 50），`offset`（默认 0）

**响应 (200):**
```json
{
  "data": [
    {
      "id": 1,
      "name": "default",
      "description": null,
      "rpm": -1, "qps": -1, "tpm": -1,
      "quota_requests": null, "quota_tokens": null,
      "allowed_model_aliases": [],
      "oidc_claim_expr": null,
      "oidc_claim_priority": 0,
      "is_default": 1,
      "enabled": 1,
      "user_count": 10
    }
  ],
  "paging": { "limit": 50, "offset": 0, "total": 1 }
}
```

### POST /api/admin/groups

创建用户组。

**认证:** 管理员

**请求体:**
```json
{
  "name": "vip",
  "description": "VIP 用户",
  "rpm": 200, "qps": 50, "tpm": 1000000,
  "quota_requests": 10000,
  "quota_tokens": 50000000,
  "allowed_model_aliases": ["gpt-4", "claude-3"],
  "oidc_claim_expr": "role == \"vip\"",
  "oidc_claim_priority": 100,
  "is_default": false
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| name | string | 是 | | 组名，1-64 字符 |
| description | string | 否 | null | 描述，最长 200 字符 |
| rpm / qps / tpm | int | 否 | -1 | 速率限制，-1 表示不限 |
| quota_requests / quota_tokens | int/null | 否 | null | 总量配额，null 表示不限 |
| allowed_model_aliases | string[] | 否 | [] | 可访问模型白名单 |
| oidc_claim_expr | string | 否 | null | OIDC Claim 匹配表达式，最长 512 字符 |
| oidc_claim_priority | int | 否 | 0 | 匹配优先级，0-9999，越大越优先 |
| is_default | bool | 否 | false | 设为默认组（新用户自动加入） |

#### OIDC Claim 表达式语法

用于 OIDC 登录时自动分配用户组：

```
# 操作符：==、!=、contains、matches（正则）、exists
# 逻辑：AND、OR、括号分组
# 点号访问嵌套字段

role == "admin"
groups contains "vip"
org.department == "engineering"
tdp_social.tencent_uin exists
(role == "staff" OR role == "admin") AND org.type == "enterprise"
email matches ".*@company\\.com"
```

`oidc_claim_priority` 越高越优先匹配，用于解决多个组表达式同时满足时的冲突。

### PUT /api/admin/groups/:id

更新用户组，所有字段可选。

**认证:** 管理员

### DELETE /api/admin/groups/:id

删除用户组。不能删除默认组或仍有用户的组。

**认证:** 管理员

**响应 (200):**
```json
{ "ok": true, "message": "用户组删除成功。" }
```

---

## 管理接口 - 渠道管理

### GET /api/admin/channels

获取所有上游渠道及其模型列表。

**认证:** 管理员

**响应 (200):**
```json
{
  "data": [
    {
      "id": 1,
      "name": "openai-main",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-...",
      "supported_protocols": "[\"chat_completions\"]",
      "enabled": 1,
      "weight": 1,
      "max_concurrency": 64,
      "timeout": 60,
      "models": [
        {
          "id": 1,
          "alias": "gpt-4",
          "real_model": "gpt-4-turbo",
          "channel_id": 1,
          "upstream_protocol": "chat_completions",
          "is_public": 1,
          "enabled": 1,
          "weight": 1,
          "token_multiplier": 1,
          "request_multiplier": 1
        }
      ]
    }
  ]
}
```

### POST /api/admin/channels

创建渠道，可附带初始模型列表。

**认证:** 管理员

**请求体:**
```json
{
  "name": "openai-main",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx",
  "supported_protocols": ["chat_completions"],
  "weight": 1,
  "max_concurrency": 64,
  "timeout": 60,
  "models": [
    {
      "alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "upstream_protocol": "chat_completions",
      "is_public": true,
      "weight": 1
    }
  ]
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| name | string | 是 | | 渠道名称 |
| base_url | string | 是 | | 上游 API 地址 |
| api_key | string | 是 | | 上游 API Key |
| supported_protocols | string[] | 否 | ["chat_completions"] | 支持的协议：`chat_completions` / `anthropic_messages` / `responses` / `embeddings` |
| weight | int | 否 | 1 | 路由权重 |
| max_concurrency | int | 否 | 64 | 最大并发数 |
| timeout | int | 否 | 60 | 超时时间（秒） |
| models | array | 否 | [] | 初始模型列表 |

### PUT /api/admin/channels/:id

更新渠道，所有字段可选。

**认证:** 管理员

### DELETE /api/admin/channels/:id

软删除渠道及其所有模型。

**认证:** 管理员

### POST /api/admin/channels/:id/test

测试渠道连通性，通过其第一个模型发送探测请求。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "渠道测试成功。",
  "data": {
    "channel_id": 1,
    "channel_name": "openai-main",
    "ok": true,
    "status": 200,
    "latency_ms": 1234,
    "body_preview": "..."
  }
}
```

### POST /api/admin/channels/probe-models

探测上游端点可用的模型列表。

**认证:** 管理员

**请求体:**
```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx"
}
```

**响应 (200):**
```json
{ "data": ["gpt-4-turbo", "gpt-3.5-turbo"] }
```

---

## 管理接口 - 模型管理

### GET /api/admin/models

获取所有模型列表。

**认证:** 管理员

### POST /api/admin/models

创建模型映射。

**认证:** 管理员

**请求体:**
```json
{
  "alias": "gpt-4",
  "real_model": "gpt-4-turbo",
  "channel_id": 1,
  "upstream_protocol": "chat_completions",
  "is_public": true,
  "enabled": true,
  "weight": 1,
  "token_multiplier": 1.5,
  "request_multiplier": 1
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| alias | string | 是 | | 客户端调用时的模型名 |
| real_model | string | 是 | | 上游真实模型名 |
| channel_id | int | 是 | | 所属渠道 ID |
| upstream_protocol | enum | 否 | chat_completions | `chat_completions` / `anthropic_messages` / `responses` / `embeddings` |
| is_public | bool | 否 | true | false 时仅白名单用户可访问 |
| weight | int | 否 | 1 | 路由权重（越大流量越多） |
| token_multiplier | float | 否 | 1 | Token 计费倍率：实际扣量 = 使用量 x 倍率 |
| request_multiplier | float | 否 | 1 | 请求计费倍率：实际扣量 = 请求次数 x 倍率 |

### PUT /api/admin/models/:id

更新模型，所有字段可选。

**认证:** 管理员

### DELETE /api/admin/models/:id

软删除模型。

**认证:** 管理员

### POST /api/admin/models/:id/test

测试指定模型，发送探测请求。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "模型测试成功。",
  "data": {
    "model_id": 1,
    "model_alias": "gpt-4",
    "real_model": "gpt-4-turbo",
    "channel_id": 1,
    "channel_name": "openai-main",
    "ok": true,
    "status": 200,
    "latency_ms": 1234,
    "summary": "响应摘要",
    "body_preview": "..."
  }
}
```

---

## 用户接口 - 密钥管理

### GET /api/user/keys

获取当前用户的 API 密钥列表。

**认证:** 用户

**响应 (200):**
```json
{
  "data": [
    {
      "id": 1,
      "key": "sk-gw-abc123...",
      "name": "my-key",
      "used_tokens": 1234,
      "used_requests": 56,
      "enabled": 1,
      "created_at": "2026-05-08 00:00:00"
    }
  ]
}
```

### POST /api/user/keys

创建新的 API 密钥。

**认证:** 用户

**请求体:**
```json
{
  "name": "生产环境密钥"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| name | string | 否 | "" | 备注名，最长 64 字符 |
| enabled | bool | 否 | true | 是否启用 |

### PUT /api/user/keys/:id

更新密钥备注或启用状态。

**认证:** 用户

**请求体:**
```json
{
  "name": "改名后的密钥",
  "enabled": false
}
```

### DELETE /api/user/keys/:id

删除密钥（软删除）。

**认证:** 用户

**响应 (200):**
```json
{ "ok": true, "message": "密钥删除成功。" }
```

---

## 用户接口 - 配额查询

### GET /api/user/quota

获取当前用户的配额和速率限制信息。

**认证:** 用户

**响应 (200):**
```json
{
  "total": {
    "quota_requests": 10000,
    "quota_tokens": 50000000,
    "used_requests": 123,
    "used_tokens": 456789,
    "remaining_requests": 9877,
    "remaining_tokens": 49543211
  },
  "rate": {
    "rpm": 200,
    "qps": 50,
    "tpm": 1000000
  }
}
```

> `null` 表示不限制。速率限制 `-1` 表示不限制。

---

## 仪表盘接口 - 日志查询

### GET /api/dashboard/logs

查询请求日志，支持多维筛选。管理员可查看所有用户，普通用户仅查看自己的日志。

**认证:** 用户

**查询参数:**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| limit | 1-200 | 每页数量（默认 50） |
| offset | int | 偏移量（默认 0） |
| user | string | 按用户名搜索（仅管理员） |
| model | string | 按模型别名或真实模型搜索 |
| channel | string | 按渠道名搜索（仅管理员） |
| ip | string | 按客户端 IP 搜索 |
| start_date | YYYY-MM-DD | 开始日期 |
| end_date | YYYY-MM-DD | 结束日期 |

**响应 (200):**
```json
{
  "summary": {
    "total_requests": 100,
    "failed_requests": 5,
    "total_tokens": 123456,
    "avg_latency_ms": 500,
    "avg_first_token_latency_ms": 200,
    "avg_output_tps": 50.5
  },
  "data": [
    {
      "id": 1,
      "username": "admin",
      "channel_name": "openai-main",
      "model_alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "stream": 1,
      "status_code": 200,
      "prompt_tokens": 100,
      "completion_tokens": 50,
      "total_tokens": 150,
      "latency_ms": 1234,
      "first_token_latency_ms": 300,
      "output_tps": 45.5,
      "route_attempts": 1,
      "attempted_channels": "openai-main",
      "error_message": null,
      "client_ip": "1.2.3.4",
      "created_at": "2026-05-08 12:00:00"
    }
  ],
  "paging": { "limit": 50, "offset": 0, "total": 100 }
}
```

> 普通用户不会看到 `username`、`channel_name`、`route_attempts`、`attempted_channels` 字段。

---

## 仪表盘接口 - 统计概览

### GET /api/dashboard/summary

获取仪表盘统计数据。管理员看全局统计，普通用户看自己的统计。

**认证:** 用户

**响应 (200):**
```json
{
  "data": {
    "total_requests": 10000,
    "total_tokens": 5000000,
    "failed_requests": 50,
    "total_keys": 5,
    "active_users": 20,
    "avg_latency_ms": 500,
    "avg_output_tps": 45.5,
    "retry_requests": 10,
    "rate_limited_requests": 3,
    "success_rate": 99.5,
    "estimated_peak_concurrency": 10,
    "estimated_avg_concurrency": 3,
    "hourly_tokens": [
      { "hour": "2026-05-08 00:00:00", "tokens": 1234 }
    ],
    "top_models": [
      { "model_name": "gpt-4", "request_count": 500, "total_tokens": 100000 }
    ],
    "top_channels": [
      { "channel_name": "openai-main", "request_count": 500, "total_tokens": 100000 }
    ],
    "recent_logs": [
      { "id": 1, "model_name": "gpt-4", "status_code": 200, "total_tokens": 150, "latency_ms": 500, "created_at": "..." }
    ]
  }
}
```

| 字段 | 说明 |
|:---|:---|
| total_requests | 总请求数 |
| total_tokens | 总 Token 消耗 |
| failed_requests | 失败请求数 |
| total_keys | 密钥数量 |
| active_users | 活跃用户数（普通用户始终为 1） |
| avg_latency_ms | 平均响应延迟 |
| avg_output_tps | 平均输出速度（token/s） |
| success_rate | 成功率（百分比） |
| hourly_tokens | 最近 24 小时 Token 趋势 |
| top_models | Top 5 模型（按请求量） |
| top_channels | Top 5 渠道（按请求量） |
| recent_logs | 最近 8 条请求记录 |

---

## 仪表盘接口 - 用户资料

### GET /api/dashboard/profile

获取当前用户资料（含生效的限制配置）。

**认证:** 用户

### PUT /api/dashboard/profile/password

修改密码（等同于 `/api/auth/change-password`）。

**认证:** 用户

---

## 仪表盘接口 - 可用模型

### GET /api/dashboard/available-models

获取当前用户可访问的模型列表。

**认证:** 用户

**响应 (200):**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4", "object": "model" },
    { "id": "claude-3", "object": "model" }
  ]
}
```

---

## 网关接口 - OpenAI 兼容

所有网关端点通过 API Key 认证。

### POST /api/v1/chat/completions

OpenAI Chat Completions 兼容端点。

**认证:** API Key

**请求体:** 标准 OpenAI 格式：
```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false
}
```

**响应:** 标准 OpenAI Chat Completion 响应，支持流式输出（`stream: true`）。

**额外响应头:**
```
X-Quota-Limit-Requests-Remaining: 9877
X-Quota-Limit-Tokens-Remaining: 49543211
```

---

### POST /api/v1/messages

Anthropic Messages 兼容端点。

**认证:** API Key

**请求体:** 标准 Anthropic 格式：
```json
{
  "model": "claude-3",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}
```

---

### POST /api/v1/responses

OpenAI Responses API 兼容端点。

**认证:** API Key

---

### POST /api/v1/embeddings

OpenAI Embeddings 兼容端点，直通上游 `/embeddings`，不参与 Chat Completions / Responses / Claude Messages 协议转换。

**认证:** API Key

**请求体:** 标准 OpenAI Embeddings 格式：
```json
{
  "model": "text-embedding-3-small",
  "input": "你好"
}
```

**响应:** 标准 OpenAI Embeddings 响应。

---

### GET /api/v1/models

获取当前 API Key 可用的模型列表。

**认证:** API Key

**响应:**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4", "object": "model" }
  ]
}
```

---

## 错误格式

所有错误遵循统一格式：

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "param": "None",
    "code": "400"
  }
}
```

| HTTP 状态码 | 含义 |
|:---|:---|
| 400 | 请求参数错误 |
| 401 | 认证失败 |
| 403 | 禁止访问（功能未开启） |
| 404 | 资源不存在 |
| 409 | 冲突（如重名） |
| 429 | 请求过于频繁 |
| 502 | 上游服务错误 |

---

## 速率限制与配额

- **RPM / QPS / TPM:** 用户级速率限制，`-1` 表示不限制
- **quota_tokens / quota_requests:** 总量配额，`null` 表示不限制
- **模型倍率:** `token_multiplier` 和 `request_multiplier` 控制计费扣量
  - 实际扣除 Token = 使用量 x token_multiplier
  - 实际扣除请求次数 = 请求次数 x request_multiplier
  - 支持小数累积（如 0.1 倍率，10 次请求累积扣 1 次）
- 用户限制未设置时（`-1` 或 `null`）自动继承所属用户组的配置

## 上游重试与熔断

- **自动重试:** 上游返回 401/429/5xx 时自动切换到其他渠道，最大重试次数可配置
- **熔断机制:** 连续失败 3 次后暂停该渠道 15 秒，可通过设置开关关闭
