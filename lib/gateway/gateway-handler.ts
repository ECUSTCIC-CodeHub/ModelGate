import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { checkChannelQuota, appendChannelQuotaHeaders } from "@/lib/gateway/channel-quota";
import { insertChatLog, withSubstitutionNote } from "@/lib/gateway/chat-log";
import { jsonError } from "@/lib/core/http";
import { checkModelQuota, appendModelQuotaHeaders } from "@/lib/gateway/model-quota";
import { resolveAccessibleModelAlias } from "@/lib/gateway/model-access";
import { getGatewayProtocolAdapter, type GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters";
import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import { createTransformedStream } from "@/lib/gateway/protocol-adapters/streaming";
import { appendQuotaHeaders, checkQuota } from "@/lib/gateway/quota";
import { createQueuedUpstreamResponse, normalizeUserAgent } from "@/lib/gateway/queued-upstream-response";
import { checkUserRateLimit } from "@/lib/gateway/ratelimit";
import { selectModelRoute, findUaDenyMatchForAlias, findVisionFallbackRoute, findQuotaFallbackRoute, resolveModelFallbackAlias, type RoutedModel } from "@/lib/gateway/router";
import { getGatewaySettings } from "@/lib/core/settings";
import { exceedsBodyLimit, resolveBodyLimitBytes } from "@/lib/gateway/body-limit";
import { readJsonBodyCapped } from "@/lib/core/request-body";
import { injectModelSystemPrompt } from "@/lib/gateway/model-system-prompt";
import { checkUserAgentRestrictions, parseUaRestrictions, type UaRestrictionMatch } from "@/lib/gateway/ua-restrictions";
import { isFeatureEnabled } from "@/lib/core/features";
import { resolveClientIp } from "@/lib/core/client-ip";
import { requestContainsImage } from "@/lib/gateway/normalized-message/detect-image";
import { resolveTokenUsage, tokenUsageMetadata } from "@/lib/gateway/token-usage";
import { resolveTriState } from "@/lib/gateway/user-preferences";
import { buildErrorResponseBody, countsAsChannelFailure, parseUpstreamError } from "@/lib/gateway/upstream-error";
import { addUsage } from "@/lib/gateway/usage-accounting";
import { findMatchingRedeemBalance } from "@/lib/services/redeem-codes";
import { redactUrlCredentials } from "@/lib/shared/redact";
import { requestUpstreamWithFallback } from "@/lib/gateway/upstream-routing";
import {
  applyCopilotCompatibilityToChatStream,
  normalizeCopilotChatCompletionRequest,
  normalizeCopilotChatCompletionText,
} from "@/lib/gateway/copilot-compat";

export async function handleGatewayProtocolRequest(request: Request, inboundAdapter: GatewayProtocolAdapter) {
  const inboundProtocol = inboundAdapter.protocol;
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

  const denyByUa = (match: UaRestrictionMatch & { matched: true }, alias: string | null): Response => {
    logRejected(match.rule.error_code, match.rule.error_message, alias);
    return jsonError(match.rule.error_message, match.rule.error_code, {
      type: "invalid_request_error",
      param: "user-agent",
      code: String(match.rule.error_code),
    });
  };

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

  const settings = await getGatewaySettings();
  const uaEnabled = isFeatureEnabled("uaRestrictions");
  const globalUaRules = uaEnabled
    ? parseUaRestrictions(settings.ua_restrictions)
    : [];
  if (globalUaRules.length > 0) {
    const globalMatch = checkUserAgentRestrictions({
      userAgent: clientUserAgent,
      globalRules: globalUaRules,
      channelRules: [],
      modelRules: [],
    });
    if (globalMatch.matched && !globalMatch.allowed) {
      return denyByUa(globalMatch, null);
    }
  }

  const bodyLimit = await resolveBodyLimitBytes();
  if (exceedsBodyLimit(request.headers.get("content-length"), bodyLimit)) {
    logRejected(413, "请求体过大", null);
    return jsonError("请求体过大", 413);
  }

  // content-length 可被伪造，实际读取必须再按同一上限分块兜底
  const capped = await readJsonBodyCapped(request, bodyLimit ?? Infinity);
  if (!capped.ok) {
    logRejected(413, "请求体过大", null);
    return jsonError("请求体过大", 413);
  }
  const rawBody = capped.data;
  if (!rawBody || typeof rawBody !== "object") {
    logRejected(400, "请求参数不正确", null);
    return jsonError("请求参数不正确", 400);
  }

  const body = rawBody as Record<string, unknown>;
  const thinkingRecord = body.thinking && typeof body.thinking === "object" ? (body.thinking as Record<string, unknown>) : null;
  const alias = body.model;
  const responseOptions: ResponseAdapterOptions = {
    thinkingEnabled: thinkingRecord?.type === "enabled",
    requestedModel: typeof alias === "string" ? alias : undefined,
  };
  const streamOptions = body.stream_options as Record<string, unknown> | undefined;
  if (streamOptions?.include_usage === true) {
    responseOptions.includeUsage = true;
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    if (messages) {
      responseOptions.streamPromptTokens = Math.ceil(JSON.stringify(messages).length / 4);
    }
  }
  if (typeof alias !== "string" || alias.length === 0) {
    logRejected(400, "缺少模型参数 model", null);
    return jsonError("缺少模型参数 model", 400);
  }

  const estimatedTokens = inboundAdapter.estimateRequestTokens(body);
  const modelFallbackEnabled = resolveTriState(auth.user.pref_model_fallback, settings.model_fallback_enabled === 1);
  const resolved = await resolveAccessibleModelAlias(auth.user, alias);
  let resolvedAlias: string;
  // 仅由定向额度放行的别名（公开模型与用户/组白名单都不覆盖）走的是「任意渠道」宽松门禁，
  // 配对是否命中要等选路阶段才知道，因此无路由时应判定为无权限，而不是当别名不存在。
  const redeemOnlyAliasGrant = resolved.ok && resolved.viaRedeemScope;
  let modelFallbackNote: string | null = null;
  let visionFallbackNote: string | null = null;
  if (!resolved.ok) {
    // 别名门禁只做「任意渠道」的宽松放行，配对收紧在选路阶段。别名级与配对级的别名口径同源，
    // 因此这里通常探不到路由，按别名不可用返回 404（不触发模型替补，避免把无权限静默换成别的模型）；
    // 仅当两级口径不一致时（如 MySQL 的别名比较不区分大小写）才会探到，此时返回 403。
    if (resolved.reason === "forbidden") {
      const grantedRoute = await selectModelRoute(alias, { protocol: inboundProtocol, user: auth.user });
      if (!grantedRoute) {
        logRejected(404, "模型别名不存在或已禁用", alias, estimatedTokens);
        return jsonError("模型别名不存在或已禁用", 404);
      }
      logRejected(403, "当前用户无权访问该模型", alias, estimatedTokens);
      return jsonError("当前用户无权访问该模型", 403);
    }
    const fallbackAlias = await resolveModelFallbackAlias({
      user: auth.user,
      requestedAlias: alias,
      fallbackEnabled: modelFallbackEnabled,
      preferredGlobalAlias: settings.model_fallback_alias,
      protocol: inboundProtocol,
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

  let effectiveAlias = resolvedAlias;
  const requestHasImage = requestContainsImage(body, inboundProtocol);
  const visionFallbackEnabled = resolveTriState(auth.user.pref_vision_fallback, settings.vision_fallback_enabled === 1);
  if (visionFallbackEnabled && requestHasImage) {
    const sourceRoute = await selectModelRoute(resolvedAlias, {
      protocol: inboundProtocol,
      allowedChannelIds,
      userAgent: uaEnabled ? clientUserAgent : undefined,
      user: auth.user,
    });
    if (sourceRoute && sourceRoute.model.supports_vision !== 1) {
      const visionRoute = await findVisionFallbackRoute({
        preferredAlias: settings.vision_fallback_alias,
        protocol: inboundProtocol,
        allowedChannelIds,
        userAgent: uaEnabled ? clientUserAgent : undefined,
        user: auth.user,
      });
      if (visionRoute) {
        effectiveAlias = visionRoute.model.alias;
        visionFallbackNote = "目标模型不支持识图，已自动路由到识图模型";
      }
    }
  }

  const initialRoute = await selectModelRoute(effectiveAlias, {
    protocol: inboundProtocol,
    allowedChannelIds,
    userAgent: uaEnabled ? clientUserAgent : undefined,
    user: auth.user,
  });
  if (!initialRoute) {
    if (uaEnabled) {
      const nonUaRoute = await selectModelRoute(effectiveAlias, { protocol: inboundProtocol, allowedChannelIds, user: auth.user });
      if (nonUaRoute !== null) {
        const denyMatch = await findUaDenyMatchForAlias(effectiveAlias, clientUserAgent, allowedChannelIds, inboundProtocol, auth.user);
        if (denyMatch) return denyByUa(denyMatch, alias);
      }
    }
    // 额度放行的别名配对没命中就是无权限，不能退化成「别名不存在或已禁用」。
    // 额度来源取自别名门禁所用的请求别名，被视觉替补换过别名后不再适用，交由渠道级诊断或 404 处理。
    if (redeemOnlyAliasGrant && effectiveAlias === resolvedAlias) {
      logRejected(403, "当前用户无权访问该模型", alias, estimatedTokens);
      return jsonError("当前用户无权访问该模型", 403);
    }
    if (allowedChannelIds) {
      // 这里只问「该别名是否存在可用渠道」，不能带 user 与 userAgent：任何请求级过滤都会把
      // 组渠道白名单之外的路由剔掉，令这条诊断对非公开别名不可达，最终误报 404。
      const anyChannelRoute = await selectModelRoute(effectiveAlias, { protocol: inboundProtocol });
      if (anyChannelRoute !== null) {
        logRejected(403, "当前用户组无可用渠道", alias, estimatedTokens);
        return jsonError("当前用户组无可用渠道", 403);
      }
    }
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const quotaHeaders: Record<string, string> = {};
  let channelQuotaHeaders: Record<string, string> | null = null;
  let modelQuotaHeaders: Record<string, string> | null = null;

  const CONVERSATION_PROTOCOLS: GatewayProtocol[] = ["chat_completions", "responses", "anthropic_messages", "embeddings"];
  const quotaFallbackEnabled = CONVERSATION_PROTOCOLS.includes(inboundProtocol)
    && resolveTriState(auth.user.pref_quota_fallback, settings.quota_fallback_enabled === 1);

  let existingRoute = initialRoute;
  let quotaFallbackNote: string | null = null;
  let userQuotaChecked = false;
  let cachedUserQuota: Awaited<ReturnType<typeof checkQuota>> | null = null;
  let cachedUserRate: Awaited<ReturnType<typeof checkUserRateLimit>> | null = null;
  const triedAliases = new Set<string>();
  let quotaFallbackAttempts = 0;
  const MAX_QUOTA_FALLBACK_ATTEMPTS = 10;
  let userLimitKnownExceeded = false;

  for (;;) {
    const quotaMode = existingRoute.model.quota_mode;
    const bypassUserLimits = quotaMode === "bypass_group" || quotaMode === "independent";

    // 命中用户定向额度（兑换码）时，跳过用户全局配额检查，由定向额度兜底。
    let redeemCovered = false;
    if (!bypassUserLimits && settings.runtime_features.redeemCode) {
      const redeem = await findMatchingRedeemBalance(auth.user.id, existingRoute.channel.id, existingRoute.model.alias);
      redeemCovered = redeem !== null;
    }

    let exceededReason: string | null = null;

    if (!bypassUserLimits && !redeemCovered) {
      if (!userQuotaChecked) {
        cachedUserQuota = await checkQuota(auth.user.id, estimatedTokens);
        if (cachedUserQuota.ok) {
          cachedUserRate = await checkUserRateLimit(auth.user, estimatedTokens);
        }
        userQuotaChecked = true;
      }
      if (cachedUserQuota && !cachedUserQuota.ok) {
        exceededReason = cachedUserQuota.reason;
        userLimitKnownExceeded = true;
        if (cachedUserQuota.quota) appendQuotaHeaders(quotaHeaders, cachedUserQuota.quota);
      } else if (cachedUserQuota?.ok) {
        appendQuotaHeaders(quotaHeaders, cachedUserQuota.quota);
        if (cachedUserRate && !cachedUserRate.ok) {
          exceededReason = cachedUserRate.reason;
          userLimitKnownExceeded = true;
        }
      }
    }

    if (!exceededReason && (quotaMode === "independent" || quotaMode === "dual")) {
      const modelQuotaResult = await checkModelQuota(existingRoute.model.id, estimatedTokens);
      if (!modelQuotaResult.ok) {
        exceededReason = modelQuotaResult.reason;
      } else {
        modelQuotaHeaders = {};
        appendModelQuotaHeaders(modelQuotaHeaders, modelQuotaResult.quota);
      }
    }

    if (!exceededReason) break;

    if (!quotaFallbackEnabled || quotaFallbackAttempts >= MAX_QUOTA_FALLBACK_ATTEMPTS) {
      logRejected(429, exceededReason, alias, estimatedTokens);
      return jsonError(exceededReason, 429, undefined, { ...quotaHeaders });
    }
    triedAliases.add(effectiveAlias);
    quotaFallbackAttempts += 1;

    const fallbackRoute = await findQuotaFallbackRoute({
      preferredAlias: settings.quota_fallback_alias,
      excludeAliases: [...triedAliases],
      requireVision: requestHasImage,
      requireBypassUserLimits: userLimitKnownExceeded,
      protocol: inboundProtocol,
      allowedChannelIds,
      userAgent: uaEnabled ? clientUserAgent : undefined,
      user: auth.user,
    });
    if (!fallbackRoute) {
      logRejected(429, exceededReason, alias, estimatedTokens);
      return jsonError(exceededReason, 429, undefined, { ...quotaHeaders });
    }

    effectiveAlias = fallbackRoute.model.alias;
    existingRoute = fallbackRoute;
    quotaFallbackNote = "达到限额已自动路由到其他模型";
    modelQuotaHeaders = null;
  }

  const substitutionNote = [modelFallbackNote, visionFallbackNote, quotaFallbackNote].filter(Boolean).join("；") || null;

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

  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = inboundAdapter.getStreamFlag(body);
  const getRouteAdapter = (route: RoutedModel) => getGatewayProtocolAdapter(route.effective_upstream_protocol);
  const countPromptTokensForRoute = (route: RoutedModel) => inboundAdapter.countPromptTokens(body, route.model.real_model);
  const adaptRequestBodyForRoute = (route: RoutedModel) => {
    const adapted = inboundAdapter.adaptRequestBody(
      body,
      getRouteAdapter(route),
      route.model.real_model,
      route.channel.force_include_usage !== 0,
    );
    const withCompatibility = shouldApplyCopilotCompatibility(route)
      ? normalizeCopilotChatCompletionRequest(adapted)
      : adapted;
    // 按上游协议注入模型级系统提示词：每次重试都按当前路由的模型配置重新计算，
    // 不修改原始 body，切换到别的模型时会用新配置而不是残留上一轮的注入内容
    return injectModelSystemPrompt(
      withCompatibility,
      route.effective_upstream_protocol,
      route.model.system_prompt ?? "",
    );
  };
  const shouldApplyCopilotCompatibility = (route: RoutedModel) =>
    inboundProtocol === "chat_completions" && route.model.copilot_compatibility === 1;
  const adaptResponseBodyForRoute = (rawText: string, route: RoutedModel) => {
    const adapted = inboundAdapter.adaptResponseBody(rawText, getRouteAdapter(route), responseOptions);
    return shouldApplyCopilotCompatibility(route)
      ? normalizeCopilotChatCompletionText(adapted, body)
      : adapted;
  };
  const getUsageForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).getUsageFromBody(rawText);
  const extractCompletionTextForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).extractCompletionTextFromBody(rawText);
  const extractReasoningTextForRoute = (rawText: string, route: RoutedModel) =>
    getRouteAdapter(route).extractReasoningTextFromBody(rawText);
  const createTransformedStreamForRoute = (upstreamBody: ReadableStream<Uint8Array>, route: RoutedModel) => {
    const transformed = createTransformedStream(upstreamBody, getRouteAdapter(route), inboundAdapter, responseOptions);
    return shouldApplyCopilotCompatibility(route)
      ? applyCopilotCompatibilityToChatStream(transformed, body)
      : transformed;
  };

  // 针对实际选中的候选路由做用户全局配额守卫：命中定向额度或该路由绕过用户限额时放行，
  // 否则需通过用户全局配额与频率限制，避免因上游回退切换到未覆盖渠道时绕过配额检查。
  const userQuotaGuard = async (route: RoutedModel): Promise<{ ok: true; redeemBalanceId?: number | null } | { ok: false; reason: string }> => {
    const routeBypass = route.model.quota_mode === "bypass_group" || route.model.quota_mode === "independent";
    if (routeBypass) return { ok: true, redeemBalanceId: null };
    if (settings.runtime_features.redeemCode) {
      const redeem = await findMatchingRedeemBalance(auth.user.id, route.channel.id, route.model.alias);
      if (redeem) return { ok: true, redeemBalanceId: redeem.id };
    }
    // 复用初始循环已执行过的用户全局配额/频率检查结果，避免对同一请求重复消耗 RPM/QPS/TPM
    if (userQuotaChecked && cachedUserQuota) {
      if (!cachedUserQuota.ok) return { ok: false, reason: cachedUserQuota.reason };
      if (cachedUserRate && !cachedUserRate.ok) return { ok: false, reason: cachedUserRate.reason };
      return { ok: true, redeemBalanceId: null };
    }
    const quotaResult = await checkQuota(auth.user.id, estimatedTokens);
    if (!quotaResult.ok) return { ok: false, reason: quotaResult.reason };
    const rate = await checkUserRateLimit(auth.user, estimatedTokens);
    if (!rate.ok) return { ok: false, reason: rate.reason };
    return { ok: true, redeemBalanceId: null };
  };

  const picked = await requestUpstreamWithFallback({
    resolvedAlias: effectiveAlias,
    inboundProtocol,
    maxRouteAttempts,
    sameChannelRetry: settings.upstream_retry_same_channel === 1,
    requestSignal: request.signal,
    inboundHeaders: request.headers,
    allowedChannelIds,
    userAgent: uaEnabled ? clientUserAgent : undefined,
    startedAt,
    estimatedTokens,
    buildRequestBody: adaptRequestBodyForRoute,
    userQuotaGuard,
    user: auth.user,
  });
  const buildFailureMessage = (stage: string, message: string, upstreamUrl?: string | null) => {
    const parts = [`阶段=${stage}`, redactUrlCredentials(message)];
    if (upstreamUrl) parts.push(`upstream=${redactUrlCredentials(upstreamUrl)}`);
    return parts.join(" | ");
  };
  if (!picked.ok) {
    if (picked.modelQuota) {
      modelQuotaHeaders = {};
      appendModelQuotaHeaders(modelQuotaHeaders, picked.modelQuota);
    }
    if (picked.quotaReason && !picked.failure) {
      logRejected(429, picked.quotaReason, alias, estimatedTokens);
      return withQuotaHeaders(jsonError(picked.quotaReason, 429, undefined, { ...quotaHeaders }));
    }
    if (picked.route) {
      const cq = await checkChannelQuota(picked.route.channel.id, estimatedTokens);
      if (cq.ok) {
        channelQuotaHeaders = {};
        appendChannelQuotaHeaders(channelQuotaHeaders, cq.quota);
      }
    }
    const failureStatus = picked.failure?.isTimeout ? 504
      : picked.lastUpstreamStatus > 0 ? picked.lastUpstreamStatus
      : 502;
    const failureMessage = picked.failure
      ? buildFailureMessage(picked.failure.stage, picked.failure.message, picked.failure.upstreamUrl)
      : "上游请求失败";
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: picked.route?.channel.id ?? null,
      model_alias: alias,
      real_model: picked.route?.model.real_model ?? null,
      stream,
      status_code: failureStatus,
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
      error_message: failureMessage,
      client_ip: clientIp,
      user_agent: clientUserAgent,
    });
    return withQuotaHeaders(jsonError(failureMessage, failureStatus, {
      type: "upstream_error",
      param: "None",
      code: String(failureStatus),
    }));
  }

  if ("queued" in picked && picked.queued) {
    const { route, modelQuota } = picked;
    if (modelQuota) {
      modelQuotaHeaders = {};
      appendModelQuotaHeaders(modelQuotaHeaders, modelQuota);
    }
    const cq = await checkChannelQuota(route.channel.id, estimatedTokens);
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
      substitutionNote,
      withQuotaHeaders,
      adaptResponseBodyForRoute,
      getUsageForRoute,
      extractCompletionTextForRoute,
      extractReasoningTextForRoute,
      createTransformedStreamForRoute,
    });
  }

  if (!("upstream" in picked)) {
    const { failure } = picked as { failure?: { isTimeout?: boolean } };
    const failStatus = failure?.isTimeout ? 504 : 502;
    const failMessage = failure?.isTimeout ? "上游请求超时" : "上游请求失败";
    const failCode = failure?.isTimeout ? "504" : "502";
    return withQuotaHeaders(jsonError(failMessage, failStatus, {
      type: "upstream_error",
      param: "None",
      code: failCode,
    }));
  }

  const { route, upstream, lease, attemptedChannels, attemptedChannelNames, modelQuota, redeemBalanceId } = picked;
  if (modelQuota) {
    modelQuotaHeaders = {};
    appendModelQuotaHeaders(modelQuotaHeaders, modelQuota);
  }
  const cq = await checkChannelQuota(route.channel.id, estimatedTokens);
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
      const errorBody = route.effective_upstream_protocol === inboundProtocol
        ? redactUrlCredentials(text)
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
        const errorBody = route.effective_upstream_protocol === inboundProtocol
          ? redactUrlCredentials(rawText)
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

      lease.complete({ ok: !countsAsChannelFailure(upstream.status), latencyMs: Date.now() - startedAt });
      addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.alias, redeemBalanceId);
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
        metadata: withSubstitutionNote(tokenUsageMetadata(tokenUsage), substitutionNote),
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
      lease.complete({ ok: !countsAsChannelFailure(upstream.status), latencyMs: totalLatencyMs });
      const tokenUsage = resolveTokenUsage({
        usage: success ? transformed.usage() : null,
        localPromptTokens,
        completionText: success ? transformed.completionText() : "",
        reasoningText: success ? transformed.reasoningText() : "",
        model: route.model.real_model,
      });
      const firstTokenAt = transformed.firstTokenAt();
      const tpsStartAt = firstTokenAt ?? startedAt;
      const outputTps =
        success && tokenUsage.outputTpsTokens > 0
          ? Number(((tokenUsage.outputTpsTokens * 1000) / Math.max(1, Date.now() - tpsStartAt)).toFixed(2))
          : null;
      const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

      if (success) {
        addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.alias, redeemBalanceId);
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
        metadata: withSubstitutionNote(tokenUsageMetadata(tokenUsage), substitutionNote),
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
      first_token_latency_ms: null,
      output_tps: null,
      route_attempts: Math.max(1, attemptedChannels.length),
      attempted_channels: attemptedChannelNames.join(" -> "),
      error_message: upstreamError.message,
      client_ip: clientIp,
      user_agent: clientUserAgent,
    });
    const errorBody = route.effective_upstream_protocol === inboundProtocol
      ? redactUrlCredentials(rawText)
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
  addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.alias, redeemBalanceId);
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
    metadata: withSubstitutionNote(tokenUsageMetadata(tokenUsage), substitutionNote),
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
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  }));
}
