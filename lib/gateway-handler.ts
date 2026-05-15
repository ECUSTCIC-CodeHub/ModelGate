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

function appendQuotaHeaders(headers: Record<string, string>, quota: QuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Quota-Limit-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Quota-Limit-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
  if (quota.period_remaining_requests !== null) {
    headers["X-Period-Quota-Requests-Remaining"] = String(quota.period_remaining_requests);
  }
  if (quota.period_remaining_tokens !== null) {
    headers["X-Period-Quota-Tokens-Remaining"] = String(quota.period_remaining_tokens);
  }
  if (quota.period_reset_at) {
    headers["X-Period-Quota-Reset"] = quota.period_reset_at;
  }
}

type QuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
  period_remaining_requests: number | null;
  period_remaining_tokens: number | null;
  period_reset_at: string | null;
};

function ensurePeriodReset(userId: number, period: number, resetAt: string | null): { period_used_tokens: number; period_used_requests: number; period_reset_at: string } {
  const now = new Date();
  if (resetAt && new Date(resetAt) > now) {
    const row = gatewayDb
      .prepare("SELECT period_used_tokens, period_used_requests, period_reset_at FROM users WHERE id = ?")
      .get(userId) as { period_used_tokens: number; period_used_requests: number; period_reset_at: string };
    return row;
  }
  const nextReset = new Date(now.getTime() + period * 1000).toISOString();
  gatewayDb
    .prepare("UPDATE users SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ? WHERE id = ?")
    .run(nextReset, userId);
  return { period_used_tokens: 0, period_used_requests: 0, period_reset_at: nextReset };
}

function checkQuota(userId: number, estimatedTokens: number): { ok: false; reason: string; quota?: QuotaInfo } | { ok: true; quota: QuotaInfo } {
  const user = gatewayDb
    .prepare(`SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests,
              quota_period, period_quota_tokens, period_quota_requests,
              period_used_tokens, period_used_requests, period_reset_at,
              rpm, qps, tpm FROM users WHERE id = ? AND deleted_at IS NULL`)
    .get(userId) as
    | {
        id: number;
        group_id: number | null;
        quota_tokens: number | null;
        quota_requests: number | null;
        used_tokens: number;
        used_requests: number;
        quota_period: number | null;
        period_quota_tokens: number | null;
        period_quota_requests: number | null;
        period_used_tokens: number;
        period_used_requests: number;
        period_reset_at: string | null;
        rpm: number;
        qps: number;
        tpm: number;
      }
    | undefined;

  if (!user) {
    return { ok: false, reason: "用户不存在" };
  }

  const limits = getEffectiveLimits(user as any);

  const quota: QuotaInfo = {
    remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
    remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    period_remaining_requests: null,
    period_remaining_tokens: null,
    period_reset_at: null,
  };

  if (limits.quota_requests !== null && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "请求配额已用尽", quota };
  }

  if (limits.quota_tokens !== null && user.used_tokens + estimatedTokens > limits.quota_tokens) {
    return { ok: false, reason: "Token 配额已用尽", quota };
  }

  if (limits.quota_period) {
    const period = ensurePeriodReset(userId, limits.quota_period, user.period_reset_at);
    quota.period_reset_at = period.period_reset_at;

    if (limits.period_quota_requests !== null) {
      quota.period_remaining_requests = Math.max(0, limits.period_quota_requests - period.period_used_requests);
      if (period.period_used_requests >= limits.period_quota_requests) {
        return { ok: false, reason: "周期请求配额已用尽", quota };
      }
    }

    if (limits.period_quota_tokens !== null) {
      quota.period_remaining_tokens = Math.max(0, limits.period_quota_tokens - period.period_used_tokens);
      if (period.period_used_tokens + estimatedTokens > limits.period_quota_tokens) {
        return { ok: false, reason: "周期 Token 配额已用尽", quota };
      }
    }
  }

  return { ok: true, quota };
}

function addUsage(userId: number, keyId: number, tokens: number, requests = 1, tokenMultiplier = 1, requestMultiplier = 1) {
  const billedTokens = Math.max(0, tokens * tokenMultiplier);
  const billedRequests = Math.max(0, requests * requestMultiplier);
  const tx = gatewayDb.transaction(() => {
    gatewayDb
      .prepare(
        `UPDATE users
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?,
             period_used_tokens = period_used_tokens + ?, period_used_requests = period_used_requests + ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(billedTokens, billedRequests, billedTokens, billedRequests, userId);

    gatewayDb
      .prepare(
        `UPDATE keys
         SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(billedTokens, billedRequests, keyId);
  });
  tx();
}

const RETRYABLE_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 504]);

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
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || null;
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
      client_ip: clientIp,
    });
  };

  const contentLength = parseInt(request.headers.get("content-length") || "0");
  if (contentLength > 10 * 1024 * 1024) {
    logRejected(413, "请求体过大", null);
    return jsonError("请求体过大", 413);
  }

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") {
    logRejected(400, "请求参数不正确", null);
    return jsonError("请求参数不正确", 400);
  }

  const body = rawBody as Record<string, unknown>;
  const thinkingRecord = body.thinking && typeof body.thinking === "object" ? (body.thinking as Record<string, unknown>) : null;
  const responseOptions = { thinkingEnabled: thinkingRecord?.type === "enabled" };
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

  const quotaResult = checkQuota(auth.user.id, estimatedTokens);
  if (!quotaResult.ok) {
    logRejected(429, quotaResult.reason, alias, estimatedTokens);
    const headers: Record<string, string> = {};
    if (quotaResult.quota) {
      appendQuotaHeaders(headers, quotaResult.quota);
    }
    return jsonError(quotaResult.reason, 429, undefined, headers);
  }
  const quotaHeaders: Record<string, string> = {};
  appendQuotaHeaders(quotaHeaders, quotaResult.quota);

  const withQuotaHeaders = (resp: Response): Response => {
    for (const [k, v] of Object.entries(quotaHeaders)) {
      resp.headers.set(k, v);
    }
    return resp;
  };

  const rate = checkUserRateLimit(auth.user, estimatedTokens);
  if (!rate.ok) {
    logRejected(429, rate.reason, alias, estimatedTokens);
    return jsonError(rate.reason, 429);
  }

  const existingRoute = selectModelRoute(resolvedAlias, { protocol: inboundProtocol });
  if (!existingRoute) {
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const settings = getGatewaySettings();
  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = inboundProtocol === "embeddings" ? false : getStreamFlag(body);

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
        protocol: inboundProtocol,
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
      client_ip: clientIp,
    });
    return withQuotaHeaders(jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    }));
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

            if (!acquireResult.ok) {
              controller.enqueue(toSseDataBlock(buildErrorResponseBody("渠道排队超时", 503, inboundProtocol, "queue_timeout", "503")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            const lease = acquireResult.lease;

            try {
              const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);

              if (upstream.status >= 400) {
                const text = await upstream.text().catch(() => "");
                const upstreamError = parseUpstreamError(text, upstream.status);
                lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
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
                const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol, responseOptions);
                const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
                const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
                const completionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
                const totalTokens = usage?.total_tokens ?? localPromptTokens + completionTokens;
                const outputTps =
                  completionTokens > 0
                    ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
                    : null;

                lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
                addUsage(auth.user.id, auth.key.id, Math.max(1, totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
      client_ip: clientIp,
                });

                controller.enqueue(toSseDataBlock(adaptedText));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              const transformed = createTransformedStream(upstream.body, route.model.upstream_protocol, inboundProtocol, responseOptions);
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

                if (success) {
                  addUsage(auth.user.id, auth.key.id, Math.max(1, actualTotalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
                }
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
                  error_message: success ? null : `上游流式请求失败: ${upstream.status}`,
      client_ip: clientIp,
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
      client_ip: clientIp,
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

      return withQuotaHeaders(new Response(queuedStream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      }));
    }

    const queuedBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const keepAliveTimer = createQueueKeepAliveTimer(controller, false);

        try {
          const acquireResult = await acquirePromise;
          clearInterval(keepAliveTimer);

          if (!acquireResult.ok) {
            controller.enqueue(encoder.encode(buildErrorResponseBody("渠道排队超时", 503, inboundProtocol, "queue_timeout", "503")));
            controller.close();
            return;
          }

          const lease = acquireResult.lease;

          try {
            const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);
            const rawText = await upstream.text().catch(() => "");

            if (upstream.status >= 400) {
              const upstreamError = parseUpstreamError(rawText, upstream.status);
              lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
              });
              const errorBody = route.model.upstream_protocol === inboundProtocol
                ? rawText
                : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
              controller.enqueue(encoder.encode(errorBody));
              controller.close();
              return;
            }

            const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol, responseOptions);
            const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
            const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
            const localCompletionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
            const localTotalTokens = usage?.total_tokens ?? (localPromptTokens + localCompletionTokens);
            const outputTps =
              localCompletionTokens > 0
                ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
                : null;

            lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
            addUsage(auth.user.id, auth.key.id, Math.max(1, localTotalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
      client_ip: clientIp,
            });

            controller.enqueue(encoder.encode(adaptedText));
            controller.close();
          } catch {
            lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
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

    return withQuotaHeaders(new Response(queuedBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    }));
  }

  if (!("upstream" in picked)) {
    return withQuotaHeaders(jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    }));
  }

  const { route, upstream, lease, attemptedChannels, attemptedChannelNames } = picked;
  const localPromptTokens = countPromptTokensForProtocol(body, inboundProtocol, route.model.real_model);

  if (stream) {
    if (upstream.status >= 400) {
      const text = await upstream.text().catch(() => "");
      const upstreamError = parseUpstreamError(text, upstream.status);
      lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
      });
      const errorBody = route.model.upstream_protocol === inboundProtocol
        ? text
        : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
      return withQuotaHeaders(new Response(errorBody, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
        },
      }));
    }

    if (!upstream.body) {
      const rawText = await upstream.text().catch(() => "");
      if (upstream.status >= 400) {
        const upstreamError = parseUpstreamError(rawText, upstream.status);
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
        });
        const errorBody = route.model.upstream_protocol === inboundProtocol
          ? rawText
          : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
        return withQuotaHeaders(new Response(errorBody, {
          status: upstream.status,
          headers: {
            "content-type": "application/json",
          },
        }));
      }
      const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol, responseOptions);
      const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
      const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
      const completionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
      const totalTokens = usage?.total_tokens ?? localPromptTokens + completionTokens;
      const outputTps =
        completionTokens > 0
          ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
          : null;

      lease.complete({ ok: upstream.status < 400, latencyMs: Date.now() - startedAt });
      addUsage(auth.user.id, auth.key.id, Math.max(1, totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
      client_ip: clientIp,
      });
      return withQuotaHeaders(new Response(adaptedText, {
        status: upstream.status,
        headers: {
          "content-type": inboundProtocol === "responses" ? "application/json" : "application/json",
        },
      }));
    }

    const transformed = createTransformedStream(upstream.body, route.model.upstream_protocol, inboundProtocol, responseOptions);
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

      if (success) {
        addUsage(auth.user.id, auth.key.id, Math.max(1, actualTotalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
      }
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
        error_message: success ? null : `上游流式请求失败: ${upstream.status}`,
      client_ip: clientIp,
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

    return withQuotaHeaders(new Response(wrapped, {
      status: upstream.status,
      headers: {
        "content-type": inboundProtocol === "responses" ? "text/event-stream" : "text/event-stream",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      },
    }));
  }

  const rawText = await upstream.text();
  if (upstream.status >= 400) {
    const upstreamError = parseUpstreamError(rawText, upstream.status);
    lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
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
      client_ip: clientIp,
    });
    const errorBody = route.model.upstream_protocol === inboundProtocol
      ? rawText
      : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
    return withQuotaHeaders(new Response(errorBody, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
      },
    }));
  }
  const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol, responseOptions);
  const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
  const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
  const localCompletionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
  const localTotalTokens = usage?.total_tokens ?? (localPromptTokens + localCompletionTokens);

  const outputTps =
    localCompletionTokens > 0
      ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
      : null;

  lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
  addUsage(auth.user.id, auth.key.id, Math.max(1, localTotalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
      client_ip: clientIp,
  });

  return withQuotaHeaders(new Response(adaptedText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  }));
}
