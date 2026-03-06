import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb.prepare("SELECT * FROM channels WHERE id = ?").get(id);
  if (!existing) return jsonError("渠道不存在", 404);

  const merged = {
    ...existing,
    ...parsed.data,
    enabled:
      parsed.data.enabled === undefined
        ? (existing as { enabled: number }).enabled
        : parsed.data.enabled
          ? 1
          : 0,
  };

  gatewayDb
    .prepare(
      `UPDATE channels
       SET name = ?, base_url = ?, api_key = ?, enabled = ?, weight = ?, timeout = ?
       WHERE id = ?`,
    )
    .run(
      (merged as { name: string }).name,
      (merged as { base_url: string }).base_url,
      (merged as { api_key: string }).api_key,
      (merged as { enabled: number }).enabled,
      (merged as { weight: number }).weight,
      (merged as { timeout: number }).timeout,
      id,
    );

  const row = gatewayDb.prepare("SELECT * FROM channels WHERE id = ?").get(id);
  return jsonOk({ message: "渠道更新成功。", data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const tx = gatewayDb.transaction(() => {
    gatewayDb.prepare("DELETE FROM models WHERE channel_id = ?").run(id);
    gatewayDb.prepare("DELETE FROM channels WHERE id = ?").run(id);
  });
  tx();
  return jsonOk({ ok: true, message: "渠道删除成功。" });
}
