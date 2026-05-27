import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { acquireChannel, type ChannelLease } from "@/lib/gateway/channel-runtime";
import { insertChatLog } from "@/lib/gateway/chat-log";
import { jsonError } from "@/lib/core/http";
import { resolveAccessibleModelAlias } from "@/lib/gateway/model-access";
import { getGatewayProtocolAdapter, type GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters";
import { createTransformedStream } from "@/lib/gateway/protocol-adapters/streaming";
import { appendQuotaHeaders, checkQuota } from "@/lib/gateway/quota";
import { fetchUpstreamRequest } from "@/lib/gateway/proxy";
import { checkUserRateLimit } from "@/lib/gateway/ratelimit";
import { selectModelRoute, type RoutedModel } from "@/lib/gateway/router";
import { getGatewaySettings } from "@/lib/core/settings";
import { countTextTokens } from "@/lib/gateway/tokenizer";
import { buildErrorResponseBody, parseUpstreamError, shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";
import { addUsage } from "@/lib/gateway/usage-accounting";

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

function normalizeUserAgent(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 500) : null;
}

export async function handleGatewayProtocolRequest(request: Request, inboundAdapter: GatewayProtocolAdapter) {
  const inboundProtocol = inboundAdapter.protocol;
  const startedAt = Date.now();
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || null;
  const clientUserAgent = normalizeUserAgent(request.headers.get("user-agent"));
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
      user_agent: clientUserAgent,
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

  const estimatedTokens = inboundAdapter.estimateRequestTokens(body);
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
  const stream = inboundAdapter.getStreamFlag(body);
  const getRouteAdapter = (route: RoutedModel) => getGatewayProtocolAdapter(route.model.upstream_protocol);
  const countPromptTokensForRoute = (route: RoutedModel) => inboundAdapter.countPromptTokens(body, route.model.real_model);
  const adaptRequestBodyForRoute = (route: RoutedModel) =>
    inboundAdapter.adaptRequestBody(body, getRouteAdapter(route), route.model.real_model);
  const adaptResponseBodyForRoute = (rawText: string, route: RoutedModel) =>
    inboundAdapter.adaptResponseBody(rawText, getRouteAdapter(route), responseOptions);
  const getUsageForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).getUsageFromBody(rawText);
  const extractCompletionTextForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).extractCompletionTextFromBody(rawText);
  const createTransformedStreamForRoute = (upstreamBody: ReadableStream<Uint8Array>, route: RoutedModel) =>
    createTransformedStream(upstreamBody, getRouteAdapter(route), inboundAdapter, responseOptions);

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
        const upstreamBody = adaptRequestBodyForRoute(route);
        const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, request.headers);
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
      user_agent: clientUserAgent,
    });
    return withQuotaHeaders(jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    }));
  }

  if ("queued" in picked && picked.queued) {
    const { route, acquirePromise, attemptedChannels, attemptedChannelNames } = picked;
    const localPromptTokens = countPromptTokensForRoute(route);
    const upstreamBody = adaptRequestBodyForRoute(route);

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
              const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, request.headers);

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
      user_agent: clientUserAgent,
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
                const adaptedText = adaptResponseBodyForRoute(rawText, route);
                const usage = getUsageForRoute(rawText, route);
                const completionText = extractCompletionTextForRoute(rawText, route);
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
      user_agent: clientUserAgent,
                });

                controller.enqueue(toSseDataBlock(adaptedText));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              const transformed = createTransformedStreamForRoute(upstream.body, route);
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
      user_agent: clientUserAgent,
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
      user_agent: clientUserAgent,
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
            const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, request.headers);
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
      user_agent: clientUserAgent,
              });
              const errorBody = route.model.upstream_protocol === inboundProtocol
                ? rawText
                : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
              controller.enqueue(encoder.encode(errorBody));
              controller.close();
              return;
            }

            const adaptedText = adaptResponseBodyForRoute(rawText, route);
            const usage = getUsageForRoute(rawText, route);
            const completionText = extractCompletionTextForRoute(rawText, route);
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
      user_agent: clientUserAgent,
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
      user_agent: clientUserAgent,
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
  const localPromptTokens = countPromptTokensForRoute(route);

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
      user_agent: clientUserAgent,
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
      user_agent: clientUserAgent,
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
      const adaptedText = adaptResponseBodyForRoute(rawText, route);
      const usage = getUsageForRoute(rawText, route);
      const completionText = extractCompletionTextForRoute(rawText, route);
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
      user_agent: clientUserAgent,
      });
      return withQuotaHeaders(new Response(adaptedText, {
        status: upstream.status,
        headers: {
          "content-type": inboundProtocol === "responses" ? "application/json" : "application/json",
        },
      }));
    }

    const transformed = createTransformedStreamForRoute(upstream.body, route);
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
      user_agent: clientUserAgent,
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
      user_agent: clientUserAgent,
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
  const adaptedText = adaptResponseBodyForRoute(rawText, route);
  const usage = getUsageForRoute(rawText, route);
  const completionText = extractCompletionTextForRoute(rawText, route);
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
      user_agent: clientUserAgent,
  });

  return withQuotaHeaders(new Response(adaptedText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  }));
}
