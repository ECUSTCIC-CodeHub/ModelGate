import {
  asArray,
  asRecord,
  normalizeContentParts,
  type JsonRecord,
  type NormalizedContentPart,
} from "@/lib/gateway/normalized-message";
import {
  omitKeys,
  type IntermediateResponse,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { usageFromResponses } from "@/lib/gateway/protocol-adapters/usage";

const RESPONSE_KEYS = ["id", "object", "created_at", "created", "status", "error", "incomplete_details", "model", "output", "output_text", "usage"];

export function extractResponsesMessage(output: unknown) {
  const items = asArray(output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
  const messageItems = items.filter((item) => item.type === "message" && item.role === "assistant");
  const functionCalls = items.filter((item) => item.type === "function_call");
  const reasoningItems = items.filter((item) => item.type === "reasoning");

  const text = messageItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  const toolCalls = functionCalls.map((item) => ({
    id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined,
    name: typeof item.name === "string" ? item.name : "",
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  }));

  const reasoning = reasoningItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");

  return { text, toolCalls, reasoning };
}

function createdToUnix(value: unknown) {
  const created = typeof value === "string"
    ? Math.floor(new Date(value).getTime() / 1000)
    : Number(value);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
}

export function responsesResponseToIntermediate(body: JsonRecord): IntermediateResponse {
  const extracted = extractResponsesMessage(body.output);
  const usage = usageFromResponses(body.usage);
  const content = [];
  if (extracted.reasoning) content.push({ type: "thinking" as const, thinking: extracted.reasoning });
  if (extracted.text || extracted.toolCalls.length === 0) content.push({ type: "text" as const, text: extracted.text || "" });

  return {
    sourceProtocol: "responses",
    id: typeof body.id === "string" ? body.id : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof body.model === "string" ? body.model : null,
    created: createdToUnix(body.created_at ?? body.created),
    role: "assistant",
    content,
    tool_calls: extracted.toolCalls,
    stop_reason: extracted.toolCalls.length > 0 ? "tool_calls" : "stop",
    usage,
    extra: omitKeys(body, RESPONSE_KEYS),
  };
}

export function responsesResponseFromIntermediate(response: IntermediateResponse): JsonRecord {
  const thinkingBlocks = response.content.filter((part): part is Extract<NormalizedContentPart, { type: "thinking" }> => part.type === "thinking");
  const reasoningText = thinkingBlocks.filter((part) => !part.redacted).map((part) => part.thinking).join("");
  const textContent = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  return {
    ...response.extra,
    id: response.id,
    object: "response",
    created_at: response.created,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: response.model,
    output: [
      ...(reasoningText ? [{
        id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: reasoningText }],
      }] : []),
      ...(textContent || response.tool_calls.length === 0 ? [{
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: textContent ? [{ type: "output_text", text: textContent, annotations: [] }] : [],
      }] : []),
      ...response.tool_calls.map((toolCall) => ({
        type: "function_call",
        id: toolCall.id ?? `fc_${crypto.randomUUID().replace(/-/g, "")}`,
        call_id: toolCall.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "completed",
      })),
    ],
    output_text: textContent,
    usage: response.usage ? {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
      output_tokens_details: response.usage.reasoning_tokens !== undefined || response.usage.text_tokens !== undefined
        ? {
            ...(response.usage.reasoning_tokens !== undefined ? { reasoning_tokens: response.usage.reasoning_tokens } : {}),
            ...(response.usage.text_tokens !== undefined ? { text_tokens: response.usage.text_tokens } : {}),
          }
        : undefined,
      input_tokens_details: response.usage.cache_read_tokens !== undefined
        ? { cached_tokens: response.usage.cache_read_tokens }
        : undefined,
    } : undefined,
  };
}
