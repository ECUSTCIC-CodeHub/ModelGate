import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { anthropicMessagesStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/anthropic";
import { chatCompletionsStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import { responsesStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/responses";
import type {
  ProtocolStreamAdapter,
  StreamingProtocol,
} from "@/lib/gateway/protocol-adapters/streaming/types";

const streamAdapters = {
  chat_completions: chatCompletionsStreamAdapter,
  responses: responsesStreamAdapter,
  anthropic_messages: anthropicMessagesStreamAdapter,
} satisfies Record<StreamingProtocol, ProtocolStreamAdapter>;

function isStreamingProtocol(protocol: GatewayProtocol): protocol is StreamingProtocol {
  return protocol !== "embeddings" && protocol !== "images" && protocol !== "other";
}

export function getStreamAdapter(protocol: GatewayProtocol): ProtocolStreamAdapter | null {
  return isStreamingProtocol(protocol) ? streamAdapters[protocol] : null;
}
