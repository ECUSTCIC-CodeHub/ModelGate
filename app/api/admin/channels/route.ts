export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";
import { isValidProxyUrl, normalizeProxyUrl } from "@/lib/gateway/upstream-proxy";

const proxyUrlSchema = z.string().max(1000).optional().refine(isValidProxyUrl);

const createSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
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
  models: z
    .array(
      z.object({
        alias: z.string().min(1),
        real_model: z.string().min(1),
        upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
        supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).optional(),
        copilot_compatibility: z.boolean().optional(),
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

  const channels = await gatewayDb.query<Record<string, unknown> & { id: number }>("SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY id DESC");
  const models = await gatewayDb
    .query<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    upstream_protocol: string;
    supported_protocols: string | null;
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
    created_at: string;
  }>("SELECT id, alias, real_model, channel_id, upstream_protocol, supported_protocols, is_public, enabled, weight, token_multiplier, request_multiplier, max_concurrency, quota_mode, quota_tokens, quota_requests, quota_period, period_quota_tokens, period_quota_requests, created_at FROM models WHERE deleted_at IS NULL ORDER BY id DESC");

  const grouped = new Map<number, typeof models>();
  for (const model of models) {
    const list = grouped.get(model.channel_id) ?? [];
    list.push(model);
    grouped.set(model.channel_id, list);
  }

  const rows = channels.map((channel) => ({
    ...channel,
    models: grouped.get(channel.id) ?? [],
  }));
  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

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
        `INSERT INTO channels (name, base_url, api_key, supported_protocols, user_agent, proxy_url, enabled, weight, max_concurrency, timeout, quota_tokens, quota_requests, quota_period, period_quota_tokens, period_quota_requests, force_include_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          `INSERT INTO models (alias, real_model, channel_id, upstream_protocol, supported_protocols, copilot_compatibility, is_public, enabled, weight, token_multiplier, request_multiplier, max_concurrency, quota_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            model.alias,
            model.real_model,
            channelId,
            upstreamProtocol,
            stringifySupportedProtocols(finalModelProtocols),
            model.copilot_compatibility === true ? 1 : 0,
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

    return channelId;
  });

  const row = await gatewayDb.queryOne("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", [channelId]);
  return jsonOk({ message: "渠道创建成功。", data: row }, 201);
}
