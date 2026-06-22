export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { testUpstreamModel } from "@/lib/gateway/proxy";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = await gatewayDb
    .queryOne<{
        id: number;
        name: string;
        base_url: string;
        api_key: string | null;
        user_agent: string;
        proxy_url: string;
        timeout: number;
      }>(
        "SELECT id, name, base_url, api_key, user_agent, proxy_url, timeout FROM channels WHERE id = ?",
        [id],
      );

  if (!channel) return jsonError("渠道不存在", 404);

  const model = await gatewayDb
    .queryOne<{
        id: number;
        alias: string;
        real_model: string;
        upstream_protocol: GatewayProtocol;
      }>(
        `SELECT id, alias, real_model, upstream_protocol
       FROM models
       WHERE channel_id = ? AND enabled = 1 AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT 1`,
        [id],
      );

  if (!model) return jsonError("该渠道下没有可测试的启用模型", 400);

  const result = await testUpstreamModel({
    channel,
    model: {
      real_model: model.real_model,
      upstream_protocol: model.upstream_protocol,
    },
  });
  const status = result.ok ? 200 : 502;

  return jsonOk(
    {
      message: result.ok ? "模型测试成功。" : "模型测试失败。",
      data: {
        channel_id: channel.id,
        channel_name: channel.name,
        model_id: model.id,
        model_alias: model.alias,
        real_model: model.real_model,
        ok: result.ok,
        status: result.status,
        latency_ms: result.latency_ms,
        body_preview: result.body_preview,
      },
    },
    status,
  );
}
