export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb, type DbUser } from "@/lib/db";
import { applyAuthCookies, hashPassword, issueAuthTokens, sanitizeUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getGatewaySettings } from "@/lib/settings";
import { USERNAME_SCHEMA } from "@/lib/username";
import { friendlyCredentialPayloadError } from "@/lib/validation";

const schema = z.object({
  username: USERNAME_SCHEMA,
  password: z.string().min(8),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const settings = getGatewaySettings();

  const adminCount = gatewayDb.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL").get() as {
    count: number;
  };

  if (settings.registration_enabled !== 1 && adminCount.count > 0) {
    return jsonError("注册功能已关闭", 403);
  }

  const existing = gatewayDb
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(parsed.data.username) as { id: number } | undefined;

  if (existing) return jsonError("用户名已存在", 409);

  const role: "admin" | "user" = adminCount.count === 0 ? "admin" : "user";
  const passwordHash = await hashPassword(parsed.data.password);

  const defaultGroup = gatewayDb
    .prepare("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL")
    .get() as { id: number } | undefined;

  const result = gatewayDb
    .prepare(
      `INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, quota_tokens, quota_requests, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      parsed.data.username,
      passwordHash,
      role,
      defaultGroup?.id ?? null,
      settings.default_rpm,
      settings.default_qps,
      settings.default_tpm,
      settings.default_quota_tokens < 0 ? null : settings.default_quota_tokens,
      settings.default_quota_requests < 0 ? null : settings.default_quota_requests,
    );

  const user = gatewayDb
    .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(result.lastInsertRowid) as DbUser;

  const payload = {
    message: "注册成功。",
    user: sanitizeUser(user),
    ...issueAuthTokens(user),
  };

  return applyAuthCookies(jsonOk(payload, 201), payload);
}
