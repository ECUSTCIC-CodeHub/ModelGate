export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { testUpstreamModel } from "@/lib/proxy";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = gatewayDb
    .prepare("SELECT id, name, base_url, api_key, timeout FROM channels WHERE id = ?")
    .get(id) as
    | {
        id: number;
        name: string;
        base_url: string;
        api_key: string;
        timeout: number;
      }
    | undefined;

  if (!channel) return jsonError("渠道不存在", 404);

  const model = gatewayDb
    .prepare(
      `SELECT id, alias, real_model
       FROM models
       WHERE channel_id = ? AND enabled = 1 AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(id) as
    | {
        id: number;
        alias: string;
        real_model: string;
      }
    | undefined;

  if (!model) return jsonError("该渠道下没有可测试的启用模型", 400);

  const result = await testUpstreamModel({
    channel,
    model: {
      real_model: model.real_model,
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
