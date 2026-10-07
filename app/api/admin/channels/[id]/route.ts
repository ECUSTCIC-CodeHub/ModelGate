export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, parseSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";
import { isValidProxyUrl, normalizeProxyUrl } from "@/lib/gateway/upstream-proxy";
import { validateUaRestrictionRules } from "@/lib/gateway/ua-restrictions";
import { toLocalDatetime, validateTimeRestrictions, normalizeTimeRestrictions } from "@/lib/gateway/channel-time";
import { disableExpiredChannels } from "@/lib/gateway/channel-expiry";
import { disableExpiredModels } from "@/lib/gateway/model-expiry";
import { stringifyCustomHeaders, validateCustomHeaders } from "@/lib/gateway/custom-headers";
import { stringifyRequestBodyOmit, validateRequestBodyOmit } from "@/lib/gateway/request-body-omit";
import { maskApiKey, resolveSubmittedApiKey } from "@/lib/shared/redact";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { resolveChannelOwnerId } from "@/lib/services/channel-ownership";

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
  expires_at: z.string().max(32).nullable().optional(),
  time_restrictions: z.string().max(20000).optional(),
  custom_headers: z.record(z.string(), z.string()).nullable().optional(),
  request_body_omit: z.array(z.string()).nullable().optional(),
  group_name: z.string().max(64).nullable().optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = updateSchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.ua_restrictions !== undefined && parsed.data.ua_restrictions.trim() !== "") {
    const validation = validateUaRestrictionRules(parsed.data.ua_restrictions);
    if (!validation.valid) return jsonError(validation.error, 400);
  }

  let timeRestrictions: string | null = null;
  if (parsed.data.time_restrictions !== undefined) {
    if (parsed.data.time_restrictions.trim() === "") {
      timeRestrictions = "";
    } else {
      const validation = validateTimeRestrictions(parsed.data.time_restrictions);
      if (!validation.valid) return jsonError(validation.error, 400);
      timeRestrictions = normalizeTimeRestrictions(validation.windows);
    }
  }

  const existing = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!existing) return jsonError("渠道不存在", 404);

  let nextExpiresAt: string | null;
  if (parsed.data.expires_at === undefined) {
    nextExpiresAt = (existing as { expires_at?: string | null }).expires_at ?? null;
  } else {
    const expiresRaw = parsed.data.expires_at?.trim() ?? "";
    if (expiresRaw) {
      const t = new Date(expiresRaw.replace(" ", "T")).getTime();
      if (Number.isNaN(t)) return jsonError("过期时间格式不正确", 400);
      nextExpiresAt = toLocalDatetime(new Date(expiresRaw));
    } else {
      nextExpiresAt = null;
    }
  }
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
  const ownerId = await resolveChannelOwnerId(existingCreatedBy);
  const existingPrivate = (existing as { api_key_private?: number | null }).api_key_private === 1 ? 1 : 0;
  const canManagePrivacy = ownerId === null || ownerId === userId;

  let nextPrivate = existingPrivate;
  // ownerId 用于判权限，落库的 created_by 默认保持原值：
  // 添加人失效不等于要抹掉归属，公共渠道更不该因此被清空 created_by
  let nextCreatedBy = existingCreatedBy;
  if (parsed.data.api_key_private !== undefined) {
    const desired = parsed.data.api_key_private ? 1 : 0;
    if (desired !== existingPrivate && canManagePrivacy) {
      nextPrivate = desired;
    }
  }
  // 只有「原本就是私有」的渠道无主时才由本次修改者接管：
  // 公共渠道即使添加人失效也保留原归属，否则列表里的添加人用户名会凭空消失
  if (existingPrivate === 1 && nextPrivate === 1 && ownerId === null) nextCreatedBy = userId;

  // 必须按落库后的 nextCreatedBy 判定：接管当场 ownerId 仍为 null，
  // 用它判定会把刚完成接管的修改者自己挡在地址修改之外（后端已解冻、接口仍冻结）
  const canManageKey = nextPrivate === 0 || nextCreatedBy === userId;

  // 「仅添加人可见」的渠道若允许他人改上游地址与代理，非添加人可把地址指向自己的服务器，
  // 再由渠道测试或真实流量取出密钥，从而使该开关失效，故这里一并收紧。
  if (!canManageKey) {
    const existingBaseUrl = (existing as { base_url?: string | null }).base_url ?? "";
    const existingProxyUrl = (existing as { proxy_url?: string | null }).proxy_url ?? "";
    const baseUrlChanged =
      parsed.data.base_url !== undefined && parsed.data.base_url !== existingBaseUrl;
    const proxyUrlChanged =
      parsed.data.proxy_url !== undefined && normalizeProxyUrl(parsed.data.proxy_url) !== existingProxyUrl;
    if (baseUrlChanged || proxyUrlChanged) {
      return jsonError("该渠道的 API Key 仅添加人可见，仅添加人可修改上游地址与代理", 403);
    }
  }

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

  const customHeadersResult = validateCustomHeaders(parsed.data.custom_headers);
  if (!customHeadersResult.ok) return jsonError(customHeadersResult.error, 400);
  const requestBodyOmitResult = validateRequestBodyOmit(parsed.data.request_body_omit);
  if (!requestBodyOmitResult.ok) return jsonError(requestBodyOmitResult.error, 400);

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
    // 字段缺席保持原值，传 {} 或 null 整份清空（与其它可清空字段一致）
    custom_headers:
      parsed.data.custom_headers === undefined
        ? (existing as { custom_headers?: string | null }).custom_headers ?? ""
        : stringifyCustomHeaders(customHeadersResult.headers),
    request_body_omit:
      parsed.data.request_body_omit === undefined
        ? (existing as { request_body_omit?: string | null }).request_body_omit ?? ""
        : stringifyRequestBodyOmit(requestBodyOmitResult.fields),
    expires_at: nextExpiresAt,
    // 字段缺席保持原值，传 null 或空串清空
    group_name:
      parsed.data.group_name === undefined
        ? (existing as { group_name?: string | null }).group_name ?? ""
        : (parsed.data.group_name ?? "").trim(),
    time_restrictions:
      timeRestrictions === null
        ? (existing as { time_restrictions?: string | null }).time_restrictions ?? ""
        : timeRestrictions,
    enabled: nextEnabled,
  };

  const existingApiKey = (existing as { api_key?: string | null }).api_key ?? null;
  if (parsed.data.api_key !== undefined) {
    (merged as { api_key?: string | null }).api_key = canManageKey
      ? resolveSubmittedApiKey(parsed.data.api_key, existingApiKey, { clearOnEmpty: true })
      : existingApiKey;
  }

  await gatewayDb.transaction(async (tx) => {
    await tx
      .execute(
        `UPDATE channels
         SET name = ?, base_url = ?, api_key = ?, supported_protocols = ?, user_agent = ?, proxy_url = ?, enabled = ?, weight = ?, max_concurrency = ?, timeout = ?,
             quota_tokens = ?, quota_requests = ?, quota_period = ?, period_quota_tokens = ?, period_quota_requests = ?, force_include_usage = ?, ua_restrictions = ?, expires_at = ?, time_restrictions = ?, custom_headers = ?, request_body_omit = ?, group_name = ?, api_key_private = ?, created_by = ?
         WHERE id = ?`,
        [
          (merged as { name: string }).name,
          (merged as { base_url: string }).base_url,
          (merged as { api_key: string | null }).api_key,
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
          (merged as { expires_at: string | null }).expires_at ?? null,
          (merged as { time_restrictions: string }).time_restrictions,
          (merged as { custom_headers: string }).custom_headers,
          (merged as { request_body_omit: string }).request_body_omit,
          (merged as { group_name: string }).group_name || null,
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

    await disableExpiredChannels(tx);
    await disableExpiredModels(tx);
  });

  const row = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [id]);
  const updatedRow = row as { created_by?: number | null; api_key?: string | null; api_key_private?: number | null } | undefined;
  // 与本次写入判定同一口径：添加人失效的渠道视为无主，不能对调用方报成「他人私有」
  const updatedOwnerId = await resolveChannelOwnerId(updatedRow?.created_by ?? null);
  const updatedIsOwner = updatedOwnerId !== null && updatedOwnerId === userId;
  const canViewUpdated = updatedRow?.api_key_private !== 1 || updatedOwnerId === null || updatedIsOwner;
  const canManageUpdated = updatedOwnerId === null || updatedIsOwner;
  return jsonOk({
    data: updatedRow
      ? {
          ...updatedRow,
          api_key: canViewUpdated ? maskApiKey(updatedRow.api_key) : null,
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
    await disableExpiredChannels(tx);
    await disableExpiredModels(tx);
  });
  return jsonOk({ ok: true, message: "渠道删除成功。" });
}
