import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

export { PUT, DELETE } from "@/app/api/admin/users/[id]/route";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = gatewayDb
    .prepare(
      `SELECT id, username, role, rpm, qps, tpm, quota_tokens, quota_requests, used_tokens, used_requests, enabled, created_at
       FROM users WHERE id = ?`,
    )
    .get(id);

  if (!row) return jsonError("用户不存在", 404);
  return jsonOk({ data: row });
}
