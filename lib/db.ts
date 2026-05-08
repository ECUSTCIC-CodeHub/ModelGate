import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { GatewayProtocol } from "@/lib/protocols";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "gateway.db");
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const DATA_DIR_MODE = 0o755;
const DB_FILE_MODE = 0o644;
const require = createRequire(import.meta.url);

function ensurePathMode(targetPath: string, mode: number) {
  try {
    const stats = fs.statSync(targetPath);
    const currentMode = stats.mode & 0o777;
    if (currentMode !== mode) {
      fs.chmodSync(targetPath, mode);
    }
  } catch {
    // Best-effort only; avoid failing DB init on chmod issues.
  }
}

const initializeGatewayDb = () => {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
  }
  ensurePathMode(dataDir, DATA_DIR_MODE);

  const db = new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  ensurePathMode(dbPath, DB_FILE_MODE);
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

  const journalMode = db.pragma("journal_mode", { simple: true });
  if (journalMode !== "wal") {
    db.pragma("journal_mode = WAL");
  }

  db.exec(`
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
    ? "CASE WHEN qpm IS NULL THEN -1 WHEN qpm < 0 THEN -1 ELSE CAST((qpm + 59) / 60 AS INTEGER) END"
    : "CASE WHEN qps IS NULL THEN -1 WHEN qps < -1 THEN -1 ELSE qps END";

  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL CHECK(length(username) >= 3 AND username NOT GLOB '*[^A-Za-z0-9]*'),
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      rpm INTEGER DEFAULT -1,
      qps INTEGER DEFAULT -1,
      tpm INTEGER DEFAULT -1,
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
  ensureColumn("users", "allowed_model_aliases", "allowed_model_aliases TEXT DEFAULT '[]'");
  ensureColumn("users", "note", "note TEXT");
  ensureColumn("users", "group_id", "group_id INTEGER REFERENCES groups(id)");
  ensureColumn("users", "oidc_issuer", "oidc_issuer TEXT");
  ensureColumn("users", "oidc_subject", "oidc_subject TEXT");
  ensureColumn("groups", "oidc_claim_value", "oidc_claim_value TEXT");
  ensureColumn("groups", "oidc_claim_expr", "oidc_claim_expr TEXT");
  ensureColumn("groups", "quota_period", "quota_period INTEGER");
  ensureColumn("groups", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn("groups", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn("users", "quota_period", "quota_period INTEGER");
  ensureColumn("users", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn("users", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn("users", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  ensureColumn("users", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  ensureColumn("users", "period_reset_at", "period_reset_at DATETIME");
  ensureColumn("keys", "deleted_at", "deleted_at DATETIME");
  const addedKeyUsedTokens = ensureColumn("keys", "used_tokens", "used_tokens INTEGER DEFAULT 0");
  const addedKeyUsedRequests = ensureColumn("keys", "used_requests", "used_requests INTEGER DEFAULT 0");
  ensureColumn("channels", "supported_protocols", `supported_protocols TEXT DEFAULT '["chat_completions"]'`);
  ensureColumn("channels", "max_concurrency", "max_concurrency INTEGER DEFAULT 64");
  ensureColumn("channels", "deleted_at", "deleted_at DATETIME");
  ensureColumn("models", "deleted_at", "deleted_at DATETIME");
  ensureColumn("models", "is_public", "is_public INTEGER DEFAULT 1");
  ensureColumn("models", "upstream_protocol", `upstream_protocol TEXT DEFAULT 'chat_completions'`);
  ensureColumn("logs", "first_token_latency_ms", "first_token_latency_ms INTEGER");
  ensureColumn("logs", "output_tps", "output_tps REAL");
  ensureColumn("logs", "route_attempts", "route_attempts INTEGER DEFAULT 1");
  ensureColumn("logs", "attempted_channels", "attempted_channels TEXT");

  // Migrate oidc_claim_value → oidc_claim_expr
  {
    const migrated = db.prepare("SELECT value FROM settings WHERE key = 'oidc_claim_expr_migrated'").get() as { value: string } | undefined;
    if (!migrated) {
      const groupClaim = (db.prepare("SELECT value FROM settings WHERE key = 'oidc_group_claim'").get() as { value: string } | undefined)?.value || "";
      if (groupClaim) {
        const rows = db.prepare("SELECT id, oidc_claim_value FROM groups WHERE oidc_claim_value IS NOT NULL AND oidc_claim_value != ''").all() as Array<{ id: number; oidc_claim_value: string }>;
        for (const row of rows) {
          const escaped = row.oidc_claim_value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          db.prepare("UPDATE groups SET oidc_claim_expr = ? WHERE id = ?").run(`${groupClaim} == "${escaped}"`, row.id);
        }
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('oidc_claim_expr_migrated', '1')").run();
    }
  }

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
    ('default_qps', '${Math.max(-1, legacy?.default_qps ?? -1)}'),
    ('default_rpm', '${Math.max(-1, legacy?.default_rpm ?? -1)}'),
    ('default_tpm', '${Math.max(-1, legacy?.default_tpm ?? -1)}');
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
  initSetting.run("password_login_enabled", "1");
  initSetting.run("default_qps", "-1");
  initSetting.run("default_rpm", "-1");
  initSetting.run("default_tpm", "-1");
  initSetting.run("upstream_retry_enabled", "1");
  initSetting.run("upstream_retry_max_attempts", "3");
  initSetting.run("oidc_enabled", "0");
  initSetting.run("oidc_issuer_url", "");
  initSetting.run("oidc_client_id", "");
  initSetting.run("oidc_client_secret", "");
  initSetting.run("oidc_scopes", "openid profile email");
  initSetting.run("oidc_auto_register", "1");
  initSetting.run("oidc_button_text", "OIDC 登录");
  initSetting.run("oidc_group_claim", "");
  initSetting.run("announcement_content", "");

// Historical compatibility (one-time):
// previous versions used 0 as "unlimited"; now -1 is unlimited.
  const limitSemanticsMigrated = db
    .prepare("SELECT value FROM settings WHERE key = 'limit_unlimited_value_migrated'")
    .get() as { value: string } | undefined;

  if (!limitSemanticsMigrated) {
    db.exec(`
  UPDATE settings SET value = '-1' WHERE key IN ('default_qps', 'default_rpm', 'default_tpm') AND value = '0';
  UPDATE users SET qps = -1 WHERE qps = 0;
  UPDATE users SET rpm = -1 WHERE rpm = 0;
  UPDATE users SET tpm = -1 WHERE tpm = 0;
  `);
    initSetting.run("limit_unlimited_value_migrated", "1");
  }

  const defaultGroup = db
    .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
    .get() as { id: number } | undefined;

  if (!defaultGroup) {
    db.exec(`
  INSERT OR IGNORE INTO groups (name, description, is_default, qps, rpm, tpm)
  VALUES ('default', '默认用户组', 1, -1, -1, -1);
  `);
    const newDefault = db.prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL").get() as { id: number };
    db.prepare("UPDATE users SET group_id = ? WHERE group_id IS NULL").run(newDefault.id);
  }

  return db;
};

export type DbChannel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  enabled: number;
  weight: number;
  max_concurrency: number;
  timeout: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbModel = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: GatewayProtocol;
  is_public: number;
  enabled: number;
  weight: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbGroup = {
  id: number;
  name: string;
  description: string | null;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  allowed_model_aliases: string;
  oidc_claim_value: string | null;
  oidc_claim_expr: string | null;
  is_default: number;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbUser = {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "user";
  group_id: number | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  quota_period: number | null;
  period_quota_tokens: number | null;
  period_quota_requests: number | null;
  period_used_tokens: number;
  period_used_requests: number;
  period_reset_at: string | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string;
  note: string | null;
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

let gatewayDbInstance: BetterSqlite3.Database | null = null;

const getGatewayDb = () => {
  if (!gatewayDbInstance) {
    gatewayDbInstance = initializeGatewayDb();
  }
  return gatewayDbInstance;
};

export const gatewayDb = new Proxy({} as BetterSqlite3.Database, {
  get(_target, prop) {
    const value = getGatewayDb()[prop as keyof BetterSqlite3.Database];
    return typeof value === "function" ? value.bind(getGatewayDb()) : value;
  },
});
