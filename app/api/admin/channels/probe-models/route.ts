export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { gatewayDb } from "@/lib/core/db";
import { jsonError, jsonOk } from "@/lib/core/http";
import { fetchUpstreamModelIds } from "@/lib/gateway/upstream-model-list";
import { isValidProxyUrl } from "@/lib/gateway/upstream-proxy";
import { isMaskedApiKey, resolveSubmittedApiKey } from "@/lib/shared/redact";
import { resolveChannelOwnerId } from "@/lib/services/channel-ownership";
import { readJsonBodyCapped } from "@/lib/core/request-body";

const proxyUrlSchema = z.string().max(1000).optional().refine(isValidProxyUrl);

const bodySchema = z.object({
  channel_id: z.number().int().positive().optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().max(500).optional(),
  user_agent: z.string().max(500).optional(),
  proxy_url: proxyUrlSchema,
});

type StoredChannel = {
  base_url: string;
  api_key: string | null;
  api_key_private: number | null;
  created_by: number | null;
  user_agent: string | null;
  proxy_url: string | null;
};

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await readJsonBodyCapped(request);
  if (!body.ok) return jsonError("请求体过大", 413);
  const parsed = bodySchema.safeParse(body.data);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  let baseUrl = parsed.data.base_url ?? "";
  let apiKey = parsed.data.api_key ?? "";
  let userAgent = parsed.data.user_agent;
  let proxyUrl = parsed.data.proxy_url;

  if (parsed.data.channel_id !== undefined) {
    const channel = await gatewayDb.queryOne<StoredChannel>(
      "SELECT base_url, api_key, api_key_private, created_by, user_agent, proxy_url FROM channels WHERE id = ? AND deleted_at IS NULL",
      [parsed.data.channel_id],
    );
    if (!channel) return jsonError("渠道不存在", 404);

    // 与 PUT /api/admin/channels/:id 相同的边界：非添加人不得借本接口把「仅添加人可见」的密钥
    // 发往自己指定的地址（含 proxy_url 取值），因此这里必须先判定密钥可用性再取库内明文。
    const ownerId = await resolveChannelOwnerId(channel.created_by);
    const canUseStoredKey =
      channel.api_key_private !== 1 || ownerId === null || ownerId === guard.auth.user.id;
    const submittedKey = parsed.data.api_key;
    const hasExplicitKey =
      typeof submittedKey === "string" && submittedKey.trim() !== "" && !isMaskedApiKey(submittedKey, channel.api_key);
    if (!canUseStoredKey && !hasExplicitKey) {
      return jsonError("该渠道的 API Key 仅添加人可用，请先填写 API Key 后再探测", 403);
    }

    baseUrl = parsed.data.base_url ?? channel.base_url;
    apiKey = canUseStoredKey
      ? resolveSubmittedApiKey(submittedKey, channel.api_key) ?? ""
      : submittedKey!.trim();
    userAgent = parsed.data.user_agent ?? channel.user_agent ?? undefined;
    proxyUrl = parsed.data.proxy_url ?? channel.proxy_url ?? undefined;
  }

  if (!baseUrl) return jsonError("请求参数不正确", 400);

  const result = await fetchUpstreamModelIds({
    baseUrl,
    apiKey,
    userAgent,
    proxyUrl,
  });
  if (!result.ok) return jsonError(result.message, 502);

  return jsonOk({ data: result.ids });
}
