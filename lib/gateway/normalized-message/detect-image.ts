import type { GatewayProtocol } from "@/lib/gateway/protocols";
import { normalizeChatMessages } from "@/lib/gateway/normalized-message/chat";
import { normalizeResponsesInput } from "@/lib/gateway/normalized-message/responses";
import { normalizeAnthropicMessages } from "@/lib/gateway/normalized-message/anthropic";
import type { NormalizedMessage } from "@/lib/gateway/normalized-message/types";

function messageContainsImage(messages: NormalizedMessage[]): boolean {
  return messages.some((message) => message.content.some((part) => part.type === "image"));
}

export function requestContainsImage(body: Record<string, unknown>, protocol: GatewayProtocol): boolean {
  if (protocol === "chat_completions") {
    return messageContainsImage(normalizeChatMessages(body.messages));
  }
  if (protocol === "responses") {
    const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
    return messageContainsImage(normalizeResponsesInput(body.input, instructions));
  }
  if (protocol === "anthropic_messages") {
    return messageContainsImage(normalizeAnthropicMessages(body.messages, body.system));
  }
  return false;
}
