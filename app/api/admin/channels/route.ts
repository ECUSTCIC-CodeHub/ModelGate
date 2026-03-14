export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

const createSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  models: z
    .array(
      z.object({
        alias: z.string().min(1),
        real_model: z.string().min(1),
        is_public: z.boolean().optional(),
        enabled: z.boolean().optional(),
        weight: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const channels = gatewayDb.prepare("SELECT * FROM channels ORDER BY id DESC").all() as Array<Record<string, unknown> & { id: number }>;
  const models = gatewayDb
    .prepare("SELECT id, alias, real_model, channel_id, is_public, enabled, weight, created_at FROM models WHERE deleted_at IS NULL ORDER BY id DESC")
    .all() as Array<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    is_public: number;
    enabled: number;
    weight: number;
    created_at: string;
  }>;

  const grouped = new Map<number, typeof models>();
  for (const model of models) {
    const list = grouped.get(model.channel_id) ?? [];
    list.push(model);
    grouped.set(model.channel_id, list);
  }

  const rows = channels.map((channel) => ({
    ...channel,
    models: grouped.get(channel.id) ?? [],
  }));
  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const tx = gatewayDb.transaction(() => {
    const result = gatewayDb
      .prepare(
        `INSERT INTO channels (name, base_url, api_key, enabled, weight, timeout)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.data.name,
        parsed.data.base_url,
        parsed.data.api_key,
        parsed.data.enabled === false ? 0 : 1,
        parsed.data.weight ?? 1,
        parsed.data.timeout ?? 60,
      );

    const channelId = Number(result.lastInsertRowid);
    for (const model of parsed.data.models ?? []) {
      gatewayDb
        .prepare(
          `INSERT INTO models (alias, real_model, channel_id, is_public, enabled, weight)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          model.alias,
          model.real_model,
          channelId,
          model.is_public === false ? 0 : 1,
          model.enabled === false ? 0 : 1,
          model.weight ?? 1,
        );
    }

    return channelId;
  });

  const channelId = tx();
  const row = gatewayDb.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
  return jsonOk({ message: "渠道创建成功。", data: row }, 201);
}
