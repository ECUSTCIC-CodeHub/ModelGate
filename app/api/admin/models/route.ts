export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

const createSchema = z.object({
  alias: z.string().min(1),
  real_model: z.string().min(1),
  channel_id: z.number().int().positive(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const rows = gatewayDb
    .prepare(
      `SELECT m.*, c.name AS channel_name
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at IS NULL
       ORDER BY m.id DESC`,
    )
    .all();

  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const channel = gatewayDb
    .prepare("SELECT id FROM channels WHERE id = ?")
    .get(parsed.data.channel_id) as { id: number } | undefined;
  if (!channel) return jsonError("渠道不存在", 404);

  const result = gatewayDb
    .prepare(
      `INSERT INTO models (alias, real_model, channel_id, enabled, weight)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.data.alias,
      parsed.data.real_model,
      parsed.data.channel_id,
      parsed.data.enabled === false ? 0 : 1,
      parsed.data.weight ?? 1,
    );

  const row = gatewayDb.prepare("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL").get(result.lastInsertRowid);
  return jsonOk({ message: "模型创建成功。", data: row }, 201);
}
