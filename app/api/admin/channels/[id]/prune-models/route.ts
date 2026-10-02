export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { fetchUpstreamModelIds } from "@/lib/gateway/upstream-model-list";
import { diffChannelModels, type CleanupCandidate } from "@/lib/services/model-cleanup";
import { softDeleteModels } from "@/lib/services/soft-delete-service";

const bodySchema = z.object({
  dry_run: z.boolean().optional().default(true),
  ids: z.array(z.number().int().positive()).max(2000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = await gatewayDb.queryOne<{
    id: number;
    name: string;
    base_url: string;
    api_key: string | null;
    user_agent: string | null;
    proxy_url: string | null;
  }>(
    "SELECT id, name, base_url, api_key, user_agent, proxy_url FROM channels WHERE id = ? AND deleted_at IS NULL",
    [id],
  );
  if (!channel) return jsonError("渠道不存在", 404);

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.dry_run) {
    const upstream = await fetchUpstreamModelIds({
      baseUrl: channel.base_url,
      apiKey: channel.api_key,
      userAgent: channel.user_agent,
      proxyUrl: channel.proxy_url,
    });
    if (!upstream.ok) return jsonError(upstream.message, 502);

    const models = await gatewayDb.query<CleanupCandidate>(
      "SELECT id, alias, real_model, enabled FROM models WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id",
      [id],
    );
    const diff = diffChannelModels(models, upstream.ids);

    return jsonOk({
      message: diff.stale.length > 0 ? `发现 ${diff.stale.length} 个上游已不存在的模型。` : "上游模型与本地一致，无需清理。",
      data: {
        channel_id: channel.id,
        channel_name: channel.name,
        upstream_count: upstream.ids.length,
        local_count: models.length,
        kept: diff.kept,
        skipped_wildcard: diff.skippedWildcard,
        stale: diff.stale,
        missing_upstream: diff.missingUpstream,
      },
    });
  }

  const ids = [...new Set(parsed.data.ids ?? [])];
  if (ids.length === 0) return jsonError("请选择要删除的模型", 400);

  const placeholders = ids.map(() => "?").join(", ");
  const owned = await gatewayDb.query<{ id: number }>(
    `SELECT id FROM models WHERE channel_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    [id, ...ids],
  );
  if (owned.length === 0) return jsonError("没有可删除的模型", 400);

  const result = await softDeleteModels(owned.map((row) => row.id));
  return jsonOk({
    message: `已删除 ${result.deleted} 个模型。`,
    data: { deleted: result.deleted, aliases_cleaned: result.aliasesCleaned },
  });
}
