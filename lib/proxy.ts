import { jsonError } from "@/lib/http";
import type { RoutedModel } from "@/lib/router";

function buildChatUrl(baseUrl: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/chat/completions`;
}

export async function fetchUpstreamChat(route: RoutedModel, requestBody: Record<string, unknown>) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, route.channel.timeout) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(buildChatUrl(route.channel.base_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${route.channel.api_key}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyChatCompletion(
  route: RoutedModel,
  requestBody: Record<string, unknown>,
  stream: boolean,
) {
  const outgoingBody = {
    ...requestBody,
    model: route.model.real_model,
  };

  try {
    const upstream = await fetchUpstreamChat(route, outgoingBody);

    if (stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    });
  }
}
