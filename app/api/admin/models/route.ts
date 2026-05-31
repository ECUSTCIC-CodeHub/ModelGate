export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, supportsProtocol } from "@/lib/gateway/protocols";

const QUOTA_MODES = ["follow_group", "bypass_group", "independent"] as const;

const createSchema = z.object({
  alias: z.string().min(1),
  real_model: z.string().min(1),
  channel_id: z.number().int().positive(),
  upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
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

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const rows = gatewayDb
    .prepare(
      `SELECT m.*, c.name AS channel_name
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at IS NULL
       ORDER BY m.id DESC`,
    )
    .all();

  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const channel = gatewayDb
    .prepare("SELECT id, supported_protocols, enabled FROM channels WHERE id = ? AND deleted_at IS NULL")
    .get(parsed.data.channel_id) as { id: number; supported_protocols: string; enabled: number } | undefined;
  if (!channel) return jsonError("渠道不存在", 404);
  const upstreamProtocol = parsed.data.upstream_protocol ?? "chat_completions";
  if (!supportsProtocol(channel.supported_protocols, upstreamProtocol)) {
    return jsonError("所选渠道不支持该上游协议", 400);
  }
  const modelEnabled = parsed.data.enabled === false ? 0 : 1;
  if (modelEnabled === 1 && channel.enabled !== 1) {
    return jsonError("禁用渠道下不能启用模型", 400);
  }

  const result = gatewayDb
    .prepare(
      `INSERT INTO models (alias, real_model, channel_id, upstream_protocol, is_public, enabled, weight, token_multiplier, request_multiplier, max_concurrency, quota_mode, quota_tokens, quota_requests, quota_period, period_quota_tokens, period_quota_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.data.alias,
      parsed.data.real_model,
      parsed.data.channel_id,
      upstreamProtocol,
      parsed.data.is_public === false ? 0 : 1,
      modelEnabled,
      parsed.data.weight ?? 1,
      parsed.data.token_multiplier ?? 1,
      parsed.data.request_multiplier ?? 1,
      parsed.data.max_concurrency ?? 0,
      parsed.data.quota_mode ?? "follow_group",
      parsed.data.quota_tokens ?? null,
      parsed.data.quota_requests ?? null,
      parsed.data.quota_period ?? null,
      parsed.data.period_quota_tokens ?? null,
      parsed.data.period_quota_requests ?? null,
    );

  const row = gatewayDb.prepare("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL").get(result.lastInsertRowid);
  return jsonOk({ message: "模型创建成功。", data: row }, 201);
}
