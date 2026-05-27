import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";
import { createAnthropicToChatStream, createAnthropicToResponsesStream, trackAnthropicMessagesStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/anthropic";
import { createChatToAnthropicStream, createChatToResponsesStream, trackChatCompletionsStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import { createPassthroughStream, type PassthroughEventTracker, type StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming/common";
import { createResponsesToAnthropicStream, createResponsesToChatStream, trackResponsesStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/responses";

const passthroughTrackers = {
  chat_completions: trackChatCompletionsStreamEvent,
  responses: trackResponsesStreamEvent,
  anthropic_messages: trackAnthropicMessagesStreamEvent,
  embeddings: () => null,
} satisfies Record<GatewayProtocolAdapter["protocol"], PassthroughEventTracker>;

export function createTransformedStream(
  upstream: ReadableStream<Uint8Array>,
  outboundAdapter: GatewayProtocolAdapter,
  inboundAdapter: GatewayProtocolAdapter,
  options?: ResponseAdapterOptions,
): StreamTransformResult {
  const outboundProtocol = outboundAdapter.protocol;
  const inboundProtocol = inboundAdapter.protocol;
  if (outboundProtocol === inboundProtocol) {
    return createPassthroughStream(upstream, passthroughTrackers[outboundProtocol]);
  }

  const thinkingEnabled = options?.thinkingEnabled ?? false;

  return outboundProtocol === "chat_completions"
    ? inboundProtocol === "responses"
      ? createChatToResponsesStream(upstream)
      : createChatToAnthropicStream(upstream, thinkingEnabled)
    : outboundProtocol === "responses"
      ? inboundProtocol === "chat_completions"
        ? createResponsesToChatStream(upstream)
        : createResponsesToAnthropicStream(upstream, thinkingEnabled)
      : inboundProtocol === "chat_completions"
        ? createAnthropicToChatStream(upstream)
        : createAnthropicToResponsesStream(upstream);
}

export type { StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming/common";
