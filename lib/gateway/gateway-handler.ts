import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { checkChannelQuota, appendChannelQuotaHeaders } from "@/lib/gateway/channel-quota";
import { insertChatLog } from "@/lib/gateway/chat-log";
import { jsonError } from "@/lib/core/http";
import { checkModelQuota, appendModelQuotaHeaders } from "@/lib/gateway/model-quota";
import { resolveAccessibleModelAlias } from "@/lib/gateway/model-access";
import { getGatewayProtocolAdapter, type GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters";
import { createTransformedStream } from "@/lib/gateway/protocol-adapters/streaming";
import { appendQuotaHeaders, checkQuota } from "@/lib/gateway/quota";
import { createQueuedUpstreamResponse, normalizeUserAgent } from "@/lib/gateway/queued-upstream-response";
import { checkUserRateLimit } from "@/lib/gateway/ratelimit";
import { selectModelRoute, type RoutedModel } from "@/lib/gateway/router";
import { getGatewaySettings } from "@/lib/core/settings";
import { resolveClientIp } from "@/lib/core/client-ip";
import { resolveTokenUsage, tokenUsageMetadata } from "@/lib/gateway/token-usage";
import { buildErrorResponseBody, parseUpstreamError } from "@/lib/gateway/upstream-error";
import { addUsage } from "@/lib/gateway/usage-accounting";
import { requestUpstreamWithFallback } from "@/lib/gateway/upstream-routing";

export async function handleGatewayProtocolRequest(request: Request, inboundAdapter: GatewayProtocolAdapter) {
  const inboundProtocol = inboundAdapter.protocol;
  const startedAt = Date.now();
  const clientIp = resolveClientIp(request.headers);
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
  const allowedChannelIds = getUserAllowedChannelIds(auth.user);

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

  const existingRoute = selectModelRoute(resolvedAlias, { protocol: inboundProtocol, allowedChannelIds });
  if (!existingRoute) {
    if (allowedChannelIds && selectModelRoute(resolvedAlias, { protocol: inboundProtocol }) !== null) {
      logRejected(403, "当前用户组无可用渠道", alias, estimatedTokens);
      return jsonError("当前用户组无可用渠道", 403);
    }
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const quotaMode = existingRoute.model.quota_mode;
  const bypassUserLimits = quotaMode === "bypass_group" || quotaMode === "independent";

  const quotaHeaders: Record<string, string> = {};
  let channelQuotaHeaders: Record<string, string> | null = null;
  let modelQuotaHeaders: Record<string, string> | null = null;

  if (!bypassUserLimits) {
    const quotaResult = checkQuota(auth.user.id, estimatedTokens);
    if (!quotaResult.ok) {
      logRejected(429, quotaResult.reason, alias, estimatedTokens);
      const headers: Record<string, string> = {};
      if (quotaResult.quota) {
        appendQuotaHeaders(headers, quotaResult.quota);
      }
      return jsonError(quotaResult.reason, 429, undefined, headers);
    }
    appendQuotaHeaders(quotaHeaders, quotaResult.quota);

    const rate = checkUserRateLimit(auth.user, estimatedTokens);
    if (!rate.ok) {
      logRejected(429, rate.reason, alias, estimatedTokens);
      return jsonError(rate.reason, 429);
    }
  }

  if (quotaMode === "independent") {
    const modelQuotaResult = checkModelQuota(existingRoute.model.id, estimatedTokens);
    if (!modelQuotaResult.ok) {
      logRejected(429, modelQuotaResult.reason, alias, estimatedTokens);
      return jsonError(modelQuotaResult.reason, 429);
    }
    modelQuotaHeaders = {};
    appendModelQuotaHeaders(modelQuotaHeaders, modelQuotaResult.quota);
  }

  const withQuotaHeaders = (resp: Response): Response => {
    for (const [k, v] of Object.entries(quotaHeaders)) {
      resp.headers.set(k, v);
    }
    if (channelQuotaHeaders) {
      for (const [k, v] of Object.entries(channelQuotaHeaders)) {
        resp.headers.set(k, v);
      }
    }
    if (modelQuotaHeaders) {
      for (const [k, v] of Object.entries(modelQuotaHeaders)) {
        resp.headers.set(k, v);
      }
    }
    return resp;
  };

  const settings = getGatewaySettings();
  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = inboundAdapter.getStreamFlag(body);
  const getRouteAdapter = (route: RoutedModel) => getGatewayProtocolAdapter(route.model.upstream_protocol);
  const countPromptTokensForRoute = (route: RoutedModel) => inboundAdapter.countPromptTokens(body, route.model.real_model);
  const adaptRequestBodyForRoute = (route: RoutedModel) =>
    inboundAdapter.adaptRequestBody(
      body,
      getRouteAdapter(route),
      route.model.real_model,
      route.channel.force_include_usage !== 0,
    );
  const adaptResponseBodyForRoute = (rawText: string, route: RoutedModel) =>
    inboundAdapter.adaptResponseBody(rawText, getRouteAdapter(route), responseOptions);
  const getUsageForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).getUsageFromBody(rawText);
  const extractCompletionTextForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).extractCompletionTextFromBody(rawText);
  const extractReasoningTextForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).extractReasoningTextFromBody(rawText);
  const createTransformedStreamForRoute = (upstreamBody: ReadableStream<Uint8Array>, route: RoutedModel) =>
    createTransformedStream(upstreamBody, getRouteAdapter(route), inboundAdapter, responseOptions);

  const picked = await requestUpstreamWithFallback({
    resolvedAlias,
    inboundProtocol,
    maxRouteAttempts,
    requestSignal: request.signal,
    inboundHeaders: request.headers,
    allowedChannelIds,
    startedAt,
    estimatedTokens,
    buildRequestBody: adaptRequestBodyForRoute,
  });
  if (!picked.ok) {
    if (picked.route) {
      const cq = checkChannelQuota(picked.route.channel.id, estimatedTokens);
      if (cq.ok) {
        channelQuotaHeaders = {};
        appendChannelQuotaHeaders(channelQuotaHeaders, cq.quota);
      }
    }
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
      token_source: "estimated",
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
    const { route } = picked;
    const cq = checkChannelQuota(route.channel.id, estimatedTokens);
    if (cq.ok) {
      channelQuotaHeaders = {};
      appendChannelQuotaHeaders(channelQuotaHeaders, cq.quota);
    }
    const localPromptTokens = countPromptTokensForRoute(route);
    const upstreamBody = adaptRequestBodyForRoute(route);

    return createQueuedUpstreamResponse({
      picked,
      requestHeaders: request.headers,
      auth,
      alias,
      inboundProtocol,
      stream,
      startedAt,
      estimatedTokens,
      localPromptTokens,
      upstreamBody,
      clientIp,
      clientUserAgent,
      withQuotaHeaders,
      adaptResponseBodyForRoute,
      getUsageForRoute,
      extractCompletionTextForRoute,
      extractReasoningTextForRoute,
      createTransformedStreamForRoute,
    });
  }

  if (!("upstream" in picked)) {
    return withQuotaHeaders(jsonError("上游请求失败", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    }));
  }

  const { route, upstream, lease, attemptedChannels, attemptedChannelNames } = picked;
  const cq = checkChannelQuota(route.channel.id, estimatedTokens);
  if (cq.ok) {
    channelQuotaHeaders = {};
    appendChannelQuotaHeaders(channelQuotaHeaders, cq.quota);
  }
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
      const reasoningText = extractReasoningTextForRoute(rawText, route);
      const tokenUsage = resolveTokenUsage({
        usage,
        localPromptTokens,
        completionText,
        reasoningText,
        model: route.model.real_model,
      });
      const outputTps =
        tokenUsage.outputTpsTokens > 0
          ? Number(((tokenUsage.outputTpsTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
          : null;

      lease.complete({ ok: upstream.status < 400, latencyMs: Date.now() - startedAt });
      addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.quota_mode);
      insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: tokenUsage.promptTokens,
        completion_tokens: tokenUsage.completionTokens,
        total_tokens: tokenUsage.totalTokens,
        token_source: tokenUsage.source,
        metadata: tokenUsageMetadata(tokenUsage),
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
      const tokenUsage = resolveTokenUsage({
        usage: success ? transformed.usage() : null,
        localPromptTokens,
        completionText: success ? transformed.completionText() : "",
        reasoningText: success ? transformed.reasoningText() : "",
        model: route.model.real_model,
      });
      const outputTps =
        success && tokenUsage.outputTpsTokens > 0
          ? Number(((tokenUsage.outputTpsTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
          : null;
      const firstTokenAt = transformed.firstTokenAt();
      const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

      if (success) {
        addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.quota_mode);
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
        prompt_tokens: tokenUsage.promptTokens,
        completion_tokens: tokenUsage.completionTokens,
        total_tokens: tokenUsage.totalTokens,
        token_source: tokenUsage.source,
        metadata: tokenUsageMetadata(tokenUsage),
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
  const reasoningText = extractReasoningTextForRoute(rawText, route);
  const tokenUsage = resolveTokenUsage({
    usage,
    localPromptTokens,
    completionText,
    reasoningText,
    model: route.model.real_model,
  });

  const outputTps =
    tokenUsage.outputTpsTokens > 0
      ? Number(((tokenUsage.outputTpsTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
      : null;

  lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.quota_mode);
  insertChatLog({
    user_id: auth.user.id,
    key_id: auth.key.id,
    channel_id: route.channel.id,
    model_alias: alias,
    real_model: route.model.real_model,
    stream: false,
    status_code: upstream.status,
    estimated_tokens: estimatedTokens,
    prompt_tokens: tokenUsage.promptTokens,
    completion_tokens: tokenUsage.completionTokens,
    total_tokens: tokenUsage.totalTokens,
    token_source: tokenUsage.source,
    metadata: tokenUsageMetadata(tokenUsage),
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
