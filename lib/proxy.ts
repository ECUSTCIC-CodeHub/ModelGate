import { jsonError } from "@/lib/http";
import type { DbChannel, DbModel } from "@/lib/db";
import type { RoutedModel } from "@/lib/router";

function normalizeProviderBaseUrl(baseUrl: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return normalized.replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
}

function buildChatUrl(baseUrl: string) {
  return `${normalizeProviderBaseUrl(baseUrl)}/chat/completions`;
}

function createTimeoutController(timeoutSeconds: number) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

export async function fetchUpstreamChat(route: RoutedModel, requestBody: Record<string, unknown>) {
  const { controller, timeout } = createTimeoutController(route.channel.timeout);

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

export async function testUpstreamModel(target: {
  channel: Pick<DbChannel, "base_url" | "api_key" | "timeout">;
  model: Pick<DbModel, "real_model">;
}) {
  const { controller, timeout } = createTimeoutController(target.channel.timeout);
  const startedAt = Date.now();

  try {
    const response = await fetch(buildChatUrl(target.channel.base_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.channel.api_key}`,
      },
      body: JSON.stringify({
        model: target.model.real_model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      body_preview: bodyText.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - startedAt,
      body_preview: error instanceof Error ? error.message : "Unknown upstream error",
    };
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
