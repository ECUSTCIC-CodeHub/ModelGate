export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, parseSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().min(1).optional(),
  supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).min(1).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  max_concurrency: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  quota_tokens: z.number().int().min(0).nullable().optional(),
  quota_requests: z.number().int().min(0).nullable().optional(),
  quota_period: z.number().int().min(0).nullable().optional(),
  period_quota_tokens: z.number().int().min(0).nullable().optional(),
  period_quota_requests: z.number().int().min(0).nullable().optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = gatewayDb.prepare("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!existing) return jsonError("渠道不存在", 404);
  const wasEnabled = (existing as { enabled: number }).enabled === 1;
  const nextProtocols = parsed.data.supported_protocols === undefined
    ? (existing as { supported_protocols: string }).supported_protocols
    : stringifySupportedProtocols(normalizeSupportedProtocols(parsed.data.supported_protocols));
  const nextProtocolList = parseSupportedProtocols(nextProtocols);
  const nextEnabled =
    parsed.data.enabled === undefined
      ? (existing as { enabled: number }).enabled
      : parsed.data.enabled
        ? 1
        : 0;

  if (nextEnabled === 1) {
    const placeholders = nextProtocolList.map(() => "?").join(", ");
    const incompatibleModel = gatewayDb
      .prepare(
        `SELECT id
         FROM models
         WHERE channel_id = ? AND deleted_at IS NULL AND enabled = 1 AND upstream_protocol NOT IN (${placeholders})
         LIMIT 1`,
      )
      .get(id, ...nextProtocolList) as { id: number } | undefined;
    if (incompatibleModel) {
      return jsonError("该渠道下存在使用未被保留协议的启用模型", 400);
    }
  }

  const merged = {
    ...existing,
    ...parsed.data,
    supported_protocols:
      parsed.data.supported_protocols === undefined
        ? (existing as { supported_protocols: string }).supported_protocols
        : nextProtocols,
    enabled: nextEnabled,
  };

  const tx = gatewayDb.transaction(() => {
    gatewayDb
      .prepare(
        `UPDATE channels
         SET name = ?, base_url = ?, api_key = ?, supported_protocols = ?, enabled = ?, weight = ?, max_concurrency = ?, timeout = ?,
             quota_tokens = ?, quota_requests = ?, quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?
         WHERE id = ?`,
      )
      .run(
        (merged as { name: string }).name,
        (merged as { base_url: string }).base_url,
        (merged as { api_key: string }).api_key,
        (merged as { supported_protocols: string }).supported_protocols,
        (merged as { enabled: number }).enabled,
        (merged as { weight: number }).weight,
        (merged as { max_concurrency: number }).max_concurrency,
        (merged as { timeout: number }).timeout,
        (merged as { quota_tokens: number | null }).quota_tokens ?? null,
        (merged as { quota_requests: number | null }).quota_requests ?? null,
        (merged as { quota_period: number | null }).quota_period ?? null,
        (merged as { period_quota_tokens: number | null }).period_quota_tokens ?? null,
        (merged as { period_quota_requests: number | null }).period_quota_requests ?? null,
        id,
      );

    if (nextEnabled === 0) {
      gatewayDb
        .prepare("UPDATE models SET enabled = 0 WHERE channel_id = ? AND deleted_at IS NULL")
        .run(id);
    } else if (!wasEnabled) {
      const placeholders = nextProtocolList.map(() => "?").join(", ");
      gatewayDb
        .prepare(
          `UPDATE models SET enabled = 1 WHERE channel_id = ? AND deleted_at IS NULL AND upstream_protocol IN (${placeholders})`,
        )
        .run(id, ...nextProtocolList);
    }
  });
  tx();

  const row = gatewayDb.prepare("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL").get(id);
  return jsonOk({
    message:
      nextEnabled === 0
        ? "渠道已禁用，关联模型已同步禁用。"
        : !wasEnabled
          ? "渠道已启用，关联模型已同步启用。"
          : "渠道更新成功。",
    data: row,
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const tx = gatewayDb.transaction(() => {
    gatewayDb.prepare("UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND deleted_at IS NULL").run(id);
    gatewayDb.prepare("UPDATE channels SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
  });
  tx();
  return jsonOk({ ok: true, message: "渠道删除成功。" });
}
