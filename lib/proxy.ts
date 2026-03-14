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
    const summary = summarizeTestResponse(bodyText);
    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      body_preview: bodyText.slice(0, 500),
      summary,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - startedAt,
      body_preview: error instanceof Error ? error.message : "Unknown upstream error",
      summary: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeTestResponse(bodyText: string) {
  try {
    const parsed = JSON.parse(bodyText) as {
      model?: string;
      error?: { message?: string; type?: string; code?: string | number };
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null; reasoning?: string | null };
        text?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      };
    };

    if (parsed.error?.message) {
      const parts = [parsed.error.message];
      if (parsed.error.type) parts.push(`type=${parsed.error.type}`);
      if (parsed.error.code !== undefined && parsed.error.code !== null) parts.push(`code=${parsed.error.code}`);
      return parts.join(" | ");
    }

    const parts: string[] = [];
    if (parsed.model) parts.push(`model=${parsed.model}`);

    const firstChoice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (firstChoice?.finish_reason) {
      parts.push(`finish_reason=${firstChoice.finish_reason}`);
    }

    const usageParts: string[] = [];
    if (parsed.usage?.prompt_tokens !== undefined && parsed.usage.prompt_tokens !== null) {
      usageParts.push(`prompt=${parsed.usage.prompt_tokens}`);
    }
    if (parsed.usage?.completion_tokens !== undefined && parsed.usage.completion_tokens !== null) {
      usageParts.push(`completion=${parsed.usage.completion_tokens}`);
    }
    if (parsed.usage?.total_tokens !== undefined && parsed.usage.total_tokens !== null) {
      usageParts.push(`total=${parsed.usage.total_tokens}`);
    }
    if (usageParts.length > 0) {
      parts.push(`tokens(${usageParts.join("/")})`);
    }

    const content =
      firstChoice?.message?.content?.trim() ||
      firstChoice?.message?.reasoning?.trim() ||
      firstChoice?.text?.trim() ||
      "";
    if (content) {
      parts.push(`content=${content.slice(0, 80)}`);
    }

    return parts.length > 0 ? parts.join(" | ") : null;
  } catch {
    return null;
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
