import { decodeChatCompletionsStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-decode";
import { encodeChatCompletionsStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-encode";
import { trackChatCompletionsStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-events";
export { trackChatCompletionsStreamEvent } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-events";
export { decodeChatCompletionsStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-decode";
export { encodeChatCompletionsStream } from "@/lib/gateway/protocol-adapters/streaming/chat-completions-encode";
export const chatCompletionsStreamAdapter = {
    protocol: "chat_completions",
    decode: decodeChatCompletionsStream,
    encode: (events, options) => encodeChatCompletionsStream(events, options),
    trackPassthroughEvent: trackChatCompletionsStreamEvent,
};
