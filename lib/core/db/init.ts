import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ensureModernColumns } from "@/lib/core/db/columns";
import {
  backfillKeyUsage,
  ensureDefaultGroup,
  migrateLegacyChatLogs,
  migrateLegacySettingsTable,
  migrateLegacyUsers,
  migrateOidcClaimValue,
  migrateUnlimitedLimitSemantics,
} from "@/lib/core/db/migrations";
import {
  BASE_SCHEMA_SQL,
  DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL,
  POST_MIGRATION_INDEXES_SQL,
} from "@/lib/core/db/schema";
import { seedDefaultSettings } from "@/lib/core/db/settings-seed";

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

export const initializeGatewayDb = () => {
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

  db.exec(BASE_SCHEMA_SQL);
  migrateLegacyUsers(db);
  const columnMigrations = ensureModernColumns(db);
  db.exec(POST_MIGRATION_INDEXES_SQL);
  db.exec(DISABLE_MODELS_FOR_DISABLED_CHANNELS_SQL);
  migrateOidcClaimValue(db);
  if (columnMigrations.addedKeyUsedTokens || columnMigrations.addedKeyUsedRequests) {
    backfillKeyUsage(db);
  }
  migrateLegacyChatLogs(db);
  migrateLegacySettingsTable(db);
  seedDefaultSettings(db);
  migrateUnlimitedLimitSemantics(db);
  ensureDefaultGroup(db);

  return db;
};
