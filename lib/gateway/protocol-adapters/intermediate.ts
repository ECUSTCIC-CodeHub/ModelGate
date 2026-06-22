import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { JsonRecord, NormalizedContentPart, NormalizedMessage } from "@/lib/gateway/normalized-message";

export type IntermediateTool = {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
};

export type IntermediateToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

export type IntermediateUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  text_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_miss_tokens?: number;
};

export type IntermediateRequest = {
  sourceProtocol: GatewayProtocol;
  model: string;
  messages: NormalizedMessage[];
  stream: boolean;
  maxTokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  stop_sequences?: unknown;
  tools?: IntermediateTool[];
  tool_choice?: IntermediateToolChoice;
  parallel_tool_calls?: unknown;
  stream_options?: unknown;
  user?: unknown;
  metadata?: unknown;
  response_format?: unknown;
  text?: unknown;
  thinking?: unknown;
  reasoning_effort?: unknown;
  context_management?: unknown;
  extra: JsonRecord;
};

export type IntermediateToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

export type IntermediateResponse = {
  sourceProtocol: GatewayProtocol;
  id: string;
  model: string | null;
  created: number;
  role: "assistant";
  content: NormalizedContentPart[];
  tool_calls: IntermediateToolCall[];
  stop_reason: string | null;
  usage: IntermediateUsage | null;
  extra: JsonRecord;
};

export type ResponseAdapterOptions = {
  thinkingEnabled?: boolean;
  requestedModel?: string;
};

export type ProtocolBodyAdapter = {
  requestToIntermediate(body: JsonRecord, realModel: string): IntermediateRequest;
  requestFromIntermediate(request: IntermediateRequest): JsonRecord;
  responseToIntermediate(body: JsonRecord): IntermediateResponse;
  responseFromIntermediate(response: IntermediateResponse, options?: ResponseAdapterOptions): JsonRecord;
};

export function omitKeys(input: JsonRecord, keys: string[]) {
  const skip = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !skip.has(key)));
}

export function parseJsonObject(text: string) {
  return JSON.parse(text) as JsonRecord;
}

export function parseToolArguments(raw: string | undefined) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw: raw ?? "" };
  }
}

export function finishReasonToAnthropic(value: string | null, hasTools: boolean) {
  if (value === "tool_calls" || hasTools) return "tool_use";
  return "end_turn";
}

export function finishReasonFromAnthropic(value: string | null, hasTools: boolean) {
  if (value === "tool_use" || hasTools) return "tool_calls";
  return "stop";
}

export function normalizeUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number,
  details?: Pick<IntermediateUsage, "text_tokens" | "reasoning_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "cache_miss_tokens">,
): IntermediateUsage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Math.max(totalTokens ?? 0, promptTokens + completionTokens),
    ...(details?.text_tokens !== undefined ? { text_tokens: details.text_tokens } : {}),
    ...(details?.reasoning_tokens !== undefined ? { reasoning_tokens: details.reasoning_tokens } : {}),
    ...(details?.cache_read_tokens !== undefined ? { cache_read_tokens: details.cache_read_tokens } : {}),
    ...(details?.cache_creation_tokens !== undefined ? { cache_creation_tokens: details.cache_creation_tokens } : {}),
    ...(details?.cache_miss_tokens !== undefined ? { cache_miss_tokens: details.cache_miss_tokens } : {}),
  };
}
