export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { fetchUpstreamModelIds } from "@/lib/gateway/upstream-model-list";
import { isValidProxyUrl } from "@/lib/gateway/upstream-proxy";

const proxyUrlSchema = z.string().max(1000).optional().refine(isValidProxyUrl);

const bodySchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().max(500).optional().default(""),
  user_agent: z.string().max(500).optional(),
  proxy_url: proxyUrlSchema,
});

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const result = await fetchUpstreamModelIds({
    baseUrl: parsed.data.base_url,
    apiKey: parsed.data.api_key,
    userAgent: parsed.data.user_agent,
    proxyUrl: parsed.data.proxy_url,
  });
  if (!result.ok) return jsonError(result.message, 502);

  return jsonOk({ data: result.ids });
}
