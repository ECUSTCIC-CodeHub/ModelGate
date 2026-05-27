import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";
import {
  decodeAnthropicMessagesStream,
  encodeAnthropicMessagesStream,
  trackAnthropicMessagesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/anthropic";
import {
  decodeChatCompletionsStream,
  encodeChatCompletionsStream,
  trackChatCompletionsStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import {
  createPassthroughStream,
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type PassthroughEventTracker,
  type StreamTransformResult,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import {
  decodeResponsesStream,
  encodeResponsesStream,
  trackResponsesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/responses";

type StreamingProtocol = Exclude<GatewayProtocolAdapter["protocol"], "embeddings">;
type StreamDecoder = (upstream: ReadableStream<Uint8Array>) => IntermediateStreamResult;
type StreamEncoder = (
  events: ReadableStream<IntermediateStreamEvent>,
  options?: ResponseAdapterOptions,
) => ReadableStream<Uint8Array>;

const passthroughTrackers = {
  chat_completions: trackChatCompletionsStreamEvent,
  responses: trackResponsesStreamEvent,
  anthropic_messages: trackAnthropicMessagesStreamEvent,
  embeddings: () => null,
} satisfies Record<GatewayProtocolAdapter["protocol"], PassthroughEventTracker>;

const streamDecoders = {
  chat_completions: decodeChatCompletionsStream,
  responses: decodeResponsesStream,
  anthropic_messages: decodeAnthropicMessagesStream,
} satisfies Record<StreamingProtocol, StreamDecoder>;

const streamEncoders = {
  chat_completions: (events) => encodeChatCompletionsStream(events),
  responses: (events) => encodeResponsesStream(events),
  anthropic_messages: (events, options) => encodeAnthropicMessagesStream(events, options?.thinkingEnabled ?? false),
} satisfies Record<StreamingProtocol, StreamEncoder>;

function isStreamingProtocol(protocol: GatewayProtocolAdapter["protocol"]): protocol is StreamingProtocol {
  return protocol !== "embeddings";
}

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

  if (!isStreamingProtocol(outboundProtocol) || !isStreamingProtocol(inboundProtocol)) {
    throw new Error(`${outboundProtocol} 协议流不能转换为 ${inboundProtocol}`);
  }

  const decoded = streamDecoders[outboundProtocol](upstream);
  return {
    stream: streamEncoders[inboundProtocol](decoded.stream, options),
    completionText: decoded.completionText,
    firstTokenAt: decoded.firstTokenAt,
  };
}

export type { StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming/common";
