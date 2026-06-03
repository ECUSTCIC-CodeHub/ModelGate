import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { usageFromAnthropic } from "@/lib/gateway/protocol-adapters/usage";

export type AnthropicSseEvent = {
  event: string;
  data: JsonRecord | string;
};

export function parseAnthropicSseEvent(event: string, data: string): AnthropicSseEvent {
  try {
    return { event, data: JSON.parse(data) as JsonRecord };
  } catch {
    return { event, data };
  }
}

export function trackAnthropicMessagesStreamEvent(eventName: string, data: string) {
  const parsed = parseAnthropicSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event === "message_start") {
    const message = asRecord(payload?.message);
    const usage = usageFromAnthropic(message?.usage);
    if (usage) {
      return {
        usage,
      };
    }
    return null;
  }

  if (parsed.event === "message_delta") {
    const usage = usageFromAnthropic(payload?.usage);
    if (usage) {
      return {
        usage: {
          completion_tokens: usage.completion_tokens,
          cache_read_tokens: usage.cache_read_tokens,
          cache_creation_tokens: usage.cache_creation_tokens,
          cache_miss_tokens: usage.cache_miss_tokens,
        },
      };
    }
    return null;
  }

  if (parsed.event === "content_block_delta") {
    const delta = asRecord(payload?.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { completionText: delta.text };
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      return { firstToken: true };
    }
  }

  return null;
}
