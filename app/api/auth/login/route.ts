import { z } from "zod";
import { comparePassword, issueAuthTokens, sanitizeUser } from "@/lib/auth";
import { gatewayDb, type DbUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { USERNAME_SCHEMA } from "@/lib/username";
import { friendlyCredentialPayloadError } from "@/lib/validation";

const schema = z.object({
  username: USERNAME_SCHEMA,
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const user = gatewayDb
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(parsed.data.username) as DbUser | undefined;

  if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);

  const ok = await comparePassword(parsed.data.password, user.password_hash);
  if (!ok) return jsonError("用户名或密码错误", 401);

  return jsonOk({
    message: "登录成功。",
    user: sanitizeUser(user),
    ...issueAuthTokens(user),
  });
}
