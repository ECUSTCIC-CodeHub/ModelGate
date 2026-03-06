import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

const updateSchema = z.object({
  alias: z.string().min(1).optional(),
  real_model: z.string().min(1).optional(),
  channel_id: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = gatewayDb
    .prepare(
      `SELECT m.*, c.name AS channel_name
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.id = ?`,
    )
    .get(id);
  if (!row) return jsonError("模型不存在", 404);
  return jsonOk({ message: "模型更新成功。", data: row });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb.prepare("SELECT * FROM models WHERE id = ?").get(id) as
    | {
        id: number;
        alias: string;
        real_model: string;
        channel_id: number;
        enabled: number;
        weight: number;
      }
    | undefined;
  if (!existing) return jsonError("模型不存在", 404);

  if (parsed.data.channel_id !== undefined) {
    const channel = gatewayDb
      .prepare("SELECT id FROM channels WHERE id = ?")
      .get(parsed.data.channel_id) as { id: number } | undefined;
    if (!channel) return jsonError("渠道不存在", 404);
  }

  const merged = {
    ...existing,
    ...parsed.data,
    enabled:
      parsed.data.enabled === undefined
        ? existing.enabled
        : parsed.data.enabled
          ? 1
          : 0,
  };

  gatewayDb
    .prepare(
      `UPDATE models
       SET alias = ?, real_model = ?, channel_id = ?, enabled = ?, weight = ?
       WHERE id = ?`,
    )
    .run(merged.alias, merged.real_model, merged.channel_id, merged.enabled, merged.weight, id);

  const row = gatewayDb.prepare("SELECT * FROM models WHERE id = ?").get(id);
  return jsonOk({ data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const existing = gatewayDb.prepare("SELECT id FROM models WHERE id = ?").get(id) as { id: number } | undefined;
  if (!existing) return jsonError("模型不存在", 404);

  gatewayDb.prepare("DELETE FROM models WHERE id = ?").run(id);
  return jsonOk({ ok: true, message: "模型删除成功。" });
}
