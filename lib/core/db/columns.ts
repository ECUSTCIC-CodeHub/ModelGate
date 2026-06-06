import type BetterSqlite3 from "better-sqlite3";

export type ColumnMigrationResult = {
  addedKeyUsedTokens: boolean;
  addedKeyUsedRequests: boolean;
};

export function ensureColumn(db: BetterSqlite3.Database, table: string, column: string, ddl: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      return true;
    } catch (error) {
      if (error instanceof Error && /duplicate column name/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

export function ensureModernColumns(db: BetterSqlite3.Database): ColumnMigrationResult {
  ensureColumn(db, "users", "deleted_at", "deleted_at DATETIME");
  ensureColumn(db, "users", "allowed_model_aliases", "allowed_model_aliases TEXT DEFAULT '[]'");
  ensureColumn(db, "users", "note", "note TEXT");
  ensureColumn(db, "users", "group_id", "group_id INTEGER REFERENCES groups(id)");
  ensureColumn(db, "users", "oidc_issuer", "oidc_issuer TEXT");
  ensureColumn(db, "users", "oidc_subject", "oidc_subject TEXT");
  ensureColumn(db, "groups", "oidc_claim_value", "oidc_claim_value TEXT");
  ensureColumn(db, "groups", "oidc_claim_expr", "oidc_claim_expr TEXT");
  ensureColumn(db, "groups", "oidc_claim_priority", "oidc_claim_priority INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "quota_period", "quota_period INTEGER");
  ensureColumn(db, "groups", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn(db, "groups", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn(db, "groups", "allowed_channel_ids", `allowed_channel_ids TEXT DEFAULT '[]'`);
  ensureColumn(db, "users", "quota_period", "quota_period INTEGER");
  ensureColumn(db, "users", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn(db, "users", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn(db, "users", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  ensureColumn(db, "users", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  ensureColumn(db, "users", "period_reset_at", "period_reset_at DATETIME");
  ensureColumn(db, "keys", "deleted_at", "deleted_at DATETIME");
  ensureColumn(db, "keys", "name", "name TEXT DEFAULT ''");
  ensureColumn(db, "logs", "client_ip", "client_ip TEXT");
  const addedKeyUsedTokens = ensureColumn(db, "keys", "used_tokens", "used_tokens INTEGER DEFAULT 0");
  const addedKeyUsedRequests = ensureColumn(db, "keys", "used_requests", "used_requests INTEGER DEFAULT 0");
  ensureColumn(db, "channels", "supported_protocols", `supported_protocols TEXT DEFAULT '["chat_completions"]'`);
  ensureColumn(db, "channels", "user_agent", "user_agent TEXT DEFAULT ''");
  ensureColumn(db, "channels", "max_concurrency", "max_concurrency INTEGER DEFAULT 64");
  ensureColumn(db, "channels", "quota_tokens", "quota_tokens INTEGER");
  ensureColumn(db, "channels", "quota_requests", "quota_requests INTEGER");
  ensureColumn(db, "channels", "quota_period", "quota_period INTEGER");
  ensureColumn(db, "channels", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn(db, "channels", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn(db, "channels", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  ensureColumn(db, "channels", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  ensureColumn(db, "channels", "period_reset_at", "period_reset_at DATETIME");
  ensureColumn(db, "channels", "deleted_at", "deleted_at DATETIME");
  ensureColumn(db, "channels", "force_include_usage", "force_include_usage INTEGER DEFAULT 1");
  ensureColumn(db, "models", "deleted_at", "deleted_at DATETIME");
  ensureColumn(db, "models", "is_public", "is_public INTEGER DEFAULT 1");
  ensureColumn(db, "models", "upstream_protocol", `upstream_protocol TEXT DEFAULT 'chat_completions'`);
  ensureColumn(db, "models", "token_multiplier", "token_multiplier REAL DEFAULT 1");
  ensureColumn(db, "models", "request_multiplier", "request_multiplier REAL DEFAULT 1");
  ensureColumn(db, "models", "max_concurrency", "max_concurrency INTEGER DEFAULT 0");
  ensureColumn(db, "models", "quota_mode", `quota_mode TEXT DEFAULT 'follow_group'`);
  ensureColumn(db, "models", "quota_tokens", "quota_tokens INTEGER");
  ensureColumn(db, "models", "quota_requests", "quota_requests INTEGER");
  ensureColumn(db, "models", "quota_period", "quota_period INTEGER");
  ensureColumn(db, "models", "period_quota_tokens", "period_quota_tokens INTEGER");
  ensureColumn(db, "models", "period_quota_requests", "period_quota_requests INTEGER");
  ensureColumn(db, "models", "period_used_tokens", "period_used_tokens INTEGER DEFAULT 0");
  ensureColumn(db, "models", "period_used_requests", "period_used_requests INTEGER DEFAULT 0");
  ensureColumn(db, "models", "period_reset_at", "period_reset_at DATETIME");
  ensureColumn(db, "models", "supported_protocols", `supported_protocols TEXT`);
  ensureColumn(db, "models", "copilot_compatibility", "copilot_compatibility INTEGER DEFAULT 0");
  ensureColumn(db, "logs", "first_token_latency_ms", "first_token_latency_ms INTEGER");
  ensureColumn(db, "logs", "output_tps", "output_tps REAL");
  ensureColumn(db, "logs", "token_source", "token_source TEXT");
  ensureColumn(db, "logs", "metadata", "metadata TEXT");
  ensureColumn(db, "logs", "route_attempts", "route_attempts INTEGER DEFAULT 1");
  ensureColumn(db, "logs", "attempted_channels", "attempted_channels TEXT");
  ensureColumn(db, "logs", "user_agent", "user_agent TEXT");
  ensureColumn(db, "users", "webhook_role", "webhook_role TEXT DEFAULT ''");
  ensureColumn(db, "users", "webhook_tags", "webhook_tags TEXT DEFAULT '[]'");
  ensureColumn(db, "users", "totp_secret", "totp_secret TEXT");
  ensureColumn(db, "users", "totp_enabled", "totp_enabled INTEGER DEFAULT 0");

  db.exec(`UPDATE users SET used_tokens = ROUND(used_tokens, 6), used_requests = ROUND(used_requests, 6),
           period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
           WHERE used_tokens != ROUND(used_tokens, 6) OR used_requests != ROUND(used_requests, 6)
              OR period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);
  db.exec(`UPDATE keys SET used_tokens = ROUND(used_tokens, 6), used_requests = ROUND(used_requests, 6)
           WHERE used_tokens != ROUND(used_tokens, 6) OR used_requests != ROUND(used_requests, 6)`);
  db.exec(`UPDATE channels SET period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
           WHERE period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);
  db.exec(`UPDATE models SET period_used_tokens = ROUND(period_used_tokens, 6), period_used_requests = ROUND(period_used_requests, 6)
           WHERE period_used_tokens != ROUND(period_used_tokens, 6) OR period_used_requests != ROUND(period_used_requests, 6)`);

  return {
    addedKeyUsedTokens,
    addedKeyUsedRequests,
  };
}
