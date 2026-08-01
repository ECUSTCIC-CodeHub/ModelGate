import { acquireChannel, type ChannelLease, makeModelRuntimeKey } from "@/lib/gateway/channel-runtime";
import { checkChannelQuota } from "@/lib/gateway/channel-quota";
import { checkModelQuota, type ModelQuotaInfo } from "@/lib/gateway/model-quota";
import { buildUpstreamUrl, fetchUpstreamRequest } from "@/lib/gateway/proxy";
import { selectModelRoute, type RoutedModel } from "@/lib/gateway/router";
import { isTimeoutError, shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

type ChannelAcquireResult = Awaited<ReturnType<typeof acquireChannel>>;

export type UpstreamFailureStage = "request_body_build" | "fetch_network";

type UpstreamFailureInfo = {
  stage: UpstreamFailureStage;
  message: string;
  name: string | null;
  upstreamUrl: string | null;
  isTimeout: boolean;
};

export type UpstreamPickResult =
  | {
      ok: true;
      route: RoutedModel;
      upstream: Response;
      lease: ChannelLease;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      modelQuota: ModelQuotaInfo | null;
    }
  | {
      ok: true;
      queued: true;
      route: RoutedModel;
      acquirePromise: Promise<ChannelAcquireResult>;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      modelQuota: ModelQuotaInfo | null;
    }
  | {
      ok: false;
      route: RoutedModel | null;
      lastUpstreamStatus: number;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      failure: UpstreamFailureInfo | null;
      quotaReason: string | null;
      modelQuota: ModelQuotaInfo | null;
    };

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "未知错误",
      name: error.name || null,
      isTimeout: error.name === "AbortError",
    };
  }

  return {
    message: typeof error === "string" && error.trim() ? error : "未知错误",
    name: null,
    isTimeout: false,
  };
}

export async function requestUpstreamWithFallback({
  resolvedAlias,
  inboundProtocol,
  maxRouteAttempts,
  sameChannelRetry,
  requestSignal,
  inboundHeaders,
  allowedChannelIds,
  userAgent,
  startedAt,
  estimatedTokens,
  buildRequestBody,
}: {
  resolvedAlias: string;
  inboundProtocol: GatewayProtocol;
  maxRouteAttempts: number;
  sameChannelRetry: boolean;
  requestSignal: AbortSignal;
  inboundHeaders: Headers;
  allowedChannelIds?: number[] | null;
  userAgent?: string | null;
  startedAt: number;
  estimatedTokens: number;
  buildRequestBody: (route: RoutedModel) => Record<string, unknown>;
}): Promise<UpstreamPickResult> {
  const attemptedChannels = new Set<number>();
  const attemptedChannelNames: string[] = [];
  let attempt = 0;
  let lastNetworkRoute: RoutedModel | null = null;
  let lastUpstreamStatus = 0;
  let lastRoute: RoutedModel | null = null;
  let lastFailure: UpstreamFailureInfo | null = null;
  let lastModelQuotaReason: string | null = null;
  let lastModelQuota: ModelQuotaInfo | null = null;

  // 候选路由的模型独立配额检查：quota_mode 非 independent 时直接放行（返回 null 配额信息）。
  // 配额不足时返回 reason，由调用方排除该候选继续选路。
  const checkCandidateModelQuota = async (route: RoutedModel): Promise<{ ok: true; quota: ModelQuotaInfo | null } | { ok: false; reason: string }> => {
    if (route.model.quota_mode !== "independent") return { ok: true, quota: null };
    const result = await checkModelQuota(route.model.id, estimatedTokens);
    if (!result.ok) {
      lastModelQuotaReason = result.reason;
      lastModelQuota = null;
      return { ok: false, reason: result.reason };
    }
    lastModelQuota = result.quota;
    return { ok: true, quota: result.quota };
  };

  while (attempt < maxRouteAttempts) {
    const route = await selectModelRoute(resolvedAlias, {
      excludeChannelIds: [...attemptedChannels],
      protocol: inboundProtocol,
      allowedChannelIds,
      userAgent,
    });

    if (!route) {
      if (!lastRoute || !sameChannelRetry) break;
      // 没有其他渠道了，用最后一个渠道继续重试（适用于 429 同渠道重试）
      const lastQuotaCheck = await checkCandidateModelQuota(lastRoute);
      if (!lastQuotaCheck.ok) break;
      const runtimeKey = makeModelRuntimeKey(lastRoute.channel.id, lastRoute.model.real_model);
      const leaseResult = acquireChannel(runtimeKey, lastRoute.channel.max_concurrency, requestSignal);
      if (isPromiseLike(leaseResult)) {
        return {
          ok: true,
          queued: true,
          route: lastRoute,
          acquirePromise: leaseResult,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
          modelQuota: lastQuotaCheck.quota,
        };
      }
      if (!leaseResult.ok) break;
      const lease = leaseResult.lease;
      const channelQuota = await checkChannelQuota(lastRoute.channel.id, estimatedTokens);
      if (!channelQuota.ok) {
        lease.abandon();
        break;
      }
      try {
        attempt += 1;
        const upstreamBody = buildRequestBody(lastRoute);
        try {
          const upstream = await fetchUpstreamRequest(lastRoute, upstreamBody, lastRoute.effective_upstream_protocol, inboundHeaders);
          lastUpstreamStatus = upstream.status;
          lastFailure = null;
          if (shouldRetryUpstreamStatus(upstream.status) && attempt < maxRouteAttempts) {
            lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
            continue;
          }
          return {
            ok: true,
            route: lastRoute,
            upstream,
            lease,
            attemptedChannels: [...attemptedChannels],
            attemptedChannelNames: [...attemptedChannelNames],
            modelQuota: lastQuotaCheck.quota,
          };
        } catch (error) {
          const summary = summarizeError(error);
          lastFailure = {
            stage: "fetch_network",
            message: summary.message,
            name: summary.name,
            upstreamUrl: buildUpstreamUrl(lastRoute.channel.base_url, lastRoute.effective_upstream_protocol),
            isTimeout: summary.isTimeout,
          };
          lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
          if (attempt >= maxRouteAttempts) break;
        }
      } catch (error) {
        const summary = summarizeError(error);
        lastFailure = {
          stage: "request_body_build",
          message: summary.message,
          name: summary.name,
          upstreamUrl: buildUpstreamUrl(lastRoute.channel.base_url, lastRoute.effective_upstream_protocol),
          isTimeout: summary.isTimeout,
        };
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        if (attempt >= maxRouteAttempts) break;
      }
      continue;
    }

    lastNetworkRoute = route;
    lastRoute = route;
    attemptedChannels.add(route.channel.id);
    attemptedChannelNames.push(route.channel.name);

    // 模型独立配额检查：配额不足则排除该候选渠道，继续尝试下一个候选。
    // 配额不足不消耗重试预算（attempt 在配额通过后才递增）
    const modelQuotaCheck = await checkCandidateModelQuota(route);
    if (!modelQuotaCheck.ok) {
      continue;
    }
    attempt += 1;

    const runtimeKey = makeModelRuntimeKey(route.channel.id, route.model.real_model);
    const leaseResult = acquireChannel(runtimeKey, route.channel.max_concurrency, requestSignal);
    if (isPromiseLike(leaseResult)) {
      return {
        ok: true,
        queued: true,
        route,
        acquirePromise: leaseResult,
        attemptedChannels: [...attemptedChannels],
        attemptedChannelNames: [...attemptedChannelNames],
        modelQuota: modelQuotaCheck.quota,
      };
    }

    if (!leaseResult.ok) continue;

    const lease = leaseResult.lease;

    const channelQuota = await checkChannelQuota(route.channel.id, estimatedTokens);
    if (!channelQuota.ok) {
      lease.abandon();
      continue;
    }

    try {
      const upstreamBody = buildRequestBody(route);
      try {
        const upstream = await fetchUpstreamRequest(route, upstreamBody, route.effective_upstream_protocol, inboundHeaders);
        lastUpstreamStatus = upstream.status;
        lastFailure = null;
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
          modelQuota: modelQuotaCheck.quota,
        };
      } catch (error) {
        const summary = summarizeError(error);
        lastFailure = {
          stage: "fetch_network",
          message: summary.message,
          name: summary.name,
          upstreamUrl: buildUpstreamUrl(route.channel.base_url, route.effective_upstream_protocol),
          isTimeout: summary.isTimeout,
        };
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        if (attempt >= maxRouteAttempts) break;
      }
    } catch (error) {
      const summary = summarizeError(error);
      lastFailure = {
        stage: "request_body_build",
        message: summary.message,
        name: summary.name,
        upstreamUrl: buildUpstreamUrl(route.channel.base_url, route.effective_upstream_protocol),
        isTimeout: summary.isTimeout,
      };
      lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
      if (attempt >= maxRouteAttempts) break;
    }
  }

  return {
    ok: false,
    route: lastNetworkRoute,
    lastUpstreamStatus,
    attemptedChannels: [...attemptedChannels],
    attemptedChannelNames: [...attemptedChannelNames],
    failure: lastFailure,
    quotaReason: lastModelQuotaReason,
    modelQuota: lastModelQuota,
  };
}
