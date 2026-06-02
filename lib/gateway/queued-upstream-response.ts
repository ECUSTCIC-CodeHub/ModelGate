import type { ApiKeyContext } from "@/lib/auth/api-key-auth";
import { insertChatLog } from "@/lib/gateway/chat-log";
import { fetchUpstreamRequest } from "@/lib/gateway/proxy";
import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming";
import type { RoutedModel } from "@/lib/gateway/router";
import { resolveTokenUsage } from "@/lib/gateway/token-usage";
import { buildErrorResponseBody, parseUpstreamError } from "@/lib/gateway/upstream-error";
import type { UpstreamPickResult } from "@/lib/gateway/upstream-routing";
import { addUsage } from "@/lib/gateway/usage-accounting";

const QUEUE_KEEPALIVE_INTERVAL_MS = 1_000;
const encoder = new TextEncoder();

type QueuedUpstreamPick = Extract<UpstreamPickResult, { queued: true }>;

type QueuedResponseOptions = {
  picked: QueuedUpstreamPick;
  requestHeaders: Headers;
  auth: ApiKeyContext;
  alias: string;
  inboundProtocol: GatewayProtocol;
  stream: boolean;
  startedAt: number;
  estimatedTokens: number;
  localPromptTokens: number;
  upstreamBody: Record<string, unknown>;
  clientIp: string | null;
  clientUserAgent: string | null;
  withQuotaHeaders: (response: Response) => Response;
  adaptResponseBodyForRoute: (rawText: string, route: RoutedModel) => string;
  getUsageForRoute: (rawText: string, route: RoutedModel) => {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  extractCompletionTextForRoute: (rawText: string, route: RoutedModel) => string;
  createTransformedStreamForRoute: (
    upstreamBody: ReadableStream<Uint8Array>,
    route: RoutedModel,
  ) => StreamTransformResult;
};

function createQueueKeepAliveTimer(controller: ReadableStreamDefaultController<Uint8Array>, stream: boolean) {
  return setInterval(() => {
    controller.enqueue(encoder.encode(stream ? ": keep-alive\n\n" : "\n"));
  }, QUEUE_KEEPALIVE_INTERVAL_MS);
}

function toSseDataBlock(payload: string) {
  const compact = payload.replace(/\r?\n/g, "");
  return encoder.encode(`data: ${compact}\n\n`);
}

export function normalizeUserAgent(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 500) : null;
}

export function createQueuedUpstreamResponse({
  picked,
  requestHeaders,
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
  createTransformedStreamForRoute,
}: QueuedResponseOptions) {
  const { route, acquirePromise, attemptedChannels, attemptedChannelNames } = picked;

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
            const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, requestHeaders);

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
              const tokenUsage = resolveTokenUsage({
                usage,
                localPromptTokens,
                completionText,
                model: route.model.real_model,
              });
              const outputTps =
                tokenUsage.completionTokens > 0
                  ? Number(((tokenUsage.completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
                  : null;

              lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
              addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
              const tokenUsage = success
                ? resolveTokenUsage({
                    usage: transformed.usage(),
                    localPromptTokens,
                    completionText: transformed.completionText(),
                    model: route.model.real_model,
                  })
                : {
                    promptTokens: localPromptTokens,
                    completionTokens: 0,
                    totalTokens: localPromptTokens,
                    source: "local" as const,
                  };
              const outputTps =
                success && tokenUsage.completionTokens > 0
                  ? Number(((tokenUsage.completionTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
                  : null;
              const firstTokenAt = transformed.firstTokenAt();
              const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

              if (success) {
                addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
          controller.error(new Error("等待渠道队列时请求已中断"));
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
          const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol, requestHeaders);
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
          const tokenUsage = resolveTokenUsage({
            usage,
            localPromptTokens,
            completionText,
            model: route.model.real_model,
          });
          const outputTps =
            tokenUsage.completionTokens > 0
              ? Number(((tokenUsage.completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
              : null;

          lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
          addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier);
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
        controller.error(new Error("等待渠道队列时请求已中断"));
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
