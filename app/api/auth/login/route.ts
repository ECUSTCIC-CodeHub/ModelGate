export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, comparePassword, issueAuthTokens, sanitizeUser, signTotpPendingToken } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { jsonError, jsonOk } from "@/lib/core/http";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";
import { getGatewaySettings } from "@/lib/core/settings";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const settings = await getGatewaySettings();
  if (settings.password_login_enabled !== 1) {
    return jsonError("账号密码登录已关闭", 403);
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);

  const rateCheck = checkLoginRateLimit(request, parsed.success ? parsed.data.username : undefined);
  if (!rateCheck.ok) {
    return jsonError("登录尝试过于频繁，请稍后再试", 429);
  }

  if (!parsed.success) return jsonError("用户名或密码错误", 401);

  const user = await gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL", [parsed.data.username]);

  if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);

  const ok = await comparePassword(parsed.data.password, user.password_hash);
  if (!ok) return jsonError("用户名或密码错误", 401);

  if (user.totp_enabled === 1 && user.totp_secret) {
    const pendingToken = signTotpPendingToken(user);
    return jsonOk({
      totp_required: true,
      pending_token: pendingToken,
    });
  }

  const payload = {
    message: "登录成功。",
    user: sanitizeUser(user),
    ...issueAuthTokens(user),
  };

  return applyAuthCookies(jsonOk(payload), payload);
}
