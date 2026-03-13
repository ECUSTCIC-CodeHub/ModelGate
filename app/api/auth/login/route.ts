export const dynamic = "force-dynamic";

import { z } from "zod";
import { applyAuthCookies, comparePassword, issueAuthTokens, sanitizeUser } from "@/lib/auth";
import { gatewayDb, type DbUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
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
