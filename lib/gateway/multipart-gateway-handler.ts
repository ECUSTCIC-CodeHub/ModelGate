import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { checkChannelQuota, appendChannelQuotaHeaders } from "@/lib/gateway/channel-quota";
import { insertChatLog, withSubstitutionNote } from "@/lib/gateway/chat-log";
import { jsonError } from "@/lib/core/http";
import { checkModelQuota, appendModelQuotaHeaders } from "@/lib/gateway/model-quota";
import { resolveAccessibleModelAlias } from "@/lib/gateway/model-access";
import { appendQuotaHeaders, checkQuota } from "@/lib/gateway/quota";
import { normalizeUserAgent } from "@/lib/gateway/queued-upstream-response";
import { checkUserRateLimit } from "@/lib/gateway/ratelimit";
import { selectModelRoute, findUaDenyMatchForAlias, resolveModelFallbackAlias } from "@/lib/gateway/router";
import { resolveClientIp } from "@/lib/core/client-ip";
import { getGatewaySettings } from "@/lib/core/settings";
import { isFeatureEnabled } from "@/lib/core/features";
import { checkUserAgentRestrictions, parseUaRestrictions } from "@/lib/gateway/ua-restrictions";
import { buildErrorResponseBody, parseUpstreamError } from "@/lib/gateway/upstream-error";
import { addUsage } from "@/lib/gateway/usage-accounting";
import { acquireChannel, makeModelRuntimeKey } from "@/lib/gateway/channel-runtime";

function estimatePromptTokens(prompt: unknown): number {
  if (typeof prompt !== "string") return 1;
  return Math.max(1, Math.ceil(prompt.length / 4));
}

export async function handleMultipartGatewayRequest(request: Request) {
  const startedAt = Date.now();
  const clientIp = resolveClientIp(request.headers);
  const clientUserAgent = normalizeUserAgent(request.headers.get("user-agent"));
  const authResult = await checkApiKeyAuth(request);
  if (!authResult.ok) {
    return jsonError(authResult.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。", 401, {
      type: "auth_error",
      param: "None",
      code: "401",
    });
  }
  const auth = authResult.context;
  const allowedChannelIds = await getUserAllowedChannelIds(auth.user);

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

  const uaEnabled = isFeatureEnabled("uaRestrictions");
  const globalUaRules = uaEnabled
    ? parseUaRestrictions((await getGatewaySettings()).ua_restrictions)
    : [];
  if (globalUaRules.length > 0) {
    const globalMatch = checkUserAgentRestrictions({
      userAgent: clientUserAgent,
      globalRules: globalUaRules,
      channelRules: [],
      modelRules: [],
    });
    if (globalMatch.matched && !globalMatch.allowed) {
      logRejected(429, globalMatch.rule.error_message, null);
      return jsonError(globalMatch.rule.error_message, globalMatch.rule.error_code, {
        type: "invalid_request_error",
        param: "user-agent",
        code: String(globalMatch.rule.error_code),
      });
    }
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    logRejected(400, "请求必须为 multipart/form-data 格式", null);
    return jsonError("请求必须为 multipart/form-data 格式", 400);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    logRejected(400, "解析 multipart 请求失败", null);
    return jsonError("解析 multipart 请求失败", 400);
  }

  const rawAlias = formData.get("model");
  if (typeof rawAlias !== "string" || rawAlias.length === 0) {
    logRejected(400, "缺少模型参数 model", null);
    return jsonError("缺少模型参数 model", 400);
  }
  const alias: string = rawAlias;

  const rawPrompt = formData.get("prompt");
  const estimatedTokens = estimatePromptTokens(typeof rawPrompt === "string" ? rawPrompt : null);

  const settings = await getGatewaySettings();
  const resolved = await resolveAccessibleModelAlias(auth.user, alias);
  let resolvedAlias: string;
  let modelFallbackNote: string | null = null;
  if (!resolved.ok) {
    if (resolved.reason === "forbidden") {
      logRejected(403, "当前用户无权访问该模型", alias, estimatedTokens);
      return jsonError("当前用户无权访问该模型", 403);
    }
    const fallbackAlias = await resolveModelFallbackAlias({
      user: auth.user,
      requestedAlias: alias,
      fallbackEnabled: settings.model_fallback_enabled === 1,
      preferredGlobalAlias: settings.model_fallback_alias,
      protocol: "images",
      allowedChannelIds,
      userAgent: uaEnabled ? clientUserAgent : undefined,
    });
    if (fallbackAlias) {
      resolvedAlias = fallbackAlias;
      modelFallbackNote = "请求模型不存在或已禁用，已自动替换";
    } else {
      logRejected(404, "模型别名不存在或已禁用", alias);
      return jsonError("模型别名不存在或已禁用", 404);
    }
  } else {
    resolvedAlias = resolved.alias;
  }

  const existingRoute = await selectModelRoute(resolvedAlias, {
    protocol: "images",
    allowedChannelIds,
    userAgent: uaEnabled ? clientUserAgent : undefined,
  });
  if (!existingRoute) {
    if (uaEnabled) {
      const nonUaRoute = await selectModelRoute(resolvedAlias, { protocol: "images", allowedChannelIds });
      if (nonUaRoute !== null) {
        const denyMatch = await findUaDenyMatchForAlias(resolvedAlias, clientUserAgent, allowedChannelIds, "images");
        if (denyMatch) {
          logRejected(429, denyMatch.rule.error_message, alias);
          return jsonError(denyMatch.rule.error_message, denyMatch.rule.error_code, {
            type: "invalid_request_error",
            param: "user-agent",
            code: String(denyMatch.rule.error_code),
          });
        }
      }
    }
    if (allowedChannelIds) {
      const withoutRestriction = await selectModelRoute(resolvedAlias, { protocol: "images" });
      if (withoutRestriction !== null) {
        logRejected(403, "当前用户组无可用渠道", alias, estimatedTokens);
        return jsonError("当前用户组无可用渠道", 403);
      }
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
    const quotaResult = await checkQuota(auth.user.id, estimatedTokens);
    if (!quotaResult.ok) {
      logRejected(429, quotaResult.reason, alias, estimatedTokens);
      const headers: Record<string, string> = {};
      if (quotaResult.quota) {
        appendQuotaHeaders(headers, quotaResult.quota);
      }
      return jsonError(quotaResult.reason, 429, undefined, headers);
    }
    appendQuotaHeaders(quotaHeaders, quotaResult.quota);

    const rate = await checkUserRateLimit(auth.user, estimatedTokens);
    if (!rate.ok) {
      logRejected(429, rate.reason, alias, estimatedTokens);
      return jsonError(rate.reason, 429);
    }
  }

  if (quotaMode === "independent") {
    const modelQuotaResult = await checkModelQuota(existingRoute.model.id, estimatedTokens);
    if (!modelQuotaResult.ok) {
      logRejected(429, modelQuotaResult.reason, alias, estimatedTokens);
      return jsonError(modelQuotaResult.reason, 429);
    }
    modelQuotaHeaders = {};
    appendModelQuotaHeaders(modelQuotaHeaders, modelQuotaResult.quota);
  }

  const withQuotaHeaders = (resp: Response): Response => {
    for (const [k, v] of Object.entries(quotaHeaders)) resp.headers.set(k, v);
    if (channelQuotaHeaders) for (const [k, v] of Object.entries(channelQuotaHeaders)) resp.headers.set(k, v);
    if (modelQuotaHeaders) for (const [k, v] of Object.entries(modelQuotaHeaders)) resp.headers.set(k, v);
    return resp;
  };

  const route = existingRoute;
  const runtimeKey = makeModelRuntimeKey(route.channel.id, route.model.real_model);
  const leaseResult = acquireChannel(runtimeKey, route.channel.max_concurrency, request.signal);
  if (typeof leaseResult === "object" && leaseResult !== null && "then" in leaseResult) {
    const acquireResult = await leaseResult;
    if (!acquireResult.ok) {
      logRejected(503, "渠道排队超时", alias, estimatedTokens);
      return withQuotaHeaders(jsonError("渠道排队超时", 503));
    }
    return await executeMultipartRequest(acquireResult.lease);
  }

  if (!leaseResult.ok) {
    logRejected(503, "渠道并发已满", alias, estimatedTokens);
    return withQuotaHeaders(jsonError("渠道并发已满", 503));
  }

  return await executeMultipartRequest(leaseResult.lease);

  async function executeMultipartRequest(lease: { complete: (result: { ok: boolean; latencyMs: number }) => void; abandon: () => void }) {
    const cq = await checkChannelQuota(route.channel.id, estimatedTokens);
    if (!cq.ok) {
      lease.abandon();
      logRejected(429, cq.reason, alias, estimatedTokens);
      return withQuotaHeaders(jsonError(cq.reason, 429));
    }
    channelQuotaHeaders = {};
    appendChannelQuotaHeaders(channelQuotaHeaders, cq.quota);

    const upstreamFormData = new FormData();
    for (const [key, value] of formData.entries()) {
      if (key === "model") {
        upstreamFormData.set("model", route.model.real_model);
      } else {
        upstreamFormData.append(key, value);
      }
    }

    const upstreamUrl = `${route.channel.base_url.replace(/\/+$/, "").replace(/\/images\/edits$/, "").replace(/\/images\/generations$/, "")}/images/edits`;
    const { controller, timeout } = createTimeoutController(route.channel.timeout);

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          ...(route.channel.api_key?.trim()
            ? { authorization: `Bearer ${route.channel.api_key.trim()}` }
            : {}),
          "user-agent": clientUserAgent ?? "OpenAI/JS 6.39.0",
        },
        body: upstreamFormData,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
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
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: estimatedTokens,
        latency_ms: Date.now() - startedAt,
        error_message: "上游请求失败",
        client_ip: clientIp,
        user_agent: clientUserAgent,
      });
      return withQuotaHeaders(jsonError("上游请求失败", 502, { type: "upstream_error", param: "None", code: "502" }));
    } finally {
      clearTimeout(timeout);
    }

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
        stream: false,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: estimatedTokens,
        latency_ms: Date.now() - startedAt,
        error_message: upstreamError.message,
        client_ip: clientIp,
        user_agent: clientUserAgent,
      });
      return withQuotaHeaders(new Response(
        buildErrorResponseBody(upstreamError.message, upstream.status, "chat_completions", upstreamError.type, upstreamError.code),
        { status: upstream.status, headers: { "content-type": "application/json" } },
      ));
    }

    lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
    addUsage(auth.user.id, auth.key.id, Math.max(1, estimatedTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id);
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: route.channel.id,
      model_alias: alias,
      real_model: route.model.real_model,
      stream: false,
      status_code: upstream.status,
      estimated_tokens: estimatedTokens,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: estimatedTokens,
      latency_ms: Date.now() - startedAt,
      error_message: null,
      metadata: withSubstitutionNote(null, modelFallbackNote),
      client_ip: clientIp,
      user_agent: clientUserAgent,
    });

    const responseBody = await upstream.text();
    return withQuotaHeaders(new Response(responseBody, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    }));
  }
}

function createTimeoutController(timeoutSeconds: number) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}
