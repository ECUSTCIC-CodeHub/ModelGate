# ModelGate API 文档

## 概述

ModelGate 是一个 LLM 网关，提供 OpenAI 兼容的 API 端点，支持用户管理、配额控制和多渠道路由。

**Base URL:** `http://your-domain:3000`

## 构建版本

通过 `MODELGATE_EDITION` / `NEXT_PUBLIC_MODELGATE_EDITION` 在构建时选择版本：

| 版本 | 取值 | 功能范围 |
|:---|:---|:---|
| 完整版 | `full`（默认） | 包含 OIDC、周期配额、系统公告、接入指南通知等完整功能 |
| 精简版 | `lite` | 不包含 OIDC、周期配额、系统公告、接入指南通知、Webhook 回调；相关页面不渲染，相关 API 功能不可用或忽略对应字段 |

> 精简版保持与完整版相同的数据库结构，便于不同制品切换。精简版行为差异：

- OIDC 授权、回调、绑定、解绑等接口返回 404，`GET /api/auth/oidc/status` 固定返回 `oidc_enabled: false`、`password_login_enabled: true`。
- 系统公告接口返回 404，公告管理接口返回 404，系统设置中的 `announcement_content` 和 `announcement_display_count` 不返回实际值，更新时忽略。
- 接入指南通知接口返回 404，系统设置中的 `access_guide_notice` 不返回实际内容，更新时忽略。
- Webhook 回调接口返回 404，系统设置中的 `webhook_secret` 不返回实际内容，更新时忽略。
- 用户和用户组的周期配额字段不参与创建/更新和配额校验，网关不维护周期用量，也不返回周期配额响应头。
- 渠道的周期配额字段在精简版中不参与创建/更新和配额校验，不返回渠道周期配额响应头。
- `reset_usage: "period"` 返回 404；`reset_usage: "all"` 在精简版中只重置总用量。
- OIDC 设置和用户组 OIDC Claim 映射字段在精简版中不参与创建/更新；已有数据库值会保留，切回完整版后仍可使用。

## 数据库配置

通过环境变量选择数据库驱动，支持 SQLite（默认）和 MySQL。

### SQLite（默认）

SQLite 数据库文件位于 `data/gateway.db`，启动时自动创建。无需额外配置。

### MySQL

设置 `DB_DRIVER=mysql` 后，需配置以下连接参数：

| 环境变量 | 默认值 | 说明 |
|:---|:---|:---|
| `DB_DRIVER` | `sqlite` | 数据库驱动，可选 `sqlite` 或 `mysql` |
| `MYSQL_HOST` | `localhost` | MySQL 主机地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `root` | MySQL 用户名 |
| `MYSQL_PASSWORD` | （空） | MySQL 密码 |
| `MYSQL_DATABASE` | `modelgate` | 数据库名 |
| `MYSQL_POOL_SIZE` | `10` | 连接池大小 |

MySQL 模式下启动时自动建表和初始化默认数据。两种驱动共享相同的业务逻辑和数据结构。

### 日志保留

网关每次请求都会写入 `logs` 表，按保留天数自动清理旧日志，避免表无限膨胀。保留天数在「系统设置 → 日志保留」中配置（设置键 `log_retention_days`），默认 0 表示不清理；设为正数按天数自动清理（合法范围 0-3650）。

公告邮件发送会在 `email_send_log` 表逐封记录发送成败（用于失败补发），该表复用同一个 `log_retention_days` 保留策略自动清理，避免长期运行实例数据库膨胀。注意：超过保留期的失败记录会被自动删除，之后无法再经「重发失败邮件」补发，因此请将日志保留天数设置得不小于预计处理失败邮件的间隔。清理任务与 `logs` 表共用同一调度（启动 1 分钟后首清、每 6 小时一次、分批删除）。

管理员仪表盘的累计总量（总请求数、总 Token、失败/限流/重试请求）独立维护在 `stats` 表，删除日志不影响这些累计值；平均延迟、近 24 小时趋势、Top 模型/渠道等仍基于 `logs` 实时聚合，仅反映保留窗口内的数据。

清理任务在数据库初始化后启动，启动 1 分钟后执行一次首清，之后每 6 小时执行一次；每次按 5000 条分批删除，批次间短暂让出，避免阻塞网关写入。首次启动会从现有日志全量回填 `stats` 计数。

## 认证方式

### Web 认证

管理后台和仪表盘接口使用 JWT Bearer Token 或 HTTP-only Cookie：

```
Authorization: Bearer <access_token>
```

通过 `/api/auth/login` 或 `/api/auth/register` 获取 Token。

### API Key 认证

网关端点（`/api/v1/*` 和 `/api/ollama/*`）使用 API Key：

```
Authorization: Bearer sk-gw-xxxxx
```

或

```
x-api-key: sk-gw-xxxxx
```

也支持通过 query 参数传递，适用于无法自定义请求头的客户端：

```
?token=sk-gw-xxxxx
```

或

```
?api_key=sk-gw-xxxxx
```

请求头方式优先级更高，也更推荐；query 鉴权会被所有支持 API Key 的端点识别，包括 `/api/v1/*`、`/api/ollama/*`、`/api/user/*`、`/api/dashboard/*` 和 `/api/admin/*`。

Ollama 兼容接口仅位于 `/api/ollama/*` 下。支持三种传递 API Key 的方式：

- 请求头：`Authorization: Bearer sk-gw-xxxxx` 或 `x-api-key: sk-gw-xxxxx`
- query：`/api/ollama/api/tags?token=sk-gw-xxxxx` 或 `?api_key=sk-gw-xxxxx`
- path：Ollama 客户端如果只能配置服务根地址、且会自行追加 `/api/version`、`/api/tags`、`/api/show`、`/api/chat` 或 `/v1/chat/completions`，可使用路径鉴权根地址：

```
http://your-domain:3000/api/ollama/sk-gw-xxxxx
```

对应路径会映射到：

```
GET  /api/ollama/sk-gw-xxxxx/api/version
GET  /api/ollama/sk-gw-xxxxx/api/tags
POST /api/ollama/sk-gw-xxxxx/api/show
POST /api/ollama/sk-gw-xxxxx/api/chat
GET  /api/ollama/sk-gw-xxxxx/v1/models
POST /api/ollama/sk-gw-xxxxx/v1/chat/completions
```

路径鉴权仅用于不支持请求头鉴权的 Ollama 客户端；常规客户端仍建议使用请求头。

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

> 登录限流：每个 IP + 用户名组合每分钟最多 5 次尝试，超出返回 429。

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

修改当前用户密码。仅在密码登录开启时可用；仅 OIDC 登录时返回 400。

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

### GET /api/auth/oidc/status

获取登录方式可用状态。

**认证:** 无

**响应 (200):**
```json
{
  "oidc_enabled": true,
  "oidc_button_text": "OIDC 登录",
  "password_login_enabled": true,
  "registration_enabled": true
}
```

> 精简版固定返回 `oidc_enabled: false`、`password_login_enabled: true`。

### GET /api/auth/oidc/authorize

发起 OIDC 授权流程。

**认证:** 无

**响应:** 302 重定向到 OIDC 提供商授权地址。

> 精简版返回 404。

### GET /api/auth/oidc/callback

处理 OIDC 提供商回调。

**认证:** 无

**查询参数:** `code`、`state`

**响应:** 登录成功后 302 重定向到 `/dashboard`，需要绑定或注册时按配置重定向到对应页面。

> 回调会通过 OIDC Discovery 的 `jwks_uri` 验证 ID Token 签名，并校验 issuer、audience、nonce 与过期时间。

> 精简版返回 404。

### GET /api/auth/oidc/bind

已登录用户发起 OIDC 账号绑定。

**认证:** 用户

**响应:** 302 重定向到 OIDC 提供商授权地址。

> 精简版返回 404。

### POST /api/auth/oidc/unbind

解绑当前用户的 OIDC 账号。

**认证:** 用户

**响应 (200):**
```json
{ "message": "OIDC 绑定已解除。" }
```

> 精简版返回 404。

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
    "upstream_retry_same_channel": 0,
    "upstream_circuit_breaker_enabled": 1,
    "oidc_enabled": 0,
    "oidc_issuer_url": "",
    "oidc_client_id": "",
    "oidc_client_secret": "",
    "oidc_scopes": "openid profile email",
    "oidc_auto_register": 1,
    "oidc_button_text": "OIDC 登录",
    "public_base_url": "",
    "announcement_content": "",
    "access_guide_notice": "",
    "webhook_secret": "",
    "cors_enabled": 0,
    "icp_filing_number": "",
    "public_security_filing_number": "",
    "theme_color": "",
    "feedback_url": "",
    "repo_name": ""
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
  "upstream_retry_same_channel": false,
  "upstream_circuit_breaker_enabled": true,
  "oidc_enabled": true,
  "oidc_issuer_url": "https://idp.example.com",
  "oidc_client_id": "modelgate",
  "oidc_client_secret": "secret",
  "oidc_scopes": "openid profile email",
  "oidc_auto_register": true,
  "oidc_button_text": "OIDC 登录",
  "public_base_url": "https://your-domain.com",
  "announcement_content": "# 欢迎",
  "access_guide_notice": "## 自动配置工具\n\n```bash\nnpx cic-ai-config-helper\n```",
  "webhook_secret": "your-webhook-secret",
  "cors_enabled": false,
  "ua_restrictions": "[]",
  "log_retention_days": 0,
  "theme_color": "#00518f",
  "feedback_url": "https://cnb.cool/{repo}/-/issues/new/choose",
  "repo_name": "ecustcic/ModelGate",
  "model_status_light_1_hours": 1,
  "model_status_light_2_hours": 2,
  "model_status_light_3_hours": 3,
  "top_users_visible": true,
  "overview_global": true,
  "vision_fallback_enabled": false,
  "vision_fallback_alias": ""
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| registration_enabled | boolean | 是否允许注册 |
| password_login_enabled | boolean | 是否允许密码登录 |
| upstream_retry_enabled | boolean | 是否开启上游自动重试 |
| upstream_retry_max_attempts | 1-10 | 最大重试次数 |
| upstream_retry_same_channel | boolean | 没有其他渠道时是否对当前渠道重试（429 场景） |
| upstream_circuit_breaker_enabled | boolean | 是否开启上游熔断 |
| oidc_enabled | boolean | 是否开启 OIDC 登录 |
| oidc_issuer_url | string | OIDC Issuer URL |
| oidc_client_id | string | OIDC Client ID |
| oidc_client_secret | string | OIDC Client Secret；返回时会以 `••••••••` 掩码展示 |
| oidc_scopes | string | OIDC scopes，默认 `openid profile email` |
| oidc_auto_register | boolean | 是否允许 OIDC 首次登录自动创建用户 |
| oidc_button_text | string | 登录页 OIDC 按钮文案 |
| oidc_group_expire_days | int | OIDC 身份组有效期（天，0-3650，默认 30）；通过 Claim 匹配到的身份组在该有效期内未重新登录确认则自动过期并回退默认组，设为 0 关闭自动过期 |
| public_base_url | string | 对外服务域名 |
| announcement_content | string | 系统公告内容（支持 Markdown，最长 5000 字符）；已弃用，公告内容现通过公告管理接口维护 |
| announcement_display_count | number | 首页公告展示条数（1-20，默认 3） |
| access_guide_notice | string | 接入指南通知内容（支持 Markdown，最长 10000 字符） |
| webhook_secret | string | Webhook 回调密钥（最长 200 字符） |
| cors_enabled | boolean | 是否允许所有来源跨域访问网关 API（开启后 `/api/v1/*` 和 `/api/ollama/*` 返回 `Access-Control-Allow-Origin: *` 并响应 OPTIONS 预检） |
| icp_filing_number | string | ICP 备案号，留空则不展示（最长 200 字符） |
| public_security_filing_number | string | 公安联网备案号，留空则不展示（最长 200 字符） |
| theme_color | string | 主题色（十六进制颜色代码，如 `#00518f`），留空则使用默认靛蓝色 |
| feedback_url | string | 自定义问题反馈链接（最长 2000 字符），必须以 `http(s)://` 开头；留空则不展示，此时若配置了 `repo_name` 则自动生成 CNB 的 Issue 链接；支持 `{repo}` 占位符，将由 `repo_name` 替换；链接以新窗口打开并附带 `noreferrer` |
| repo_name | string | CNB 仓库路径（最长 200 字符），如 `ecustcic/ModelGate`；当 `feedback_url` 为空时，自动生成 `https://cnb.cool/<repo_name>/-/issues/new/choose` |
| ua_restrictions | string | 全站 User-Agent 限制规则 JSON 数组，留空或 `[]` 表示不限制（完整版功能，最长 20000 字符） |
| log_retention_days | number | 请求日志（`logs`）与邮件发送日志（`email_send_log`）的保留天数，0 表示不清理（0-3650）；超过保留期的失败邮件记录会被自动删除，无法再经「重发失败邮件」补发 |
| model_status_light_1_hours | int | 模型列表成功率状态灯配置项 1 的统计时长（小时，1-168，默认 1） |
| model_status_light_2_hours | int | 模型列表成功率状态灯配置项 2 的统计时长（小时，1-168，默认 2） |
| model_status_light_3_hours | int | 模型列表成功率状态灯配置项 3 的统计时长（小时，1-168，默认 3） |
| top_users_visible | boolean | 是否允许普通用户在首页查看 Top 用户排行（默认 true）；管理员始终可见 |
| overview_global | boolean | 是否允许普通用户在首页概览查看全局统计（默认 true）；关闭后普通用户只看自己的统计，管理员始终看全局 |
| vision_fallback_enabled | boolean | 是否开启「图片自动路由到识图模型」；开启后，用户向未标记支持识图的模型发送图片时，自动改路由到支持识图的模型 |
| vision_fallback_alias | string | 指定优先使用的识图模型别名（最长 255 字符）；留空时从已启用且标记「支持识图」的模型中自动选择 |

> 精简版固定保留账号密码登录；返回时会隐藏 OIDC 配置、公告内容、公告展示条数、接入指南通知和 Webhook 密钥，更新时忽略 `oidc_*`、`announcement_content`、`announcement_display_count`、`access_guide_notice` 与 `webhook_secret` 字段。

---

## 管理接口 - 邮件通知

邮件通知用于在创建/修改系统公告时，向「用户列表中填写了邮箱且处于启用状态」的用户发送通知邮件。支持配置多个 SMTP 发件账号，并按优先级与单日发送上限自动分流：优先使用优先级最高的账号，同一优先级内的多个账号轮流分配；当且仅当较高优先级的所有账号均已达到单日上限时，才降级使用下一优先级的账号；全部账号额度用尽时剩余用户当日不再发送。单封邮件若在某个账号发送失败，会自动尝试用下一优先级的可用账号补发；所有账号均失败后才记录为失败，可通过「重发失败邮件」手动补发（重发同样按优先级依次尝试可用账号，且不占用单日额度）。

邮件发送在公告保存之后于后台异步进行，不阻塞公告创建/修改接口；可配置在发送完成后向指定管理员邮箱发送结果汇报邮件。每封邮件的成败都会写入 `email_send_log` 表，失败的邮件不会自动重试，可通过「重发失败邮件」接口手动补发（见下文）。

邮件相关配置（全局开关、标题模板、发件名称、页脚）与发件账号独立维护，不随「系统设置」的统一保存提交。

发件账号的 SMTP 密码在落库时默认以 AES-256-GCM 加密存储（密钥取自 `EMAIL_ENCRYPTION_SECRET`，未配置时回退 `JWT_ACCESS_SECRET`；两者均未配置则写入明文并在日志告警）。接口返回密码时始终以掩码 `••••••••` 呈现，仅管理员可访问。

### GET /api/admin/email/settings

获取邮件通知全局配置。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "ok",
  "data": {
    "enabled": true,
    "subject_template": "【系统公告】{title}",
    "from_name": "",
    "footer": "",
    "report_enabled": false,
    "report_to": "",
    "blocked_domains": ""
  }
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| enabled | boolean | 是否启用邮件通知（总开关） |
| subject_template | string | 邮件标题模板，支持 `{title}`（公告标题）与 `{date}`（日期）占位符 |
| from_name | string | 默认发件名称，留空则使用发件账号自身的发件名称 |
| footer | string | 邮件正文页脚，附加在公告内容之后；支持内联 HTML（例如超链接 `<a href="https://..." target="_blank" rel="noopener noreferrer">CIC模型网关</a>`），纯文本版会自动转换为「文字 (URL)」 |
| report_enabled | boolean | 是否在公告邮件发送完成后，向指定管理员邮箱发送结果汇报 |
| report_to | string | 接收汇报的管理员邮箱，多个用逗号或换行分隔；`report_enabled` 为 true 时生效 |
| blocked_domains | string | 屏蔽的收件邮箱域名列表，多个用逗号或换行分隔；仅精确匹配完整域名（不含其子域），如配置 `ecust.edu.cn` 会屏蔽 `a@ecust.edu.cn` 但不会屏蔽 `a@mail.ecust.edu.cn` |

### PUT /api/admin/email/settings

更新邮件通知全局配置。

**认证:** 管理员

**请求体:**
```json
{
  "enabled": true,
  "subject_template": "【系统公告】{title}",
  "from_name": "",
  "footer": "",
  "report_enabled": false,
  "report_to": "",
  "blocked_domains": ""
}
```

**响应 (200):** 返回更新后的配置。

### GET /api/admin/email/senders

获取全部发件账号列表（密码以掩码返回）。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "ok",
  "data": [
    {
      "id": 1,
      "name": "主账号",
      "host": "smtp.example.com",
      "port": 465,
      "secure": true,
      "auth_user": "noreply@example.com",
      "auth_pass": "••••••••",
      "from_address": "noreply@example.com",
      "from_name": "ModelGate 通知",
      "daily_limit": 500,
      "priority": 10,
      "enabled": true,
      "sent_today": 12,
      "sent_date": "2026-07-09"
    }
  ]
}
```

### POST /api/admin/email/senders

新增发件账号。

**认证:** 管理员

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| name | string | 账号名称（1-100 字符） |
| host | string | SMTP 服务器地址 |
| port | number | 端口（1-65535） |
| secure | boolean | 是否使用 SSL/TLS 隐式加密（如 465）；false 表示 STARTTLS（如 587/25） |
| auth_user | string | 认证用户名（可选，可留空表示无需认证） |
| auth_pass | string | 认证密码（可选，可留空） |
| from_address | string | 发件地址 |
| from_name | string | 发件名称（可选） |
| daily_limit | number | 单日发送上限，0 表示不限制（0-100000） |
| priority | number | 优先级，数值越大越优先使用 |
| enabled | boolean | 是否启用该账号 |

**响应 (201):** 返回创建的账号。

### PUT /api/admin/email/senders/{id}

更新指定发件账号。字段同新增；`auth_pass` 传掩码 `••••••••` 或留空表示保留原密码。

**认证:** 管理员

**响应 (200):** 返回更新后的账号；账号不存在返回 404。

### DELETE /api/admin/email/senders/{id}

删除指定发件账号。

**认证:** 管理员

**响应 (200):** `{ "message": "发件账号已删除。" }`；账号不存在返回 404。

### POST /api/admin/email/senders/{id}/test

向指定邮箱发送一封测试邮件，用于验证账号配置。

**认证:** 管理员

**请求体:**
```json
{
  "to": "admin@example.com"
}
```

`to` 可选，留空则发送至该账号的 `from_address`。

**响应 (200):** `{ "message": "测试邮件已发送至 admin@example.com。" }`；发送失败返回 502 并附带错误信息。

### POST /api/admin/email/resend-failed

重发此前发送失败的公告邮件。仅针对 `email_send_log` 中状态为 `failed` 的记录，按公告分组补发，且**不占用发件账号的单日发送额度**。补发时按优先级从高到低依次尝试可用发件账号，任一账号发送成功即标记该记录为 `sent`；全部账号失败仍保持 `failed`，可继续重发。

**认证:** 管理员

**请求体:**
```json
{
  "announcement_id": 12
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| announcement_id | number | 可选；指定只重发该公告的失败邮件，不传则重发全部失败邮件（含广播邮件） |

**响应 (200):**
```json
{
  "message": "已处理失败邮件重发：尝试 3 封，成功 3，失败 0。",
  "data": {
    "attempted": 3,
    "sent": 3,
    "failed": 0,
    "skipped_missing": 0,
    "errors": []
  }
}
```

- `skipped_missing`：对应公告已不存在（被删除）或广播邮件正文缺失而跳过的失败记录数。
- 没有失败邮件时返回 `message: "没有需要重发的失败邮件。"`。

> 失败的邮件不会被自动重试：每次公告或广播邮件发送会在后台异步进行，并将每封的成败写入 `email_send_log`；管理员在完成通知邮件中获知失败数后，可在此手动补发（绕过单日额度），而非等待次日。广播邮件的失败记录同样在此处补发。

### POST /api/admin/email/send

向全部用户或指定用户组主动发送一封邮件通知，不经过系统公告。收件人取有邮箱、已启用且未删除的用户；指定用户组时再叠加 `group_id` 过滤。邮件标题使用「邮件通知」中的标题模板渲染，正文支持 Markdown，分页与页脚沿用邮件通知设置。发送沿用多账号优先级与单日额度策略，失败自动降级到其他可用发件账号。**该接口为后台异步发送**：提交后立即返回，邮件在后台逐个发送，不会阻塞请求；请勿重复提交。

**认证:** 管理员（仅限 web 登录，不接受 API Key）

**请求体:**
```json
{
  "title": "全员通知",
  "content": "这是一封**主动发送**的邮件。",
  "target": "group",
  "group_id": 3
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| title | string | 必填；邮件标题，最长 500 字符，用于标题模板的 `{title}` 占位符 |
| content | string | 必填；邮件正文，支持 Markdown，最长 20000 字符 |
| target | string | 必填；`all` 表示全部用户，`group` 表示指定用户组 |
| group_id | number | `target` 为 `group` 时必填，且必须为存在的用户组；`target` 为 `all` 时忽略 |

**响应 (200):**
```json
{
  "message": "广播邮件已提交，将在后台发送，请勿重复提交。"
}
```

- 接口仅做参数与用户组存在性校验后提交后台任务，立即返回，不返回发送结果。
- 实际发送进度与成败由后台任务处理并记录到 `email_send_log`；邮件功能未启用或未配置发件账号时任务会在后台跳过。
- 发送完成后若「邮件通知」中开启了「发送完成后通知管理员」，会向管理员邮箱发送一封完成汇报（沿用该配置），汇报包含计划数、成功、失败与额度跳过数量，与公告邮件一致。
- 广播邮件的失败记录同样写入 `email_send_log`（`kind = broadcast`，并保存邮件标题与正文），可在「邮件通知」设置的「重发失败邮件」中手动补发。
- 同一时间仅允许一个广播发送任务；若已有任务进行中，接口返回 `409` 并提示「已有广播邮件发送任务进行中，请稍后再试。」

### GET /api/admin/email/failed-logs

查看邮件发送日志。默认返回全部记录，可通过 `status` 参数只查失败或成功的记录，用于排查发送失败的原因。

**认证:** 管理员

**查询参数:**

| 参数 | 类型 | 说明 |
|:---|:---|:---|
| status | string | 可选；`failed` 仅返回失败记录，`sent` 仅返回成功记录，不传则返回全部 |

**响应 (200):**
```json
{
  "data": [
    {
      "id": 5,
      "announcement_id": 12,
      "announcement_title": "系统维护通知",
      "kind": "announcement",
      "title": null,
      "recipient_email": "user@example.com",
      "sender_id": 1,
      "status": "failed",
      "error": "连接失败: 认证被拒绝",
      "created_at": "2026-07-09 17:30:00"
    },
    {
      "id": 6,
      "announcement_id": 0,
      "announcement_title": null,
      "kind": "broadcast",
      "title": "全员通知",
      "recipient_email": "a@b.com",
      "sender_id": 1,
      "status": "failed",
      "error": "连接失败: 认证被拒绝",
      "created_at": "2026-07-09 18:00:00"
    }
  ]
}
```

- `kind` 为 `announcement`（系统公告）或 `broadcast`（广播邮件）。
- `kind = broadcast` 时 `announcement_id` 为 `0`、`announcement_title` 为 `null`，邮件标题与正文取自 `title` 字段。
- 关联公告已删除时 `announcement_title` 为 `null`。
- 记录按 `created_at` 倒序返回。

---

## 站点信息

### GET /api/site-info

获取首页展示所需的公开站点信息（备案号、侧边栏问题反馈链接等），无需认证。

**响应 (200):**
```json
{
  "data": {
    "icp_filing_number": "苏ICP备2023000758号-3",
    "public_security_filing_number": "沪公网安备31012102000146号",
    "feedback_url": "https://cnb.cool/ecustcic/ModelGate/-/issues/new/choose"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| icp_filing_number | string | ICP 备案号，未配置时为空字符串 |
| public_security_filing_number | string | 公安联网备案号，未配置时为空字符串 |
| feedback_url | string | 问题反馈链接，未配置时为空字符串 |

---

## Webhook 回调

### POST /api/webhook

接收外部平台的用户变更事件推送，HMAC-SHA256 验签后自动根据用户角色/标签匹配用户组。

**签名验证:**

> 精简版不包含 Webhook 回调功能，本接口返回 404。

签名从请求体 `signature` 字段读取，计算方式：

```
HMAC-SHA256(webhook_secret, id + "." + type + "." + timestamp + JSON(data))
```

其中 `JSON(data)` 为 `data` 字段的紧凑 JSON 序列化。`timestamp` 允许 5 分钟偏差（防重放）。

**请求体:**
```json
{
  "id": "361e4176-1ee8-4c34-a209-b90f7110b1be",
  "type": "user.role_change",
  "timestamp": "2026-05-11T06:54:03Z",
  "app_id": "optional_app_id",
  "signature": "sha256=<HMAC-SHA256 hex>",
  "data": {
    "user_id": "311039016986218496",
    "old_role": "user",
    "new_role": "certified"
  }
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| id | string | 事件唯一 ID（UUID v4），用于幂等去重 |
| type | string | 事件类型 |
| timestamp | string | 事件发生时间（ISO 8601） |
| signature | string | `sha256=<hex>` 格式的 HMAC-SHA256 签名 |
| app_id | string | 可选，来源应用标识 |
| data | object | 业务载荷，随事件类型不同 |

**支持的事件类型:**

| type | 说明 | data 字段 |
|:---|:---|:---|
| user.role_change | 用户角色变更 | user_id, old_role, new_role |
| user.tags_changed | 用户标签变更 | user_id, action(set/add/remove), tags[] |
| user.identity_change | 身份信息变更（仅记录） | user_id, field |

**分组匹配逻辑:**

系统在用户表维护 `webhook_role` 和 `webhook_tags` 快照，每次事件更新快照后用完整的 `{ role, tags }` 作为 claims 调用各用户组的 Claim 表达式进行匹配。无匹配时回退到默认组。

- `role_change`: 更新 role 快照，合并已有 tags，重新匹配
- `tags_changed`: 按 action 更新 tags 快照（`set` 全量替换 / `add` 合并去重 / `remove` 删除），合并已有 role，重新匹配

Claim 表达式示例：`role == "certified"`、`tags contains "先锋会员"`、`role == "certified" AND tags contains "VIP"`

**响应 (200):**
```json
{
  "message": "已将用户分组更新为 3",
  "event_id": "361e4176-1ee8-4c34-a209-b90f7110b1be"
}
```

**错误响应:**

| 状态码 | 说明 |
|:---|:---|
| 400 | 请求体格式错误或缺少必要字段 |
| 403 | 签名验证失败或时间戳过期 |
| 503 | Webhook 密钥未配置 |

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
| role | string | | 按角色筛选：`admin` / `user` |
| sort_by | string | created_at | 排序字段：`created_at` / `used_requests` / `used_tokens` / `username` |
| sort_dir | string | desc | 排序方向：`asc` / `desc` |

**响应 (200):**
```json
{
  "data": [
    {
      "id": 1,
      "username": "admin",
      "email": "admin@example.com",
      "role": "admin",
      "group_id": 1,
      "group_name": "default",
      "rpm": -1, "qps": -1, "tpm": -1,
      "quota_tokens": null, "quota_requests": null,
      "quota_period": null,
      "period_quota_tokens": null,
      "period_quota_requests": null,
      "used_tokens": 1234, "used_requests": 56,
      "allowed_model_aliases": [],
      "note": null,
      "enabled": 1,
      "created_at": "2026-05-08 00:00:00",
      "group_rpm": -1, "group_qps": -1, "group_tpm": -1,
      "group_quota_requests": null, "group_quota_tokens": null,
      "group_quota_period": null,
      "group_period_quota_tokens": null,
      "group_period_quota_requests": null,
      "effective_rpm": -1, "effective_qps": -1, "effective_tpm": -1,
      "effective_quota_requests": null, "effective_quota_tokens": null,
      "effective_quota_period": null,
      "effective_period_quota_tokens": null,
      "effective_period_quota_requests": null
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
  "email": "user@example.com",
  "role": "user",
  "group_id": 1,
  "enabled": true,
  "group_locked": false,
  "rpm": -1, "qps": -1, "tpm": -1,
  "quota_tokens": null,
  "quota_requests": null,
  "quota_period": 86400,
  "period_quota_tokens": 500000,
  "period_quota_requests": 1000,
  "allowed_model_aliases": [],
  "note": "备注"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| username | string | 是 | | 仅英文字母和数字，3-32 位 |
| password | string | 是 | | 最少 8 位 |
| email | string | 否 | null | 邮箱，用于 OIDC 账号关联 |
| role | string | 否 | user | `admin` / `user` |
| group_id | int/null | 否 | 默认组 | 用户组 ID |
| enabled | bool | 否 | true | 是否启用 |
| group_locked | bool | 否 | false | 锁定身份组；开启后 OIDC 登录与过期回收定时任务都不再修改该用户的身份组，由管理员手动指定 |
| rpm / qps / tpm | int | 否 | -1 | 速率限制，-1 表示继承组设置 |
| quota_tokens / quota_requests | int/null | 否 | null | 总量配额，null 表示继承组设置 |
| quota_period | int/null | 否 | null | 周期配额重置周期（秒），null 表示继承组设置 |
| period_quota_tokens / period_quota_requests | int/null | 否 | null | 周期配额，null 表示继承组设置 |
| allowed_model_aliases | string[] | 否 | [] | 可访问的模型白名单 |
| note | string | 否 | null | 备注，最长 500 字符 |

**响应 (201):**
```json
{
  "message": "用户创建成功。",
  "data": { "id": 1, "username": "newuser", ... },
  "warnings": ["以下模型别名不存在，已忽略: xxx"]
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| message | string | 操作结果描述 |
| data | object | 创建后的用户数据 |
| warnings | string[] | 被忽略的模型别名提示（仅当有不存在于 models 表的别名时出现） |

### PUT /api/admin/users/:id

更新用户，所有字段可选。

**认证:** 管理员

**请求体:**
```json
{
  "role": "admin",
  "enabled": true,
  "group_locked": false,
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

`group_locked` 含义见 POST 创建接口字段表；开启后该用户的身份组不受 OIDC 同步与过期回收影响。

> 精简版忽略 `quota_period`、`period_quota_tokens`、`period_quota_requests`；`reset_usage: "period"` 返回 404，`reset_usage: "all"` 仅重置总量用量。

**响应 (200):**
```json
{
  "message": "用户更新成功。",
  "data": { "id": 1, "username": "newuser", ... },
  "warnings": ["以下模型别名不存在，已忽略: xxx"]
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| message | string | 操作结果描述 |
| data | object | 更新后的用户数据 |
| warnings | string[] | 被忽略的模型别名提示（仅当有不存在于 models 表的别名时出现） |

### DELETE /api/admin/users/:id

软删除用户。不能删除最后一个启用的管理员。

**认证:** 管理员

**响应 (200):**
```json
{ "ok": true, "message": "用户删除成功。" }
```

---

## 管理接口 - 配额概览

### GET /api/admin/quota-overview

获取系统全局配额概览，包括用户统计、各用户组配额配置、各渠道配额与使用量、特殊配额模型使用情况。

**认证:** 管理员

**响应 (200):**
```json
{
  "total_users": 5,
  "total_keys": 8,
  "groups": [
    {
      "id": 1,
      "name": "default",
      "user_count": 3,
      "rpm": -1,
      "qps": -1,
      "tpm": -1,
      "quota_tokens": null,
      "quota_requests": 100,
      "quota_period": null,
      "period_label": null,
      "period_quota_tokens": null,
      "period_quota_requests": null
    }
  ],
  "channels": [
    {
      "id": 1,
      "name": "OpenAI",
      "model_count": 2,
      "quota_tokens": 1000000,
      "quota_requests": null,
      "used_tokens": 250000,
      "used_requests": null,
      "remaining_tokens": 750000,
      "remaining_requests": null,
      "quota_period": 86400,
      "period_label": "每日",
      "period_quota_tokens": 500000,
      "period_quota_requests": null,
      "period_used_tokens": 120000,
      "period_used_requests": null,
      "period_remaining_tokens": 380000,
      "period_remaining_requests": null,
      "period_reset_at": "2026-06-02T00:00:00.000Z"
    }
  ],
  "models": [
    {
      "id": 1,
      "alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "channel_name": "OpenAI",
      "quota_mode": "independent",
      "quota_requests": 1000,
      "quota_tokens": 500000,
      "used_requests": 150,
      "used_tokens": 75000,
      "remaining_requests": 850,
      "remaining_tokens": 425000,
      "quota_period": 3600,
      "period_label": "每小时",
      "period_quota_requests": 100,
      "period_quota_tokens": 50000,
      "period_used_requests": 30,
      "period_used_tokens": 12000,
      "period_remaining_requests": 70,
      "period_remaining_tokens": 38000,
      "period_reset_at": "2026-06-01T00:00:00.000Z"
    }
  ]
}
```

> 精简版 `quota_period`、`period_label`、`period_quota_*`、`period_used_*`、`period_remaining_*`、`period_reset_at` 字段均为 `null`。
>
> 用户组配额为每用户独立生效的限制，非总量池。`bypass_group` 模型的 `used_*`、`remaining_*` 为 `null`。

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
      "quota_period": null,
      "period_quota_tokens": null,
      "period_quota_requests": null,
      "allowed_model_aliases": [],
      "allowed_channel_ids": [],
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
  "quota_period": 86400,
  "period_quota_requests": 1000,
  "period_quota_tokens": 5000000,
  "allowed_model_aliases": ["gpt-4", "claude-3"],
  "allowed_channel_ids": [1, 2],
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
| quota_period | int/null | 否 | null | 周期配额重置周期（秒），null 表示不启用 |
| period_quota_requests / period_quota_tokens | int/null | 否 | null | 周期请求/Token 配额，null 表示不限 |
| allowed_model_aliases | string[] | 否 | [] | 可访问模型白名单 |
| allowed_channel_ids | int[] | 否 | [] | 可命中渠道白名单（按渠道 id），为空表示允许所有渠道；不在白名单内的渠道在路由和模型列表中会被过滤 |
| oidc_claim_expr | string | 否 | null | OIDC Claim 匹配表达式，最长 512 字符 |
| oidc_claim_priority | int | 否 | 0 | 匹配优先级，0-9999，越大越优先 |
| is_default | bool | 否 | false | 设为默认组（新用户自动加入） |

**响应 (201):**
```json
{
  "message": "用户组创建成功。",
  "data": { "id": 1, "name": "vip", ... },
  "warnings": ["以下模型别名不存在，已忽略: xxx"]
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| message | string | 操作结果描述 |
| data | object | 创建后的用户组数据 |
| warnings | string[] | 被忽略的模型别名提示（仅当有不存在于 models 表的别名时出现） |

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

OIDC 身份组在每次登录或绑定账号时都会**重新评估**：若 Claim 当前匹配某个组，则加入该组并刷新同步时间；若 Claim 不再匹配任何组，且用户当前所在的组本身是通过 OIDC Claim 表达式映射的组，则自动过期并回退到默认组（无默认组时置空）。管理员手动分配的、未配置 `oidc_claim_expr` 的组不会被自动覆盖或回退。此外，用户可单独开启「锁定身份组」（`group_locked=1`）：开启后该用户的身份组完全由管理员指定，OIDC 登录同步与过期回收定时任务都会跳过它，即使其 Claim 命中某个映射组或当前位于映射组也不会被修改。

匹配到的身份组附带同步时间，受 `oidc_group_expire_days` 控制的有效期约束。网关后台定时任务会扫描超过有效期且期间未重新登录确认的用户，将这类 OIDC 映射组自动回退到默认组，因此即使该用户长期不登录，身份组也会按有效期自动过期，不会永久保留。

对于功能上线前已匹配到 OIDC 映射组、但 `oidc_group_synced_at` 为空的历史用户，网关初始化时会一次性回填为当前时间，使其从上线起享有完整的有效期宽限，之后交由后台定时任务按正常 TTL 接管，避免存量数据永久保留。

> 精简版忽略周期配额字段和 `oidc_claim_expr` / `oidc_claim_priority`；更新用户组时会保留数据库中已有的 OIDC Claim 映射值。

### PUT /api/admin/groups/:id

更新用户组，所有字段可选。

**认证:** 管理员

**响应 (200):**
```json
{
  "message": "用户组更新成功。",
  "data": { "id": 1, "name": "vip", ... },
  "warnings": ["以下模型别名不存在，已忽略: xxx"]
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| message | string | 操作结果描述 |
| data | object | 更新后的用户组数据 |
| warnings | string[] | 被忽略的模型别名提示（仅当有不存在于 models 表的别名时出现） |

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

> 渠道 `api_key` 默认对所有管理员可见。当渠道开启 `api_key_private`（仅添加人可见）后，`api_key` 仅对添加人（`created_by` 对应的管理员）可见：非添加人调用时 `api_key` 返回 `null` 且 `can_view_api_key: false`，添加人调用时返回真实值且 `can_view_api_key: true`。响应还包含 `can_manage_api_key_privacy`，表示当前管理员是否有权切换该渠道的「仅添加人可见」开关（无添加人渠道任意管理员可切换，有添加人渠道仅添加人可切换）。

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
      "user_agent": "OpenAI/JS 6.39.0",
      "enabled": 1,
      "weight": 1,
      "max_concurrency": 64,
      "timeout": 60,
      "created_by_username": "admin",
      "models": [
        {
          "id": 1,
          "alias": "gpt-4",
          "real_model": "gpt-4-turbo",
          "channel_id": 1,
          "upstream_protocol": "chat_completions",
          "supported_protocols": "[\"chat_completions\"]",
          "is_public": 1,
          "enabled": 1,
          "weight": 1,
          "token_multiplier": 1,
          "request_multiplier": 1,
          "max_concurrency": 0,
          "quota_mode": "follow_group"
        }
      ]
    }
  ]
}
```

### POST /api/admin/channels

创建渠道，可附带初始模型列表。

**认证:** 管理员

> 渠道创建后自动记录当前管理员为添加人（`created_by`），列表接口返回 `created_by_username`。

**请求体:**
```json
{
  "name": "openai-main",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx",
  "supported_protocols": ["chat_completions"],
  "user_agent": "OpenAI/JS 6.39.0",
  "weight": 1,
  "max_concurrency": 64,
  "timeout": 60,
  "quota_tokens": 1000000,
  "quota_requests": null,
  "quota_period": 86400,
  "period_quota_tokens": 500000,
  "period_quota_requests": null,
  "force_include_usage": true,
  "models": [
    {
      "alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "upstream_protocol": "chat_completions",
      "supported_protocols": ["chat_completions"],
      "copilot_compatibility": false,
      "is_public": true,
      "enabled": true,
      "weight": 1,
      "token_multiplier": 1,
      "request_multiplier": 1,
      "max_concurrency": 0,
      "quota_mode": "follow_group"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| name | string | 是 | | 渠道名称 |
| base_url | string | 是 | | 上游 API 地址 |
| api_key | string | 否 | | 上游 API Key |
| api_key_private | boolean | 否 | false | 是否「仅添加人可见」，开启后 `api_key` 仅添加人可见与修改 |
| supported_protocols | string[] | 否 | ["chat_completions"] | 支持的协议：`chat_completions` / `anthropic_messages` / `responses` / `embeddings` / `images`。各协议对应的网关端点：`chat_completions` → `/api/v1/chat/completions`，`anthropic_messages` → `/api/v1/messages`，`responses` → `/api/v1/responses`，`embeddings` → `/api/v1/embeddings`，`images` → `/api/v1/images/generations` + `/api/v1/images/edits` |
| user_agent | string | 否 | "" | 渠道级上游 User-Agent，留空时透传客户端 UA 或使用协议默认值 |
| proxy_url | string | 否 | "" | 渠道级上游 HTTP(S) 代理地址，留空表示直连；支持 `http://` / `https://`，可在 URL 中携带代理认证信息 |
| ua_restrictions | string | 否 | "" | 渠道级 User-Agent 限制规则 JSON 数组，留空表示不限制（完整版功能，最长 20000 字符） |
| expires_at | string\|null | 否 | null | 过期时间（本地 datetime，如 `2026-08-01T00:00`），null 或留空表示永不过期；到达该时间后渠道在路由中自动不可用，管理员对任意渠道执行操作后，已过期渠道会被彻底禁用并级联禁用其模型 |
| time_restrictions | string | 否 | "" | 限制时段 JSON 数组，每个元素含 `days`（1-7，周一至周日）、`start`、`end`（HH:MM）；配置后渠道仅在该时段内可用（服务器本地时区），留空表示不限制；`start` 不可等于 `end`，`end` 早于 `start` 表示跨午夜 |
| weight | int | 否 | 1 | 路由权重 |
| max_concurrency | int | 否 | 64 | 最大并发数 |
| timeout | int | 否 | 60 | 超时时间（秒） |
| quota_tokens | int\|null | 否 | null | 渠道总 Token 配额，null 表示不限制 |
| quota_requests | int\|null | 否 | null | 渠道总请求配额，null 表示不限制 |
| quota_period | int\|null | 否 | null | 周期配额重置间隔（秒），null 表示不启用周期配额（仅完整版） |
| period_quota_tokens | int\|null | 否 | null | 每周期 Token 配额上限（仅完整版） |
| period_quota_requests | int\|null | 否 | null | 每周期请求配额上限（仅完整版） |
| force_include_usage | bool | 否 | true | 流式请求时向上游发送 `stream_options.include_usage`，设为 false 可兼容不支持该参数的上游（如微软） |
| models | array | 否 | [] | 初始模型列表 |

`models` 初始模型字段：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| alias | string | 是 | | 客户端调用时的模型名 |
| real_model | string | 是 | | 上游真实模型名 |
| upstream_protocol | enum | 否 | 渠道第一个协议 | `chat_completions` / `anthropic_messages` / `responses` / `embeddings` |
| supported_protocols | string[] | 否 | 渠道全部协议 | 模型可用协议，须为渠道 `supported_protocols` 的子集。入站协议在可用协议中时直接透传，否则使用 `upstream_protocol` |
| copilot_compatibility | bool | 否 | false | 启用 GitHub Copilot 兼容模式，规范化 tool_calls 返回并过滤未声明的工具调用 |
| is_public | bool | 否 | true | false 时仅白名单用户可访问 |
| enabled | bool | 否 | true | 是否启用 |
| weight | int | 否 | 1 | 路由权重 |
| token_multiplier | number | 否 | 1 | Token 用量倍率（0~100） |
| request_multiplier | number | 否 | 1 | 请求次数倍率（0~100） |
| max_concurrency | int | 否 | 0 | 模型级最大并发数，0 表示不限制 |
| quota_mode | enum | 否 | "follow_group" | 配额模式：`follow_group`（跟随用户组）/ `bypass_group`（绕过用户组）/ `independent`（独立配额） |

### PUT /api/admin/channels/:id

更新渠道，所有字段可选。

**认证:** 管理员

> `api_key_private` 控制渠道「仅添加人可见」：由添加人或无添加人渠道的任意管理员切换；无添加人渠道被首次开启时，操作者自动成为添加人（`created_by`）。开启后仅添加人可查看与修改 `api_key`，非添加人提交的 `api_key` 会被忽略并保留原值；非添加人提交的 `api_key_private` 变更也会被忽略。响应中 `api_key` 遵循「仅添加人可见」规则，并附带 `can_view_api_key`、`can_manage_api_key_privacy`。


**请求体:** 与 POST 相同，所有字段均为可选。`force_include_usage` 变更对后续新请求立即生效，不影响已建立的连接。`proxy_url` 传空字符串可清空代理配置。

**模型同步:**

- 禁用渠道（`enabled` 由任意状态变为 `false`）时，该渠道下所有未删除模型同步置为禁用。
- 启用渠道（`enabled` 由 `false` 变为 `true`）时，该渠道下协议在 `supported_protocols` 范围内的未删除模型同步置为启用；协议不被支持的模型保持禁用。
- 渠道已处于启用状态时再次更新其他字段，不会改动模型的启用状态。
- 启用渠道时若已存在使用未被支持协议的启用模型，返回 400「该渠道下存在使用未被保留协议的启用模型」。
- 管理员对任意渠道执行创建、更新或删除操作后，系统会扫描并彻底禁用所有已到过期时间（`expires_at`）的启用渠道，并级联禁用其模型。

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
  "api_key": "sk-xxx",
  "user_agent": "OpenAI/JS 6.39.0"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| base_url | string | 是 | | 上游 API 地址 |
| api_key | string | 是 | | 上游 API Key |
| user_agent | string | 否 | "" | 探测模型列表时使用的 User-Agent |
| proxy_url | string | 否 | "" | 探测模型列表时使用的 HTTP(S) 代理地址，留空表示直连 |

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
  "supported_protocols": ["chat_completions"],
  "is_public": true,
  "enabled": true,
  "weight": 1,
  "token_multiplier": 1.5,
  "request_multiplier": 1,
  "quota_mode": "independent",
  "quota_tokens": 1000000,
  "quota_requests": null,
  "quota_period": 86400,
  "period_quota_tokens": 500000,
  "period_quota_requests": null,
  "supports_vision": false
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|:---|
| alias | string | 是 | | 客户端调用时的模型名 |
| real_model | string | 是 | | 上游真实模型名 |
| channel_id | int | 是 | | 所属渠道 ID |
| upstream_protocol | enum | 否 | chat_completions | `chat_completions` / `anthropic_messages` / `responses` / `embeddings` / `images`。各协议对应的上游路径：`chat_completions` → `/chat/completions`，`anthropic_messages` → `/messages`，`responses` → `/responses`，`embeddings` → `/embeddings`，`images` → `/images/generations`（`/images/edits` 由 multipart 网关单独处理） |
| supported_protocols | string[] | 否 | 渠道全部协议 | 模型可用协议，须为渠道 `supported_protocols` 的子集。入站协议在可用协议中时直接透传，否则使用 `upstream_protocol` |
| copilot_compatibility | bool | 否 | false | GitHub Copilot 兼容模式；开启后会映射 OpenAI 风格 thinking 参数与 vLLM/Qwen thinking 参数，规范化工具调用，并将文本形式的 `<tool_call>` 转换为结构化工具调用 |
| supports_vision | bool | 否 | false | 标记该模型支持图片（多模态）输入；开启「图片自动路由到识图模型」后，网关会优先将含图片的请求路由到标记此项的模型 |
| is_public | bool | 否 | true | false 时仅白名单用户可访问 |
| weight | int | 否 | 1 | 路由权重（越大流量越多） |
| max_concurrency | int | 否 | 0 | 模型级最大并发数，0 时继承渠道配置；实际生效值为 min(模型并发, 渠道并发) |
| token_multiplier | float | 否 | 1 | Token 计费倍率：实际扣量 = 使用量 x 倍率 |
| request_multiplier | float | 否 | 1 | 请求计费倍率：实际扣量 = 请求次数 x 倍率 |
| quota_mode | enum | 否 | follow_group | `follow_group`：跟随用户组限制；`bypass_group`：跳过用户组配额和速率限制；`independent`：跳过用户组限制，使用模型自身配额 |
| ua_restrictions | string | 否 | "" | 模型级 User-Agent 限制规则 JSON 数组，留空表示不限制（完整版功能，最长 20000 字符） |
| quota_tokens | int\|null | 否 | null | 模型总 Token 配额（仅 `independent` 模式生效），null 表示不限制 |
| quota_requests | int\|null | 否 | null | 模型总请求配额（仅 `independent` 模式生效），null 表示不限制 |
| quota_period | int\|null | 否 | null | 周期配额重置间隔（秒），null 表示不启用（仅完整版） |
| period_quota_tokens | int\|null | 否 | null | 每周期 Token 配额上限（仅完整版） |
| period_quota_requests | int\|null | 否 | null | 每周期请求配额上限（仅完整版） |

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
      "key": "sk-gw-abc0...xyz9",
      "name": "my-key",
      "used_tokens": 1234,
      "used_requests": 56,
      "enabled": 1,
      "created_at": "2026-05-08 00:00:00",
      "last_used_at": "2026-05-10 12:34:56"
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

获取当前用户的配额和速率限制信息（已解析用户级与用户组级继承后的生效值）。

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
  "period": {
    "period_seconds": 86400,
    "period_label": "每日",
    "quota_requests": 1000,
    "quota_tokens": 5000000,
    "used_requests": 50,
    "used_tokens": 123456,
    "remaining_requests": 950,
    "remaining_tokens": 4876544,
    "reset_at": "2026-06-01T00:00:00.000Z"
  },
  "rate": {
    "rpm": 200,
    "qps": 50,
    "tpm": 1000000
  }
}
```

> `null` 表示不限制。速率限制 `-1` 表示不限制。`period` 在未配置周期配额时为 `null`。
>
> 精简版 `period` 始终为 `null`。

### GET /api/user/model-quotas

获取当前用户有权访问的所有模型列表，包含配额信息和计费倍率。先前仅返回 `independent` 和 `bypass_group` 的模型，现已扩展为返回所有权限内模型。

**认证:** 用户

**响应 (200):**
```json
{
  "data": [
    {
      "alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "quota_mode": "independent",
      "token_multiplier": 1.5,
      "request_multiplier": 1,
      "quota_requests": 1000,
      "quota_tokens": 500000,
      "used_requests": 150,
      "used_tokens": 75000,
      "remaining_requests": 850,
      "remaining_tokens": 425000,
      "quota_period": 3600,
      "period_label": "每小时",
      "period_quota_requests": 100,
      "period_quota_tokens": 50000,
      "period_used_requests": 30,
      "period_used_tokens": 12000,
      "period_remaining_requests": 70,
      "period_remaining_tokens": 38000,
      "period_reset_at": "2026-06-01T00:00:00.000Z"
    },
    {
      "alias": "claude-3",
      "real_model": "claude-3-opus",
      "quota_mode": "bypass_group",
      "token_multiplier": 1,
      "request_multiplier": 1,
      "quota_requests": null,
      "quota_tokens": null,
      "used_requests": null,
      "used_tokens": null,
      "remaining_requests": null,
      "remaining_tokens": null,
      "quota_period": null,
      "period_label": null,
      "period_quota_requests": null,
      "period_quota_tokens": null,
      "period_used_requests": null,
      "period_used_tokens": null,
      "period_remaining_requests": null,
      "period_remaining_tokens": null,
      "period_reset_at": null
    },
    {
      "alias": "gpt-3",
      "real_model": "gpt-3.5-turbo",
      "quota_mode": "follow_group",
      "token_multiplier": 1,
      "request_multiplier": 1,
      "quota_requests": null,
      "quota_tokens": null,
      "used_requests": null,
      "used_tokens": null,
      "remaining_requests": null,
      "remaining_tokens": null,
      "quota_period": null,
      "period_label": null,
      "period_quota_requests": null,
      "period_quota_tokens": null,
      "period_used_requests": null,
      "period_used_tokens": null,
      "period_remaining_requests": null,
      "period_remaining_tokens": null,
      "period_reset_at": null
    }
  ]
}
```

> 返回当前用户有权访问的所有模型。`follow_group` 模型的配额字段均为 `null`（受用户组配额约束）；`bypass_group` 模型的配额字段均为 `null`（不受配额限制）；`independent` 模型使用自身的配额额度。`token_multiplier` 和 `request_multiplier` 表示实际扣量倍率。
>
> 精简版 `quota_period`、`period_label`、`period_quota_*`、`period_used_*`、`period_remaining_*`、`period_reset_at` 字段均为 `null`。

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
| key | string | 按密钥搜索：完整 key 精确匹配；`sk-gw-abcd...wxyz` / `abcdwxyz` 按前 4 + 后 4 指纹匹配；4 位 hex 匹配前缀或后缀；其他内容按密钥备注模糊匹配 |
| ip | string | 按客户端 IP 搜索 |
| start_date | YYYY-MM-DD | 开始日期 |
| end_date | YYYY-MM-DD | 结束日期 |
| status | success / failed / rate_limited | 按请求状态筛选：success 仅成功请求，failed 仅失败请求（不含 429），rate_limited 仅限流请求 |

**响应 (200):**
```json
{
  "summary": {
    "total_requests": 100,
    "failed_requests": 5,
    "rate_limited_requests": 2,
    "total_tokens": 123456,
    "cache_read_tokens": 5000,
    "avg_latency_ms": 500,
    "avg_first_token_latency_ms": 200,
    "avg_output_tps": 50.5
  },
  "data": [
    {
      "id": 1,
      "username": "admin",
      "channel_name": "openai-main",
      "key_id": 7,
      "key_name": "生产环境",
      "key_masked": "sk-gw-abcd...wxyz",
      "model_alias": "gpt-4",
      "real_model": "gpt-4-turbo",
      "stream": 1,
      "status_code": 200,
      "prompt_tokens": 100,
      "completion_tokens": 50,
      "total_tokens": 150,
      "token_source": "usage",
      "metadata": {
        "token_usage": {
          "remote": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "text_tokens": 38,
            "reasoning_tokens": 12,
            "total_tokens": 150,
            "cache": { "read_tokens": 32, "creation_tokens": 0, "miss_tokens": 68 }
          },
          "local": { "prompt_tokens": 98, "completion_tokens": 37, "reasoning_tokens": 12, "total_tokens": 147 }
        }
      },
      "latency_ms": 1234,
      "first_token_latency_ms": 300,
      "output_tps": 45.5,
      "route_attempts": 1,
      "attempted_channels": "openai-main",
      "error_message": null,
      "client_ip": "1.2.3.4",
      "user_agent": "OpenAI/JS 6.39.0",
      "created_at": "2026-05-08 12:00:00"
    }
  ],
  "paging": { "limit": 50, "offset": 0, "total": 100 }
}
```

> `prompt_tokens`、`completion_tokens`、`total_tokens` 为实际用于扣量和汇总的 Token 用量：优先采用远端 usage，远端缺失时回退本地统计。日志中的 `completion_tokens` 表示可见输出 Token，不包含单独识别出的思考 Token；如果上游没有返回可见文本 Token 明细，但流式内容中包含思考文本，会用本地对可见文本的统计作为响应 Token。`total_tokens` 仍包含思考消耗。`metadata.token_usage.remote` 记录上游返回的 usage 原始 Token 数，其中 `text_tokens` 表示上游明细中明确返回的可见文本 Token，`reasoning_tokens` 表示上游明确返回的思考 Token，`cache` 记录上游返回的缓存命中/读取、缓存创建/写入、缓存未命中 Token。`metadata.token_usage.local` 记录本地分词统计结果。`output_tps` 使用可见输出 Token 与思考 Token 共同计算输出速度。`token_source` 表示本次采用来源：`usage` 为上游响应返回的 usage 字段，`local` 为本地 GPT 分词器兜底统计，`estimated` 为请求失败时的预估值。`user_agent` 记录客户端请求携带的 User-Agent，最长保留 500 字符。普通用户不会看到 `username`、`channel_name`、`route_attempts`、`attempted_channels` 字段。

---

## 仪表盘接口 - 统计概览

### GET /api/dashboard/summary

获取仪表盘统计数据。普通用户首页概览的数据范围由 `overview_global` 控制：开启时为站点级全局全貌，关闭时仅展示当前用户自己的统计；管理员始终看全局。仅密钥数量为当前用户可管理数量。Top 用户是否可见由 `top_users_visible` 控制。

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
    "top_users_visible": 1,
    "overview_global": 1,
    "hourly_tokens": [
      { "hour": "2026-05-08 00:00:00", "tokens": 1234 }
    ],
    "top_models": [
      { "model_name": "gpt-4", "request_count": 500, "total_tokens": 100000 }
    ],
    "top_channels": [
      { "channel_name": "openai-main", "request_count": 500, "total_tokens": 100000 }
    ],
    "top_users": [
      { "user_id": 1, "username": "alice", "request_count": 500, "failed_requests": 3, "total_tokens": 100000, "avg_latency_ms": 420 }
    ]
  }
}
```

| 字段 | 说明 |
|:---|:---|
| total_requests | 总请求数 |
| total_tokens | 总 Token 消耗 |
| failed_requests | 失败请求数（不含 429 限流） |
| rate_limited_requests | 限流请求数 |
| total_keys | 密钥数量（当前用户可管理，普通用户只看自己的密钥） |
| active_users | 活跃用户数（站点级，所有角色一致）。窗口随日志保留天数变化：未设置保留天数时为累计去重用户，设置后仅统计保留窗口内的去重用户 |
| avg_latency_ms | 平均响应延迟。窗口同上：未设置保留天数时为全部请求均值，设置后为保留窗口内均值 |
| avg_output_tps | 平均输出速度（token/s）。窗口同上 |
| success_rate | 成功率（百分比） |
| log_retention_days | 当前日志保留天数（0 表示不删除）。前端据此把“活跃用户 / 平均延迟 / 平均输出速度 / 近 N 天失败请求”的文案窗口动态显示为保留天数或 30 天 |
| top_users_visible | 是否允许普通用户查看 Top 用户排行（1 允许 / 0 不允许）；管理员始终可见。普通用户且此项为 0 时，`top_users` 返回空数组 |
| overview_global | 控制普通用户概览范围（1 全局 / 0 仅自己）；管理员始终为全局。普通用户且此项为 0 时，概览统计按当前用户隔离 |
| hourly_tokens | 最近 24 小时 Token 趋势 |
| top_models | Top 5 模型（按 Token 消耗） |
| top_channels | Top 5 渠道（按 Token 消耗） |
| top_users | Top 5 用户（按 Token 消耗，含 user_id / username / request_count / failed_requests / total_tokens / avg_latency_ms） |

---

## 仪表盘接口 - 用户资料

### GET /api/dashboard/profile

获取当前用户资料（含生效的限制配置）。

**认证:** 用户

### PUT /api/dashboard/profile/password

修改密码（等同于 `/api/auth/change-password`）。仅在密码登录开启时可用；仅 OIDC 登录时返回 400。

**认证:** 用户

---

## 仪表盘接口 - 可用模型

### GET /api/dashboard/available-models

获取当前用户可访问的模型列表；若所属用户组设置了渠道白名单，只返回该用户实际可命中渠道上的模型。

**认证:** 用户

**响应 (200):**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4",
      "object": "model",
      "token_multiplier": 1,
      "request_multiplier": 1,
      "token_multiplier_min": 1,
      "token_multiplier_max": 2,
      "request_multiplier_min": 1,
      "request_multiplier_max": 1,
      "max_effective_weight": 4,
      "channels": [
        { "channel_id": 1, "channel_name": "openai-official", "token_multiplier": 2, "request_multiplier": 1, "effective_weight": 4 },
        { "channel_id": 2, "channel_name": "openai-mirror", "token_multiplier": 1, "request_multiplier": 1, "effective_weight": 2 }
      ]
    },
    { "id": "claude-3", "object": "model", "token_multiplier": 1.5, "request_multiplier": 1, "token_multiplier_min": 1.5, "token_multiplier_max": 1.5, "request_multiplier_min": 1, "request_multiplier_max": 1, "max_effective_weight": 1, "channels": [{ "channel_id": 3, "channel_name": "anthropic-main", "token_multiplier": 1.5, "request_multiplier": 1, "effective_weight": 1 }] }
  ]
}
```

> `token_multiplier` 和 `request_multiplier` 为计费倍率（取所有渠道中的最低值），实际扣量 = 使用量 × 倍率。`token_multiplier_min/max` 和 `request_multiplier_min/max` 为各渠道倍率范围。`max_effective_weight` 为该模型所有渠道中的最大有效权重（渠道权重 × 模型权重），列表按此降序排列。`channels` 包含各渠道的倍率和有效权重明细，按权重降序排列。

### GET /api/dashboard/model-metrics

获取各模型近期的平均延迟、平均输出速度与多档成功率状态灯数据。三档成功率的统计时长由系统设置「模型成功率状态灯」分别配置（默认 1 小时、2 小时、3 小时），每档统计对应时长内 `status_code < 400` 的请求占比（分母排除 429）。

**认证:** 用户（非管理员仅返回其可访问模型）

**响应 (200):**
```json
{
  "data": {
    "gpt-4": {
      "avg_latency_ms": 820,
      "avg_output_tps": 64.2,
      "hourly": [
        { "hours": 3, "success_rate": 97.4, "request_count": 360 },
        { "hours": 2, "success_rate": 98.1, "request_count": 240 },
        { "hours": 1, "success_rate": 99.5, "request_count": 120 }
      ]
    }
  }
}
```

> `hourly` 按 `hours` 降序（从大到小）排列，对应模型列表卡片上从左到右的三盏状态灯（左起第一盏为最长时长）；`request_count` 为该时长内**排除 429 限流/访问拒绝**后的请求数，`success_rate` 为成功率（百分比，= `status_code < 400` 的请求数 / 排除 429 后的请求数），无有效请求时 `request_count` 为 0、状态灯显示「无数据」。

---

## 管理接口 - 公告管理

### GET /api/admin/announcements

获取全部公告列表（按置顶 + 发布时间倒序）。

**认证:** 管理员

> 精简版本接口返回 404。

**响应 (200):**
```json
{
  "message": "公告列表获取成功。",
  "data": [
    {
      "id": 1,
      "title": "系统升级通知",
      "content": "系统将于今晚 22:00 进行升级维护...",
      "pinned": 1,
      "created_at": "2025-06-17 22:00:00"
    }
  ]
}
```

### POST /api/admin/announcements

创建新公告。

**认证:** 管理员

> 精简版本接口返回 404。

**请求体:**
```json
{
  "title": "系统升级通知",
  "content": "系统将于今晚 22:00 进行升级维护...",
  "pinned": true
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| title | string | 公告标题（1-255 字符） |
| content | string | 公告内容，支持 Markdown（1-10000 字符） |
| pinned | boolean | 是否置顶（可选，默认 false） |
| notify_email | boolean | 是否同时邮件通知用户（可选，默认 false）；需先在「邮件通知」中启用并配置发件账号。发送在后台异步进行，接口不等待发送完成，结果通过完成通知邮件反馈给配置的管理员邮箱 |

**响应 (201):**
```json
{
  "message": "公告创建成功。",
  "data": {
    "id": 2,
    "title": "系统升级通知",
    "content": "系统将于今晚 22:00 进行升级维护...",
    "pinned": 1,
    "created_at": "2025-06-17 22:30:00"
  }
}
```

### PUT /api/admin/announcements/{id}

更新指定公告（支持部分更新）。

**认证:** 管理员

> 精简版本接口返回 404。

**请求体:**
```json
{
  "title": "更新后的标题",
  "content": "更新后的内容",
  "pinned": false
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| title | string | 公告标题（1-255 字符，可选） |
| content | string | 公告内容，支持 Markdown（1-10000 字符，可选） |
| pinned | boolean | 是否置顶（可选） |
| notify_email | boolean | 是否同时邮件通知用户（可选，默认 false）；仅当 `title`/`content` 实际更新时发送。发送在后台异步进行，接口不等待发送完成，结果通过完成通知邮件反馈给配置的管理员邮箱 |

**响应 (200):**
```json
{
  "message": "公告更新成功。",
  "data": {
    "id": 2,
    "title": "更新后的标题",
    "content": "更新后的内容",
    "pinned": 0,
    "created_at": "2025-06-17 22:30:00"
  }
}
```

### DELETE /api/admin/announcements/{id}

删除指定公告。

**认证:** 管理员

> 精简版本接口返回 404。

**响应 (200):**
```json
{
  "message": "公告删除成功。"
}
```

---

## 仪表盘接口 - 公告

### GET /api/dashboard/announcement

获取最新一条公告（用于登录后弹窗展示）。

**认证:** 用户

> 精简版本接口返回 404。

**响应 (200):**
```json
{
  "content": "系统将于今晚 22:00 进行升级维护...",
  "id": 2,
  "title": "系统升级通知"
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| content | string | 公告内容（Markdown 格式）；无公告时为空字符串 |
| id | number \| null | 公告 ID；无公告时为 null |
| title | string | 公告标题；无公告时为空字符串 |

### GET /api/dashboard/announcements

获取公告列表（按置顶 + 发布时间倒序，返回最近 N 条，N 由设置 `announcement_display_count` 控制）。

**认证:** 用户

> 精简版本接口返回 404。

**响应 (200):**
```json
{
  "message": "公告列表获取成功。",
  "data": [
    {
      "id": 2,
      "title": "系统升级通知",
      "content": "系统将于今晚 22:00 进行升级维护...",
      "pinned": 1,
      "created_at": "2025-06-17 22:30:00"
    }
  ]
}
```

---

## 仪表盘接口 - 接入指南通知

### GET /api/dashboard/access-guide-notice

获取接入指南页面顶部展示的自定义 Markdown 内容。

**认证:** 用户

> 精简版本接口返回 404。

**响应 (200):**
```json
{
  "content": "## 自动配置工具\n\n[Eric](https://github.com/ericzhang-debug) 提供了一个自动配置工具..."
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| content | string | 接入指南通知内容（Markdown 格式）；管理员在系统设置中配置，未配置时为空字符串 |

---

## 网关接口 - OpenAI 兼容

所有网关端点通过 API Key 认证。

**CORS:** 默认关闭。管理员在系统设置中开启 `cors_enabled` 后，所有 `/api/v1/*` 和 `/api/ollama/*` 端点会返回 `Access-Control-Allow-Origin: *` 并响应 `OPTIONS` 预检请求，允许浏览器从任意来源跨域调用。

**User-Agent 透传:** 渠道配置了 `user_agent` 时，网关请求固定使用该值；未配置时，如果客户端请求包含 `User-Agent`，网关会原样透传给上游渠道；仍未提供时 OpenAI 协议默认使用 `OpenAI/JS 6.39.0`，Anthropic Messages 协议默认使用 Claude Code UA `claude-cli/2.1.148`。可通过环境变量 `CLAUDE_CODE_USER_AGENT` 覆盖默认 Claude Code UA。

**上游代理:** 渠道配置了 `proxy_url` 时，网关访问该渠道的普通调用、流式调用、模型测试和模型列表探测都会通过该 HTTP(S) 代理转发；未配置时直连上游。

**User-Agent 限制（完整版）:** 支持在「全站 / 渠道 / 模型」三级配置 User-Agent 限制规则，用于控制哪些客户端可以访问网关。规则为 JSON 数组，每条规则结构如下：

```json
[
  { "pattern": "Mozilla/*", "mode": "deny", "error_code": 403, "error_message": "该浏览器客户端不被允许访问。" },
  { "pattern": "regex:.*bot.*", "mode": "deny", "error_code": 403, "error_message": "爬虫被拒绝。" },
  { "pattern": "curl/*", "mode": "allow", "error_code": 403, "error_message": "允许 curl 访问。" }
]
```

- `pattern`：匹配模式。支持通配符（`*` 匹配任意字符，不区分大小写），或以 `regex:` 开头表示标准正则表达式（同样不区分大小写）。留空字符串仅匹配未携带 User-Agent 的请求。
- `mode`：`deny` 拒绝 / `allow` 允许。
- `error_code`：拦截时返回 HTTP 状态码，范围 100-599。
- `error_message`：拦截时返回的错误提示。

匹配优先级为「全站 → 渠道 → 模型」：
1. 全站规则优先于渠道与模型；若全站层级命中拒绝，立即拦截。
2. 任何层级配置了规则且命中 `allow`，视为该层级放行。
3. 所有层级均未命中任何规则，则放行请求。

未配置规则（空数组或空字符串）的层级不生效。命中拒绝时返回对应 `error_code` 与 `error_message`，错误响应 `error.param` 为 `user-agent`，并写入访问日志。

渠道/模型级限制在路由选择阶段生效：网关优先选择允许该 User-Agent 的渠道；只有当该模型在用户可访问范围内的所有候选渠道都拒绝该 User-Agent 时，才返回对应的拦截错误。因此某个渠道拒绝并不会直接中断请求，网关会顺延到其它允许该 User-Agent 的可用渠道；全站级命中拒绝仍会立即拦截，不触发顺延。
### POST /api/v1/chat/completions

OpenAI Chat Completions 兼容端点。

**Ollama 路径:** `POST /api/ollama/v1/chat/completions`；路径鉴权版本 `POST /api/ollama/:api_key/v1/chat/completions`。

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

> 模型开启 GitHub Copilot 兼容模式后，网关会默认向上游发送 `chat_template_kwargs.enable_thinking = true` 和 `thinking_token_budget = 1024`，保持思考模式；当请求显式携带 OpenAI 风格 `reasoning_effort` 或 `reasoning.effort` 时，会映射为 vLLM/Qwen 使用的 thinking 参数，且用户已传入的 vLLM 原生参数优先生效。同时会规范化工具调用名称和 ID，并将上游误输出为文本的 `<tool_call>` 转换为结构化工具调用，避免 Copilot 客户端停止工具循环。

> 当系统设置开启「图片自动路由到识图模型」且请求 `messages` 包含图片内容（`image_url` / `input_image`）时，若目标模型未标记「支持识图」，网关会自动改路由到支持识图的模型（优先使用设置中指定的别名，否则从已启用且标记「支持识图」的模型中自动挑选），后续沿用现有失败重试与渠道切换机制。

> 流式 Chat Completions 请求转发到上游时，网关会自动附加 `stream_options.include_usage = true`，用于优先记录上游返回的 Token usage 和缓存 Token；上游不返回 usage 时才使用本地分词统计。

> 当 Chat Completions 请求被路由到 Responses 或 Anthropic Messages 上游时，网关会将 `developer` 消息按系统指令语义转换，避免上游协议不支持 `developer` role 导致请求失败。

> 当 Chat Completions 请求被路由到 Responses 上游时，assistant 消息中的 `reasoning` / `reasoning_content` 会转换为 Responses reasoning item，不会作为 `thinking` 内容块写入 `message.content`。

> 当 Chat Completions 请求被路由到 Responses 或 Anthropic Messages 上游时，`max_completion_tokens` 会映射到目标协议的输出上限字段；`n`、`logprobs`、`top_logprobs`、`presence_penalty`、`frequency_penalty`、`logit_bias`、`seed` 等 Chat 专属字段不会透传到不兼容上游。

**额外响应头:**
```
X-Quota-Limit-Requests-Remaining: 9877
X-Quota-Limit-Tokens-Remaining: 49543211
X-Period-Quota-Requests-Remaining: 988
X-Period-Quota-Tokens-Remaining: 496800
X-Period-Quota-Reset: 2026-05-08T00:00:00.000Z
X-Channel-Quota-Requests-Remaining: 5000
X-Channel-Quota-Tokens-Remaining: 2000000
X-Channel-Period-Quota-Requests-Remaining: 450
X-Channel-Period-Quota-Tokens-Remaining: 1800000
X-Channel-Period-Quota-Reset: 2026-05-08T00:00:00.000Z
```

> `X-Quota-*` 和 `X-Period-Quota-*` 为用户级配额；`X-Channel-Quota-*` 和 `X-Channel-Period-Quota-*` 为渠道级配额；`X-Model-Quota-*` 和 `X-Model-Period-Quota-*` 为模型级配额（仅 `quota_mode = independent` 时返回）。配额头仅在配置了对应配额时返回；精简版不会返回 `X-Period-*`、`X-Channel-Period-*` 和 `X-Model-Period-*` 响应头。

---

### POST /api/ollama/api/chat

Ollama Chat 兼容接口，仅支持对话端点。请求会复用 ModelGate 的 API Key 鉴权、模型别名路由、配额、限流、日志和上游协议转换能力。

**路径鉴权:** `POST /api/ollama/:api_key/api/chat`，用于只支持配置 Ollama 服务根地址的客户端。

**认证:** API Key。标准路径支持请求头或 query 参数；路径鉴权版本从 `:api_key` 读取 API Key。

**请求体字段:**

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| model | string | 是 | ModelGate 中配置的模型别名 |
| messages | array | 是 | Ollama 兼容消息数组；历史 assistant 消息中的 `thinking` 会转换为上游协议的推理内容 |
| stream | boolean | 否 | 是否流式返回；未传时按 Ollama 协议默认流式返回 |
| format | string/object | 否 | `json` 或 JSON Schema，会转换为 OpenAI 兼容 `response_format` |
| options | object | 否 | 支持 `temperature`、`top_p`、`seed`、`stop`、`num_predict` 等常用选项 |
| tools | array | 否 | 工具定义，透传为 OpenAI Chat Completions 兼容工具格式 |

**非流式响应示例:**

```json
{
  "model": "gpt-4o-mini",
  "created_at": "2026-05-27T12:00:00.000Z",
  "message": {
    "role": "assistant",
    "content": "你好，有什么可以帮你？",
    "thinking": "可选的推理内容"
  },
  "done": true,
  "done_reason": "stop"
}
```

**流式响应:** NDJSON，每行一个 JSON 对象：

```json
{"model":"gpt-4o-mini","created_at":"2026-05-27T12:00:00.000Z","message":{"role":"assistant","content":"你好"},"done":false}
{"model":"gpt-4o-mini","created_at":"2026-05-27T12:00:01.000Z","done":true,"done_reason":"stop"}
```

---

### GET /api/ollama/api/version

Ollama 版本探测兼容接口，用于 Ollama 客户端连接检测。

**路径鉴权:** `GET /api/ollama/:api_key/api/version`。

**认证:** API Key。标准路径支持请求头或 query 参数；路径鉴权版本从 `:api_key` 读取 API Key。

**请求体:** 无

**响应示例:**

```json
{
  "version": "0.6.4"
}
```

---

### GET /api/ollama/api/tags

Ollama 模型列表兼容接口，返回当前 API Key 可访问的模型别名。

**路径鉴权:** `GET /api/ollama/:api_key/api/tags`。

**认证:** API Key。标准路径支持请求头或 query 参数；路径鉴权版本从 `:api_key` 读取 API Key。

**请求体:** 无

**响应示例:**

```json
{
  "models": [
    {
      "name": "gpt-4o-mini",
      "model": "gpt-4o-mini",
      "modified_at": "2026-05-27T12:00:00.000Z",
      "size": 0,
      "digest": "sha256:...",
      "details": {
        "parent_model": "",
        "format": "modelgate",
        "family": "gpt-4o-mini",
        "families": ["gpt-4o-mini"],
        "parameter_size": "",
        "quantization_level": ""
      }
    }
  ]
}
```

---

### POST /api/ollama/api/show

Ollama 模型详情兼容接口，返回当前 API Key 可访问模型的基础元信息。

**路径鉴权:** `POST /api/ollama/:api_key/api/show`。

**认证:** API Key。标准路径支持请求头或 query 参数；路径鉴权版本从 `:api_key` 读取 API Key。

**请求体字段:**

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| model | string | 是 | ModelGate 中配置的模型别名 |

**响应示例:**

```json
{
  "license": "",
  "modelfile": "FROM gpt-4o-mini",
  "parameters": "num_ctx 131072\nnum_predict 8192",
  "template": "",
  "details": {
    "parent_model": "",
    "format": "modelgate",
    "family": "gpt-4o-mini",
    "families": ["gpt-4o-mini"],
    "parameter_size": "",
    "quantization_level": ""
  },
  "model_info": {
    "general.architecture": "modelgate",
    "general.file_type": 0,
    "general.parameter_count": 0,
    "general.quantization_version": 0,
    "general.context_length": 131072,
    "general.max_output_tokens": 8192,
    "modelgate.context_length": 131072,
    "modelgate.max_output_tokens": 8192,
    "gpt-4o-mini.context_length": 131072
  },
  "capabilities": ["completion", "tools"],
  "modified_at": "2026-05-27T12:00:00.000Z"
}
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

**上游为 Anthropic 协议（透传）时:**

- 同时发送 `x-api-key` 与 `Authorization: Bearer <api_key>`，兼容原生 Anthropic（认 `x-api-key`）及第三方 Claude 兼容代理（部分仅认 `Authorization`）
- 客户端的 `anthropic-version` 头透传给上游，未提供时默认 `2023-06-01`
- 客户端的 `anthropic-beta` 头透传给上游（prompt caching、扩展思考等特性所需）
- 当实际命中的上游协议为 `responses` 时，流式转换会从 `response.completed` 的最终快照补齐未通过 delta 发出的文本与工具调用，避免 Claude Code 等 Anthropic 客户端收到空回复。

---

### POST /api/v1/responses

OpenAI Responses API 兼容端点。

**认证:** API Key

**路由与工具兼容性:**

- 该端点会按模型配置路由到 `responses`、`chat_completions` 或其他可兼容的上游协议。
- 当实际命中的上游协议为原生 `responses` 时，保留 Responses 原生工具能力。
- 当实际命中的上游协议为 `chat_completions` 时，网关会尽量兼容：仅转发可映射为 OpenAI function calling 的 `function tools`，忽略 `namespace`、`custom` 等无法映射的 Responses 原生 tools。
- 若 `tool_choice` 在过滤后已不再有效，网关会自动降级为 chat 上游可接受的形式（如 `auto` 或省略）。
- 当 Responses 请求被路由到 `chat_completions` 上游时，网关会将 `developer` 消息角色转换为 `system`，避免 Codex 等客户端的开发者消息被 Chat 上游拒绝。
- 当 Responses 请求中的思考内容被路由到 `chat_completions` 上游时，网关不会将 `thinking` 作为 `messages[].content` 内容块发送；assistant 思考内容会映射到 Chat 兼容的 `reasoning` 与 `reasoning_content` 字段，并与相邻的 assistant 文本或工具调用历史合并，满足 thinking 模式上游对历史思考内容回传的要求。连续工具调用会合并到同一条 assistant `tool_calls`，对应 tool 结果会紧跟其后，避免生成 Chat 上游拒绝的未闭合工具调用历史。

**流式响应说明:**

- 流式 Responses 响应在上游正常 EOF 但缺少最终 `response.completed` 时，会由网关补齐标准完成事件，避免客户端因缺少 `response.completed` 而报流提前结束。
- 流式 Responses 响应在上游只在 `response.completed` 最终快照中提供文本或工具调用时，网关会补发对应增量事件，确保跨协议转换和 Responses 客户端都能收到完整输出。
- 流式 Responses 响应在上游只通过 `response.output_item.done`、`response.content_part.done`、`response.output_text.done` 或 reasoning done 事件提供最终文本/思考内容时，网关也会补发对应增量，并纳入本地 Token 统计。

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

### POST /api/v1/images/generations

OpenAI Images 兼容端点，直通上游 `/images/generations`，不参与 Chat Completions / Responses / Claude Messages 协议转换。

**认证:** API Key

**请求体:** 标准 OpenAI Images 格式：
```json
{
  "model": "dall-e-3",
  "prompt": "a white siamese cat",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

**响应:** 标准 OpenAI Images 响应：
```json
{
  "created": 1234567890,
  "data": [
    {
      "url": "https://..."
    }
  ]
}
```

---

### POST /api/v1/images/edits

OpenAI Images Edits 兼容端点，直通上游 `/images/edits`，支持 multipart/form-data 上传图片进行编辑。

**认证:** API Key

**请求体:** `multipart/form-data` 格式：

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| model | string | 是 | 模型别名 |
| image | file | 是 | 参考图片文件 |
| prompt | string | 是 | 编辑指令 |
| mask | file | 否 | 遮罩图片 |
| n | int | 否 | 生成数量 |
| size | string | 否 | 图片尺寸 |
| response_format | string | 否 | `url` 或 `b64_json` |

**响应:** 标准 OpenAI Images 响应。

---

### GET /api/v1/models

获取当前 API Key 可用的模型列表；若所属用户组设置了渠道白名单，只返回该用户实际可命中渠道上的模型。

**Ollama 路径:** `GET /api/ollama/v1/models`；路径鉴权版本 `GET /api/ollama/:api_key/v1/models`。

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
| 504 | 上游请求超时 |

---

## JSONL 请求日志

支持将请求日志以 JSONL 格式写入文件，用于审计和分析。

**环境变量:**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `JSONL_LOG_ENABLED` | 未设置（禁用） | 设为 `1` 启用 JSONL 日志 |
| `JSONL_LOG_PATH` | `<data_dir>/request-logs.jsonl` | JSONL 文件路径 |

启用后每个请求完成时异步写入一行 JSON 记录，采用批量异步写入避免阻塞请求处理。

**JSONL 行格式:**
```json
{"timestamp":"2026-05-08T12:00:00.000Z","user_id":1,"key_id":7,"channel_id":2,"model_alias":"gpt-4","real_model":"gpt-4-turbo","stream":1,"status_code":200,"estimated_tokens":200,"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"token_source":"usage","metadata":{"token_usage":{"remote":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"cache":{"read_tokens":32,"creation_tokens":0,"miss_tokens":68}}}},"latency_ms":1234,"first_token_latency_ms":300,"output_tps":45.5,"route_attempts":1,"attempted_channels":"openai-main","error_message":null,"client_ip":"1.2.3.4","user_agent":"OpenAI/JS 6.39.0"}
```

> 异步批量写入：队列容量 1024，每批 64 条或 100ms 间隔刷新落盘。队列满时请求会等待入队（不丢日志）。

## 速率限制与配额

- **RPM / QPS / TPM:** 用户级速率限制，`-1` 表示不限制
- **quota_tokens / quota_requests:** 总量配额，`null` 表示不限制
- **渠道配额:** 渠道可独立配置总量配额和周期配额，与用户/组配额同时生效，任一耗尽返回 429
- **模型配额模式:** 模型的 `quota_mode` 控制配额检查和用量计入行为
  - `follow_group`（默认）：受用户组配额和速率限制约束，用量计入用户配额
  - `bypass_group`：跳过用户组配额检查和速率限制检查，用量不计入用户配额
  - `independent`：跳过用户组限制，改为检查模型自身的配额配置，用量不计入用户配额
- **模型倍率:** `token_multiplier` 和 `request_multiplier` 控制计费扣量
  - 实际扣除 Token = 使用量 x token_multiplier
  - 实际扣除请求次数 = 请求次数 x request_multiplier
  - 支持小数累积（如 0.1 倍率，10 次请求累积扣 1 次）
- **模型级并发:** 每个模型维护独立的并发信号量。模型的 `max_concurrency` 为 0 时使用渠道并发限制，大于 0 时实际生效值为 `min(模型并发, 渠道并发)`
- 用户限制未设置时（`-1` 或 `null`）自动继承所属用户组的配置

## 上游重试与熔断

- **自动重试:** 上游返回 401/429/5xx 时自动切换到其他渠道，最大重试次数可配置
- **熔断机制:** 连续失败 3 次后暂停该渠道 15 秒，可通过设置开关关闭
