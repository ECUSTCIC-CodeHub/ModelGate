import { acquireChannel, type ChannelLease, makeModelRuntimeKey } from "@/lib/gateway/channel-runtime";
import { checkChannelQuota } from "@/lib/gateway/channel-quota";
import { buildUpstreamUrl, fetchUpstreamRequest } from "@/lib/gateway/proxy";
import { selectModelRoute, type RoutedModel } from "@/lib/gateway/router";
import { shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

type ChannelAcquireResult = Awaited<ReturnType<typeof acquireChannel>>;

export type UpstreamFailureStage = "request_body_build" | "fetch_network";

type UpstreamFailureInfo = {
  stage: UpstreamFailureStage;
  message: string;
  name: string | null;
  upstreamUrl: string | null;
};

export type UpstreamPickResult =
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
      acquirePromise: Promise<ChannelAcquireResult>;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
    }
  | {
      ok: false;
      route: RoutedModel | null;
      lastUpstreamStatus: number;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      failure: UpstreamFailureInfo | null;
    };

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "未知错误",
      name: error.name || null,
    };
  }

  return {
    message: typeof error === "string" && error.trim() ? error : "未知错误",
    name: null,
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

  while (attempt < maxRouteAttempts) {
    const route = selectModelRoute(resolvedAlias, {
      excludeChannelIds: [...attemptedChannels],
      protocol: inboundProtocol,
      allowedChannelIds,
    });

    if (!route) {
      if (!lastRoute || !sameChannelRetry) break;
      // 没有其他渠道了，用最后一个渠道继续重试（适用于 429 同渠道重试）
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
        };
      }
      if (!leaseResult.ok) break;
      const lease = leaseResult.lease;
      const channelQuota = checkChannelQuota(lastRoute.channel.id, estimatedTokens);
      if (!channelQuota.ok) {
        lease.abandon();
        break;
      }
      try {
        attempt += 1;
        const upstreamBody = buildRequestBody(lastRoute);
        try {
          const upstream = await fetchUpstreamRequest(lastRoute, upstreamBody, lastRoute.model.upstream_protocol, inboundHeaders);
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
          };
        } catch (error) {
          const summary = summarizeError(error);
          lastFailure = {
            stage: "fetch_network",
            message: summary.message,
            name: summary.name,
            upstreamUrl: buildUpstreamUrl(lastRoute.channel.base_url, lastRoute.model.upstream_protocol),
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
          upstreamUrl: buildUpstreamUrl(lastRoute.channel.base_url, lastRoute.model.upstream_protocol),
        };
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
        if (attempt >= maxRouteAttempts) break;
      }
      continue;
    }

    lastNetworkRoute = route;
    lastRoute = route;
    attempt += 1;
    attemptedChannels.add(route.channel.id);
    attemptedChannelNames.push(route.channel.name);

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
      };
    }

    if (!leaseResult.ok) continue;

    const lease = leaseResult.lease;

    const channelQuota = checkChannelQuota(route.channel.id, estimatedTokens);
    if (!channelQuota.ok) {
      lease.abandon();
      continue;
    }

    try {
      const upstreamBody = buildRequestBody(route);
      try {
        const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, inboundHeaders);
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
        };
      } catch (error) {
        const summary = summarizeError(error);
        lastFailure = {
          stage: "fetch_network",
          message: summary.message,
          name: summary.name,
          upstreamUrl: buildUpstreamUrl(route.channel.base_url, route.model.upstream_protocol),
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
        upstreamUrl: buildUpstreamUrl(route.channel.base_url, route.model.upstream_protocol),
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
  };
}
