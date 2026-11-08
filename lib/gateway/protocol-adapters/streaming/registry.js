import { anthropicMessagesStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/anthropic";
import { chatCompletionsStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/chat-completions";
import { responsesStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/responses";
const streamAdapters = {
    chat_completions: chatCompletionsStreamAdapter,
    responses: responsesStreamAdapter,
    anthropic_messages: anthropicMessagesStreamAdapter,
};
function isStreamingProtocol(protocol) {
    return protocol !== "embeddings" && protocol !== "images" && protocol !== "other";
}
export function getStreamAdapter(protocol) {
    return isStreamingProtocol(protocol) ? streamAdapters[protocol] : null;
}
