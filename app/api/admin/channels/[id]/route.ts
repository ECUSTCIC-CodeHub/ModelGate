export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, parseSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";
import { isValidProxyUrl, normalizeProxyUrl } from "@/lib/gateway/upstream-proxy";
import { validateUaRestrictionRules } from "@/lib/gateway/ua-restrictions";

const proxyUrlSchema = z.string().max(1000).optional().refine(isValidProxyUrl);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  api_key_private: z.boolean().optional(),
  supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).min(1).optional(),
  user_agent: z.string().max(500).optional(),
  proxy_url: proxyUrlSchema,
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  max_concurrency: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  quota_tokens: z.number().int().min(0).nullable().optional(),
  quota_requests: z.number().int().min(0).nullable().optional(),
  quota_period: z.number().int().min(0).nullable().optional(),
  period_quota_tokens: z.number().int().min(0).nullable().optional(),
  period_quota_requests: z.number().int().min(0).nullable().optional(),
  force_include_usage: z.boolean().optional(),
  ua_restrictions: z.string().max(20000).optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.ua_restrictions !== undefined && parsed.data.ua_restrictions.trim() !== "") {
    const validation = validateUaRestrictionRules(parsed.data.ua_restrictions);
    if (!validation.valid) return jsonError(validation.error, 400);
  }

  const existing = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [id]);
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

  const userId = guard.auth.user.id;
  const existingCreatedBy = (existing as { created_by?: number | null }).created_by ?? null;
  const existingPrivate = (existing as { api_key_private?: number | null }).api_key_private === 1 ? 1 : 0;
  const canManagePrivacy = existingCreatedBy == null || existingCreatedBy === userId;

  let nextPrivate = existingPrivate;
  let nextCreatedBy = existingCreatedBy;
  if (parsed.data.api_key_private !== undefined) {
    const desired = parsed.data.api_key_private ? 1 : 0;
    if (desired !== existingPrivate && canManagePrivacy) {
      nextPrivate = desired;
      if (desired === 1 && nextCreatedBy == null) nextCreatedBy = userId;
    }
  }

  const canManageKey = nextPrivate === 0 || nextCreatedBy === userId;

  if (nextEnabled === 1) {
    const placeholders = nextProtocolList.map(() => "?").join(", ");
    const incompatibleModel = await gatewayDb
      .queryOne<{ id: number }>(
        `SELECT id
         FROM models
         WHERE channel_id = ? AND deleted_at IS NULL AND enabled = 1 AND upstream_protocol NOT IN (${placeholders})
         LIMIT 1`,
        [id, ...nextProtocolList],
      );
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
    user_agent:
      parsed.data.user_agent === undefined
        ? (existing as { user_agent?: string | null }).user_agent ?? ""
        : parsed.data.user_agent.trim(),
    proxy_url:
      parsed.data.proxy_url === undefined
        ? (existing as { proxy_url?: string | null }).proxy_url ?? ""
        : normalizeProxyUrl(parsed.data.proxy_url),
    ua_restrictions:
      parsed.data.ua_restrictions === undefined
        ? (existing as { ua_restrictions?: string | null }).ua_restrictions ?? ""
        : parsed.data.ua_restrictions.trim(),
    enabled: nextEnabled,
  };

  if (!canManageKey && parsed.data.api_key !== undefined) {
    (merged as { api_key?: string | null }).api_key = (existing as { api_key?: string | null }).api_key ?? null;
  }

  await gatewayDb.transaction(async (tx) => {
    await tx
      .execute(
        `UPDATE channels
         SET name = ?, base_url = ?, api_key = ?, supported_protocols = ?, user_agent = ?, proxy_url = ?, enabled = ?, weight = ?, max_concurrency = ?, timeout = ?,
             quota_tokens = ?, quota_requests = ?, quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?, force_include_usage = ?, ua_restrictions = ?, api_key_private = ?, created_by = ?
         WHERE id = ?`,
        [
          (merged as { name: string }).name,
          (merged as { base_url: string }).base_url,
          (merged as { api_key: string }).api_key,
          (merged as { supported_protocols: string }).supported_protocols,
          (merged as { user_agent: string }).user_agent,
          (merged as { proxy_url: string }).proxy_url,
          (merged as { enabled: number }).enabled,
          (merged as { weight: number }).weight,
          (merged as { max_concurrency: number }).max_concurrency,
          (merged as { timeout: number }).timeout,
          (merged as { quota_tokens: number | null }).quota_tokens ?? null,
          (merged as { quota_requests: number | null }).quota_requests ?? null,
          (merged as { quota_period: number | null }).quota_period ?? null,
          (merged as { period_quota_tokens: number | null }).period_quota_tokens ?? null,
          (merged as { period_quota_requests: number | null }).period_quota_requests ?? null,
          parsed.data.force_include_usage === undefined
            ? (existing as { force_include_usage: number }).force_include_usage
            : parsed.data.force_include_usage
              ? 1
              : 0,
          (merged as { ua_restrictions: string }).ua_restrictions,
          nextPrivate,
          nextCreatedBy,
          id,
        ],
      );

    if (nextEnabled === 0) {
      await tx
        .execute("UPDATE models SET enabled = 0 WHERE channel_id = ? AND deleted_at IS NULL", [id]);
    } else if (!wasEnabled) {
      const placeholders = nextProtocolList.map(() => "?").join(", ");
      await tx
        .execute(
          `UPDATE models SET enabled = 1 WHERE channel_id = ? AND deleted_at IS NULL AND upstream_protocol IN (${placeholders})`,
          [id, ...nextProtocolList],
        );
    }
  });

  const row = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [id]);
  const updatedRow = row as { created_by?: number | null; api_key?: string | null; api_key_private?: number | null } | undefined;
  const updatedIsOwner = updatedRow?.created_by != null && updatedRow.created_by === userId;
  const canViewUpdated = updatedRow?.api_key_private !== 1 || updatedIsOwner;
  const canManageUpdated = updatedRow?.created_by == null || updatedIsOwner;
  return jsonOk({
    data: updatedRow
      ? {
          ...updatedRow,
          api_key: canViewUpdated ? updatedRow.api_key : null,
          can_view_api_key: canViewUpdated,
          can_manage_api_key_privacy: canManageUpdated,
        }
      : row,
    message:
      nextEnabled === 0
        ? "渠道已禁用，关联模型已同步禁用。"
        : !wasEnabled
          ? "渠道已启用，关联模型已同步启用。"
          : "渠道更新成功。",
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  await gatewayDb.transaction(async (tx) => {
    await tx.execute("UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND deleted_at IS NULL", [id]);
    await tx.execute("UPDATE channels SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [id]);
  });
  return jsonOk({ ok: true, message: "渠道删除成功。" });
}
