export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { softDeleteKey } from "@/lib/services/soft-delete-service";

const updateSchema = z.object({
  enabled: z.boolean(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb
    .prepare("SELECT * FROM keys WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .get(id, guard.auth.user.id);
  if (!existing) return jsonError("密钥不存在", 404);

  gatewayDb
    .prepare("UPDATE keys SET enabled = ? WHERE id = ?")
    .run(parsed.data.enabled ? 1 : 0, id);

  const row = gatewayDb.prepare("SELECT * FROM keys WHERE id = ? AND deleted_at IS NULL").get(id);
  return jsonOk({ message: "密钥更新成功。", data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureUser(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const existing = gatewayDb
    .prepare("SELECT * FROM keys WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .get(id, guard.auth.user.id);
  if (!existing) return jsonError("密钥不存在", 404);

  softDeleteKey(id);
  return jsonOk({ ok: true, message: "密钥删除成功。" });
}
