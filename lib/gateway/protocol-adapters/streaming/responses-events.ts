import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import { usageFromResponses as normalizeResponsesUsage } from "@/lib/gateway/protocol-adapters/usage";
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
  const response = asRecord(payload?.response);
  const usage = usageFromResponses(response?.usage);
  const tracked: {
    completionText?: string;
    reasoningText?: string;
    usage?: StreamUsage;
  } = {};
  if (usage) tracked.usage = usage;
  if (parsed.event === "response.output_text.delta" && typeof payload?.delta === "string") {
    tracked.completionText = payload.delta;
  }
  if (parsed.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
    tracked.reasoningText = payload.delta;
  }
  return tracked.usage || tracked.completionText || tracked.reasoningText ? tracked : null;
}

export function createdToUnix(value: unknown) {
  const created = typeof value === "string"
    ? Math.floor(new Date(value).getTime() / 1000)
    : Number(value);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
}

export function usageFromResponses(value: unknown): StreamUsage | null {
  return normalizeResponsesUsage(value);
}

export function responseUsage(usage: StreamUsage | null) {
  return usage
    ? {
        input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      output_tokens_details: usage.reasoning_tokens !== undefined || usage.text_tokens !== undefined
        ? {
            ...(usage.reasoning_tokens !== undefined ? { reasoning_tokens: usage.reasoning_tokens } : {}),
            ...(usage.text_tokens !== undefined ? { text_tokens: usage.text_tokens } : {}),
          }
        : undefined,
      input_tokens_details: usage.cache_read_tokens !== undefined
          ? { cached_tokens: usage.cache_read_tokens }
          : undefined,
      }
    : undefined;
}
