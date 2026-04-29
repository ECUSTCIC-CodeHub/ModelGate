import { checkApiKeyAuth } from "@/lib/api-key-auth";
import { acquireChannel, type ChannelLease } from "@/lib/channel-runtime";
import { insertChatLog } from "@/lib/chat-log";
import { gatewayDb } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";
import { jsonError } from "@/lib/http";
import { resolveAccessibleModelAlias } from "@/lib/model-access";
import {
  adaptRequestBody,
  adaptResponseBody,
  countPromptTokensForProtocol,
  createTransformedStream,
  estimateRequestTokensForProtocol,
  extractCompletionTextFromBody,
  getStreamFlag,
  getUsageFromBody,
} from "@/lib/openai-adapter";
import { fetchUpstreamRequest } from "@/lib/proxy";
import { checkUserRateLimit } from "@/lib/ratelimit";
import { selectModelRoute, type RoutedModel } from "@/lib/router";
import { getGatewaySettings } from "@/lib/settings";
import { countTextTokens } from "@/lib/tokenizer";
import type { GatewayProtocol } from "@/lib/protocols";

function checkQuota(userId: number, estimatedTokens: number) {
  const user = gatewayDb
    .prepare("SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests, rpm, qps, tpm FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(userId) as
    | {
        id: number;
        group_id: number | null;
        quota_tokens: number | null;
        quota_requests: number | null;
        used_tokens: number;
        used_requests: number;
        rpm: number;
        qps: number;
        tpm: number;
      }
    | undefined;

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  const limits = getEffectiveLimits(user as any);

  if (limits.quota_requests !== null && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "请求配额已用尽" };
  }

  if (limits.quota_tokens !== null && user.used_tokens + estimatedTokens > limits.quota_tokens) {
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

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

function shouldRetryUpstreamStatus(status: number) {
  return RETRYABLE_UPSTREAM_STATUS.has(status);
}

function parseUpstreamError(text: string, status: number) {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    const message =
      (typeof error?.message === "string" ? error.message : null)
      ?? (typeof parsed.message === "string" ? parsed.message : null)
      ?? text.trim()
      ?? `上游请求失败 (${status})`;
    const type =
      (typeof error?.type === "string" ? error.type : null)
      ?? (typeof parsed.type === "string" ? parsed.type : null)
      ?? "upstream_error";
    const code =
      (typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null)
      ?? status;
    return { message, type, code };
  } catch {
    const message = text.trim() || `上游请求失败 (${status})`;
    return { message, type: "upstream_error", code: status };
  }
}

function buildErrorResponseBody(message: string, status: number, inboundProtocol: GatewayProtocol, type?: string, code?: string | number) {
  if (inboundProtocol === "anthropic_messages") {
    return JSON.stringify({
      type: "error",
      error: {
        type: type ?? "api_error",
        message,
      },
    });
  }

  return JSON.stringify({
    error: {
      message,
      type: type ?? (status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error"),
      param: "None",
      code: String(code ?? status),
    },
  });
}

const QUEUE_KEEPALIVE_INTERVAL_MS = 1_000;
const encoder = new TextEncoder();

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function createQueueKeepAliveTimer(controller: ReadableStreamDefaultController<Uint8Array>, stream: boolean) {
  return setInterval(() => {
    controller.enqueue(encoder.encode(stream ? ": keep-alive\n\n" : "\n"));
  }, QUEUE_KEEPALIVE_INTERVAL_MS);
}

function toSseDataBlock(payload: string) {
  const compact = payload.replace(/\r?\n/g, "");
  return encoder.encode(`data: ${compact}\n\n`);
}

export async function handleGatewayProtocolRequest(request: Request, inboundProtocol: GatewayProtocol) {
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
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
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

  const estimatedTokens = estimateRequestTokensForProtocol(body, inboundProtocol);
  const resolved = resolveAccessibleModelAlias(auth.user, alias);
  if (!resolved.ok) {
    if (resolved.reason === "forbidden") {
      logRejected(403, "当前用户无权访问该模型", alias, estimatedTokens);
      return jsonError("当前用户无权访问该模型", 403);
    }
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }
  const resolvedAlias = resolved.alias;

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

  const existingRoute = selectModelRoute(resolvedAlias);
  if (!existingRoute) {
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const settings = getGatewaySettings();
  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = getStreamFlag(body);

  const requestUpstreamWithFallback = async (): Promise<
    | {
        ok: true;
        route: RoutedModel;
        upstream: Response;
        lease: ChannelLease;
        attemptedChannels: number[];
        attemptedChannelNames: string[];
      }
    | {
        ok: true;
        queued: true;
        route: RoutedModel;
        acquirePromise: Promise<{ ok: true; lease: ChannelLease; queued: boolean }>;
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
    const attemptedChannels = new Set<number>();
    const attemptedChannelNames: string[] = [];
    let attempt = 0;
    let lastNetworkRoute: RoutedModel | null = null;

    while (attempt < maxRouteAttempts) {
      const route = selectModelRoute(resolvedAlias, {
        excludeChannelIds: [...attemptedChannels],
      });

      if (!route) {
        break;
      }

      lastNetworkRoute = route;
      attempt += 1;
      attemptedChannels.add(route.channel.id);
      attemptedChannelNames.push(route.channel.name);

      const leaseResult = acquireChannel(route.channel.id, route.channel.max_concurrency, request.signal);
      if (isPromiseLike(leaseResult)) {
        return {
          ok: true,
          queued: true,
          route,
          acquirePromise: leaseResult as Promise<{ ok: true; lease: ChannelLease; queued: boolean }>,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
        };
      }

      if (!leaseResult.ok) {
        continue;
      }
      const lease = leaseResult.lease;

      try {
        const upstreamBody = adaptRequestBody(body, inboundProtocol, route.model.upstream_protocol, route.model.real_model);
        const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);
        if (shouldRetryUpstreamStatus(upstream.status) && attempt < maxRouteAttempts) {
          lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
          continue;
        }
        return {
          ok: true,
          route,
          upstream,
          lease,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
        };
      } catch {
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        if (attempt >= maxRouteAttempts) break;
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

  if ("queued" in picked && picked.queued) {
    const { route, acquirePromise, attemptedChannels, attemptedChannelNames } = picked;
    const localPromptTokens = countPromptTokensForProtocol(body, inboundProtocol, route.model.real_model);
    const upstreamBody = adaptRequestBody(body, inboundProtocol, route.model.upstream_protocol, route.model.real_model);

    if (stream) {
      const queuedStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const keepAliveTimer = createQueueKeepAliveTimer(controller, true);

          try {
            const acquireResult = await acquirePromise;
            clearInterval(keepAliveTimer);
            const lease = acquireResult.lease;

            try {
              const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);

              if (upstream.status >= 400) {
                const text = await upstream.text().catch(() => "");
                const upstreamError = parseUpstreamError(text, upstream.status);
                lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
                  error_message: upstreamError.message,
                });

                const errorBody = route.model.upstream_protocol === inboundProtocol
                  ? text
                  : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
                controller.enqueue(toSseDataBlock(errorBody));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              if (!upstream.body) {
                const rawText = await upstream.text().catch(() => "");
                const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
                const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
                const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
                const completionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
                const totalTokens = usage?.total_tokens ?? localPromptTokens + completionTokens;
                const outputTps =
                  completionTokens > 0
                    ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
                    : null;

                lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
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
                  prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: totalTokens,
                  latency_ms: Date.now() - startedAt,
                  first_token_latency_ms: null,
                  output_tps: outputTps,
                  route_attempts: Math.max(1, attemptedChannels.length),
                  attempted_channels: attemptedChannelNames.join(" -> "),
                  error_message: null,
                });

                controller.enqueue(toSseDataBlock(adaptedText));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              const transformed = createTransformedStream(upstream.body, route.model.upstream_protocol, inboundProtocol);
              let finalized = false;
              const finalize = () => {
                if (finalized) return;
                finalized = true;
                const totalLatencyMs = Date.now() - startedAt;
                lease.complete({ ok: upstream.status < 400, latencyMs: totalLatencyMs });
                const actualCompletionTokens = Math.max(0, countTextTokens(transformed.completionText(), route.model.real_model));
                const actualTotalTokens = localPromptTokens + actualCompletionTokens;
                const outputTps =
                  actualCompletionTokens > 0
                    ? Number(((actualCompletionTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
                    : null;
                const firstTokenAt = transformed.firstTokenAt();
                const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

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
                  first_token_latency_ms: firstTokenLatencyMs,
                  output_tps: outputTps,
                  route_attempts: Math.max(1, attemptedChannels.length),
                  attempted_channels: attemptedChannelNames.join(" -> "),
                  error_message: upstream.status >= 400 ? `上游流式请求失败: ${upstream.status}` : null,
                });
              };

              const reader = transformed.stream.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) controller.enqueue(value);
                }
                controller.close();
              } catch (error) {
                controller.error(error);
              } finally {
                finalize();
              }
            } catch {
              lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
              addUsage(auth.user.id, auth.key.id, Math.max(1, localPromptTokens), 1);
              insertChatLog({
                user_id: auth.user.id,
                key_id: auth.key.id,
                channel_id: route.channel.id,
                model_alias: alias,
                real_model: route.model.real_model,
                stream: true,
                status_code: 502,
                estimated_tokens: estimatedTokens,
                prompt_tokens: localPromptTokens,
                completion_tokens: 0,
                total_tokens: localPromptTokens,
                latency_ms: Date.now() - startedAt,
                first_token_latency_ms: null,
                output_tps: null,
                route_attempts: Math.max(1, attemptedChannels.length),
                attempted_channels: attemptedChannelNames.join(" -> "),
                error_message: "上游请求失败",
              });
              controller.enqueue(toSseDataBlock(buildErrorResponseBody("上游请求失败", 502, inboundProtocol, "upstream_error", "502")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          } catch {
            clearInterval(keepAliveTimer);
            controller.error(new Error("Request aborted while waiting for channel queue."));
          }
        },
      });

      return new Response(queuedStream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const queuedBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const keepAliveTimer = createQueueKeepAliveTimer(controller, false);

        try {
          const acquireResult = await acquirePromise;
          clearInterval(keepAliveTimer);
          const lease = acquireResult.lease;

          try {
            const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);
            const rawText = await upstream.text().catch(() => "");

            if (upstream.status >= 400) {
              const upstreamError = parseUpstreamError(rawText, upstream.status);
              lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
              addUsage(auth.user.id, auth.key.id, Math.max(1, localPromptTokens), 1);
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
                completion_tokens: 0,
                total_tokens: localPromptTokens,
                latency_ms: Date.now() - startedAt,
                output_tps: null,
                route_attempts: Math.max(1, attemptedChannels.length),
                attempted_channels: attemptedChannelNames.join(" -> "),
                error_message: upstreamError.message,
              });
              const errorBody = route.model.upstream_protocol === inboundProtocol
                ? rawText
                : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
              controller.enqueue(encoder.encode(errorBody));
              controller.close();
              return;
            }

            const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
            const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
            const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
            const localCompletionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
            const localTotalTokens = usage?.total_tokens ?? (localPromptTokens + localCompletionTokens);
            const outputTps =
              localCompletionTokens > 0
                ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
                : null;

            lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
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
              prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
              completion_tokens: localCompletionTokens,
              total_tokens: localTotalTokens,
              latency_ms: Date.now() - startedAt,
              output_tps: outputTps,
              route_attempts: Math.max(1, attemptedChannels.length),
              attempted_channels: attemptedChannelNames.join(" -> "),
              error_message: null,
            });

            controller.enqueue(encoder.encode(adaptedText));
            controller.close();
          } catch {
            lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
            addUsage(auth.user.id, auth.key.id, Math.max(1, localPromptTokens), 1);
            insertChatLog({
              user_id: auth.user.id,
              key_id: auth.key.id,
              channel_id: route.channel.id,
              model_alias: alias,
              real_model: route.model.real_model,
              stream: false,
              status_code: 502,
              estimated_tokens: estimatedTokens,
              prompt_tokens: localPromptTokens,
              completion_tokens: 0,
              total_tokens: localPromptTokens,
              latency_ms: Date.now() - startedAt,
              output_tps: null,
              route_attempts: Math.max(1, attemptedChannels.length),
              attempted_channels: attemptedChannelNames.join(" -> "),
              error_message: "上游请求失败",
            });
            controller.enqueue(encoder.encode(buildErrorResponseBody("上游请求失败", 502, inboundProtocol, "upstream_error", "502")));
            controller.close();
          }
        } catch {
          clearInterval(keepAliveTimer);
          controller.error(new Error("Request aborted while waiting for channel queue."));
        }
      },
    });

    return new Response(queuedBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  if (!("upstream" in picked)) {
    return jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    });
  }

  const { route, upstream, lease, attemptedChannels, attemptedChannelNames } = picked;
  const localPromptTokens = countPromptTokensForProtocol(body, inboundProtocol, route.model.real_model);

  if (stream) {
    if (upstream.status >= 400) {
      const text = await upstream.text().catch(() => "");
      const upstreamError = parseUpstreamError(text, upstream.status);
      lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
        error_message: upstreamError.message,
      });
      const errorBody = route.model.upstream_protocol === inboundProtocol
        ? text
        : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
      return new Response(errorBody, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (!upstream.body) {
      const rawText = await upstream.text().catch(() => "");
      if (upstream.status >= 400) {
        const upstreamError = parseUpstreamError(rawText, upstream.status);
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
          error_message: upstreamError.message,
        });
        const errorBody = route.model.upstream_protocol === inboundProtocol
          ? rawText
          : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
        return new Response(errorBody, {
          status: upstream.status,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
      const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
      const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
      const completionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
      const totalTokens = usage?.total_tokens ?? localPromptTokens + completionTokens;
      const outputTps =
        completionTokens > 0
          ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
          : null;

      lease.complete({ ok: upstream.status < 400, latencyMs: Date.now() - startedAt });
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
        prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        latency_ms: Date.now() - startedAt,
        first_token_latency_ms: null,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: null,
      });
      return new Response(adaptedText, {
        status: upstream.status,
        headers: {
          "content-type": inboundProtocol === "responses" ? "application/json" : "application/json",
        },
      });
    }

    const transformed = createTransformedStream(upstream.body, route.model.upstream_protocol, inboundProtocol);
    const streamOut = transformed.stream;
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const totalLatencyMs = Date.now() - startedAt;
      const success = upstream.status < 400;
      lease.complete({ ok: success, latencyMs: totalLatencyMs });
      const actualCompletionTokens = success ? Math.max(0, countTextTokens(transformed.completionText(), route.model.real_model)) : 0;
      const actualTotalTokens = localPromptTokens + actualCompletionTokens;
      const outputTps =
        success && actualCompletionTokens > 0
          ? Number(((actualCompletionTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
          : null;
      const firstTokenAt = transformed.firstTokenAt();
      const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

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
        first_token_latency_ms: firstTokenLatencyMs,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: upstream.status >= 400 ? `上游流式请求失败: ${upstream.status}` : null,
      });
    };

    const wrapped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = streamOut.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            controller.enqueue(value);
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

    return new Response(wrapped, {
      status: upstream.status,
      headers: {
        "content-type": inboundProtocol === "responses" ? "text/event-stream" : "text/event-stream",
        "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
        connection: upstream.headers.get("connection") ?? "keep-alive",
      },
    });
  }

  const rawText = await upstream.text();
  if (upstream.status >= 400) {
    const upstreamError = parseUpstreamError(rawText, upstream.status);
    lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
    addUsage(auth.user.id, auth.key.id, Math.max(1, localPromptTokens), 1);
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
      completion_tokens: 0,
      total_tokens: localPromptTokens,
      latency_ms: Date.now() - startedAt,
      output_tps: null,
      route_attempts: Math.max(1, attemptedChannels.length),
      attempted_channels: attemptedChannelNames.join(" -> "),
      error_message: upstreamError.message,
    });
    const errorBody = route.model.upstream_protocol === inboundProtocol
      ? rawText
      : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
    return new Response(errorBody, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
  const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
  const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
  const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
  const localCompletionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
  const localTotalTokens = usage?.total_tokens ?? (localPromptTokens + localCompletionTokens);

  const outputTps =
    localCompletionTokens > 0
      ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
      : null;

  lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
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
    prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
    completion_tokens: localCompletionTokens,
    total_tokens: localTotalTokens,
    latency_ms: Date.now() - startedAt,
    output_tps: outputTps,
    route_attempts: Math.max(1, attemptedChannels.length),
    attempted_channels: attemptedChannelNames.join(" -> "),
    error_message: null,
  });

  return new Response(adaptedText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
