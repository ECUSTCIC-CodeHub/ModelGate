import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import type { StreamUsage } from "@/lib/gateway/protocol-adapters/streaming/common";

export type ResponsesSseEvent = {
  event: string;
  data: JsonRecord | string;
};

export function parseResponsesSseEvent(event: string, data: string): ResponsesSseEvent {
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    const actualEvent = event || (typeof parsed.type === "string" ? parsed.type : "message");
    return { event: actualEvent, data: parsed };
  } catch {
    return { event: event || "message", data };
  }
}

export function trackResponsesStreamEvent(eventName: string, data: string) {
  const parsed = parseResponsesSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event === "response.output_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  if (parsed.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  return null;
}

export function createdToUnix(value: unknown) {
  const created = typeof value === "string"
    ? Math.floor(new Date(value).getTime() / 1000)
    : Number(value);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
}

export function usageFromResponses(value: unknown): StreamUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
  };
}

export function responseUsage(usage: StreamUsage | null) {
  return usage
    ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
    : undefined;
}
