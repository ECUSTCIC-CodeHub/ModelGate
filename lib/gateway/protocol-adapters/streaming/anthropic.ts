import { decodeAnthropicMessagesStream } from "@/lib/gateway/protocol-adapters/streaming/anthropic-decode";
import { encodeAnthropicMessagesStream } from "@/lib/gateway/protocol-adapters/streaming/anthropic-encode";
import {
  trackAnthropicMessagesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/anthropic-events";
import type { ProtocolStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/types";

export {
  parseAnthropicSseEvent,
  trackAnthropicMessagesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/anthropic-events";
export { decodeAnthropicMessagesStream } from "@/lib/gateway/protocol-adapters/streaming/anthropic-decode";
export { encodeAnthropicMessagesStream } from "@/lib/gateway/protocol-adapters/streaming/anthropic-encode";

export const anthropicMessagesStreamAdapter: ProtocolStreamAdapter = {
  protocol: "anthropic_messages",
  decode: decodeAnthropicMessagesStream,
  encode: (events, options) => encodeAnthropicMessagesStream(events, options?.thinkingEnabled ?? false),
  trackPassthroughEvent: trackAnthropicMessagesStreamEvent,
};
