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
      redeemBalanceId: number | null;
    }
  | {
      ok: true;
      queued: true;
      route: RoutedModel;
      acquirePromise: Promise<ChannelAcquireResult>;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      modelQuota: ModelQuotaInfo | null;
      redeemBalanceId: number | null;
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
      redeemBalanceId: number | null;
    };

// 用户全局配额守卫：针对实际候选路由判断是否需要拦截（命中定向额度/绕过用户限额时放行）。
// 返回 { ok: false; reason } 表示该候选路由不应被使用，交由调用方继续选路或整体失败。
// 返回 { ok: true; redeemBalanceId } 时，redeemBalanceId 为请求时命中并据以跳过全局配额检查的定向额度 id，
// 供调用方在扣减时使用，保证“跳过检查”与“实际扣减”针对同一定向额度。
export type UserQuotaGuard = (route: RoutedModel) => Promise<{ ok: true; redeemBalanceId?: number | null } | { ok: false; reason: string }>;

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
  userQuotaGuard,
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
  userQuotaGuard?: UserQuotaGuard;
}): Promise<UpstreamPickResult> {
  const attemptedChannels = new Set<number>();
  const attemptedChannelNames: string[] = [];
  const excludedModelIds = new Set<number>();
  let attempt = 0;
  let lastNetworkRoute: RoutedModel | null = null;
  let lastUpstreamStatus = 0;
  let lastRoute: RoutedModel | null = null;
  let lastFailure: UpstreamFailureInfo | null = null;
  let lastModelQuotaReason: string | null = null;
  let lastModelQuota: ModelQuotaInfo | null = null;
  let lastUserQuotaReason: string | null = null;
  // 请求时守卫确认命中的定向额度 id（供扣减时使用），仅对成功放行的路由记录
  let approvedRedeemBalanceId: number | null = null;

  // 候选路由的模型独立配额检查：quota_mode 非 independent/dual 时直接放行（返回 null 配额信息）。
  // 配额不足时返回 reason，由调用方排除该候选继续选路。
  const checkCandidateModelQuota = async (route: RoutedModel): Promise<{ ok: true; quota: ModelQuotaInfo | null } | { ok: false; reason: string }> => {
    if (route.model.quota_mode !== "independent" && route.model.quota_mode !== "dual") return { ok: true, quota: null };
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
      excludeModelIds: [...excludedModelIds],
      protocol: inboundProtocol,
      allowedChannelIds,
      userAgent,
    });

    if (!route) {
      if (!lastRoute || !sameChannelRetry) break;
      // 没有其他渠道了，用最后一个渠道继续重试（适用于 429 同渠道重试）
      const lastQuotaCheck = await checkCandidateModelQuota(lastRoute);
      if (!lastQuotaCheck.ok) break;
      if (userQuotaGuard) {
        const uq = await userQuotaGuard(lastRoute);
        if (!uq.ok) {
          lastUserQuotaReason = uq.reason;
          break;
        }
        approvedRedeemBalanceId = uq.redeemBalanceId ?? null;
      }
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
          redeemBalanceId: approvedRedeemBalanceId,
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
            redeemBalanceId: approvedRedeemBalanceId,
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

    // 模型独立配额检查：配额不足则排除该候选模型实例（不排除整个渠道，避免同渠道其他实例被连坐跳过），
    // 继续尝试下一个候选。模型配额不足不消耗重试预算（attempt 仅在真正发起上游请求前递增）
    const modelQuotaCheck = await checkCandidateModelQuota(route);
    if (!modelQuotaCheck.ok) {
      excludedModelIds.add(route.model.id);
      continue;
    }
    attemptedChannels.add(route.channel.id);
    attemptedChannelNames.push(route.channel.name);

    if (userQuotaGuard) {
      const uq = await userQuotaGuard(route);
      if (!uq.ok) {
        lastUserQuotaReason = uq.reason;
        continue;
      }
      approvedRedeemBalanceId = uq.redeemBalanceId ?? null;
    }

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
        redeemBalanceId: approvedRedeemBalanceId,
      };
    }

    if (!leaseResult.ok) continue;

    const lease = leaseResult.lease;

    const channelQuota = await checkChannelQuota(route.channel.id, estimatedTokens);
    if (!channelQuota.ok) {
      lease.abandon();
      continue;
    }

    // 预检守卫（渠道并发获取、渠道配额、用户配额）失败均不消耗重试预算，只有真正发起上游请求才递增 attempt
    attempt += 1;

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
          redeemBalanceId: approvedRedeemBalanceId,
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
    quotaReason: lastUserQuotaReason ?? lastModelQuotaReason,
    modelQuota: lastModelQuota,
    redeemBalanceId: approvedRedeemBalanceId,
  };
}
