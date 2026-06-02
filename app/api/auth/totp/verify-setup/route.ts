export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { verifyTotpCode } from "@/lib/auth/totp";

const schema = z.object({
  code: z.string().length(6),
});

export async function POST(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("验证码格式错误", 400);

  const row = gatewayDb
    .prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(user.id) as { totp_secret: string | null; totp_enabled: number } | undefined;

  if (!row || !row.totp_secret) {
    return jsonError("请先发起 TOTP 设置", 400);
  }

  if (row.totp_enabled === 1) {
    return jsonError("TOTP 已启用", 409);
  }

  const valid = verifyTotpCode(row.totp_secret, parsed.data.code, user.id);
  if (!valid) {
    return jsonError("验证码错误", 401);
  }

  gatewayDb
    .prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?")
    .run(user.id);

  return jsonOk({ message: "TOTP 绑定成功。" });
}
