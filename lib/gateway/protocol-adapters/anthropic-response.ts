import {
  asArray,
  asRecord,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";
import {
  finishReasonToAnthropic,
  omitKeys,
  parseToolArguments,
  type IntermediateResponse,
  type ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { usageFromAnthropic } from "@/lib/gateway/protocol-adapters/usage";

const RESPONSE_KEYS = ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"];

function contentBlocksFromResponse(content: unknown) {
  return asArray(content).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
}

function thinkingBlocks(content: JsonRecord[]) {
  return content
    .filter((item) => item.type === "thinking" || item.type === "redacted_thinking")
    .map((item) => {
      if (item.type === "redacted_thinking") {
        return {
          type: "thinking" as const,
          thinking: typeof item.data === "string" ? item.data : "",
          signature: typeof item.signature === "string" ? item.signature : undefined,
          redacted: true,
        };
      }
      return {
        type: "thinking" as const,
        thinking: typeof item.thinking === "string" ? item.thinking : "",
        signature: typeof item.signature === "string" ? item.signature : undefined,
      };
    })
    .filter((item) => item.thinking);
}

export function anthropicResponseToIntermediate(body: JsonRecord): IntermediateResponse {
  const content = contentBlocksFromResponse(body.content);
  const normalizedContent = [
    ...thinkingBlocks(content),
    ...content
      .filter((item) => item.type === "text")
      .map((item) => ({ type: "text" as const, text: typeof item.text === "string" ? item.text : "" }))
      .filter((item) => item.text),
  ];
  const toolCalls = content
    .filter((item) => item.type === "tool_use")
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : "",
      arguments: JSON.stringify(asRecord(item.input) ?? item.input ?? {}),
    }));
  const usage = usageFromAnthropic(body.usage);

  if (normalizedContent.length === 0 && toolCalls.length === 0) {
    normalizedContent.push({ type: "text", text: "" });
  }

  return {
    sourceProtocol: "anthropic_messages",
    id: typeof body.id === "string" ? body.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof body.model === "string" ? body.model : null,
    created: Math.floor(Date.now() / 1000),
    role: "assistant",
    content: normalizedContent,
    tool_calls: toolCalls,
    stop_reason: typeof body.stop_reason === "string" ? body.stop_reason : null,
    usage,
    extra: omitKeys(body, RESPONSE_KEYS),
  };
}

export function anthropicResponseFromIntermediate(
  response: IntermediateResponse,
  options?: ResponseAdapterOptions,
): JsonRecord {
  const content: JsonRecord[] = [];
  if (options?.thinkingEnabled) {
    for (const part of response.content) {
      if (part.type !== "thinking") continue;
      content.push(part.redacted
        ? { type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }
        : { type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined });
    }
  }

  const textContent = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (textContent || (content.length === 0 && response.tool_calls.length === 0)) {
    content.push({ type: "text", text: textContent || "" });
  }

  for (const toolCall of response.tool_calls) {
    content.push({
      type: "tool_use",
      id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
      name: toolCall.name,
      input: parseToolArguments(toolCall.arguments),
    });
  }

  return {
    ...response.extra,
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: finishReasonToAnthropic(response.stop_reason, response.tool_calls.length > 0),
    stop_sequence: null,
    usage: response.usage ? {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      cache_read_input_tokens: response.usage.cache_read_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_tokens,
    } : undefined,
  };
}
