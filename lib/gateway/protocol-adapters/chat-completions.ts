import { normalizeChatMessages } from "@/lib/gateway/normalized-message";
import {
  type ProtocolBodyAdapter,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { createBodyProtocolGatewayAdapter, inputTextFromMessages } from "@/lib/gateway/protocol-adapters/runtime";
import {
  chatCompletionsRequestFromIntermediate,
  chatCompletionsRequestToIntermediate,
} from "@/lib/gateway/protocol-adapters/chat-completions-request";
import {
  chatCompletionsResponseFromIntermediate,
  chatCompletionsResponseToIntermediate,
} from "@/lib/gateway/protocol-adapters/chat-completions-response";
import type { JsonRecord } from "@/lib/gateway/normalized-message";

export {
  extractChatMessageText,
  extractChatToolCalls,
} from "@/lib/gateway/protocol-adapters/chat-completions-response";

export const chatCompletionsAdapter: ProtocolBodyAdapter = {
  requestToIntermediate: chatCompletionsRequestToIntermediate,
  requestFromIntermediate: chatCompletionsRequestFromIntermediate,
  responseToIntermediate: chatCompletionsResponseToIntermediate,
  responseFromIntermediate: chatCompletionsResponseFromIntermediate,
};

export const chatCompletionsGatewayAdapter = createBodyProtocolGatewayAdapter({
  protocol: "chat_completions",
  bodyAdapter: chatCompletionsAdapter,
  getInputText(body) {
    return inputTextFromMessages(normalizeChatMessages(body.messages));
  },
  getMaxOutputTokens(body) {
    return body.max_tokens;
  },
});
