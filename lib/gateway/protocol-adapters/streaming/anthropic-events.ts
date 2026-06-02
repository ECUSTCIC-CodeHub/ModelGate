import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";

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
    const usage = asRecord(message?.usage);
    if (usage) {
      return {
        usage: {
          prompt_tokens: Number(usage.input_tokens ?? 0),
          completion_tokens: 0,
        },
      };
    }
    return null;
  }

  if (parsed.event === "message_delta") {
    const usage = asRecord(payload?.usage);
    if (usage) {
      return {
        usage: {
          completion_tokens: Number(usage.output_tokens ?? 0),
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
