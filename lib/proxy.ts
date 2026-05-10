import { jsonError } from "@/lib/http";
import type { DbChannel, DbModel } from "@/lib/db";
import type { RoutedModel } from "@/lib/router";
import type { GatewayProtocol } from "@/lib/protocols";

function normalizeProviderBaseUrl(baseUrl: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return normalized
    .replace(/\/chat\/completions$/, "")
    .replace(/\/messages$/, "")
    .replace(/\/responses$/, "")
    .replace(/\/embeddings$/, "")
    .replace(/\/models$/, "");
}

const PROTOCOL_PATH: Record<GatewayProtocol, string> = {
  chat_completions: "chat/completions",
  responses: "responses",
  anthropic_messages: "messages",
  embeddings: "embeddings",
};

function buildUpstreamUrl(baseUrl: string, protocol: GatewayProtocol) {
  return `${normalizeProviderBaseUrl(baseUrl)}/${PROTOCOL_PATH[protocol]}`;
}

function buildUpstreamHeaders(route: RoutedModel, protocol: GatewayProtocol): Record<string, string> {
  if (protocol === "anthropic_messages") {
    return {
      "content-type": "application/json",
      "x-api-key": route.channel.api_key,
      authorization: `Bearer ${route.channel.api_key}`,
      "anthropic-version": "2023-06-01",
    };
  }

  return {
    "content-type": "application/json",
    authorization: `Bearer ${route.channel.api_key}`,
  };
}

function createTimeoutController(timeoutSeconds: number) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

export async function fetchUpstreamRequest(
  route: RoutedModel,
  requestBody: Record<string, unknown>,
  protocol: GatewayProtocol,
) {
  const { controller, timeout } = createTimeoutController(route.channel.timeout);

  try {
    return await fetch(buildUpstreamUrl(route.channel.base_url, protocol), {
      method: "POST",
      headers: buildUpstreamHeaders(route, protocol),
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function testUpstreamModel(target: {
  channel: Pick<DbChannel, "base_url" | "api_key" | "timeout">;
  model: Pick<DbModel, "real_model" | "upstream_protocol">;
}) {
  const { controller, timeout } = createTimeoutController(target.channel.timeout);
  const startedAt = Date.now();

  try {
    const protocol = target.model.upstream_protocol as GatewayProtocol;
    const response = await fetch(buildUpstreamUrl(target.channel.base_url, protocol), {
      method: "POST",
      headers:
        protocol === "anthropic_messages"
          ? {
              "content-type": "application/json",
              "x-api-key": target.channel.api_key,
              authorization: `Bearer ${target.channel.api_key}`,
              "anthropic-version": "2023-06-01",
            }
          : {
              "content-type": "application/json",
              authorization: `Bearer ${target.channel.api_key}`,
            },
      body: JSON.stringify(
        protocol === "responses"
          ? {
              model: target.model.real_model,
              input: "ping",
              max_output_tokens: 1,
              stream: false,
            }
          : protocol === "embeddings"
            ? {
                model: target.model.real_model,
                input: "ping",
              }
          : protocol === "anthropic_messages"
            ? {
                model: target.model.real_model,
                max_tokens: 1,
                messages: [{ role: "user", content: "ping" }],
                stream: false,
              }
          : {
              model: target.model.real_model,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
              stream: false,
            },
      ),
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
      status?: string;
      output_text?: string | null;
      content?: Array<{ type?: string; text?: string | null }>;
      output?: Array<{
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string | null }>;
        name?: string;
      }>;
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
    if (parsed.status) parts.push(`status=${parsed.status}`);

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

    if (parsed.usage && parsed.usage.prompt_tokens === undefined) {
      const responsesUsage = parsed.usage as {
        input_tokens?: number | null;
        output_tokens?: number | null;
        total_tokens?: number | null;
      };
      const nextUsageParts: string[] = [];
      if (responsesUsage.input_tokens !== undefined && responsesUsage.input_tokens !== null) {
        nextUsageParts.push(`prompt=${responsesUsage.input_tokens}`);
      }
      if (responsesUsage.output_tokens !== undefined && responsesUsage.output_tokens !== null) {
        nextUsageParts.push(`completion=${responsesUsage.output_tokens}`);
      }
      if (responsesUsage.total_tokens !== undefined && responsesUsage.total_tokens !== null) {
        nextUsageParts.push(`total=${responsesUsage.total_tokens}`);
      }
      if (nextUsageParts.length > 0) {
        parts.push(`tokens(${nextUsageParts.join("/")})`);
      }
    }

    const content =
      parsed.output_text?.trim() ||
      (Array.isArray(parsed.content)
        ? parsed.content
            .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
            .find(Boolean)
        : "") ||
      (Array.isArray(parsed.output)
        ? parsed.output
            .flatMap((item) => (item?.type === "message" ? (item.content ?? []) : []))
            .map((part) => part?.text?.trim() ?? "")
            .find(Boolean)
        : "") ||
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
    const upstream = await fetchUpstreamRequest(route, outgoingBody, "chat_completions");

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
