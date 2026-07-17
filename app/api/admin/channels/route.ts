export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";
import { isValidProxyUrl, normalizeProxyUrl } from "@/lib/gateway/upstream-proxy";
import { validateUaRestrictionRules } from "@/lib/gateway/ua-restrictions";
import { toLocalDatetime, validateTimeRestrictions, normalizeTimeRestrictions } from "@/lib/gateway/channel-time";
import { disableExpiredChannels } from "@/lib/gateway/channel-expiry";

const proxyUrlSchema = z.string().max(1000).optional().refine(isValidProxyUrl);

const createSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
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
  models: z
    .array(
      z.object({
        alias: z.string().min(1),
        real_model: z.string().min(1),
        upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
        supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).optional(),
        copilot_compatibility: z.boolean().optional(),
        supports_vision: z.boolean().optional(),
        is_public: z.boolean().optional(),
        enabled: z.boolean().optional(),
        weight: z.number().int().min(1).optional(),
        token_multiplier: z.number().min(0).max(100).optional(),
        request_multiplier: z.number().min(0).max(100).optional(),
        max_concurrency: z.number().int().min(0).optional(),
        quota_mode: z.enum(["follow_group", "bypass_group", "independent"]).optional(),
      }),
    )
    .optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const channels = await gatewayDb.query<Record<string, unknown> & { id: number }>("SELECT c.*, u.username AS created_by_username FROM channels c LEFT JOIN users u ON u.id = c.created_by WHERE c.deleted_at IS NULL ORDER BY c.id DESC");
  const models = await gatewayDb
    .query<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    upstream_protocol: string;
    supported_protocols: string | null;
    copilot_compatibility: number;
    supports_vision: number;
    is_public: number;
    enabled: number;
    weight: number;
    token_multiplier: number;
    request_multiplier: number;
    max_concurrency: number;
    quota_mode: string;
    quota_tokens: number | null;
    quota_requests: number | null;
    quota_period: number | null;
    period_quota_tokens: number | null;
    period_quota_requests: number | null;
    ua_restrictions: string;
    created_at: string;
  }>("SELECT id, alias, real_model, channel_id, upstream_protocol, supported_protocols, copilot_compatibility, supports_vision, is_public, enabled, weight, token_multiplier, request_multiplier, max_concurrency, quota_mode, quota_tokens, quota_requests, quota_period, period_quota_tokens, period_quota_requests, ua_restrictions, created_at FROM models WHERE deleted_at IS NULL ORDER BY id DESC");

  const grouped = new Map<number, typeof models>();
  for (const model of models) {
    const list = grouped.get(model.channel_id) ?? [];
    list.push(model);
    grouped.set(model.channel_id, list);
  }

  const currentUserId = guard.auth.user.id;
  const rows = channels.map((channel) => {
    const createdBy = (channel as { created_by?: number | null }).created_by ?? null;
    const isPrivate = (channel as { api_key_private?: number | null }).api_key_private === 1;
    const isOwner = createdBy != null && createdBy === currentUserId;
    const canView = !isPrivate || isOwner;
    const canManagePrivacy = createdBy == null || isOwner;
    return {
      ...channel,
      api_key: canView ? channel.api_key : null,
      can_view_api_key: canView,
      can_manage_api_key_privacy: canManagePrivacy,
      models: grouped.get(channel.id) ?? [],
    };
  });
  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (parsed.data.ua_restrictions !== undefined && parsed.data.ua_restrictions.trim() !== "") {
    const validation = validateUaRestrictionRules(parsed.data.ua_restrictions);
    if (!validation.valid) return jsonError(validation.error, 400);
  }

  let timeRestrictions = "";
  if (parsed.data.time_restrictions !== undefined && parsed.data.time_restrictions.trim() !== "") {
    const validation = validateTimeRestrictions(parsed.data.time_restrictions);
    if (!validation.valid) return jsonError(validation.error, 400);
    timeRestrictions = normalizeTimeRestrictions(validation.windows);
  }

  let expiresAt: string | null = null;
  const expiresRaw = parsed.data.expires_at?.trim() ?? "";
  if (expiresRaw) {
    const t = new Date(expiresRaw.replace(" ", "T")).getTime();
    if (Number.isNaN(t)) return jsonError("过期时间格式不正确", 400);
    expiresAt = toLocalDatetime(new Date(expiresRaw));
  }

  const supportedProtocols = normalizeSupportedProtocols(parsed.data.supported_protocols);
  for (const model of parsed.data.models ?? []) {
    const upstreamProtocol = model.upstream_protocol ?? supportedProtocols[0] ?? "chat_completions";
    if (!supportedProtocols.includes(upstreamProtocol)) {
      return jsonError("模型草稿包含渠道不支持的上游协议", 400);
    }
  }

  const channelId = await gatewayDb.transaction(async (tx) => {
    const channelEnabled = parsed.data.enabled === false ? 0 : 1;
    const result = await tx
      .execute(
        `INSERT INTO channels (name, base_url, api_key, supported_protocols, user_agent, proxy_url, enabled, weight, max_concurrency, timeout, quota_tokens, quota_requests, quota_period, period_quota_tokens, period_quota_requests, force_include_usage, ua_restrictions, expires_at, time_restrictions, created_by, api_key_private)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsed.data.name,
          parsed.data.base_url,
          parsed.data.api_key,
          stringifySupportedProtocols(supportedProtocols),
          parsed.data.user_agent?.trim() ?? "",
          normalizeProxyUrl(parsed.data.proxy_url),
          channelEnabled,
          parsed.data.weight ?? 1,
          parsed.data.max_concurrency ?? 64,
          parsed.data.timeout ?? 60,
          parsed.data.quota_tokens ?? null,
          parsed.data.quota_requests ?? null,
          parsed.data.quota_period ?? null,
          parsed.data.period_quota_tokens ?? null,
          parsed.data.period_quota_requests ?? null,
          parsed.data.force_include_usage === false ? 0 : 1,
          parsed.data.ua_restrictions?.trim() ?? "",
          expiresAt,
          timeRestrictions,
          guard.auth.user.id,
          parsed.data.api_key_private === true ? 1 : 0,
        ],
      );

    const channelId = Number(result.lastInsertRowid);
    for (const model of parsed.data.models ?? []) {
      const upstreamProtocol = model.upstream_protocol ?? supportedProtocols[0] ?? "chat_completions";
      const modelProtocols = normalizeSupportedProtocols(model.supported_protocols);
      const validModelProtocols = modelProtocols.filter((p) => supportedProtocols.includes(p));
      const finalModelProtocols = validModelProtocols.length > 0 ? validModelProtocols : [upstreamProtocol];
      await tx
        .execute(
          `INSERT INTO models (alias, real_model, channel_id, upstream_protocol, supported_protocols, copilot_compatibility, supports_vision, is_public, enabled, weight, token_multiplier, request_multiplier, max_concurrency, quota_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            model.alias,
            model.real_model,
            channelId,
            upstreamProtocol,
            stringifySupportedProtocols(finalModelProtocols),
            model.copilot_compatibility === true ? 1 : 0,
            model.supports_vision === true ? 1 : 0,
            model.is_public === false ? 0 : 1,
            channelEnabled === 1 && model.enabled !== false ? 1 : 0,
            model.weight ?? 1,
            model.token_multiplier ?? 1,
            model.request_multiplier ?? 1,
            model.max_concurrency ?? 0,
            model.quota_mode ?? "follow_group",
          ],
        );
    }

    await disableExpiredChannels(tx);

    return channelId;
  });

  const row = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [channelId]);
  const createdRow = row as { created_by?: number | null; api_key?: string | null; api_key_private?: number | null } | undefined;
  const createdIsOwner = createdRow?.created_by != null && createdRow.created_by === guard.auth.user.id;
  const canViewCreated = createdRow?.api_key_private !== 1 || createdIsOwner;
  const canManageCreated = createdRow?.created_by == null || createdIsOwner;
  return jsonOk(
    {
      message: "渠道创建成功。",
      data: createdRow
        ? {
            ...createdRow,
            api_key: canViewCreated ? createdRow.api_key : null,
            can_view_api_key: canViewCreated,
            can_manage_api_key_privacy: canManageCreated,
          }
        : row,
    },
    201,
  );
}
