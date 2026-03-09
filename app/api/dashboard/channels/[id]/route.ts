export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

export { PUT, DELETE } from "@/app/api/admin/channels/[id]/route";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = gatewayDb
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!channel) return jsonError("渠道不存在", 404);

  const models = gatewayDb
    .prepare("SELECT id, alias, real_model, channel_id, enabled, weight, created_at FROM models WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC")
    .all(id);

  return jsonOk({ data: { ...channel, models } });
}
