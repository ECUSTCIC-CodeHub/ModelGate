import type BetterSqlite3 from "better-sqlite3";

const DEFAULT_SETTINGS: Array<[string, string]> = [
  ["registration_enabled", "1"],
  ["password_login_enabled", "1"],
  ["default_qps", "-1"],
  ["default_rpm", "-1"],
  ["default_tpm", "-1"],
  ["upstream_retry_enabled", "1"],
  ["upstream_retry_max_attempts", "3"],
  ["upstream_retry_same_channel", "0"],
  ["upstream_circuit_breaker_enabled", "1"],
  ["oidc_enabled", "0"],
  ["oidc_issuer_url", ""],
  ["oidc_client_id", ""],
  ["oidc_client_secret", ""],
  ["oidc_scopes", "openid profile email"],
  ["oidc_auto_register", "1"],
  ["oidc_button_text", "OIDC 登录"],
  ["announcement_content", ""],
  ["icp_filing_number", ""],
  ["public_security_filing_number", ""],
];

export function seedDefaultSettings(db: BetterSqlite3.Database) {
  const initSetting = db.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
  );

  for (const [key, value] of DEFAULT_SETTINGS) {
    initSetting.run(key, value);
  }
}
