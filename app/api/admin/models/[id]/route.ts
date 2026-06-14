export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, type GatewayProtocol, normalizeSupportedProtocols, parseSupportedProtocols, stringifySupportedProtocols, supportsProtocol } from "@/lib/gateway/protocols";
import type { ModelQuotaMode } from "@/lib/core/db/types";
import { softDeleteModel } from "@/lib/services/soft-delete-service";

const QUOTA_MODES = ["follow_group", "bypass_group", "independent"] as const;

const updateSchema = z.object({
  alias: z.string().min(1).optional(),
  real_model: z.string().min(1).optional(),
  channel_id: z.number().int().positive().optional(),
  upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
  supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).optional(),
  copilot_compatibility: z.boolean().optional(),
  is_public: z.boolean().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  token_multiplier: z.number().min(0).max(100).optional(),
  request_multiplier: z.number().min(0).max(100).optional(),
  max_concurrency: z.number().int().min(0).optional(),
  quota_mode: z.enum(QUOTA_MODES).optional(),
  quota_tokens: z.number().int().min(0).nullable().optional(),
  quota_requests: z.number().int().min(0).nullable().optional(),
  quota_period: z.number().int().min(0).nullable().optional(),
  period_quota_tokens: z.number().int().min(0).nullable().optional(),
  period_quota_requests: z.number().int().min(0).nullable().optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const row = await gatewayDb
    .queryOne(
      `SELECT m.*, c.name AS channel_name
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.id = ? AND m.deleted_at IS NULL`,
      [id],
    );
  if (!row) return jsonError("模型不存在", 404);
  return jsonOk({ message: "模型更新成功。", data: row });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = await gatewayDb.queryOne<{
        id: number;
        alias: string;
        real_model: string;
        channel_id: number;
        upstream_protocol: GatewayProtocol;
        supported_protocols: string | null;
        copilot_compatibility: number;
        is_public: number;
        enabled: number;
        weight: number;
        token_multiplier: number;
        request_multiplier: number;
        max_concurrency: number;
        quota_mode: ModelQuotaMode;
        quota_tokens: number | null;
        quota_requests: number | null;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
      }>("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!existing) return jsonError("模型不存在", 404);

  const targetChannelId = parsed.data.channel_id ?? existing.channel_id;
  const targetProtocol = parsed.data.upstream_protocol ?? existing.upstream_protocol;
  const targetEnabled =
    parsed.data.enabled === undefined
      ? existing.enabled
      : parsed.data.enabled
        ? 1
        : 0;
  const channel = await gatewayDb
    .queryOne<{ id: number; supported_protocols: string; enabled: number }>("SELECT id, supported_protocols, enabled FROM channels WHERE id = ? AND deleted_at IS NULL", [targetChannelId]);
  if (!channel) return jsonError("渠道不存在", 404);
  if (!supportsProtocol(channel.supported_protocols, targetProtocol)) {
    return jsonError("所选渠道不支持该上游协议", 400);
  }
  const channelProtocols = parseSupportedProtocols(channel.supported_protocols);
  const rawModelProtocols = parsed.data.supported_protocols ?? parseSupportedProtocols(existing.supported_protocols);
  const validModelProtocols = rawModelProtocols.filter((p) => channelProtocols.includes(p));
  if (validModelProtocols.length === 0) {
    return jsonError("至少需要一个渠道支持的可用协议", 400);
  }
  if (!validModelProtocols.includes(targetProtocol)) {
    return jsonError("默认上游协议必须在可用协议中", 400);
  }
  const targetSupportedProtocols = stringifySupportedProtocols(validModelProtocols);
  if (targetEnabled === 1 && channel.enabled !== 1) {
    return jsonError("禁用渠道下不能启用模型", 400);
  }

  const merged = {
    ...existing,
    ...parsed.data,
    upstream_protocol: targetProtocol,
    is_public:
      parsed.data.is_public === undefined
        ? existing.is_public
        : parsed.data.is_public
          ? 1
          : 0,
    enabled: targetEnabled,
  };

  await gatewayDb
    .execute(
      `UPDATE models
       SET alias = ?, real_model = ?, channel_id = ?, upstream_protocol = ?, supported_protocols = ?, copilot_compatibility = ?, is_public = ?, enabled = ?, weight = ?, token_multiplier = ?, request_multiplier = ?, max_concurrency = ?,
           quota_mode = ?, quota_tokens = ?, quota_requests = ?, quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?
       WHERE id = ?`,
      [merged.alias, merged.real_model, merged.channel_id, merged.upstream_protocol, targetSupportedProtocols, parsed.data.copilot_compatibility === true ? 1 : parsed.data.copilot_compatibility === false ? 0 : existing.copilot_compatibility ?? 0, merged.is_public, merged.enabled, merged.weight, merged.token_multiplier, merged.request_multiplier, merged.max_concurrency,
        merged.quota_mode ?? existing.quota_mode ?? "follow_group",
        merged.quota_tokens ?? existing.quota_tokens ?? null,
        merged.quota_requests ?? existing.quota_requests ?? null,
        merged.quota_period ?? existing.quota_period ?? null,
        merged.period_quota_tokens ?? existing.period_quota_tokens ?? null,
        merged.period_quota_requests ?? existing.period_quota_requests ?? null,
        id],
    );

  const row = await gatewayDb.queryOne("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL", [id]);
  return jsonOk({ data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const existing = await gatewayDb.queryOne<{ id: number }>("SELECT id FROM models WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!existing) return jsonError("模型不存在", 404);

  await softDeleteModel(id);
  return jsonOk({ ok: true, message: "模型删除成功。" });
}
