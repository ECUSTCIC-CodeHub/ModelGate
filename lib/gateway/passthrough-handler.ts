import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { getUserAllowedChannelIds } from "@/lib/gateway/channel-access";
import { jsonError } from "@/lib/core/http";
import { insertChatLog } from "@/lib/gateway/chat-log";
import { checkQuota, appendQuotaHeaders } from "@/lib/gateway/quota";
import { resolveAccessibleModelAlias } from "@/lib/gateway/model-access";
import { selectModelRoute, findUaDenyMatchForAlias, type RoutedModel } from "@/lib/gateway/router";
import { getGatewaySettings } from "@/lib/core/settings";
import { isFeatureEnabled } from "@/lib/core/features";
import { checkUserAgentRestrictions, parseUaRestrictions } from "@/lib/gateway/ua-restrictions";
import { resolveClientIp } from "@/lib/core/client-ip";
import { normalizeUserAgent } from "@/lib/gateway/queued-upstream-response";
import { buildArbitraryUpstreamUrl } from "@/lib/gateway/proxy";
import { withUpstreamProxy } from "@/lib/gateway/upstream-proxy";
import { isTimeoutError, upstreamFailureStatus } from "@/lib/gateway/upstream-error";
import { addUsage } from "@/lib/gateway/usage-accounting";
import { Agent, type Dispatcher } from "undici";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "trailer",
  "te",
]);

const RESPONSE_STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export async function handlePassthroughRequest(request: Request, upstreamPath: string) {
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

  const logRejected = (statusCode: number, message: string, alias: string | null) => {
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: null,
      model_alias: alias,
      real_model: null,
      stream: false,
      status_code: statusCode,
      estimated_tokens: 0,
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
  if (contentLength > MAX_BODY_BYTES) {
    logRejected(413, "请求体过大", null);
    return jsonError("请求体过大", 413);
  }

  const rawBytes = await readBodyCapped(request, MAX_BODY_BYTES);
  if (rawBytes === null) {
    logRejected(413, "请求体过大", null);
    return jsonError("请求体过大", 413);
  }
  let alias: string | null = null;
  if (rawBytes.byteLength > 0) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model.trim()) {
        alias = parsed.model.trim();
      }
    } catch {
      // 非 JSON 请求体无法解析 model，交由下方 400 处理
    }
  }
  if (!alias) {
    logRejected(400, "缺少模型参数 model（应置于请求体 JSON 的 model 字段）", null);
    return jsonError("缺少模型参数 model（应置于请求体 JSON 的 model 字段）", 400);
  }

  const settings = await getGatewaySettings();
  const uaEnabled = isFeatureEnabled("uaRestrictions");
  const globalUaRules = uaEnabled ? parseUaRestrictions(settings.ua_restrictions) : [];
  if (globalUaRules.length > 0) {
    const globalMatch = checkUserAgentRestrictions({
      userAgent: clientUserAgent,
      globalRules: globalUaRules,
      channelRules: [],
      modelRules: [],
    });
    if (globalMatch.matched && !globalMatch.allowed) {
      logRejected(globalMatch.rule.error_code, globalMatch.rule.error_message, alias);
      return jsonError(globalMatch.rule.error_message, globalMatch.rule.error_code, {
        type: "invalid_request_error",
        param: "user-agent",
        code: String(globalMatch.rule.error_code),
      });
    }
  }

  const resolved = await resolveAccessibleModelAlias(auth.user, alias);
  if (!resolved.ok) {
    if (resolved.reason === "forbidden") {
      logRejected(403, "当前用户无权访问该模型", alias);
      return jsonError("当前用户无权访问该模型", 403);
    }
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }
  const effectiveAlias = resolved.alias;

  const route = await selectModelRoute(effectiveAlias, {
    allowedChannelIds,
    userAgent: uaEnabled ? clientUserAgent : undefined,
  });
  if (!route) {
    if (uaEnabled) {
      const denyMatch = await findUaDenyMatchForAlias(effectiveAlias, clientUserAgent, allowedChannelIds);
      if (denyMatch) {
        logRejected(denyMatch.rule.error_code, denyMatch.rule.error_message, alias);
        return jsonError(denyMatch.rule.error_message, denyMatch.rule.error_code, {
          type: "invalid_request_error",
          param: "user-agent",
          code: String(denyMatch.rule.error_code),
        });
      }
    }
    if (allowedChannelIds) {
      const withoutRestriction = await selectModelRoute(effectiveAlias, {
        userAgent: uaEnabled ? clientUserAgent : undefined,
      });
      if (withoutRestriction !== null) {
        logRejected(403, "当前用户组无可用渠道", alias);
        return jsonError("当前用户组无可用渠道", 403);
      }
    }
    logRejected(404, "模型别名不存在或已禁用", alias);
    return jsonError("模型别名不存在或已禁用", 404);
  }

  const quotaResult = await checkQuota(auth.user.id, 0);
  const quotaHeaders: Record<string, string> = {};
  if (!quotaResult.ok) {
    if (quotaResult.quota) appendQuotaHeaders(quotaHeaders, quotaResult.quota);
    logRejected(429, quotaResult.reason, alias);
    return jsonError(quotaResult.reason, 429, undefined, quotaHeaders);
  }
  appendQuotaHeaders(quotaHeaders, quotaResult.quota);

  let upstream: Response;
  try {
    upstream = await forwardToChannel(route, request, upstreamPath, rawBytes);
  } catch (error) {
    const status = upstreamFailureStatus(error);
    const message = isTimeoutError(error) ? "上游请求超时" : "上游请求失败";
    insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: route.channel.id,
      model_alias: alias,
      real_model: route.model.real_model,
      stream: false,
      status_code: status,
      estimated_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      latency_ms: Date.now() - startedAt,
      error_message: message,
      client_ip: clientIp,
      user_agent: clientUserAgent,
    });
    return jsonError(message, status, {
      type: "upstream_error",
      param: "None",
      code: String(status),
    }, quotaHeaders);
  }

  const success = upstream.status < 400;
  insertChatLog({
    user_id: auth.user.id,
    key_id: auth.key.id,
    channel_id: route.channel.id,
    model_alias: alias,
    real_model: route.model.real_model,
    stream: false,
    status_code: upstream.status,
    estimated_tokens: 0,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    latency_ms: Date.now() - startedAt,
    error_message: success ? null : "通用转发上游返回错误",
    client_ip: clientIp,
    user_agent: clientUserAgent,
  });
  if (success) {
    addUsage(auth.user.id, auth.key.id, 0, 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id);
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }
  for (const [key, value] of Object.entries(quotaHeaders)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function forwardToChannel(route: RoutedModel, request: Request, upstreamPath: string, bodyBytes: Uint8Array | null): Promise<Response> {
  const channel = route.channel;
  const upstreamUrl = buildArbitraryUpstreamUrl(
    channel.base_url,
    upstreamPath,
    cleanUpstreamSearch(request.url),
  );

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization" || lower === "x-api-key") continue;
    if (lower === "content-length" || lower === "cookie" || lower === "host") continue;
    headers.set(key, value);
  }
  const apiKey = channel.api_key?.trim();
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("x-api-key", apiKey);
  }
  if (channel.user_agent?.trim()) {
    headers.set("user-agent", channel.user_agent.trim());
  }

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const fetchInit: RequestInit = {
    method,
    headers,
  };
  if (hasBody && bodyBytes) {
    fetchInit.body = bodyBytes as unknown as BodyInit;
  }

  const proxyUrl = channel.proxy_url?.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, channel.timeout) * 1000);
  try {
    const initWithSignal: RequestInit & { signal?: AbortSignal } = {
      ...fetchInit,
      signal: controller.signal,
    };
    if (proxyUrl) {
      return await fetch(upstreamUrl, withUpstreamProxy(initWithSignal, proxyUrl));
    }
    const initWithDispatcher: RequestInit & { dispatcher: Dispatcher } = {
      ...initWithSignal,
      dispatcher: new Agent(),
    };
    return await fetch(upstreamUrl, initWithDispatcher);
  } finally {
    clearTimeout(timeout);
  }
}

// 按硬上限分块读取请求体原始字节，超过上限返回 null（防止 content-length 被伪造导致内存放大）。
async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// 透传 query 前剔除网关自有鉴权参数，避免将它们转发给上游。
function cleanUpstreamSearch(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.searchParams.delete("api_key");
  url.searchParams.delete("token");
  return url.search;
}
