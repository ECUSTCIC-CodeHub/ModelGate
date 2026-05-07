import { gatewayDb } from "@/lib/db";

const DEFAULTS = {
  registration_enabled: 1,
  upstream_retry_enabled: 1,
  upstream_retry_max_attempts: 3,
} as const;

export type GatewaySettings = {
  registration_enabled: number;
  password_login_enabled: number;
  upstream_retry_enabled: number;
  upstream_retry_max_attempts: number;
  oidc_enabled: number;
  oidc_issuer_url: string;
  oidc_client_id: string;
  oidc_client_secret: string;
  oidc_scopes: string;
  oidc_auto_register: number;
  oidc_button_text: string;
  oidc_group_claim: string;
  public_base_url: string;
  announcement_content: string;
};

function positiveInt(value: string | null | undefined, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.trunc(num));
}

const OIDC_KEYS = [
  "oidc_enabled",
  "oidc_issuer_url",
  "oidc_client_id",
  "oidc_client_secret",
  "oidc_scopes",
  "oidc_auto_register",
  "oidc_button_text",
  "oidc_group_claim",
  "public_base_url",
] as const;

const GATEWAY_KEYS = [
  "registration_enabled",
  "password_login_enabled",
  "upstream_retry_enabled",
  "upstream_retry_max_attempts",
  ...OIDC_KEYS,
  "announcement_content",
] as const;

export function getGatewaySettings(): GatewaySettings {
  const placeholders = GATEWAY_KEYS.map(() => "?").join(", ");
  const rows = gatewayDb
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .all(...GATEWAY_KEYS) as Array<{ key: string; value: string }>;

  const map = new Map(rows.map((row) => [row.key, row.value]));

  return {
    registration_enabled: map.get("registration_enabled") === "0" ? 0 : 1,
    password_login_enabled: map.get("password_login_enabled") === "0" ? 0 : 1,
    upstream_retry_enabled: map.get("upstream_retry_enabled") === "0" ? 0 : 1,
    upstream_retry_max_attempts: positiveInt(
      map.get("upstream_retry_max_attempts"),
      DEFAULTS.upstream_retry_max_attempts,
    ),
    oidc_enabled: map.get("oidc_enabled") === "1" ? 1 : 0,
    oidc_issuer_url: map.get("oidc_issuer_url") ?? "",
    oidc_client_id: map.get("oidc_client_id") ?? "",
    oidc_client_secret: map.get("oidc_client_secret") ?? "",
    oidc_scopes: map.get("oidc_scopes") ?? "openid profile email",
    oidc_auto_register: map.get("oidc_auto_register") === "0" ? 0 : 1,
    oidc_button_text: map.get("oidc_button_text") || "OIDC 登录",
    oidc_group_claim: map.get("oidc_group_claim") ?? "",
    public_base_url: map.get("public_base_url") ?? "",
    announcement_content: map.get("announcement_content") ?? "",
  };
}

export function setGatewaySettings(input: {
  registration_enabled: boolean;
  password_login_enabled: boolean;
  upstream_retry_enabled: boolean;
  upstream_retry_max_attempts: number;
  oidc_enabled?: boolean;
  oidc_issuer_url?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  oidc_scopes?: string;
  oidc_auto_register?: boolean;
  oidc_button_text?: string;
  oidc_group_claim?: string;
  public_base_url?: string;
  announcement_content?: string;
}) {
  const values: Record<string, string> = {
    registration_enabled: input.registration_enabled ? "1" : "0",
    password_login_enabled: input.password_login_enabled ? "1" : "0",
    upstream_retry_enabled: input.upstream_retry_enabled ? "1" : "0",
    upstream_retry_max_attempts: String(Math.max(1, Math.trunc(input.upstream_retry_max_attempts))),
  };

  if (input.oidc_enabled !== undefined) values.oidc_enabled = input.oidc_enabled ? "1" : "0";
  if (input.oidc_issuer_url !== undefined) values.oidc_issuer_url = input.oidc_issuer_url.trim();
  if (input.oidc_client_id !== undefined) values.oidc_client_id = input.oidc_client_id.trim();
  if (input.oidc_client_secret !== undefined) values.oidc_client_secret = input.oidc_client_secret.trim();
  if (input.oidc_scopes !== undefined) values.oidc_scopes = input.oidc_scopes.trim() || "openid profile email";
  if (input.oidc_auto_register !== undefined) values.oidc_auto_register = input.oidc_auto_register ? "1" : "0";
  if (input.oidc_button_text !== undefined) values.oidc_button_text = input.oidc_button_text.trim() || "OIDC 登录";
  if (input.oidc_group_claim !== undefined) values.oidc_group_claim = input.oidc_group_claim.trim();
  if (input.public_base_url !== undefined) values.public_base_url = input.public_base_url.trim().replace(/\/+$/, "");
  if (input.announcement_content !== undefined) values.announcement_content = input.announcement_content;

  const upsert = gatewayDb.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
  );

  const tx = gatewayDb.transaction(() => {
    for (const [key, val] of Object.entries(values)) {
      upsert.run(key, val);
    }
  });

  tx();
}
