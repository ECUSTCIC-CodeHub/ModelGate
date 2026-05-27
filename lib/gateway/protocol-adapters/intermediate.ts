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

export function normalizeUsage(promptTokens: number, completionTokens: number, totalTokens?: number): IntermediateUsage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens ?? promptTokens + completionTokens,
  };
}
