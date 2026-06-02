export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { comparePassword } from "@/lib/auth/auth";

const schema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请输入当前密码", 400);

  const row = gatewayDb
    .prepare("SELECT password_hash, totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(user.id) as { password_hash: string; totp_enabled: number } | undefined;

  if (!row) return jsonError("用户不存在", 404);

  const ok = await comparePassword(parsed.data.password, row.password_hash);
  if (!ok) return jsonError("密码错误", 401);

  if (row.totp_enabled !== 1) {
    return jsonError("TOTP 未启用", 400);
  }

  gatewayDb
    .prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?")
    .run(user.id);

  return jsonOk({ message: "TOTP 已解绑。" });
}
