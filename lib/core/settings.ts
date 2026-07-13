import { gatewayDb } from "@/lib/core/db";

const DEFAULTS = {
  registration_enabled: 1,
  upstream_retry_enabled: 1,
  upstream_retry_max_attempts: 3,
  upstream_retry_same_channel: 0,
} as const;

const GATEWAY_SETTINGS_CACHE_TTL_MS = 30_000;

export type GatewaySettings = {
  registration_enabled: number;
  password_login_enabled: number;
  upstream_retry_enabled: number;
  upstream_retry_max_attempts: number;
  upstream_retry_same_channel: number;
  upstream_circuit_breaker_enabled: number;
  upstream_strict_priority: number;
  ua_restrictions: string;
  log_retention_days: number;
  oidc_enabled: number;
  oidc_issuer_url: string;
  oidc_client_id: string;
  oidc_client_secret: string;
  oidc_scopes: string;
  oidc_auto_register: number;
  oidc_button_text: string;
  oidc_group_expire_days: number;
  public_base_url: string;
  announcement_content: string;
  announcement_display_count: number;
  access_guide_notice: string;
  webhook_secret: string;
  cors_enabled: number;
  icp_filing_number: string;
  public_security_filing_number: string;
  theme_color: string;
  logo_url: string;
  logo_square_url: string;
  feedback_url: string;
  repo_name: string;
};

let cachedGatewaySettings: { value: GatewaySettings; expiresAt: number } | null = null;

function positiveInt(value: string | null | undefined, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.trunc(num));
}

function retentionDays(value: string | null | undefined): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(Math.trunc(num), 3650);
}

function clampOidcGroupExpireDays(value: string | null | undefined): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 30;
  if (num === 0) return 0;
  return Math.min(Math.trunc(num), 3650);
}

const OIDC_KEYS = [
  "oidc_enabled",
  "oidc_issuer_url",
  "oidc_client_id",
  "oidc_client_secret",
  "oidc_scopes",
  "oidc_auto_register",
  "oidc_button_text",
  "oidc_group_expire_days",
  "public_base_url",
] as const;

const GATEWAY_KEYS = [
  "registration_enabled",
  "password_login_enabled",
  "upstream_retry_enabled",
  "upstream_retry_max_attempts",
  "upstream_retry_same_channel",
  "upstream_circuit_breaker_enabled",
  "upstream_strict_priority",
  "ua_restrictions",
  "log_retention_days",
  ...OIDC_KEYS,
  "announcement_content",
  "announcement_display_count",
  "access_guide_notice",
  "webhook_secret",
  "cors_enabled",
  "icp_filing_number",
  "public_security_filing_number",
  "theme_color",
  "logo_url",
  "logo_square_url",
  "feedback_url",
  "repo_name",
] as const;

const SETTINGS_SELECT_SQL = `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${GATEWAY_KEYS.map(() => "?").join(", ")})`;

async function readGatewaySettingsFromDb(): Promise<GatewaySettings> {
  const rows = await gatewayDb.query<{ key: string; value: string }>(SETTINGS_SELECT_SQL, [...GATEWAY_KEYS]);

  const map = new Map(rows.map((row) => [row.key, row.value]));

  return {
    registration_enabled: map.get("registration_enabled") === "0" ? 0 : 1,
    password_login_enabled: map.get("password_login_enabled") === "0" ? 0 : 1,
    upstream_retry_enabled: map.get("upstream_retry_enabled") === "0" ? 0 : 1,
    upstream_circuit_breaker_enabled: map.get("upstream_circuit_breaker_enabled") === "0" ? 0 : 1,
    upstream_strict_priority: map.get("upstream_strict_priority") === "1" ? 1 : 0,
    ua_restrictions: map.get("ua_restrictions") ?? "",
    log_retention_days: retentionDays(map.get("log_retention_days")),
    upstream_retry_max_attempts: positiveInt(
      map.get("upstream_retry_max_attempts"),
      DEFAULTS.upstream_retry_max_attempts,
    ),
    upstream_retry_same_channel: map.get("upstream_retry_same_channel") === "1" ? 1 : DEFAULTS.upstream_retry_same_channel,
    oidc_enabled: map.get("oidc_enabled") === "1" ? 1 : 0,
    oidc_issuer_url: map.get("oidc_issuer_url") ?? "",
    oidc_client_id: map.get("oidc_client_id") ?? "",
    oidc_client_secret: map.get("oidc_client_secret") ?? "",
    oidc_scopes: map.get("oidc_scopes") ?? "openid profile email",
    oidc_auto_register: map.get("oidc_auto_register") === "0" ? 0 : 1,
    oidc_button_text: map.get("oidc_button_text") || "OIDC 登录",
    oidc_group_expire_days: clampOidcGroupExpireDays(map.get("oidc_group_expire_days")),
    public_base_url: map.get("public_base_url") ?? "",
    announcement_content: map.get("announcement_content") ?? "",
    announcement_display_count: positiveInt(map.get("announcement_display_count"), 3),
    access_guide_notice: map.get("access_guide_notice") ?? "",
    webhook_secret: map.get("webhook_secret") ?? "",
    cors_enabled: map.get("cors_enabled") === "1" ? 1 : 0,
    icp_filing_number: map.get("icp_filing_number") ?? "",
    public_security_filing_number: map.get("public_security_filing_number") ?? "",
    theme_color: map.get("theme_color") ?? "",
    logo_url: map.get("logo_url") ?? "",
    logo_square_url: map.get("logo_square_url") ?? "",
    feedback_url: map.get("feedback_url") ?? "",
    repo_name: map.get("repo_name") ?? "",
  };
}

export async function getGatewaySettings(): Promise<GatewaySettings> {
  const now = Date.now();
  if (cachedGatewaySettings && cachedGatewaySettings.expiresAt > now) {
    return cachedGatewaySettings.value;
  }

  const value = await readGatewaySettingsFromDb();
  cachedGatewaySettings = { value, expiresAt: now + GATEWAY_SETTINGS_CACHE_TTL_MS };
  return value;
}

export async function setGatewaySettings(input: {
  registration_enabled: boolean;
  password_login_enabled: boolean;
  upstream_retry_enabled: boolean;
  upstream_retry_max_attempts: number;
  upstream_retry_same_channel: boolean;
  upstream_circuit_breaker_enabled: boolean;
  upstream_strict_priority: boolean;
  ua_restrictions?: string;
  log_retention_days?: number;
  oidc_enabled?: boolean;
  oidc_issuer_url?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  oidc_scopes?: string;
  oidc_auto_register?: boolean;
  oidc_button_text?: string;
  oidc_group_expire_days?: number;
  public_base_url?: string;
  announcement_content?: string;
  announcement_display_count?: number;
  access_guide_notice?: string;
  webhook_secret?: string;
  cors_enabled?: boolean;
  icp_filing_number?: string;
  public_security_filing_number?: string;
  theme_color?: string;
  logo_url?: string;
  logo_square_url?: string;
  feedback_url?: string;
  repo_name?: string;
}) {
  const values: Record<string, string> = {
    registration_enabled: input.registration_enabled ? "1" : "0",
    password_login_enabled: input.password_login_enabled ? "1" : "0",
    upstream_retry_enabled: input.upstream_retry_enabled ? "1" : "0",
    upstream_circuit_breaker_enabled: input.upstream_circuit_breaker_enabled ? "1" : "0",
    upstream_strict_priority: input.upstream_strict_priority ? "1" : "0",
    ua_restrictions: input.ua_restrictions ?? "",
    upstream_retry_max_attempts: String(Math.max(1, Math.trunc(input.upstream_retry_max_attempts))),
    upstream_retry_same_channel: input.upstream_retry_same_channel ? "1" : "0",
  };

  if (input.log_retention_days !== undefined) values.log_retention_days = String(Math.max(0, Math.min(3650, Math.trunc(input.log_retention_days))));
  if (input.oidc_enabled !== undefined) values.oidc_enabled = input.oidc_enabled ? "1" : "0";
  if (input.oidc_issuer_url !== undefined) values.oidc_issuer_url = input.oidc_issuer_url.trim();
  if (input.oidc_client_id !== undefined) values.oidc_client_id = input.oidc_client_id.trim();
  if (input.oidc_client_secret !== undefined) values.oidc_client_secret = input.oidc_client_secret.trim();
  if (input.oidc_scopes !== undefined) values.oidc_scopes = input.oidc_scopes.trim() || "openid profile email";
  if (input.oidc_auto_register !== undefined) values.oidc_auto_register = input.oidc_auto_register ? "1" : "0";
  if (input.oidc_button_text !== undefined) values.oidc_button_text = input.oidc_button_text.trim() || "OIDC 登录";
  if (input.oidc_group_expire_days !== undefined) values.oidc_group_expire_days = String(Math.min(3650, Math.max(0, Math.trunc(input.oidc_group_expire_days))));
  if (input.public_base_url !== undefined) values.public_base_url = input.public_base_url.trim().replace(/\/+$/, "");
  if (input.announcement_content !== undefined) values.announcement_content = input.announcement_content;
  if (input.announcement_display_count !== undefined) values.announcement_display_count = String(Math.max(1, Math.trunc(input.announcement_display_count)));
  if (input.access_guide_notice !== undefined) values.access_guide_notice = input.access_guide_notice;
  if (input.webhook_secret !== undefined) values.webhook_secret = input.webhook_secret.trim();
  if (input.cors_enabled !== undefined) values.cors_enabled = input.cors_enabled ? "1" : "0";
  if (input.icp_filing_number !== undefined) values.icp_filing_number = input.icp_filing_number.trim();
  if (input.public_security_filing_number !== undefined) values.public_security_filing_number = input.public_security_filing_number.trim();
  if (input.theme_color !== undefined) values.theme_color = input.theme_color.trim();
  if (input.logo_url !== undefined) values.logo_url = input.logo_url.trim();
  if (input.logo_square_url !== undefined) values.logo_square_url = input.logo_square_url.trim();
  if (input.feedback_url !== undefined) values.feedback_url = input.feedback_url.trim();
  if (input.repo_name !== undefined) values.repo_name = input.repo_name.trim();

  const isMysql = await gatewayDb.getDriver() === "mysql";
  const upsertSql = isMysql
    ? `INSERT INTO settings (\`key\`, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP`
    : `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`;

  await gatewayDb.transaction(async (tx) => {
    for (const [key, val] of Object.entries(values)) {
      await tx.execute(upsertSql, [key, val]);
    }
  });

  cachedGatewaySettings = null;
}
