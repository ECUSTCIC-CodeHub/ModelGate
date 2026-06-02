export const dynamic = "force-dynamic";

import { ensureAdmin } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;

  const row = gatewayDb
    .prepare("SELECT totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { totp_enabled: number } | undefined;

  if (!row) return jsonError("用户不存在", 404);
  if (row.totp_enabled !== 1) return jsonError("该用户未启用 TOTP", 400);

  gatewayDb
    .prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?")
    .run(id);

  return jsonOk({ message: "已撤销该用户的 TOTP。" });
}
