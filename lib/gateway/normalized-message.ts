export type { JsonRecord, NormalizedContentPart, NormalizedMessage } from "@/lib/gateway/normalized-message/types";
export { asArray, asRecord } from "@/lib/gateway/normalized-message/utils";
export {
  extractThinkingText,
  normalizeContentParts,
  normalizedPartsToAnthropicContent,
  normalizedPartsToChatContent,
  normalizedPartsToResponseContent,
} from "@/lib/gateway/normalized-message/content";
export { normalizeChatMessages } from "@/lib/gateway/normalized-message/chat";
export { normalizeResponsesInput } from "@/lib/gateway/normalized-message/responses";
export { normalizeAnthropicMessages } from "@/lib/gateway/normalized-message/anthropic";
