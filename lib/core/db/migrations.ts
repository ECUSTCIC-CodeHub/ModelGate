import type BetterSqlite3 from "better-sqlite3";

function tableExists(db: BetterSqlite3.Database, name: string) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

export function migrateLegacyUsers(db: BetterSqlite3.Database) {
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const hasNameColumn = userColumns.some((col) => col.name === "name");
  const hasQpmColumn = userColumns.some((col) => col.name === "qpm");
  const hasQpsColumn = userColumns.some((col) => col.name === "qps");
  if (!hasNameColumn && !hasQpmColumn && hasQpsColumn) return;

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

export function migrateOidcClaimValue(db: BetterSqlite3.Database) {
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'oidc_claim_expr_migrated'").get() as { value: string } | undefined;
  if (migrated) return;

  const groupClaim = (db.prepare("SELECT value FROM settings WHERE key = 'oidc_group_claim'").get() as { value: string } | undefined)?.value || "";
  if (groupClaim) {
    const rows = db
      .prepare("SELECT id, oidc_claim_value FROM groups WHERE oidc_claim_value IS NOT NULL AND oidc_claim_value != ''")
      .all() as Array<{ id: number; oidc_claim_value: string }>;
    for (const row of rows) {
      const escaped = row.oidc_claim_value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      db.prepare("UPDATE groups SET oidc_claim_expr = ? WHERE id = ?").run(`${groupClaim} == "${escaped}"`, row.id);
    }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('oidc_claim_expr_migrated', '1')").run();
}

export function backfillKeyUsage(db: BetterSqlite3.Database) {
  db.exec(`
  UPDATE keys
  SET
    used_requests = COALESCE((SELECT COUNT(*) FROM logs WHERE logs.key_id = keys.id), 0),
    used_tokens = COALESCE((SELECT SUM(COALESCE(logs.total_tokens, 0)) FROM logs WHERE logs.key_id = keys.id), 0)
  `);
}

export function migrateLegacyChatLogs(db: BetterSqlite3.Database) {
  if (!tableExists(db, "chat_logs")) return;

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

export function migrateLegacySettingsTable(db: BetterSqlite3.Database) {
  const settingsColumns = db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
  const isKvSettings = settingsColumns.some((col) => col.name === "key") && settingsColumns.some((col) => col.name === "value");
  if (isKvSettings) return;

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

export function migrateUnlimitedLimitSemantics(db: BetterSqlite3.Database) {
  const migrated = db
    .prepare("SELECT value FROM settings WHERE key = 'limit_unlimited_value_migrated'")
    .get() as { value: string } | undefined;
  if (migrated) return;

  db.exec(`
  UPDATE settings SET value = '-1' WHERE key IN ('default_qps', 'default_rpm', 'default_tpm') AND value = '0';
  UPDATE users SET qps = -1 WHERE qps = 0;
  UPDATE users SET rpm = -1 WHERE rpm = 0;
  UPDATE users SET tpm = -1 WHERE tpm = 0;
  `);
  db.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run("limit_unlimited_value_migrated", "1");
}

export function ensureDefaultGroup(db: BetterSqlite3.Database) {
  const defaultGroup = db
    .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
    .get() as { id: number } | undefined;

  if (defaultGroup) return;

  db.exec(`
  INSERT OR IGNORE INTO groups (name, description, is_default, qps, rpm, tpm)
  VALUES ('default', '默认用户组', 1, -1, -1, -1);
  `);
  const newDefault = db.prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL").get() as { id: number };
  db.prepare("UPDATE users SET group_id = ? WHERE group_id IS NULL").run(newDefault.id);
}
