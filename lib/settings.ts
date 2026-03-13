import { gatewayDb } from "@/lib/db";

const DEFAULTS = {
  registration_enabled: 1,
  default_qps: -1,
  default_rpm: -1,
  default_tpm: -1,
  default_quota_requests: -1,
  default_quota_tokens: -1,
  upstream_retry_enabled: 1,
  upstream_retry_max_attempts: 3,
} as const;

type SettingsKey = keyof typeof DEFAULTS;

export type GatewaySettings = {
  registration_enabled: number;
  default_qps: number;
  default_rpm: number;
  default_tpm: number;
  default_quota_requests: number;
  default_quota_tokens: number;
  upstream_retry_enabled: number;
  upstream_retry_max_attempts: number;
};

function rateLimitInt(value: string | null | undefined, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.trunc(num);
  if (intVal < -1) return -1;
  return intVal;
}

function positiveInt(value: string | null | undefined, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.trunc(num));
}

export function getGatewaySettings(): GatewaySettings {
  const rows = gatewayDb
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('registration_enabled', 'default_qps', 'default_rpm', 'default_tpm', 'default_quota_requests', 'default_quota_tokens', 'upstream_retry_enabled', 'upstream_retry_max_attempts')",
    )
    .all() as Array<{ key: string; value: string }>;

  const map = new Map(rows.map((row) => [row.key, row.value]));

  return {
    registration_enabled: map.get("registration_enabled") === "0" ? 0 : 1,
    default_qps: rateLimitInt(map.get("default_qps"), DEFAULTS.default_qps),
    default_rpm: rateLimitInt(map.get("default_rpm"), DEFAULTS.default_rpm),
    default_tpm: rateLimitInt(map.get("default_tpm"), DEFAULTS.default_tpm),
    default_quota_requests: rateLimitInt(map.get("default_quota_requests"), DEFAULTS.default_quota_requests),
    default_quota_tokens: rateLimitInt(map.get("default_quota_tokens"), DEFAULTS.default_quota_tokens),
    upstream_retry_enabled: map.get("upstream_retry_enabled") === "0" ? 0 : 1,
    upstream_retry_max_attempts: positiveInt(
      map.get("upstream_retry_max_attempts"),
      DEFAULTS.upstream_retry_max_attempts,
    ),
  };
}

export function setGatewaySettings(input: {
  registration_enabled: boolean;
  default_qps: number;
  default_rpm: number;
  default_tpm: number;
  default_quota_requests: number;
  default_quota_tokens: number;
  upstream_retry_enabled: boolean;
  upstream_retry_max_attempts: number;
}) {
  const values: Record<SettingsKey, string> = {
    registration_enabled: input.registration_enabled ? "1" : "0",
    default_qps: String(Math.max(-1, Math.trunc(input.default_qps))),
    default_rpm: String(Math.max(-1, Math.trunc(input.default_rpm))),
    default_tpm: String(Math.max(-1, Math.trunc(input.default_tpm))),
    default_quota_requests: String(Math.max(-1, Math.trunc(input.default_quota_requests))),
    default_quota_tokens: String(Math.max(-1, Math.trunc(input.default_quota_tokens))),
    upstream_retry_enabled: input.upstream_retry_enabled ? "1" : "0",
    upstream_retry_max_attempts: String(Math.max(1, Math.trunc(input.upstream_retry_max_attempts))),
  };

  const upsert = gatewayDb.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
  );

  const tx = gatewayDb.transaction(() => {
    (Object.keys(values) as SettingsKey[]).forEach((key) => {
      upsert.run(key, values[key]);
    });
  });

  tx();
}
