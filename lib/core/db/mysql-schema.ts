export const MYSQL_BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  supported_protocols TEXT DEFAULT NULL,
  enabled TINYINT(1) DEFAULT 1,
  weight INT DEFAULT 1,
  max_concurrency INT DEFAULT 64,
  timeout INT DEFAULT 60,
  user_agent TEXT,
  proxy_url TEXT,
  quota_tokens BIGINT,
  quota_requests BIGINT,
  quota_period INT,
  period_quota_tokens BIGINT,
  period_quota_requests BIGINT,
  period_used_tokens BIGINT DEFAULT 0,
  period_used_requests BIGINT DEFAULT 0,
  period_reset_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  force_include_usage TINYINT(1) DEFAULT 1
);

CREATE TABLE IF NOT EXISTS models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  alias VARCHAR(255) NOT NULL,
  real_model VARCHAR(255) NOT NULL,
  channel_id INT NOT NULL,
  upstream_protocol VARCHAR(64) DEFAULT 'chat_completions',
  supported_protocols TEXT,
  is_public TINYINT(1) DEFAULT 1,
  enabled TINYINT(1) DEFAULT 1,
  weight INT DEFAULT 1,
  token_multiplier DOUBLE DEFAULT 1,
  request_multiplier DOUBLE DEFAULT 1,
  max_concurrency INT DEFAULT 0,
  copilot_compatibility TINYINT(1) DEFAULT 0,
  quota_mode VARCHAR(32) DEFAULT 'follow_group',
  quota_tokens BIGINT,
  quota_requests BIGINT,
  quota_period INT,
  period_quota_tokens BIGINT,
  period_quota_requests BIGINT,
  period_used_tokens BIGINT DEFAULT 0,
  period_used_requests BIGINT DEFAULT 0,
  period_reset_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS \`groups\` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  qps INT DEFAULT -1,
  rpm INT DEFAULT -1,
  tpm INT DEFAULT -1,
  quota_requests BIGINT,
  quota_tokens BIGINT,
  quota_period INT,
  period_quota_tokens BIGINT,
  period_quota_requests BIGINT,
  allowed_model_aliases TEXT DEFAULT NULL,
  allowed_channel_ids TEXT DEFAULT NULL,
  oidc_claim_value TEXT,
  oidc_claim_expr TEXT,
  oidc_claim_priority INT DEFAULT 0,
  is_default TINYINT(1) DEFAULT 0,
  enabled TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK(role IN ('admin', 'user')),
  group_id INT,
  oidc_issuer TEXT,
  oidc_subject TEXT,
  email TEXT,
  rpm INT DEFAULT -1,
  qps INT DEFAULT -1,
  tpm INT DEFAULT -1,
  quota_tokens BIGINT,
  quota_requests BIGINT,
  quota_period INT,
  period_quota_tokens BIGINT,
  period_quota_requests BIGINT,
  period_used_tokens BIGINT DEFAULT 0,
  period_used_requests BIGINT DEFAULT 0,
  period_reset_at DATETIME,
  used_tokens DOUBLE DEFAULT 0,
  used_requests DOUBLE DEFAULT 0,
  allowed_model_aliases TEXT DEFAULT NULL,
  note TEXT,
  enabled TINYINT(1) DEFAULT 1,
  webhook_role VARCHAR(255) DEFAULT '',
  webhook_tags TEXT DEFAULT NULL,
  totp_secret TEXT,
  totp_enabled TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (group_id) REFERENCES \`groups\`(id)
);

CREATE TABLE IF NOT EXISTS \`keys\` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  \`key\` VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) DEFAULT '',
  user_id INT NOT NULL,
  used_tokens DOUBLE DEFAULT 0,
  used_requests DOUBLE DEFAULT 0,
  enabled TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  key_id INT NOT NULL,
  channel_id INT,
  model_alias VARCHAR(255),
  real_model VARCHAR(255),
  stream TINYINT(1) DEFAULT 0,
  status_code INT,
  estimated_tokens INT,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  token_source VARCHAR(64),
  metadata TEXT,
  latency_ms INT,
  first_token_latency_ms INT,
  output_tps DOUBLE,
  route_attempts INT DEFAULT 1,
  attempted_channels TEXT,
  error_message LONGTEXT,
  client_ip VARCHAR(64),
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  pinned TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const MYSQL_BASE_INDEXES = [
  { name: "idx_models_alias_enabled", table: "models", expr: "(alias, enabled)" },
  { name: "idx_models_channel_id", table: "models", expr: "(channel_id)" },
  { name: "idx_users_username", table: "users", expr: "(username)" },
  { name: "idx_users_role", table: "users", expr: "(role)" },
  { name: "idx_logs_created_at", table: "logs", expr: "(created_at)" },
  { name: "idx_logs_user_id", table: "logs", expr: "(user_id)" },
  { name: "idx_logs_user_created_at", table: "logs", expr: "(user_id, created_at)" },
  { name: "idx_logs_user_id_id", table: "logs", expr: "(user_id, id)" },
  { name: "idx_logs_channel_created_at", table: "logs", expr: "(channel_id, created_at)" },
  { name: "idx_logs_key_id", table: "logs", expr: "(key_id)" },
  { name: "idx_keys_key", table: "`keys`", expr: "(`key`)" },
  { name: "idx_announcements_pinned_created", table: "announcements", expr: "(pinned, created_at)" },
] as const;

export const MYSQL_POST_MIGRATION_INDEXES = [
  { name: "idx_models_alias_enabled_deleted", table: "models", expr: "(alias, enabled, deleted_at, channel_id)" },
  { name: "idx_channels_enabled_deleted", table: "channels", expr: "(enabled, deleted_at)" },
] as const;

export const MYSQL_DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL = `
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
