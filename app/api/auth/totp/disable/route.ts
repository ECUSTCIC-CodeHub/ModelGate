export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { comparePassword } from "@/lib/auth/auth";
import { getAuthStatus } from "@/lib/auth/auth-status";
import { verifyTotpCode } from "@/lib/auth/totp";

const schema = z.object({
  password: z.string().min(1).optional(),
  code: z.string().length(6).optional(),
});

export async function POST(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数错误", 400);

  const row = await gatewayDb
    .queryOne<{ password_hash: string; totp_secret: string | null; totp_enabled: number }>("SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL", [user.id]);

  if (!row) return jsonError("用户不存在", 404);
  if (row.totp_enabled !== 1 || !row.totp_secret) {
    return jsonError("TOTP 未启用", 400);
  }

  if ((await getAuthStatus()).password_login_enabled) {
    if (!parsed.data.password) return jsonError("请输入当前密码", 400);
    const ok = await comparePassword(parsed.data.password, row.password_hash);
    if (!ok) return jsonError("密码错误", 401);
  } else {
    if (!parsed.data.code) return jsonError("请输入 6 位验证码", 400);
    const valid = verifyTotpCode(row.totp_secret, parsed.data.code, user.id);
    if (!valid) return jsonError("验证码错误", 401);
  }

  await gatewayDb
    .execute("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?", [user.id]);

  return jsonOk({ message: "TOTP 已解绑。" });
}
