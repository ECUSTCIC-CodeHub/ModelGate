import {
  asArray,
  asRecord,
  normalizeContentParts,
  normalizedPartsToChatContent,
  type JsonRecord,
  type NormalizedContentPart,
} from "@/lib/gateway/normalized-message";
import {
  finishReasonFromAnthropic,
  omitKeys,
  type IntermediateResponse,
  type ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { usageFromChatCompletions } from "@/lib/gateway/protocol-adapters/usage";

const RESPONSE_KEYS = ["id", "object", "created", "model", "choices", "usage"];

function chatUsageFromIntermediate(usage: IntermediateResponse["usage"]) {
  if (!usage) return undefined;
  const completionDetails =
    usage.reasoning_tokens !== undefined
      ? { reasoning_tokens: usage.reasoning_tokens }
      : undefined;
  const promptDetails =
    usage.cache_read_tokens !== undefined || usage.cache_creation_tokens !== undefined
      ? {
          ...(usage.cache_read_tokens !== undefined ? { cached_tokens: usage.cache_read_tokens } : {}),
          ...(usage.cache_creation_tokens !== undefined
            ? {
                cache_creation: {
                  cache_creation_input_tokens: usage.cache_creation_tokens,
                  cache_type: "ephemeral",
                },
              }
            : {}),
        }
      : undefined;
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(completionDetails ? { completion_tokens_details: completionDetails } : {}),
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
  };
}

export function extractChatMessageText(message: JsonRecord | null) {
  if (!message) return "";
  const content = normalizeContentParts(message.content);
  return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export function extractChatToolCalls(message: JsonRecord | null) {
  return asArray(message?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record || !fn) return null;
      return {
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function chatContentFromIntermediate(content: NormalizedContentPart[], options?: ResponseAdapterOptions) {
  const thinkingBlocks = content.filter((part) => part.type === "thinking");
  const textContent = content.filter((part) => part.type === "text").map((part) => part.text).join("");
  if (options?.thinkingEnabled && thinkingBlocks.length > 0) {
    return normalizedPartsToChatContent(content, { preserveThinking: true });
  }
  return textContent;
}

export function chatCompletionsResponseToIntermediate(body: JsonRecord): IntermediateResponse {
  const choices = asArray(body.choices);
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = normalizeContentParts(message?.content);
  const reasoningText = typeof message?.reasoning === "string"
    ? message.reasoning
    : typeof message?.reasoning_content === "string"
      ? message.reasoning_content
      : "";
  if (reasoningText && !content.some((part) => part.type === "thinking" && part.thinking === reasoningText)) {
    content.unshift({ type: "thinking", thinking: reasoningText });
  }

  const usage = usageFromChatCompletions(body.usage);
  const toolCalls = extractChatToolCalls(message);

  return {
    sourceProtocol: "chat_completions",
    id: typeof body.id === "string" ? body.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof body.model === "string" ? body.model : null,
    created: Number(body.created ?? Math.floor(Date.now() / 1000)),
    role: "assistant",
    content,
    tool_calls: toolCalls,
    stop_reason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage,
    extra: omitKeys(body, RESPONSE_KEYS),
  };
}

export function chatCompletionsResponseFromIntermediate(
  response: IntermediateResponse,
  options?: ResponseAdapterOptions,
): JsonRecord {
  const messageContent = chatContentFromIntermediate(response.content, options);
  const reasoningText = response.content
    .flatMap((part) => part.type === "thinking" && !part.redacted ? [part.thinking] : [])
    .join("");
  const toolCalls = response.tool_calls.map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }));

  return {
    ...response.extra,
    id: response.id,
    object: "chat.completion",
    created: response.created,
    model: options?.requestedModel || response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: messageContent,
        reasoning: reasoningText || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: response.sourceProtocol === "anthropic_messages"
        ? finishReasonFromAnthropic(response.stop_reason, toolCalls.length > 0)
        : toolCalls.length > 0 ? "tool_calls" : response.stop_reason ?? "stop",
    }],
    usage: chatUsageFromIntermediate(response.usage),
  };
}
