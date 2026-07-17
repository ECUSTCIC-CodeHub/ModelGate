import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseAdapter } from "@/lib/core/db/adapter";
import { SqliteAdapter } from "@/lib/core/db/sqlite-adapter";
import { MysqlAdapter } from "@/lib/core/db/mysql-adapter";
import { startLogRetentionJob } from "@/lib/data/log-cleanup";
import { startOidcGroupExpiryJob } from "@/lib/auth/oidc-group-reaper";
import {
  BASE_SCHEMA_SQL,
  DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL,
  POST_MIGRATION_INDEXES_SQL,
} from "@/lib/core/db/schema";
import {
  MYSQL_BASE_SCHEMA_SQL,
  MYSQL_BASE_INDEXES,
  MYSQL_DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL,
  MYSQL_POST_MIGRATION_INDEXES,
} from "@/lib/core/db/mysql-schema";
import { toMysqlDatetime } from "@/lib/core/db/datetime";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "gateway.db");
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const DATA_DIR_MODE = 0o755;
const DB_FILE_MODE = 0o644;
const require = createRequire(import.meta.url);

const SQLITE_PERMISSION_PATTERNS = [
  "SQLITE_CANTOPEN",
  "SQLITE_PERM",
  "not authorized",
  "access to the path",
  "unable to open",
];

const MYSQL_PERMISSION_CODES = [
  "ER_ACCESS_DENIED_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_COLUMNACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_CANT_OPEN_FILE",
];

function isPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (SQLITE_PERMISSION_PATTERNS.some((p) => msg.includes(p))) return true;
  const code = "code" in err ? (err as Error & { code?: string }).code : undefined;
  if (code && MYSQL_PERMISSION_CODES.includes(code)) return true;
  return false;
}

function throwPermissionError(err: unknown): never {
  throw new Error(
    "数据库权限错误：无法访问数据库文件。请检查文件权限或联系管理员。" +
      (err instanceof Error ? ` (原始错误: ${err.message})` : ""),
    { cause: err },
  );
}

function ensurePathMode(targetPath: string, mode: number) {
  try {
    const stats = fs.statSync(targetPath);
    const currentMode = stats.mode & 0o777;
    if (currentMode !== mode) {
      fs.chmodSync(targetPath, mode);
    }
  } catch {
    // best-effort
  }
}

function getDbDriver(): "sqlite" | "mysql" {
  const driver = process.env.DB_DRIVER?.toLowerCase();
  if (driver === "mysql") return "mysql";
  return "sqlite";
}

async function initSqlite(): Promise<DatabaseAdapter> {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
  }
  ensurePathMode(dataDir, DATA_DIR_MODE);

  let raw: InstanceType<typeof Database>;
  try {
    raw = new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  } catch (err) {
    if (isPermissionError(err)) throwPermissionError(err);
    throw err;
  }
  ensurePathMode(dbPath, DB_FILE_MODE);
  raw.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

  const journalMode = raw.pragma("journal_mode", { simple: true });
  if (journalMode !== "wal") {
    raw.pragma("journal_mode = WAL");
  }

  const db = new SqliteAdapter(raw);

  try {
    await db.exec(BASE_SCHEMA_SQL);
    await runSqliteMigrations(db);
    await ensureAllColumns(db);
    await db.exec(POST_MIGRATION_INDEXES_SQL);
    await db.exec(DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL);
    await seedDefaultSettings(db);
    await backfillStats(db);
    await migrateUnlimitedLimitSemantics(db);
    await ensureDefaultGroup(db);
    await cleanupModelUserUsage(db);
  } catch (err) {
    if (isPermissionError(err)) throwPermissionError(err);
    throw err;
  }

  return db;
}

async function runSqliteMigrations(db: DatabaseAdapter) {
  // migrateLegacyUsers
  const userCols = await db.query<{ name: string }>("PRAGMA table_info(users)");
  const hasNameColumn = userCols.some((col) => col.name === "name");
  const hasQpmColumn = userCols.some((col) => col.name === "qpm");
  const hasQpsColumn = userCols.some((col) => col.name === "qps");
  if (hasNameColumn || hasQpmColumn || !hasQpsColumn) {
    const hasUsername = userCols.some((col) => col.name === "username");
    if (!hasUsername) {
      throw new Error("users 表必须包含 username 列");
    }

    const qpsExpr = hasQpmColumn
      ? "CASE WHEN qpm IS NULL THEN -1 WHEN qpm < 0 THEN -1 ELSE CAST((qpm + 59) / 60 AS INTEGER) END"
      : "CASE WHEN qps IS NULL THEN -1 WHEN qps < -1 THEN -1 ELSE qps END";

    await db.exec("PRAGMA foreign_keys = OFF");
    try {
      await db.exec(`
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
      await db.exec("ROLLBACK;");
    } finally {
      await db.exec("PRAGMA foreign_keys = ON");
    }
  }

  // migrateOidcClaimValue
  const migrated = await db.queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'oidc_claim_expr_migrated'");
  if (!migrated) {
    const groupClaimRow = await db.queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'oidc_group_claim'");
    const groupClaim = groupClaimRow?.value || "";
    if (groupClaim) {
      const rows = await db.query<{ id: number; oidc_claim_value: string }>(
        "SELECT id, oidc_claim_value FROM `groups` WHERE oidc_claim_value IS NOT NULL AND oidc_claim_value != ''",
      );
      for (const row of rows) {
        const escaped = row.oidc_claim_value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await db.execute("UPDATE `groups` SET oidc_claim_expr = ? WHERE id = ?", [`${groupClaim} == "${escaped}"`, row.id]);
      }
    }
    await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["oidc_claim_expr_migrated", "1"]);
  }

  // backfillKeyUsage (only if new columns were added)
  // migrateLegacyChatLogs
  const tableRow = await db.queryOne<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_logs'");
  if (tableRow) {
    await db.exec(`
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
    await db.exec("DROP INDEX IF EXISTS idx_chat_logs_created_at");
    await db.exec("DROP INDEX IF EXISTS idx_chat_logs_user_id");
    await db.exec("DROP TABLE chat_logs");
  }

  // migrateLegacySettingsTable
  const settingsColumns = await db.query<{ name: string }>("PRAGMA table_info(settings)");
  const isKvSettings = settingsColumns.some((col) => col.name === "key") && settingsColumns.some((col) => col.name === "value");
  if (!isKvSettings) {
    const legacy = await db.queryOne<{
      registration_enabled: number | null;
      default_qps: number | null;
      default_rpm: number | null;
      default_tpm: number | null;
    }>("SELECT registration_enabled, default_qps, default_rpm, default_tpm FROM settings LIMIT 1");

    await db.exec(`
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
}

async function backfillOidcGroupSyncedAt(db: DatabaseAdapter) {
  const now = toMysqlDatetime(new Date());
  await db.execute(
    `UPDATE users
     SET oidc_group_synced_at = ?
     WHERE oidc_group_synced_at IS NULL
       AND deleted_at IS NULL
       AND (group_locked = 0 OR group_locked IS NULL)
       AND group_id IN (
         SELECT id FROM \`groups\` WHERE oidc_claim_expr IS NOT NULL AND oidc_claim_expr != '' AND deleted_at IS NULL
       )`,
    [now],
  );
}

async function ensureAllColumns(db: DatabaseAdapter) {
  await db.ensureColumn("users", "deleted_at", "deleted_at DATETIME");
  await db.ensureColumn("users", "allowed_model_aliases", "allowed_model_aliases TEXT DEFAULT '[]'");
  await db.ensureColumn("users", "note", "note TEXT");
  await db.ensureColumn("users", "group_id", "group_id INTEGER REFERENCES groups(id)");
  await db.ensureColumn("users", "oidc_issuer", "oidc_issuer TEXT");
  await db.ensureColumn("users", "oidc_subject", "oidc_subject TEXT");
  await db.ensureColumn("users", "oidc_group_synced_at", "oidc_group_synced_at DATETIME");
  await db.ensureColumn("users", "group_locked", "group_locked INTEGER DEFAULT 0");
  await db.ensureColumn("groups", "oidc_claim_value", "oidc_claim_value TEXT");
  await db.ensureColumn("groups", "oidc_claim_expr", "oidc_claim_expr TEXT");
  await db.ensureColumn("groups", "oidc_claim_priority", "oidc_claim_priority INTEGER DEFAULT 0");
  await backfillOidcGroupSyncedAt(db);
  await db.ensureColumn("groups", "quota_period", "quota_period INTEGER");
  await db.ensureColumn("groups", "period_quota_tokens", "period_quota_tokens INTEGER");
  await db.ensureColumn("groups", "period_quota_requests", "period_quota_requests INTEGER");
  await db.ensureColumn("groups", "allowed_channel_ids", "allowed_channel_ids TEXT DEFAULT '[]'");
  await db.ensureColumn("users", "quota_period", "quota_period INTEGER");
  await db.ensureColumn("users", "period_quota_tokens", "period_quota_tokens INTEGER");
  await db.ensureColumn("users", "period_quota_requests", "period_quota_requests INTEGER");
  await db.ensureColumn("users", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  await db.ensureColumn("users", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  await db.ensureColumn("users", "period_reset_at", "period_reset_at DATETIME");
  await db.ensureColumn("keys", "deleted_at", "deleted_at DATETIME");
  await db.ensureColumn("keys", "name", "name TEXT DEFAULT ''");
  await db.ensureColumn("keys", "used_tokens", "used_tokens INTEGER DEFAULT 0");
  await db.ensureColumn("keys", "used_requests", "used_requests INTEGER DEFAULT 0");
  await db.ensureColumn("keys", "last_used_at", "last_used_at DATETIME");
  await db.ensureColumn("logs", "client_ip", "client_ip TEXT");
  await db.ensureColumn("channels", "supported_protocols", `supported_protocols TEXT DEFAULT '["chat_completions"]'`);
  await db.ensureColumn("channels", "user_agent", "user_agent TEXT DEFAULT ''");
  await db.ensureColumn("channels", "proxy_url", "proxy_url TEXT DEFAULT ''");
  await db.ensureColumn("channels", "max_concurrency", "max_concurrency INTEGER DEFAULT 64");
  await db.ensureColumn("channels", "quota_tokens", "quota_tokens INTEGER");
  await db.ensureColumn("channels", "quota_requests", "quota_requests INTEGER");
  await db.ensureColumn("channels", "quota_period", "quota_period INTEGER");
  await db.ensureColumn("channels", "period_quota_tokens", "period_quota_tokens INTEGER");
  await db.ensureColumn("channels", "period_quota_requests", "period_quota_requests INTEGER");
  await db.ensureColumn("channels", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  await db.ensureColumn("channels", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  await db.ensureColumn("channels", "period_reset_at", "period_reset_at DATETIME");
  await db.ensureColumn("channels", "deleted_at", "deleted_at DATETIME");
  await db.ensureColumn("channels", "force_include_usage", "force_include_usage INTEGER DEFAULT 1");
  await db.ensureColumn("channels", "ua_restrictions", "ua_restrictions TEXT DEFAULT ''");
  await db.ensureColumn("channels", "created_by", "created_by INTEGER REFERENCES users(id)");
  await db.ensureColumn("channels", "api_key_private", "api_key_private INTEGER DEFAULT 0");
  await db.ensureColumn("channels", "expires_at", "expires_at DATETIME DEFAULT NULL");
  await db.ensureColumn("channels", "time_restrictions", "time_restrictions TEXT DEFAULT NULL");
  await db.ensureColumn("models", "deleted_at", "deleted_at DATETIME");
  await db.ensureColumn("models", "is_public", "is_public INTEGER DEFAULT 1");
  await db.ensureColumn("models", "upstream_protocol", `upstream_protocol TEXT DEFAULT 'chat_completions'`);
  await db.ensureColumn("models", "token_multiplier", "token_multiplier REAL DEFAULT 1");
  await db.ensureColumn("models", "request_multiplier", "request_multiplier REAL DEFAULT 1");
  await db.ensureColumn("models", "max_concurrency", "max_concurrency INTEGER DEFAULT 0");
  await db.ensureColumn("models", "quota_mode", `quota_mode TEXT DEFAULT 'follow_group'`);
  await db.ensureColumn("models", "quota_tokens", "quota_tokens INTEGER");
  await db.ensureColumn("models", "quota_requests", "quota_requests INTEGER");
  await db.ensureColumn("models", "quota_period", "quota_period INTEGER");
  await db.ensureColumn("models", "period_quota_tokens", "period_quota_tokens INTEGER");
  await db.ensureColumn("models", "period_quota_requests", "period_quota_requests INTEGER");
  await db.ensureColumn("models", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  await db.ensureColumn("models", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  await db.ensureColumn("models", "period_reset_at", "period_reset_at DATETIME");
  await db.ensureColumn("models", "supported_protocols", "supported_protocols TEXT");
  await db.ensureColumn("models", "copilot_compatibility", "copilot_compatibility INTEGER DEFAULT 0");
  await db.ensureColumn("models", "ua_restrictions", "ua_restrictions TEXT DEFAULT ''");
  await db.ensureColumn("logs", "first_token_latency_ms", "first_token_latency_ms INTEGER");
  await db.ensureColumn("logs", "output_tps", "output_tps REAL");
  await db.ensureColumn("logs", "token_source", "token_source TEXT");
  await db.ensureColumn("logs", "metadata", "metadata TEXT");
  await db.ensureColumn("logs", "route_attempts", "route_attempts INTEGER DEFAULT 1");
  await db.ensureColumn("logs", "attempted_channels", "attempted_channels TEXT");
  await db.ensureColumn("logs", "user_agent", "user_agent TEXT");
  await db.ensureColumn("users", "webhook_role", "webhook_role TEXT DEFAULT ''");
  await db.ensureColumn("users", "webhook_tags", "webhook_tags TEXT DEFAULT '[]'");
  await db.ensureColumn("users", "email", "email TEXT");
  await db.ensureColumn("email_send_log", "kind", "kind VARCHAR(16) NOT NULL DEFAULT 'announcement'");
  await db.ensureColumn("email_send_log", "title", "title TEXT");
  await db.ensureColumn("email_send_log", "content", "content TEXT");

  if (db.driver === "sqlite") {
    await db.exec(`UPDATE users SET used_tokens = ROUND(used_tokens, 6), used_requests = ROUND(used_requests, 6),
             period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
             WHERE used_tokens != ROUND(used_tokens, 6) OR used_requests != ROUND(used_requests, 6)
                OR period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);
    await db.exec(`UPDATE \`keys\` SET used_tokens = ROUND(used_tokens, 6), used_requests = ROUND(used_requests, 6)
             WHERE used_tokens != ROUND(used_tokens, 6) OR used_requests != ROUND(used_requests, 6)`);
    await db.exec(`UPDATE channels SET period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
             WHERE period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);
    await db.exec(`UPDATE models SET period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
             WHERE period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);
  }
}

async function createIndexIdempotent(db: MysqlAdapter, index: { name: string; table: string; expr: string }) {
  try {
    await db.exec(`CREATE INDEX ${index.name} ON ${index.table} ${index.expr}`);
  } catch (err) {
    if (err instanceof Error && /duplicate key name/i.test(err.message)) return;
    throw err;
  }
}

async function normalizeMysqlDatetimes(db: DatabaseAdapter) {
  const tables: Array<{ table: string; columns: string[] }> = [
    { table: "logs", columns: ["created_at"] },
    { table: "users", columns: ["created_at", "deleted_at", "period_reset_at"] },
    { table: "keys", columns: ["created_at", "deleted_at"] },
    { table: "channels", columns: ["created_at", "deleted_at", "period_reset_at", "expires_at"] },
    { table: "models", columns: ["created_at", "deleted_at", "period_reset_at"] },
    { table: "groups", columns: ["created_at", "deleted_at"] },
    { table: "settings", columns: ["updated_at"] },
  ];

  for (const { table, columns } of tables) {
    for (const col of columns) {
      const safeCol = "`" + col + "`";
      await db.exec(`
        UPDATE \`${table}\`
        SET ${safeCol} = REPLACE(REPLACE(REPLACE(REPLACE(${safeCol}, 'T', ' '), '.000Z', ''), '.000', ''), 'Z', '')
        WHERE ${safeCol} IS NOT NULL AND CAST(${safeCol} AS BINARY) LIKE '%T%'
      `);
    }
  }
}

async function migrateQuotaColumnsToBigInt(db: DatabaseAdapter) {
  const tables = ["channels", "models", "`groups`", "users"];
  const columns = ["quota_tokens", "quota_requests", "period_quota_tokens", "period_quota_requests"];
  for (const table of tables) {
    for (const col of columns) {
      await db.exec(`ALTER TABLE ${table} MODIFY COLUMN \`${col}\` BIGINT`).catch(() => {
        // 列可能已经是 BIGINT，忽略错误
      });
    }
  }
}

async function initMysql(): Promise<DatabaseAdapter> {
  const host = process.env.MYSQL_HOST || "localhost";
  const port = Number(process.env.MYSQL_PORT) || 3306;
  const user = process.env.MYSQL_USER || "root";
  const database = process.env.MYSQL_DATABASE || "modelgate";
  const db = new MysqlAdapter({
    host,
    port,
    user,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    poolSize: Number(process.env.MYSQL_POOL_SIZE) || 10,
  });

  try {
    await db.exec(MYSQL_BASE_SCHEMA_SQL);
    for (const idx of MYSQL_BASE_INDEXES) await createIndexIdempotent(db, idx);
    await ensureAllColumns(db);
    await migrateQuotaColumnsToBigInt(db);
    for (const idx of MYSQL_POST_MIGRATION_INDEXES) await createIndexIdempotent(db, idx);
    await db.exec(MYSQL_DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL);
    await seedDefaultSettings(db);
    await backfillStats(db);
    await migrateUnlimitedLimitSemantics(db);
    await normalizeMysqlDatetimes(db);
    await ensureDefaultGroup(db);
    await cleanupModelUserUsage(db);
  } catch (err) {
    await db.close();
    if (isPermissionError(err)) throwPermissionError(err);
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && "code" in err ? ` (${(err as Error & { code: string }).code})` : "";
    console.error(`[ModelGate] MySQL 初始化失败: 无法连接 ${host}:${port}/${database} (用户: ${user})${code} - ${msg}`);
    throw new Error(`MySQL 数据库初始化失败: ${msg}`);
  }

  return db;
}

async function backfillStats(db: DatabaseAdapter) {
  const selectSql = `SELECT 1 AS id,
      COUNT(*) AS total_requests,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code != 429 THEN 1 ELSE 0 END), 0) AS failed_requests,
      COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0) AS rate_limited_requests,
      COALESCE(SUM(CASE WHEN route_attempts > 1 THEN 1 ELSE 0 END), 0) AS retry_requests
    FROM logs`;
  if (db.driver === "mysql") {
    await db.exec(`INSERT IGNORE INTO stats (id, total_requests, total_tokens, failed_requests, rate_limited_requests, retry_requests) ${selectSql}`);
  } else {
    await db.exec(`INSERT OR IGNORE INTO stats (id, total_requests, total_tokens, failed_requests, rate_limited_requests, retry_requests) ${selectSql}`);
  }
}

async function seedDefaultSettings(db: DatabaseAdapter) {
  const defaults: Array<[string, string]> = [
    ["registration_enabled", "1"],
    ["password_login_enabled", "1"],
    ["default_qps", "-1"],
    ["default_rpm", "-1"],
    ["default_tpm", "-1"],
    ["upstream_retry_enabled", "1"],
    ["upstream_retry_max_attempts", "3"],
    ["upstream_retry_same_channel", "0"],
    ["upstream_circuit_breaker_enabled", "1"],
    ["ua_restrictions", ""],
    ["log_retention_days", "0"],
    ["oidc_enabled", "0"],
    ["oidc_issuer_url", ""],
    ["oidc_client_id", ""],
    ["oidc_client_secret", ""],
    ["oidc_scopes", "openid profile email"],
    ["oidc_auto_register", "1"],
    ["oidc_button_text", "OIDC 登录"],
    ["announcement_content", ""],
    ["announcement_display_count", "3"],
    ["icp_filing_number", ""],
    ["public_security_filing_number", ""],
  ];

  for (const [key, value] of defaults) {
    if (db.driver === "mysql") {
      await db.execute(
        "INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)",
        [key, value],
      );
    } else {
      await db.execute(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
        [key, value],
      );
    }
  }
}

async function migrateUnlimitedLimitSemantics(db: DatabaseAdapter) {
  const migrated = await db.queryOne<{ value: string }>("SELECT value FROM settings WHERE `key` = 'limit_unlimited_value_migrated'");
  if (migrated) return;

  const isMysql = db.driver === "mysql";
  const keyCol = isMysql ? "`key`" : "key";
  await db.exec(`
  UPDATE settings SET value = '-1' WHERE ${keyCol} IN ('default_qps', 'default_rpm', 'default_tpm') AND value = '0';
  UPDATE users SET qps = -1 WHERE qps = 0;
  UPDATE users SET rpm = -1 WHERE rpm = 0;
  UPDATE users SET tpm = -1 WHERE tpm = 0;
  `);

  if (db.driver === "mysql") {
    await db.execute(
      "INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)",
      ["limit_unlimited_value_migrated", "1"],
    );
  } else {
    await db.execute(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
      ["limit_unlimited_value_migrated", "1"],
    );
  }
}

async function ensureDefaultGroup(db: DatabaseAdapter) {
  const defaultGroup = await db.queryOne<{ id: number }>(
    "SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL",
  );
  if (defaultGroup) return;

  if (db.driver === "mysql") {
    await db.exec(`
    INSERT IGNORE INTO \`groups\` (name, description, is_default, qps, rpm, tpm)
    VALUES ('default', '默认用户组', 1, -1, -1, -1);
    `);
  } else {
    await db.exec(`
    INSERT OR IGNORE INTO \`groups\` (name, description, is_default, qps, rpm, tpm)
    VALUES ('default', '默认用户组', 1, -1, -1, -1);
    `);
  }

  const newDefault = await db.queryOne<{ id: number }>(
    "SELECT id FROM `groups` WHERE is_default = 1 AND deleted_at IS NULL",
  );
  if (newDefault) {
    await db.execute("UPDATE users SET group_id = ? WHERE group_id IS NULL", [newDefault.id]);
  }
}

async function cleanupModelUserUsage(db: DatabaseAdapter) {
  if (db.driver === "sqlite") {
    const tableRow = await db.queryOne<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_user_usage'");
    if (tableRow) {
      await db.exec("DROP TABLE IF EXISTS model_user_usage");
    }
    try {
      const perUserColumns = [
        "per_user_quota_requests",
        "per_user_quota_tokens",
        "per_user_quota_period",
        "per_user_period_quota_requests",
        "per_user_period_quota_tokens",
      ];
      const existing = (await db.query<{ name: string }>("PRAGMA table_info(models)")).map((c) => c.name);
      for (const col of perUserColumns) {
        if (existing.includes(col)) {
          await db.exec(`ALTER TABLE models DROP COLUMN ${col}`);
        }
      }
    } catch {
      // skip
    }
  } else {
    const tableRow = await db.queryOne<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_user_usage'`,
    );
    if (tableRow) {
      await db.exec("DROP TABLE IF EXISTS model_user_usage");
    }
    try {
      const perUserColumns = [
        "per_user_quota_requests",
        "per_user_quota_tokens",
        "per_user_quota_period",
        "per_user_period_quota_requests",
        "per_user_period_quota_tokens",
      ];
      const existing = (await db.query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'models'`,
      )).map((c) => c.COLUMN_NAME);
      for (const col of perUserColumns) {
        if (existing.includes(col)) {
          await db.exec(`ALTER TABLE models DROP COLUMN ${col}`);
        }
      }
    } catch {
      // skip
    }
  }
}

let initPromise: Promise<DatabaseAdapter> | null = null;

export async function initializeGatewayDbAsync(): Promise<DatabaseAdapter> {
  if (!initPromise) {
    const driver = getDbDriver();
    initPromise = (driver === "mysql" ? initMysql() : initSqlite())
      .then((db) => {
        startLogRetentionJob(db);
        startOidcGroupExpiryJob();
        return db;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}
