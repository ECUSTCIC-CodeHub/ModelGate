export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { applyAuthCookies, hashPassword, issueAuthTokens, sanitizeUser } from "@/lib/auth/auth";
import { jsonError, jsonOk } from "@/lib/core/http";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";
import { getGatewaySettings } from "@/lib/core/settings";
import { USERNAME_SCHEMA } from "@/lib/auth/username";
import { friendlyCredentialPayloadError } from "@/lib/auth/validation";

const schema = z.object({
  username: USERNAME_SCHEMA,
  password: z.string().min(8),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const rateCheck = checkLoginRateLimit(request, parsed.data.username);
  if (!rateCheck.ok) {
    return jsonError("注册尝试过于频繁，请稍后再试", 429);
  }

  const settings = await getGatewaySettings();

  const adminCount = await gatewayDb.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND deleted_at IS NULL");

  if (settings.registration_enabled !== 1 && (adminCount?.count ?? 0) > 0) {
    return jsonError("注册功能已关闭", 403);
  }

  if (settings.password_login_enabled === 0 && (adminCount?.count ?? 0) > 0) {
    return jsonError("当前仅支持 OIDC 登录，注册功能已关闭", 403);
  }

  const existing = await gatewayDb.queryOne<{ id: number }>("SELECT id FROM users WHERE username = ?", [parsed.data.username]);

  if (existing) return jsonError("注册失败，请检查输入", 400);

  const role: "admin" | "user" = (adminCount?.count ?? 0) === 0 ? "admin" : "user";
  const passwordHash = await hashPassword(parsed.data.password);

  const defaultGroup = await gatewayDb.queryOne<{ id: number }>("SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL");

  const result = await gatewayDb.execute(
    `INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, quota_tokens, quota_requests, enabled)
       VALUES (?, ?, ?, ?, -1, -1, -1, NULL, NULL, 1)`,
    [parsed.data.username, passwordHash, role, defaultGroup?.id ?? null],
  );

  const user = await gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [result.lastInsertRowid]) as DbUser;

  const payload = {
    message: "注册成功。",
    user: sanitizeUser(user),
    ...issueAuthTokens(user),
  };

  return applyAuthCookies(jsonOk(payload, 201), payload);
}
