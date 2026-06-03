export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { testUpstreamModel } from "@/lib/gateway/proxy";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

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
         m.upstream_protocol,
         c.id AS channel_id,
         c.name AS channel_name,
         c.base_url,
         c.api_key,
         c.user_agent,
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
        upstream_protocol: GatewayProtocol;
        channel_id: number;
        channel_name: string;
        base_url: string;
        api_key: string;
        user_agent: string;
        timeout: number;
      }
    | undefined;

  if (!row) return jsonError("模型不存在", 404);

  const result = await testUpstreamModel({
    channel: {
      base_url: row.base_url,
      api_key: row.api_key,
      user_agent: row.user_agent,
      timeout: row.timeout,
    },
    model: {
      real_model: row.real_model,
      upstream_protocol: row.upstream_protocol,
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
        summary: result.summary,
        body_preview: result.body_preview,
      },
    },
    result.ok ? 200 : 502,
  );
}
