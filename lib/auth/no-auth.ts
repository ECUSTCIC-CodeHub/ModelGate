import { randomBytes } from "node:crypto";
import { gatewayDb, type DbKey, type DbUser } from "@/lib/core/db";

export const AUTH_DISABLED = process.env.AUTH_DISABLED === "1" || process.env.AUTH_DISABLED === "true";

const NOAUTH_USERNAME = "noauth";

let cached: { user: DbUser; key: DbKey } | null = null;

export function getNoAuthContext(): { user: DbUser; key: DbKey } {
  if (!AUTH_DISABLED) throw new Error("AUTH_DISABLED is not set");
  if (cached) return cached;

  let user = gatewayDb
    .prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL")
    .get(NOAUTH_USERNAME) as DbUser | undefined;

  if (!user) {
    const defaultGroup = gatewayDb
      .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
      .get() as { id: number } | undefined;

    gatewayDb
      .prepare(
        `INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled)
         VALUES (?, ?, 'admin', ?, -1, -1, -1, 1)`,
      )
      .run(NOAUTH_USERNAME, "noauth-no-password-login", defaultGroup?.id ?? null);

    user = gatewayDb
      .prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL")
      .get(NOAUTH_USERNAME) as DbUser;
  }

  let key = gatewayDb
    .prepare("SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL")
    .get(user.id) as DbKey | undefined;

  if (!key) {
    const keyValue = `sk-gw-noauth-${randomBytes(16).toString("hex")}`;
    gatewayDb
      .prepare("INSERT INTO keys (key, user_id, enabled) VALUES (?, ?, 1)")
      .run(keyValue, user.id);

    key = gatewayDb
      .prepare("SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL")
      .get(user.id) as DbKey;
  }

  cached = { user, key };
  return cached;
}
