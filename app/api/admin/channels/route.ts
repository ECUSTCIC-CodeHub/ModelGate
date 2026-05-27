export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/core/db";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, stringifySupportedProtocols } from "@/lib/gateway/protocols";

const createSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
  supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).min(1).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  max_concurrency: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  models: z
    .array(
      z.object({
        alias: z.string().min(1),
        real_model: z.string().min(1),
        upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
        is_public: z.boolean().optional(),
        enabled: z.boolean().optional(),
        weight: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const channels = gatewayDb.prepare("SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY id DESC").all() as Array<Record<string, unknown> & { id: number }>;
  const models = gatewayDb
    .prepare("SELECT id, alias, real_model, channel_id, upstream_protocol, is_public, enabled, weight, token_multiplier, request_multiplier, created_at FROM models WHERE deleted_at IS NULL ORDER BY id DESC")
    .all() as Array<{
    id: number;
    alias: string;
    real_model: string;
    channel_id: number;
    upstream_protocol: string;
    is_public: number;
    enabled: number;
    weight: number;
    token_multiplier: number;
    request_multiplier: number;
    created_at: string;
  }>;

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
  const guard = ensureAdmin(request);
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

  const tx = gatewayDb.transaction(() => {
    const channelEnabled = parsed.data.enabled === false ? 0 : 1;
    const result = gatewayDb
      .prepare(
        `INSERT INTO channels (name, base_url, api_key, supported_protocols, enabled, weight, max_concurrency, timeout)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.data.name,
        parsed.data.base_url,
        parsed.data.api_key,
        stringifySupportedProtocols(supportedProtocols),
        channelEnabled,
        parsed.data.weight ?? 1,
        parsed.data.max_concurrency ?? 64,
        parsed.data.timeout ?? 60,
      );

    const channelId = Number(result.lastInsertRowid);
    for (const model of parsed.data.models ?? []) {
      const upstreamProtocol = model.upstream_protocol ?? supportedProtocols[0] ?? "chat_completions";
      gatewayDb
        .prepare(
          `INSERT INTO models (alias, real_model, channel_id, upstream_protocol, is_public, enabled, weight)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          model.alias,
          model.real_model,
          channelId,
          upstreamProtocol,
          model.is_public === false ? 0 : 1,
          channelEnabled === 1 && model.enabled !== false ? 1 : 0,
          model.weight ?? 1,
        );
    }

    return channelId;
  });

  const channelId = tx();
  const row = gatewayDb.prepare("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL").get(channelId);
  return jsonOk({ message: "渠道创建成功。", data: row }, 201);
}
