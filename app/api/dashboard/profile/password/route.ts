export const dynamic = "force-dynamic";

import { z } from "zod";
import { comparePassword, hashPassword } from "@/lib/auth/auth";
import { gatewayDb, type DbUser } from "@/lib/core/db";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { friendlyCredentialPayloadError } from "@/lib/auth/validation";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

export async function PUT(request: Request) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const user = gatewayDb
    .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(guard.auth.user.id) as DbUser;

  const ok = await comparePassword(parsed.data.current_password, user.password_hash);
  if (!ok) return jsonError("当前密码不正确。", 400);

  const nextHash = await hashPassword(parsed.data.new_password);
  gatewayDb
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(nextHash, user.id);

  return jsonOk({ ok: true, message: "密码修改成功。" });
}
