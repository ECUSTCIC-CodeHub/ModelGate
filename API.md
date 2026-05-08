# ModelGate API Reference

## Overview

ModelGate is an LLM gateway that provides OpenAI-compatible API endpoints with user management, quota control, and multi-channel routing.

**Base URL:** `http://your-domain:3000`

## Authentication

### Web Authentication

Dashboard and management APIs use JWT Bearer tokens or HTTP-only cookies.

```
Authorization: Bearer <access_token>
```

Tokens are obtained via `/api/auth/login` or `/api/auth/register`.

### API Key Authentication

Gateway endpoints (`/api/v1/*`) use API keys:

```
Authorization: Bearer sk-gw-xxxxx
```

or

```
x-api-key: sk-gw-xxxxx
```

---

## Auth

### POST /api/auth/login

Login with username and password.

**Auth:** None

**Request:**
```json
{
  "username": "admin",
  "password": "your-password"
}
```

**Response (200):**
```json
{
  "message": "登录成功。",
  "user": { "id": 1, "username": "admin", "role": "admin" },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

> Rate limited: 5 attempts per IP per minute, returns 429 if exceeded.

---

### POST /api/auth/register

Register a new account. First registered user becomes admin.

**Auth:** None

**Request:**
```json
{
  "username": "newuser",
  "password": "12345678"
}
```

**Response (201):**
```json
{
  "message": "注册成功。",
  "user": { "id": 2, "username": "newuser", "role": "user" },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 900
}
```

| Field | Type | Rule |
|:---|:---|:---|
| username | string | Alphanumeric, 3-32 chars |
| password | string | Min 8 chars |

---

### POST /api/auth/refresh

Refresh access token using refresh token.

**Auth:** None

**Request:**
```json
{
  "refresh_token": "eyJ..."
}
```

Or send via `vlm-refresh-token` cookie (auto).

**Response (200):**
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

Clear auth cookies.

**Auth:** None

**Response (200):**
```json
{ "ok": true, "message": "已登出。" }
```

---

### GET /api/auth/me

Get current authenticated user profile.

**Auth:** User

**Response (200):**
```json
{
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

---

### POST /api/auth/change-password

Change the current user's password.

**Auth:** User

**Request:**
```json
{
  "current_password": "old-password",
  "new_password": "new-password-8chars"
}
```

**Response (200):**
```json
{ "ok": true, "message": "密码修改成功。" }
```

---

## Admin - Settings

### GET /api/admin/settings

Get system settings.

**Auth:** Admin

**Response (200):**
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

Update system settings.

**Auth:** Admin

**Request:**
```json
{
  "registration_enabled": true,
  "password_login_enabled": true,
  "upstream_retry_enabled": true,
  "upstream_retry_max_attempts": 3,
  "upstream_circuit_breaker_enabled": true,
  "public_base_url": "https://your-domain.com",
  "announcement_content": "# Welcome"
}
```

---

## Admin - Users

### GET /api/admin/users

List all users with pagination, search, and sorting.

**Auth:** Admin

**Query Parameters:**

| Param | Type | Default | Description |
|:---|:---|:---|:---|
| limit | 1-100 | 20 | Page size |
| offset | int | 0 | Offset |
| keyword | string | | Search by username |
| group_id | int / "all" | | Filter by group |
| sort_by | string | created_at | `created_at` / `used_requests` / `used_tokens` / `username` |
| sort_dir | string | desc | `asc` / `desc` |

**Response (200):**
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

Create a new user.

**Auth:** Admin

**Request:**
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
  "note": "test user"
}
```

### PUT /api/admin/users/:id

Update a user. All fields optional.

**Auth:** Admin

**Request:**
```json
{
  "role": "admin",
  "enabled": true,
  "rpm": 100,
  "new_password": "new-password",
  "reset_usage": "all"
}
```

| reset_usage | Effect |
|:---|:---|
| `"all"` | Reset total + period usage |
| `"total"` | Reset total usage only |
| `"period"` | Reset period usage only |

### DELETE /api/admin/users/:id

Soft-delete a user. Cannot delete the last enabled admin.

**Auth:** Admin

---

## Admin - Groups

### GET /api/admin/groups

List all user groups.

**Auth:** Admin

**Query Parameters:** `limit` (1-100, default 50), `offset` (default 0)

**Response (200):**
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

Create a user group.

**Auth:** Admin

**Request:**
```json
{
  "name": "vip",
  "description": "VIP users",
  "rpm": 200, "qps": 50, "tpm": 1000000,
  "quota_requests": 10000,
  "quota_tokens": 50000000,
  "allowed_model_aliases": ["gpt-4", "claude-3"],
  "oidc_claim_expr": "role == \"vip\"",
  "oidc_claim_priority": 100,
  "is_default": false
}
```

#### OIDC Claim Expression Syntax

Supports matching OIDC token claims for auto-assignment:

```
# Operators: ==, !=, contains, matches (regex), exists
# Logic: AND, OR, parentheses
# Dot-notation for nested fields

role == "admin"
groups contains "vip"
org.department == "engineering"
tdp_social.tencent_uin exists
(role == "staff" OR role == "admin") AND org.type == "enterprise"
email matches ".*@company\\.com"
```

Higher `oidc_claim_priority` matches first.

### PUT /api/admin/groups/:id

Update a group. All fields optional.

**Auth:** Admin

### DELETE /api/admin/groups/:id

Delete a group. Cannot delete default group or groups with users.

**Auth:** Admin

---

## Admin - Channels

### GET /api/admin/channels

List all upstream channels with their models.

**Auth:** Admin

**Response (200):**
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

Create a channel with optional initial models.

**Auth:** Admin

**Request:**
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

### PUT /api/admin/channels/:id

Update a channel. All fields optional.

**Auth:** Admin

### DELETE /api/admin/channels/:id

Soft-delete a channel and all its models.

**Auth:** Admin

### POST /api/admin/channels/:id/test

Test a channel by sending a probe request through its first model.

**Auth:** Admin

**Response (200):**
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

Probe an upstream endpoint for available models.

**Auth:** Admin

**Request:**
```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx"
}
```

**Response (200):**
```json
{ "data": ["gpt-4-turbo", "gpt-3.5-turbo", "..."] }
```

---

## Admin - Models

### GET /api/admin/models

List all models.

**Auth:** Admin

### POST /api/admin/models

Create a model mapping.

**Auth:** Admin

**Request:**
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

| Field | Type | Default | Description |
|:---|:---|:---|:---|
| alias | string | required | Client-facing model name |
| real_model | string | required | Upstream model name |
| channel_id | int | required | Target channel |
| upstream_protocol | enum | chat_completions | `chat_completions` / `anthropic_messages` / `responses` |
| is_public | bool | true | false = whitelist-only access |
| weight | int | 1 | Routing weight (higher = more traffic) |
| token_multiplier | float | 1 | Billing: actual_tokens = tokens * multiplier |
| request_multiplier | float | 1 | Billing: actual_requests = requests * multiplier |

### PUT /api/admin/models/:id

Update a model. All fields optional.

**Auth:** Admin

### DELETE /api/admin/models/:id

Soft-delete a model.

**Auth:** Admin

### POST /api/admin/models/:id/test

Test a specific model by sending a probe request.

**Auth:** Admin

---

## User - Keys

### GET /api/user/keys

List current user's API keys.

**Auth:** User

**Response (200):**
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

Create a new API key.

**Auth:** User

**Request:**
```json
{
  "name": "production-key"
}
```

| Field | Type | Default | Description |
|:---|:---|:---|:---|
| name | string | "" | Key label, max 64 chars |
| enabled | bool | true | |

### PUT /api/user/keys/:id

Update key name or enabled status.

**Auth:** User

**Request:**
```json
{
  "name": "renamed-key",
  "enabled": false
}
```

### DELETE /api/user/keys/:id

Delete an API key.

**Auth:** User

---

## User - Quota

### GET /api/user/quota

Get current user's quota and rate limit info.

**Auth:** User

**Response (200):**
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

> `null` values mean unlimited. Rate limit `-1` means unlimited.

---

## Dashboard - Logs

### GET /api/dashboard/logs

Query request logs with filters.

**Auth:** User (admins see all users, regular users see own logs only)

**Query Parameters:**

| Param | Type | Description |
|:---|:---|:---|
| limit | 1-200 | Page size (default 50) |
| offset | int | Offset (default 0) |
| user | string | Search by username (admin only) |
| model | string | Search by model alias or real model |
| channel | string | Search by channel name (admin only) |
| ip | string | Search by client IP |
| start_date | YYYY-MM-DD | Start date filter |
| end_date | YYYY-MM-DD | End date filter |

**Response (200):**
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

---

## Dashboard - Summary

### GET /api/dashboard/summary

Get dashboard statistics. Admin sees global stats, users see their own.

**Auth:** User

**Response (200):**
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

---

## Dashboard - Profile

### GET /api/dashboard/profile

Get current user's profile with effective limits.

**Auth:** User

### PUT /api/dashboard/profile/password

Change password (same as `/api/auth/change-password`).

**Auth:** User

---

## Dashboard - Available Models

### GET /api/dashboard/available-models

List models accessible to the current user.

**Auth:** User

**Response (200):**
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

## Gateway - OpenAI Compatible

All gateway endpoints authenticate via API key.

### POST /api/v1/chat/completions

OpenAI Chat Completions compatible endpoint.

**Auth:** API Key

**Request:** Standard OpenAI chat completion format:
```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

**Response:** Standard OpenAI chat completion response. Supports streaming (`stream: true`).

**Extra Response Headers:**
```
X-Quota-Limit-Requests-Remaining: 9877
X-Quota-Limit-Tokens-Remaining: 49543211
```

---

### POST /api/v1/messages

Anthropic Messages compatible endpoint.

**Auth:** API Key

**Request:** Standard Anthropic messages format:
```json
{
  "model": "claude-3",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

---

### POST /api/v1/responses

OpenAI Responses API compatible endpoint.

**Auth:** API Key

---

### GET /api/v1/models

List available models for the authenticated API key.

**Auth:** API Key

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4", "object": "model" }
  ]
}
```

---

## Error Format

All errors follow a consistent format:

```json
{
  "error": {
    "message": "Error description",
    "type": "invalid_request_error",
    "param": "None",
    "code": "400"
  }
}
```

| HTTP Status | Meaning |
|:---|:---|
| 400 | Bad request / validation error |
| 401 | Authentication failed |
| 403 | Forbidden (feature disabled) |
| 404 | Not found |
| 409 | Conflict (duplicate) |
| 429 | Rate limited |
| 502 | Upstream error |

---

## Rate Limits & Quotas

- **RPM / QPS / TPM:** Per-user rate limits, `-1` = unlimited
- **quota_tokens / quota_requests:** Lifetime quotas, `null` = unlimited
- **Model multipliers:** `token_multiplier` and `request_multiplier` scale billed usage
  - Billed tokens = actual tokens x token_multiplier
  - Billed requests = actual requests x request_multiplier
- Limits inherit from user group if not set on user (`-1` or `null`)

## Upstream Retry & Circuit Breaker

- **Retry:** Automatic failover on 401/429/5xx, configurable max attempts
- **Circuit Breaker:** 3 consecutive failures = 15s channel pause, configurable on/off
