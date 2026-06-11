import { randomBytes } from "node:crypto";
import { gatewayDb, type DbKey, type DbUser } from "@/lib/core/db";

export const AUTH_DISABLED = process.env.AUTH_DISABLED === "1" || process.env.AUTH_DISABLED === "true";

const NOAUTH_USERNAME = "noauth";

let cached: { user: DbUser; key: DbKey } | null = null;

export async function getNoAuthContext(): Promise<{ user: DbUser; key: DbKey }> {
  if (!AUTH_DISABLED) throw new Error("AUTH_DISABLED is not set");
  if (cached) return cached;

  let user = await gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL", [NOAUTH_USERNAME]);

  if (!user) {
    const defaultGroup = await gatewayDb.queryOne<{ id: number }>("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL");

    await gatewayDb.execute(
      `INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled)
         VALUES (?, ?, 'admin', ?, -1, -1, -1, 1)`,
      [NOAUTH_USERNAME, "noauth-no-password-login", defaultGroup?.id ?? null],
    );

    user = await gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL", [NOAUTH_USERNAME]) as DbUser;
  }

  let key = await gatewayDb.queryOne<DbKey>("SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL", [user.id]);

  if (!key) {
    const keyValue = `sk-gw-noauth-${randomBytes(16).toString("hex")}`;
    await gatewayDb.execute("INSERT INTO keys (`key`, user_id, enabled) VALUES (?, ?, 1)", [keyValue, user.id]);

    key = await gatewayDb.queryOne<DbKey>("SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL", [user.id]) as DbKey;
  }

  cached = { user, key };
  return cached;
}
