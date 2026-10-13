import type { DbUser } from "@/lib/core/db";
import { acquireChannel, type ChannelLease, makeModelRuntimeKey } from "@/lib/gateway/channel-runtime";
import { checkChannelQuota } from "@/lib/gateway/channel-quota";
import { checkModelQuota, type ModelQuotaInfo } from "@/lib/gateway/model-quota";
import { buildUpstreamUrl, fetchUpstreamRequest } from "@/lib/gateway/proxy";
import { listModelRoutes, type RoutedModel } from "@/lib/gateway/router";
import { createCandidateQueue, MAX_CANDIDATE_VISITS } from "@/lib/gateway/candidate-queue";
import { resolveRetryStatusCodes, shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";
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

// 候选预检被跳过或未及时返回时的原因，用于失败时给出可诊断的 quotaReason。
export type RouteSkipReason = "channel_quota" | "queue_full" | "circuit_open" | "user_quota" | "model_quota";

export { MAX_CANDIDATE_VISITS };

export type UpstreamRoutingDeps = {
  listModelRoutes: typeof listModelRoutes;
  checkChannelQuota: typeof checkChannelQuota;
  checkModelQuota: typeof checkModelQuota;
  acquireChannel: typeof acquireChannel;
  fetchUpstreamRequest: typeof fetchUpstreamRequest;
  shouldRetryUpstreamStatus: typeof shouldRetryUpstreamStatus;
};

const defaultDeps: UpstreamRoutingDeps = {
  listModelRoutes,
  checkChannelQuota,
  checkModelQuota,
  acquireChannel,
  fetchUpstreamRequest,
  shouldRetryUpstreamStatus,
};

// attemptedChannels / attemptedChannelNames 只记录真正打到上游的渠道，route_attempts 以它为准。
// skippedChannels / skippedChannelNames 记录预检被跳过、未发起请求的渠道，单独落到 skipped_channels 观测。

export type UpstreamPickResult =
  | {
      ok: true;
      route: RoutedModel;
      upstream: Response;
      lease: ChannelLease;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      skippedChannels: number[];
      skippedChannelNames: string[];
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
      skippedChannels: number[];
      skippedChannelNames: string[];
      modelQuota: ModelQuotaInfo | null;
      redeemBalanceId: number | null;
    }
  | {
      ok: false;
      // 真正发过上游请求的渠道；没有任何渠道打到上游时为 null，避免失败日志误指向未使用的渠道。
      route: RoutedModel | null;
      lastUpstreamStatus: number;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      skippedChannels: number[];
      skippedChannelNames: string[];
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

type SkipReason = { reason: RouteSkipReason; message: string };

export async function requestUpstreamWithFallback({
  resolvedAlias,
  inboundProtocol,
  maxRouteAttempts,
  sameChannelRetry,
  defaultRetryStatusCodes,
  requestSignal,
  inboundHeaders,
  allowedChannelIds,
  userAgent,
  startedAt,
  estimatedTokens,
  buildRequestBody,
  userQuotaGuard,
  user,
  deps = defaultDeps,
}: {
  resolvedAlias: string;
  inboundProtocol: GatewayProtocol;
  maxRouteAttempts: number;
  sameChannelRetry: boolean;
  defaultRetryStatusCodes?: readonly number[] | null;
  requestSignal: AbortSignal;
  inboundHeaders: Headers;
  allowedChannelIds?: number[] | null;
  userAgent?: string | null;
  startedAt: number;
  estimatedTokens: number;
  buildRequestBody: (route: RoutedModel) => Record<string, unknown>;
  userQuotaGuard?: UserQuotaGuard;
  user?: Pick<DbUser, "id" | "role" | "group_id" | "allowed_model_aliases">;
  deps?: UpstreamRoutingDeps;
}): Promise<UpstreamPickResult> {
  // 真正打到上游的渠道（route_attempts 的真实口径）
  const attemptedChannels = new Set<number>();
  const attemptedChannelNames: string[] = [];
  // 预检被跳过、未发起上游请求的渠道（单独观测，不混入 attemptedChannels）
  const skippedChannels = new Set<number>();
  const skippedChannelNames: string[] = [];
  let attempt = 0;
  // 真正发过请求的渠道，失败日志的 channel_id 只认它
  let lastRequestedRoute: RoutedModel | null = null;
  let lastFailure: UpstreamFailureInfo | null = null;
  let lastUpstreamStatus = 0;
  let lastModelQuotaReason: string | null = null;
  let lastModelQuota: ModelQuotaInfo | null = null;
  let lastUserQuotaReason: string | null = null;
  let lastSkipReason: SkipReason | null = null;
  // 请求时守卫确认命中的定向额度 id（供扣减时使用），仅对成功放行的路由记录
  let approvedRedeemBalanceId: number | null = null;

  // 候选遍历状态机：屏蔽「重查候选」与「访问上界」细节，让主循环只关心使用哪个候选。
  // 排除集合变化先内存过滤，缓冲耗尽后才重查，避免热路径上每排除一个候选就重查一次。
  const candidates = createCandidateQueue({
    load: ({ excludeChannelIds, excludeModelIds }) => deps.listModelRoutes(resolvedAlias, {
      excludeChannelIds,
      excludeModelIds,
      protocol: inboundProtocol,
      allowedChannelIds,
      userAgent,
      user,
    }),
  });

  // 候选路由的模型独立配额检查：quota_mode 非 independent/dual 时直接放行（返回 null 配额信息）。
  // 配额不足时返回 reason，由调用方排除该候选继续选路。
  const checkCandidateModelQuota = async (route: RoutedModel): Promise<{ ok: true; quota: ModelQuotaInfo | null } | { ok: false; reason: string }> => {
    if (route.model.quota_mode !== "independent" && route.model.quota_mode !== "dual") return { ok: true, quota: null };
    const result = await deps.checkModelQuota(route.model.id, estimatedTokens);
    if (!result.ok) {
      lastModelQuotaReason = result.reason;
      lastModelQuota = null;
      return { ok: false, reason: result.reason };
    }
    lastModelQuota = result.quota;
    return { ok: true, quota: result.quota };
  };

  // 预检不通过：把渠道加入消费集合（避免选路反复返回同一渠道）并刷新候选队列。
  // 未真正打到上游，因此只计入 skippedChannels。
  const markCandidateSkipped = (route: RoutedModel) => {
    candidates.consumeChannel(route.channel.id);
    if (!skippedChannels.has(route.channel.id)) skippedChannels.add(route.channel.id);
    if (!skippedChannelNames.includes(route.channel.name)) skippedChannelNames.push(route.channel.name);
  };

  // 模型级预检失败：只排除该模型实例并刷新候选队列，不把整条渠道加入排除集合，
  // 以便同渠道下其它模型实例仍可被尝试。候选遍历的终止由 excludedModelIds 单调增长保证。
  const markModelSkipped = (route: RoutedModel) => {
    candidates.excludeModel(route.model.id);
    if (!skippedChannels.has(route.channel.id)) skippedChannels.add(route.channel.id);
    if (!skippedChannelNames.includes(route.channel.name)) skippedChannelNames.push(route.channel.name);
  };

  // 真正打到上游：计入 route_attempts 口径，同时进入排除集合。
  const markUpstreamAttempted = (route: RoutedModel) => {
    candidates.consumeChannel(route.channel.id);
    if (!attemptedChannels.has(route.channel.id)) attemptedChannels.add(route.channel.id);
    if (!attemptedChannelNames.includes(route.channel.name)) attemptedChannelNames.push(route.channel.name);
  };

  // 上界触发只表示「不再拉新候选」，不覆盖已有诊断原因、也不跳过后续的 sameChannelRetry。
  let visitLimitReached = false;

  // 上界触发时在既有诊断原因后追加标注，不覆盖真实原因（渠道熔断 / 配额等更有排查价值）
  const withVisitLimitNote = (reason: string): string =>
    visitLimitReached ? `${reason}；候选遍历达到上界，已放弃剩余候选` : reason;

  // 预检被跳过时把最后一次原因转成可诊断的中文提示
  const describeSkipReason = (skip: SkipReason | null): string | null => {
    if (!skip) return null;
    switch (skip.reason) {
      case "queue_full":
        return `渠道并发已满：${skip.message}`;
      case "circuit_open":
        return `渠道已熔断：${skip.message}`;
      case "model_quota":
        return `模型配额已用尽：${skip.message}`;
      case "channel_quota":
      case "user_quota":
        return skip.message;
    }
  };

  let candidate: RoutedModel;
  for (;;) {
    const next = await candidates.shift();

    if (next.type === "candidate") {
      candidate = next.route;
      if (next.limitReached) visitLimitReached = true;
    } else {
      // 候选耗尽或达到上界：两者都进入同一退出路径，上界不抢重试预算的退出权，
      // 也不覆盖已有原因（上界只在最终消息里作为附注追加）。
      // 没有其他渠道了，用最后一个渠道继续重试（适用于 429 同渠道重试）
      if (!lastRequestedRoute || !sameChannelRetry) break;
      const retryRoute = lastRequestedRoute;
      const lastQuotaCheck = await checkCandidateModelQuota(retryRoute);
      if (!lastQuotaCheck.ok) break;
      if (userQuotaGuard) {
        const uq = await userQuotaGuard(retryRoute);
        if (!uq.ok) {
          lastUserQuotaReason = uq.reason;
          break;
        }
        approvedRedeemBalanceId = uq.redeemBalanceId ?? null;
      }
      const runtimeKey = makeModelRuntimeKey(retryRoute.channel.id, retryRoute.model.real_model);
      const leaseResult = deps.acquireChannel(runtimeKey, retryRoute.channel.max_concurrency, requestSignal);
      if (isPromiseLike(leaseResult)) {
        return {
          ok: true,
          queued: true,
          route: retryRoute,
          acquirePromise: leaseResult,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
          skippedChannels: [...skippedChannels],
          skippedChannelNames: [...skippedChannelNames],
          modelQuota: lastQuotaCheck.quota,
          redeemBalanceId: approvedRedeemBalanceId,
        };
      }
      if (!leaseResult.ok) {
        lastSkipReason = { reason: leaseResult.reason === "queue_full" ? "queue_full" : "circuit_open", message: retryRoute.channel.name };
        break;
      }
      const lease = leaseResult.lease;
      const channelQuota = await deps.checkChannelQuota(retryRoute.channel.id, estimatedTokens);
      if (!channelQuota.ok) {
        lease.abandon();
        lastSkipReason = { reason: "channel_quota", message: channelQuota.reason };
        break;
      }
      try {
        attempt += 1;
        const upstreamBody = buildRequestBody(retryRoute);
        try {
          const upstream = await deps.fetchUpstreamRequest(retryRoute, upstreamBody, retryRoute.effective_upstream_protocol, inboundHeaders);
          lastUpstreamStatus = upstream.status;
          lastFailure = null;
          markUpstreamAttempted(retryRoute);
          if (deps.shouldRetryUpstreamStatus(upstream.status, resolveRetryStatusCodes(retryRoute.model.retry_status_codes, retryRoute.channel.retry_status_codes, defaultRetryStatusCodes)) && attempt < maxRouteAttempts) {
            lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
            continue;
          }
          return {
            ok: true,
            route: retryRoute,
            upstream,
            lease,
            attemptedChannels: [...attemptedChannels],
            attemptedChannelNames: [...attemptedChannelNames],
            skippedChannels: [...skippedChannels],
            skippedChannelNames: [...skippedChannelNames],
            modelQuota: lastQuotaCheck.quota,
            redeemBalanceId: approvedRedeemBalanceId,
          };
        } catch (error) {
          const summary = summarizeError(error);
          lastFailure = {
            stage: "fetch_network",
            message: summary.message,
            name: summary.name,
            upstreamUrl: buildUpstreamUrl(retryRoute.channel.base_url, retryRoute.effective_upstream_protocol),
            isTimeout: summary.isTimeout,
          };
          lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
          markUpstreamAttempted(retryRoute);
          if (attempt >= maxRouteAttempts) break;
        }
      } catch (error) {
        const summary = summarizeError(error);
        lastFailure = {
          stage: "request_body_build",
          message: summary.message,
          name: summary.name,
          upstreamUrl: buildUpstreamUrl(retryRoute.channel.base_url, retryRoute.effective_upstream_protocol),
          isTimeout: summary.isTimeout,
        };
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        markUpstreamAttempted(retryRoute);
        if (attempt >= maxRouteAttempts) break;
      }
      continue;
    }

    // 模型独立配额检查：配额不足则排除该候选模型实例（不排除整个渠道，避免同渠道其他实例被连坐跳过），
    // 继续尝试下一个候选。模型配额不足不消耗重试预算（attempt 仅在真正发起上游请求前递增）。
    // 遍历有界性由两点保证：(1) excludedModelIds / consumedChannelIds 单调增长，同一候选不会被重复考察；
    // (2) 循环顶部按实际访问候选数计数的 MAX_CANDIDATE_VISITS 兜底。
    const modelQuotaCheck = await checkCandidateModelQuota(candidate);
    if (!modelQuotaCheck.ok) {
      lastSkipReason = { reason: "model_quota", message: candidate.model.real_model };
      // 只排除模型实例：同渠道其它模型实例仍可尝试。
      markModelSkipped(candidate);
      continue;
    }

    if (userQuotaGuard) {
      const uq = await userQuotaGuard(candidate);
      if (!uq.ok) {
        lastUserQuotaReason = uq.reason;
        lastSkipReason = { reason: "user_quota", message: uq.reason };
        markCandidateSkipped(candidate);
        continue;
      }
      approvedRedeemBalanceId = uq.redeemBalanceId ?? null;
    }

    const runtimeKey = makeModelRuntimeKey(candidate.channel.id, candidate.model.real_model);
    const leaseResult = deps.acquireChannel(runtimeKey, candidate.channel.max_concurrency, requestSignal);
    if (isPromiseLike(leaseResult)) {
      // 进入排队即视为已打到上游，计入 route_attempts
      markUpstreamAttempted(candidate);
      return {
        ok: true,
        queued: true,
        route: candidate,
        acquirePromise: leaseResult,
        attemptedChannels: [...attemptedChannels],
        attemptedChannelNames: [...attemptedChannelNames],
        skippedChannels: [...skippedChannels],
        skippedChannelNames: [...skippedChannelNames],
        modelQuota: modelQuotaCheck.quota,
        redeemBalanceId: approvedRedeemBalanceId,
      };
    }

    if (!leaseResult.ok) {
      lastSkipReason = { reason: leaseResult.reason === "queue_full" ? "queue_full" : "circuit_open", message: candidate.channel.name };
      markCandidateSkipped(candidate);
      continue;
    }

    const lease = leaseResult.lease;

    const channelQuota = await deps.checkChannelQuota(candidate.channel.id, estimatedTokens);
    if (!channelQuota.ok) {
      lease.abandon();
      lastSkipReason = { reason: "channel_quota", message: channelQuota.reason };
      markCandidateSkipped(candidate);
      continue;
    }

    // 预检守卫（渠道并发获取、渠道配额、用户配额）失败均不消耗重试预算，只有真正发起上游请求才递增 attempt
    attempt += 1;

    try {
      const upstreamBody = buildRequestBody(candidate);
      try {
        const upstream = await deps.fetchUpstreamRequest(candidate, upstreamBody, candidate.effective_upstream_protocol, inboundHeaders);
        lastUpstreamStatus = upstream.status;
        lastFailure = null;
        lastRequestedRoute = candidate;
        markUpstreamAttempted(candidate);
        if (deps.shouldRetryUpstreamStatus(upstream.status, resolveRetryStatusCodes(candidate.model.retry_status_codes, candidate.channel.retry_status_codes, defaultRetryStatusCodes)) && attempt < maxRouteAttempts) {
          lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
          continue;
        }
        return {
          ok: true,
          route: candidate,
          upstream,
          lease,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames: [...attemptedChannelNames],
          skippedChannels: [...skippedChannels],
          skippedChannelNames: [...skippedChannelNames],
          modelQuota: modelQuotaCheck.quota,
          redeemBalanceId: approvedRedeemBalanceId,
        };
      } catch (error) {
        const summary = summarizeError(error);
        lastFailure = {
          stage: "fetch_network",
          message: summary.message,
          name: summary.name,
          upstreamUrl: buildUpstreamUrl(candidate.channel.base_url, candidate.effective_upstream_protocol),
          isTimeout: summary.isTimeout,
        };
        lastRequestedRoute = candidate;
        markUpstreamAttempted(candidate);
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        if (attempt >= maxRouteAttempts) break;
      }
    } catch (error) {
      const summary = summarizeError(error);
      lastFailure = {
        stage: "request_body_build",
        message: summary.message,
        name: summary.name,
        upstreamUrl: buildUpstreamUrl(candidate.channel.base_url, candidate.effective_upstream_protocol),
        isTimeout: summary.isTimeout,
      };
      lastRequestedRoute = candidate;
      markUpstreamAttempted(candidate);
      lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
      if (attempt >= maxRouteAttempts) break;
    }
  }

  return {
    ok: false,
    route: lastRequestedRoute,
    lastUpstreamStatus,
    attemptedChannels: [...attemptedChannels],
    attemptedChannelNames: [...attemptedChannelNames],
    skippedChannels: [...skippedChannels],
    skippedChannelNames: [...skippedChannelNames],
    failure: lastFailure,
    quotaReason: (() => {
      const reason = lastUserQuotaReason ?? lastModelQuotaReason ?? describeSkipReason(lastSkipReason);
      if (reason) return withVisitLimitNote(reason);
      return visitLimitReached ? "候选遍历达到上界，已放弃剩余候选" : null;
    })(),
    modelQuota: lastModelQuota,
    redeemBalanceId: approvedRedeemBalanceId,
  };
}
