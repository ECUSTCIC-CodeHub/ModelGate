export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { gatewayDb } from "@/lib/core/db";
import { jsonError, jsonOk } from "@/lib/core/http";
import { fetchUpstreamModelIds } from "@/lib/gateway/upstream-model-list";
import { isValidProxyUrl } from "@/lib/gateway/upstream-proxy";
import { resolveSubmittedApiKey } from "@/lib/shared/redact";

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
  user_agent: string | null;
  proxy_url: string | null;
};

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  let baseUrl = parsed.data.base_url ?? "";
  let apiKey = parsed.data.api_key ?? "";
  let userAgent = parsed.data.user_agent;
  let proxyUrl = parsed.data.proxy_url;

  if (parsed.data.channel_id !== undefined) {
    const channel = await gatewayDb.queryOne<StoredChannel>(
      "SELECT base_url, api_key, user_agent, proxy_url FROM channels WHERE id = ? AND deleted_at IS NULL",
      [parsed.data.channel_id],
    );
    if (!channel) return jsonError("渠道不存在", 404);
    baseUrl = parsed.data.base_url ?? channel.base_url;
    apiKey = resolveSubmittedApiKey(parsed.data.api_key, channel.api_key ?? "");
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
