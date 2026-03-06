import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_logs (
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
  error_message TEXT,
  request_body TEXT,
  response_body TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);
CREATE INDEX IF NOT EXISTS idx_models_alias_enabled ON models(alias, enabled);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON chat_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_logs_user_id ON chat_logs(user_id);
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users_new (
        id, username, password_hash, role, rpm, qps, tpm,
        quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
      )
      SELECT
        id,
        CASE
          WHEN username IS NULL OR length(username) < 3 OR username GLOB '*[^A-Za-z0-9]*' THEN 'user' || id
          ELSE username
        END,
        password_hash, role, rpm, ${qpsExpr}, tpm,
        quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
      FROM users;

      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      COMMIT;
      `);
    } catch (error) {
      const message = String(error);
      if (
        !message.includes("no such column: qpm") &&
        !message.includes("table users_new already exists") &&
        !message.includes("database schema has changed")
      ) {
        throw error;
      }
      db.exec("ROLLBACK;");
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
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
    ('default_qps', '${Math.max(1, legacy?.default_qps ?? 1)}'),
    ('default_rpm', '${Math.max(1, legacy?.default_rpm ?? 60)}'),
    ('default_tpm', '${Math.max(1, legacy?.default_tpm ?? 60000)}');
  DROP TABLE settings;
  ALTER TABLE settings_new RENAME TO settings;
  COMMIT;
  `);
}

db.prepare(
  `INSERT INTO settings (key, value)
   VALUES (?, ?)
   ON CONFLICT(key) DO NOTHING`,
).run("registration_enabled", "1");
db.prepare(
  `INSERT INTO settings (key, value)
   VALUES (?, ?)
   ON CONFLICT(key) DO NOTHING`,
).run("default_qps", "1");
db.prepare(
  `INSERT INTO settings (key, value)
   VALUES (?, ?)
   ON CONFLICT(key) DO NOTHING`,
).run("default_rpm", "60");
db.prepare(
  `INSERT INTO settings (key, value)
   VALUES (?, ?)
   ON CONFLICT(key) DO NOTHING`,
).run("default_tpm", "60000");

const chatLogColumns = db.prepare("PRAGMA table_info(chat_logs)").all() as Array<{ name: string }>;
if (!chatLogColumns.some((col) => col.name === "first_token_latency_ms")) {
  db.exec("ALTER TABLE chat_logs ADD COLUMN first_token_latency_ms INTEGER");
}
if (!chatLogColumns.some((col) => col.name === "output_tps")) {
  db.exec("ALTER TABLE chat_logs ADD COLUMN output_tps REAL");
}

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
};

export type DbKey = {
  id: number;
  key: string;
  user_id: number;
  enabled: number;
  created_at: string;
};

export type DbChatLog = {
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
  error_message: string | null;
  request_body: string | null;
  response_body: string | null;
  created_at: string;
};

export const gatewayDb = db;
