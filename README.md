# VLM Control

Multi-tenant LLM Gateway + Web Console based on Next.js + SQLite.

## Stack

- Next.js (App Router + Route Handlers)
- SQLite (`better-sqlite3`)
- JWT auth (access + refresh)
- In-memory token bucket rate limit
- OpenAI-compatible APIs

## Features

- Multi-channel provider config (`channels`)
- Model alias routing (`models`) + weighted random load balancing
- Tenant users (`users`) with admin/user role split
- API Keys (`keys`) for gateway auth
- Chat request logs (`chat_logs`) with model/channel/status/token/latency
- Registration switch (`settings.registration_enabled`)
- Web auth via Bearer JWT (access/refresh)
- User self-service (manage own keys, change own password)
- Admin console (channels/models/users/settings)
- OpenAI-compatible endpoints:
  - `GET /api/v1/models`
  - `POST /api/v1/chat/completions`

## Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Env Vars

Optional, with defaults:

- `JWT_ACCESS_SECRET` (default: `dev-access-secret-change-me`)
- `JWT_REFRESH_SECRET` (default: `dev-refresh-secret-change-me`)
- `JWT_ACCESS_EXPIRES_SECONDS` (default: `900`)
- `JWT_REFRESH_EXPIRES_SECONDS` (default: `604800`)

## Data File

SQLite DB path:

- `data/gateway.db`

Tables are auto-initialized on first run:

- `channels`
- `models`
- `users`
- `keys`
- `settings`
- `chat_logs`

## Auth Model

- `POST /api/auth/register`
  - controlled by `settings.registration_enabled`
  - first ever registered user is auto-promoted to `admin`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `POST /api/auth/logout`

Web pages use JWT Bearer from browser localStorage.
Login/register uses `username + password` (no email/name field).
Username only allows English letters and numbers (`[A-Za-z0-9]`).

## Authorization Rules

- Admin APIs (`/api/admin/*`): admin only
- User APIs (`/api/user/*`): authenticated user, scoped to own resources
- Gateway APIs (`/api/v1/*`): API key auth (`Authorization: Bearer sk-gw-...`)

## OpenAI-Compatible Usage

1. Create a channel in `/admin/channels` (provider base URL + provider API key)
2. Create model alias mapping in `/admin/models`
3. Create user + user API key (or let user create own key)
4. Call gateway:

```bash
curl -sS http://localhost:3000/api/v1/models \
  -H 'Authorization: Bearer sk-gw-xxxx'
```

```bash
curl -sS http://localhost:3000/api/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v3.2",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## Notes

- TPM for non-stream response prefers upstream `usage.total_tokens` when available.
- For stream response (`stream=true`), usage is estimated before forwarding.
- Rate limit is in-memory and single-instance only.
Admin log endpoint:

- `GET /api/admin/logs/chat` (summary + recent chat records)
