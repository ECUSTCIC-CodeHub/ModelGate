export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureUser } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { softDeleteKey } from "@/lib/services/soft-delete-service";

const updateSchema = z.object({
  name: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
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

  const sets: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(parsed.data.enabled ? 1 : 0);
  }
  if (parsed.data.name !== undefined) {
    sets.push("name = ?");
    params.push(parsed.data.name.trim());
  }
  if (sets.length === 0) return jsonError("没有可更新的字段", 400);
  params.push(id);
  gatewayDb.prepare(`UPDATE keys SET ${sets.join(", ")} WHERE id = ?`).run(...params);

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
