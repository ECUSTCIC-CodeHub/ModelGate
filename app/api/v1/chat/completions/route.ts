export const dynamic = "force-dynamic";

import { checkApiKeyAuth } from "@/lib/api-key-auth";
import { insertChatLog } from "@/lib/chat-log";
import { gatewayDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { fetchUpstreamChat } from "@/lib/proxy";
import { checkUserRateLimit } from "@/lib/ratelimit";
import { selectModelRoute, type RoutedModel } from "@/lib/router";
import { getGatewaySettings } from "@/lib/settings";
import { estimateRequestTokens } from "@/lib/token-estimate";
import { countTextTokens } from "@/lib/tokenizer";

function checkQuota(userId: number, estimatedTokens: number) {
  const user = gatewayDb
    .prepare("SELECT quota_tokens, quota_requests, used_tokens, used_requests FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(userId) as
    | {
        quota_tokens: number | null;
        quota_requests: number | null;
        used_tokens: number;
        used_requests: number;
      }
    | undefined;

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  if (user.quota_requests !== null && user.used_requests >= user.quota_requests) {
    return { ok: false, reason: "请求配额已用尽" };
  }

  if (user.quota_tokens !== null && user.used_tokens + estimatedTokens > user.quota_tokens) {
    return { ok: false, reason: "Token 配额已用尽" };
  }

  return { ok: true as const };
}

function addUsage(userId: number, keyId: number, tokens: number, requests = 1) {
  const tx = gatewayDb.transaction(() => {
    gatewayDb
      .prepare(
        `UPDATE users
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(tokens, requests, userId);

    gatewayDb
      .prepare(
        `UPDATE keys
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(tokens, requests, keyId);
  });
  tx();
}

function extractText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const text = (item as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

function countPromptTokensFromBody(body: Record<string, unknown>, model: string) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const promptText = messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const m = message as Record<string, unknown>;
      return [extractText(m.content), extractText(m.reasoning), extractText(m.reasoning_content)].join("\n");
    })
    .join("\n");
  return Math.max(0, countTextTokens(promptText, model));
}

function extractCompletionTextFromJsonResponse(text: string) {
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{
        message?: Record<string, unknown>;
        delta?: Record<string, unknown>;
        text?: string;
      }>;
    };
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    return choices
      .map((choice) => {
        const message = choice?.message ?? {};
        const delta = choice?.delta ?? {};
        return [
          extractText(choice?.text),
          extractText(message.content),
          extractText(message.reasoning),
          extractText(message.reasoning_content),
          extractText(delta.content),
          extractText(delta.reasoning),
          extractText(delta.reasoning_content),
        ].join("");
      })
      .join("");
  } catch {
    return "";
  }
}

function extractSseDataEvents(buffer: string) {
  const events: string[] = [];
  let remainder = buffer.replace(/\r\n/g, "\n");

  while (true) {
    const idx = remainder.indexOf("\n\n");
    if (idx === -1) break;
    const rawEvent = remainder.slice(0, idx);
    remainder = remainder.slice(idx + 2);

    const lines = rawEvent.split("\n");
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
    }
  }

  return { events, remainder };
}

function extractDeltaText(delta: unknown) {
  if (!delta || typeof delta !== "object") return "";
  const d = delta as Record<string, unknown>;
  const parts: string[] = [];

  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      }
    }
  };

  pushText(d.content);
  pushText(d.reasoning);
  pushText(d.reasoning_content);

  return parts.join("");
}

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

function shouldRetryUpstreamStatus(status: number) {
  return RETRYABLE_UPSTREAM_STATUS.has(status);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const authResult = checkApiKeyAuth(request);
  if (!authResult.ok) {
    return jsonError(authResult.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。", 401, {
      type: "auth_error",
      param: "None",
      code: "401",
    });
  }
  const auth = authResult.context;

  const logRejected = (statusCode: number, message: string, alias: string | null, estimatedTokens?: number) => {
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: null,
      model_alias: alias,
      real_model: null,
      stream: false,
      status_code: statusCode,
      estimated_tokens: estimatedTokens ?? null,
      total_tokens: estimatedTokens ?? 0,
      latency_ms: Date.now() - startedAt,
      error_message: message,
    });
  };

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") {
    logRejected(400, "请求参数不正确", null);
    return jsonError("请求参数不正确", 400);
  }

  const body = rawBody as Record<string, unknown>;
  const alias = body.model;
  if (typeof alias !== "string" || alias.length === 0) {
    logRejected(400, "缺少模型参数 model", null);
    return jsonError("缺少模型参数 model", 400);
  }

  const estimatedTokens = estimateRequestTokens(body);
  const quota = checkQuota(auth.user.id, estimatedTokens);
  if (!quota.ok) {
    logRejected(429, quota.reason, alias, estimatedTokens);
    return jsonError(quota.reason, 429);
  }

  const rate = checkUserRateLimit(auth.user, estimatedTokens);
  if (!rate.ok) {
    logRejected(429, rate.reason, alias, estimatedTokens);
    return jsonError(rate.reason, 429);
  }

  const existingRoute = selectModelRoute(alias);
  if (!existingRoute) {
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const settings = getGatewaySettings();
  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = body.stream === true;
  const streamOptions =
    body.stream_options && typeof body.stream_options === "object"
      ? (body.stream_options as Record<string, unknown>)
      : {};

  const baseOutgoingBody: Record<string, unknown> = stream
    ? { ...body, stream: true, stream_options: streamOptions }
    : body;

  const requestUpstreamWithFallback = async (): Promise<
    | {
        ok: true;
        route: RoutedModel;
        upstream: Response;
        attemptedChannels: number[];
        attemptedChannelNames: string[];
      }
    | {
        ok: false;
        route: RoutedModel | null;
        attemptedChannels: number[];
        attemptedChannelNames: string[];
      }
  > => {
    const attemptedChannels: number[] = [];
    const attemptedChannelNames: string[] = [];
    let lastNetworkRoute: RoutedModel | null = null;

    for (let attempt = 1; attempt <= maxRouteAttempts; attempt += 1) {
      const route = selectModelRoute(alias, { excludeChannelIds: attemptedChannels });
      if (!route) break;
      attemptedChannels.push(route.channel.id);
      attemptedChannelNames.push(route.channel.name);

      const outgoingBody: Record<string, unknown> = {
        ...baseOutgoingBody,
        model: route.model.real_model,
      };

      try {
        const upstream = await fetchUpstreamChat(route, outgoingBody);
        if (
          retryEnabled &&
          shouldRetryUpstreamStatus(upstream.status) &&
          attempt < maxRouteAttempts
        ) {
          await upstream.text().catch(() => "");
          continue;
        }
        return {
          ok: true,
          route,
          upstream,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
        };
      } catch {
        lastNetworkRoute = route;
        if (retryEnabled && attempt < maxRouteAttempts) {
          continue;
        }
        break;
      }
    }

    return {
      ok: false,
      route: lastNetworkRoute,
      attemptedChannels: [...attemptedChannels],
      attemptedChannelNames: [...attemptedChannelNames],
    };
  };

  const picked = await requestUpstreamWithFallback();
  if (!picked.ok) {
    addUsage(auth.user.id, auth.key.id, Math.max(1, estimatedTokens), 1);
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: picked.route?.channel.id ?? null,
      model_alias: alias,
      real_model: picked.route?.model.real_model ?? null,
      stream,
      status_code: 502,
      estimated_tokens: estimatedTokens,
      prompt_tokens: null,
      completion_tokens: 0,
      total_tokens: estimatedTokens,
      latency_ms: Date.now() - startedAt,
      first_token_latency_ms: null,
      output_tps: null,
      route_attempts: Math.max(1, picked.attemptedChannels.length),
      attempted_channels: picked.attemptedChannelNames.join(" -> "),
      error_message: "上游请求失败",
    });
    return jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    });
  }

  const { route, upstream, attemptedChannels, attemptedChannelNames } = picked;

  if (stream) {
    const localPromptTokens = countPromptTokensFromBody(body, route.model.real_model);
    if (upstream.status >= 400) {
      const text = await upstream.text().catch(() => "");
      addUsage(auth.user.id, auth.key.id, Math.max(1, localPromptTokens), 1);
      insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: localPromptTokens,
        completion_tokens: 0,
        total_tokens: localPromptTokens,
        latency_ms: Date.now() - startedAt,
        first_token_latency_ms: null,
        output_tps: null,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: `上游流式请求失败: ${upstream.status}`,
      });
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }

    if (!upstream.body) {
      const text = await upstream.text().catch(() => "");
      const completionText = extractCompletionTextFromJsonResponse(text);
      const completionTokens = Math.max(0, countTextTokens(completionText, route.model.real_model));
      const totalTokens = localPromptTokens + completionTokens;
      const outputTps =
        completionTokens > 0
          ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
          : null;

      addUsage(auth.user.id, auth.key.id, Math.max(1, totalTokens), 1);
      insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: localPromptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        latency_ms: Date.now() - startedAt,
        first_token_latency_ms: null,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: null,
      });
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    let firstTokenLatencyMs: number | null = null;
    let completionText = "";
    let sseBuffer = "";

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const totalLatencyMs = Date.now() - startedAt;
      const success = upstream.status < 400;
      const actualCompletionTokens = success ? Math.max(0, countTextTokens(completionText, route.model.real_model)) : 0;
      const actualTotalTokens = localPromptTokens + actualCompletionTokens;
      const outputTps =
        success && actualCompletionTokens > 0
          ? Number(((actualCompletionTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
          : null;

      addUsage(auth.user.id, auth.key.id, Math.max(1, actualTotalTokens), 1);
      insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: localPromptTokens,
        completion_tokens: actualCompletionTokens,
        total_tokens: actualTotalTokens,
        latency_ms: totalLatencyMs,
        first_token_latency_ms: success ? firstTokenLatencyMs : null,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: upstream.status >= 400 ? `上游流式请求失败: ${upstream.status}` : null,
      });
    };

    const streamOut = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            controller.enqueue(value);
            const decoded = decoder.decode(value, { stream: true });
            sseBuffer += decoded;

            const parsed = extractSseDataEvents(sseBuffer);
            sseBuffer = parsed.remainder;

            for (const data of parsed.events) {
              if (data === "[DONE]") {
                continue;
              }
              try {
                const json = JSON.parse(data) as {
                  choices?: Array<{ delta?: Record<string, unknown> }>;
                };

                const choices = Array.isArray(json.choices) ? json.choices : [];
                for (const choice of choices) {
                  const deltaText = extractDeltaText(choice?.delta);
                  if (deltaText.length > 0) {
                    completionText += deltaText;
                    if (firstTokenLatencyMs === null) {
                      firstTokenLatencyMs = Date.now() - startedAt;
                    }
                  }
                }
              } catch {
                // Keep forwarding stream even if one event is not JSON.
              }
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          finalize();
        }
      },
      cancel() {
        finalize();
      },
    });

    return new Response(streamOut, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
        connection: upstream.headers.get("connection") ?? "keep-alive",
      },
    });
  }

  const text = await upstream.text();
  const localPromptTokens = countPromptTokensFromBody(body, route.model.real_model);
  const completionText = extractCompletionTextFromJsonResponse(text);
  const localCompletionTokens =
    upstream.status < 400 ? Math.max(0, countTextTokens(completionText, route.model.real_model)) : 0;
  const localTotalTokens = localPromptTokens + localCompletionTokens;

  const outputTps =
    upstream.status < 400 && localCompletionTokens > 0
      ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
      : null;

  addUsage(auth.user.id, auth.key.id, Math.max(1, localTotalTokens), 1);
  insertChatLog({
    user_id: auth.user.id,
    key_id: auth.key.id,
    channel_id: route.channel.id,
    model_alias: alias,
    real_model: route.model.real_model,
    stream: false,
    status_code: upstream.status,
    estimated_tokens: estimatedTokens,
    prompt_tokens: localPromptTokens,
    completion_tokens: localCompletionTokens,
    total_tokens: localTotalTokens,
    latency_ms: Date.now() - startedAt,
    output_tps: outputTps,
    route_attempts: Math.max(1, attemptedChannels.length),
    attempted_channels: attemptedChannelNames.join(" -> "),
    error_message: upstream.status >= 400 ? `上游请求失败: ${upstream.status}` : null,
  });

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
