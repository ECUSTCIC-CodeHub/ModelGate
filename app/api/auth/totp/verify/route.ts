export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, issueAuthTokens, sanitizeUser, verifyTotpPendingToken } from "@/lib/auth/auth";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { verifyTotpCode } from "@/lib/auth/totp";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";

const schema = z.object({
  pending_token: z.string().min(1),
  code: z.string().length(6),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数错误", 400);

  const payload = verifyTotpPendingToken(parsed.data.pending_token);
  if (!payload) return jsonError("令牌无效或已过期，请重新登录", 401);

  const rateCheck = checkLoginRateLimit(request, payload.username);
  if (!rateCheck.ok) {
    return jsonError("验证尝试过于频繁，请稍后再试", 429);
  }

  const user = await gatewayDb
    .queryOne<DbUser>("SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL", [Number(payload.sub)]);

  if (!user) return jsonError("用户不存在或已禁用", 401);
  if (user.totp_enabled !== 1 || !user.totp_secret) {
    return jsonError("TOTP 未启用", 400);
  }

  const valid = verifyTotpCode(user.totp_secret, parsed.data.code, user.id);
  if (!valid) {
    return jsonError("验证码错误", 401);
  }

  const tokens = issueAuthTokens(user);
  const result = {
    message: "登录成功。",
    user: sanitizeUser(user),
    ...tokens,
  };

  return applyAuthCookies(jsonOk(result), result);
}
