import { acquireChannel, type ChannelLease } from "@/lib/gateway/channel-runtime";
import { fetchUpstreamRequest } from "@/lib/gateway/proxy";
import { selectModelRoute, type RoutedModel } from "@/lib/gateway/router";
import { shouldRetryUpstreamStatus } from "@/lib/gateway/upstream-error";
import type { GatewayProtocol } from "@/lib/gateway/protocols";

type ChannelAcquireResult = Awaited<ReturnType<typeof acquireChannel>>;

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
      attemptedChannels: number[];
      attemptedChannelNames: string[];
    };

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

export async function requestUpstreamWithFallback({
  resolvedAlias,
  inboundProtocol,
  maxRouteAttempts,
  requestSignal,
  inboundHeaders,
  startedAt,
  buildRequestBody,
}: {
  resolvedAlias: string;
  inboundProtocol: GatewayProtocol;
  maxRouteAttempts: number;
  requestSignal: AbortSignal;
  inboundHeaders: Headers;
  startedAt: number;
  buildRequestBody: (route: RoutedModel) => Record<string, unknown>;
}): Promise<UpstreamPickResult> {
  const attemptedChannels = new Set<number>();
  const attemptedChannelNames: string[] = [];
  let attempt = 0;
  let lastNetworkRoute: RoutedModel | null = null;

  while (attempt < maxRouteAttempts) {
    const route = selectModelRoute(resolvedAlias, {
      excludeChannelIds: [...attemptedChannels],
      protocol: inboundProtocol,
    });

    if (!route) break;

    lastNetworkRoute = route;
    attempt += 1;
    attemptedChannels.add(route.channel.id);
    attemptedChannelNames.push(route.channel.name);

    const leaseResult = acquireChannel(route.channel.id, route.channel.max_concurrency, requestSignal);
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
    try {
      const upstreamBody = buildRequestBody(route);
      const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, inboundHeaders);
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
}
