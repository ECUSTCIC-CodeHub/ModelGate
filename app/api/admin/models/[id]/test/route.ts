export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { testUpstreamModel } from "@/lib/proxy";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = gatewayDb
    .prepare(
      `SELECT
         m.id AS model_id,
         m.alias,
         m.real_model,
         c.id AS channel_id,
         c.name AS channel_name,
         c.base_url,
         c.api_key,
         c.timeout
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.id = ? AND m.deleted_at IS NULL`,
    )
    .get(id) as
    | {
        model_id: number;
        alias: string;
        real_model: string;
        channel_id: number;
        channel_name: string;
        base_url: string;
        api_key: string;
        timeout: number;
      }
    | undefined;

  if (!row) return jsonError("模型不存在", 404);

  const result = await testUpstreamModel({
    channel: {
      base_url: row.base_url,
      api_key: row.api_key,
      timeout: row.timeout,
    },
    model: {
      real_model: row.real_model,
    },
  });

  return jsonOk(
    {
      message: result.ok ? "模型测试成功。" : "模型测试失败。",
      data: {
        model_id: row.model_id,
        model_alias: row.alias,
        real_model: row.real_model,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        ok: result.ok,
        status: result.status,
        latency_ms: result.latency_ms,
        body_preview: result.body_preview,
      },
    },
    result.ok ? 200 : 502,
  );
}
