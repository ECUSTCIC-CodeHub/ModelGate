export const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  supported_protocols TEXT DEFAULT '["chat_completions"]',
  enabled INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  max_concurrency INTEGER DEFAULT 64,
  timeout INTEGER DEFAULT 60,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL,
  real_model TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  upstream_protocol TEXT DEFAULT 'chat_completions',
  is_public INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  qps INTEGER DEFAULT -1,
  rpm INTEGER DEFAULT -1,
  tpm INTEGER DEFAULT -1,
  quota_requests INTEGER,
  quota_tokens INTEGER,
  allowed_model_aliases TEXT DEFAULT '[]',
  is_default INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL CHECK(length(username) >= 3 AND username NOT GLOB '*[^A-Za-z0-9]*'),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
  group_id INTEGER,
  rpm INTEGER DEFAULT -1,
  qps INTEGER DEFAULT -1,
  tpm INTEGER DEFAULT -1,
  quota_tokens INTEGER,
  quota_requests INTEGER,
  used_tokens INTEGER DEFAULT 0,
  used_requests INTEGER DEFAULT 0,
  allowed_model_aliases TEXT DEFAULT '[]',
  note TEXT,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  used_tokens INTEGER DEFAULT 0,
  used_requests INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  channel_id INTEGER,
  model_alias TEXT,
  real_model TEXT,
  stream INTEGER DEFAULT 0,
  status_code INTEGER,
  estimated_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  first_token_latency_ms INTEGER,
  output_tps REAL,
  route_attempts INTEGER DEFAULT 1,
  attempted_channels TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);
CREATE INDEX IF NOT EXISTS idx_models_alias_enabled ON models(alias, enabled);
CREATE INDEX IF NOT EXISTS idx_models_channel_id ON models(channel_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE TABLE IF NOT EXISTS model_user_usage (
  id INTEGER PRIMARY KEY,
  model_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  used_tokens INTEGER DEFAULT 0,
  used_requests INTEGER DEFAULT 0,
  period_used_tokens INTEGER DEFAULT 0,
  period_used_requests INTEGER DEFAULT 0,
  period_reset_at DATETIME,
  UNIQUE(model_id, user_id),
  FOREIGN KEY (model_id) REFERENCES models(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user_created_at ON logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_user_id_id ON logs(user_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_channel_created_at ON logs(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_key_id ON logs(key_id);
`;

export const POST_MIGRATION_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_models_alias_enabled_deleted ON models(alias, enabled, deleted_at, channel_id);
CREATE INDEX IF NOT EXISTS idx_channels_enabled_deleted ON channels(enabled, deleted_at);
`;

export const DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL = `
  UPDATE models
  SET enabled = 0
  WHERE enabled = 1
    AND deleted_at IS NULL
    AND channel_id IN (
      SELECT id
      FROM channels
      WHERE enabled = 0 OR deleted_at IS NOT NULL
    )
  `;
