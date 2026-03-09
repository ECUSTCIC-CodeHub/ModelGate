export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

export { PUT, DELETE } from "@/app/api/user/keys/[id]/route";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = gatewayDb
    .prepare(
      `SELECT id, key, user_id, used_tokens, used_requests, enabled, created_at
       FROM keys
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(id, guard.auth.user.id);

  if (!row) return jsonError("密钥不存在", 404);
  return jsonOk({ data: row });
}
