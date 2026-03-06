import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "gateway.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  timeout INTEGER DEFAULT 60,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL,
  real_model TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL CHECK(length(username) >= 3 AND username NOT GLOB '*[^A-Za-z0-9]*'),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
  rpm INTEGER DEFAULT 60,
  qps INTEGER DEFAULT 1,
  tpm INTEGER DEFAULT 60000,
  quota_tokens INTEGER,
  quota_requests INTEGER,
  used_tokens INTEGER DEFAULT 0,
  used_requests INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
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
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
const hasNameColumn = userColumns.some((col) => col.name === "name");
const hasQpmColumn = userColumns.some((col) => col.name === "qpm");
const hasQpsColumn = userColumns.some((col) => col.name === "qps");
if (hasNameColumn || hasQpmColumn || !hasQpsColumn) {
  const hasUsername = userColumns.some((col) => col.name === "username");
  if (!hasUsername) {
    throw new Error("users table must contain username column");
  }

  const qpsExpr = hasQpmColumn
    ? "CASE WHEN qpm IS NULL OR qpm < 60 THEN 1 ELSE CAST((qpm + 59) / 60 AS INTEGER) END"
    : "CASE WHEN qps IS NULL OR qps < 1 THEN 1 ELSE qps END";

  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL CHECK(length(username) >= 3 AND username NOT GLOB '*[^A-Za-z0-9]*'),
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      rpm INTEGER DEFAULT 60,
      qps INTEGER DEFAULT 1,
      tpm INTEGER DEFAULT 60000,
      quota_tokens INTEGER,
      quota_requests INTEGER,
      used_tokens INTEGER DEFAULT 0,
      used_requests INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    );

    INSERT INTO users_new (
      id, username, password_hash, role, rpm, qps, tpm,
      quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at, deleted_at
    )
    SELECT
      id,
      CASE
        WHEN username IS NULL OR length(username) < 3 OR username GLOB '*[^A-Za-z0-9]*' THEN 'user' || id
        ELSE username
      END,
      password_hash, role, rpm, ${qpsExpr}, tpm,
      quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at, NULL
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    COMMIT;
    `);
  } catch {
    db.exec("ROLLBACK;");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const ensureColumn = (table: string, column: string, ddl: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true;
  }
  return false;
};

ensureColumn("users", "deleted_at", "deleted_at DATETIME");
ensureColumn("keys", "deleted_at", "deleted_at DATETIME");
const addedKeyUsedTokens = ensureColumn("keys", "used_tokens", "used_tokens INTEGER DEFAULT 0");
const addedKeyUsedRequests = ensureColumn("keys", "used_requests", "used_requests INTEGER DEFAULT 0");
ensureColumn("models", "deleted_at", "deleted_at DATETIME");
ensureColumn("logs", "first_token_latency_ms", "first_token_latency_ms INTEGER");
ensureColumn("logs", "output_tps", "output_tps REAL");
ensureColumn("logs", "route_attempts", "route_attempts INTEGER DEFAULT 1");
ensureColumn("logs", "attempted_channels", "attempted_channels TEXT");

if (addedKeyUsedTokens || addedKeyUsedRequests) {
  db.exec(`
  UPDATE keys
  SET
    used_requests = COALESCE((SELECT COUNT(*) FROM logs WHERE logs.key_id = keys.id), 0),
    used_tokens = COALESCE((SELECT SUM(COALESCE(logs.total_tokens, 0)) FROM logs WHERE logs.key_id = keys.id), 0)
  `);
}

const tableExists = (name: string) => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return Boolean(row);
};

if (tableExists("chat_logs")) {
  db.exec(`
  INSERT OR IGNORE INTO logs (
    id, user_id, key_id, channel_id, model_alias, real_model, stream, status_code,
    estimated_tokens, prompt_tokens, completion_tokens, total_tokens, latency_ms,
    first_token_latency_ms, output_tps, route_attempts, attempted_channels, error_message, created_at
  )
  SELECT
    id, user_id, key_id, channel_id, model_alias, real_model, stream, status_code,
    estimated_tokens, prompt_tokens, completion_tokens, total_tokens, latency_ms,
    first_token_latency_ms, output_tps, COALESCE(route_attempts, 1), attempted_channels, error_message, created_at
  FROM chat_logs;
  `);

  db.exec("DROP INDEX IF EXISTS idx_chat_logs_created_at");
  db.exec("DROP INDEX IF EXISTS idx_chat_logs_user_id");
  db.exec("DROP TABLE chat_logs");
}

const settingsColumns = db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
const isKvSettings = settingsColumns.some((col) => col.name === "key") && settingsColumns.some((col) => col.name === "value");
if (!isKvSettings) {
  const legacy = db
    .prepare("SELECT registration_enabled, default_qps, default_rpm, default_tpm FROM settings LIMIT 1")
    .get() as
    | {
        registration_enabled: number | null;
        default_qps: number | null;
        default_rpm: number | null;
        default_tpm: number | null;
      }
    | undefined;

  db.exec(`
  BEGIN;
  CREATE TABLE settings_new (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO settings_new (key, value) VALUES
    ('registration_enabled', '${legacy?.registration_enabled === 0 ? "0" : "1"}'),
    ('default_qps', '${Math.max(0, legacy?.default_qps ?? 0)}'),
    ('default_rpm', '${Math.max(0, legacy?.default_rpm ?? 0)}'),
    ('default_tpm', '${Math.max(0, legacy?.default_tpm ?? 0)}');
  DROP TABLE settings;
  ALTER TABLE settings_new RENAME TO settings;
  COMMIT;
  `);
}

const initSetting = db.prepare(
  `INSERT INTO settings (key, value)
   VALUES (?, ?)
   ON CONFLICT(key) DO NOTHING`,
);
initSetting.run("registration_enabled", "1");
initSetting.run("default_qps", "0");
initSetting.run("default_rpm", "0");
initSetting.run("default_tpm", "0");
initSetting.run("upstream_retry_enabled", "1");
initSetting.run("upstream_retry_max_attempts", "3");

export type DbChannel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  weight: number;
  timeout: number;
  created_at: string;
};

export type DbModel = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  enabled: number;
  weight: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbUser = {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "user";
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbKey = {
  id: number;
  key: string;
  user_id: number;
  used_tokens: number;
  used_requests: number;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbLog = {
  id: number;
  user_id: number;
  key_id: number;
  channel_id: number | null;
  model_alias: string | null;
  real_model: string | null;
  stream: number;
  status_code: number | null;
  estimated_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  first_token_latency_ms: number | null;
  output_tps: number | null;
  route_attempts: number | null;
  attempted_channels: string | null;
  error_message: string | null;
  created_at: string;
};

export const gatewayDb = db;
