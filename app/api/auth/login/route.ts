export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, comparePassword, issueAuthTokens, sanitizeUser } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { jsonError, jsonOk } from "@/lib/core/http";
import { checkLoginRateLimit } from "@/lib/auth/login-ratelimit";
import { getGatewaySettings } from "@/lib/core/settings";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const settings = getGatewaySettings();
  if (settings.password_login_enabled !== 1) {
    return jsonError("账号密码登录已关闭", 403);
  }

  const rateCheck = checkLoginRateLimit(request);
  if (!rateCheck.ok) {
    return jsonError("登录尝试过于频繁，请稍后再试", 429);
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("用户名或密码错误", 401);

  const user = gatewayDb
    .prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL")
    .get(parsed.data.username) as DbUser | undefined;

  if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);

  const ok = await comparePassword(parsed.data.password, user.password_hash);
  if (!ok) return jsonError("用户名或密码错误", 401);

  const payload = {
    message: "登录成功。",
    user: sanitizeUser(user),
    ...issueAuthTokens(user),
  };

  return applyAuthCookies(jsonOk(payload), payload);
}
