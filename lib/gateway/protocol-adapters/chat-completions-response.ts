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
  normalizeUsage,
  omitKeys,
  type IntermediateResponse,
  type ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";

const RESPONSE_KEYS = ["id", "object", "created", "model", "choices", "usage"];

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

  const usage = asRecord(body.usage);
  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
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
    usage: normalizeUsage(promptTokens, completionTokens, totalTokens),
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
    model: response.model,
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
    usage: response.usage ? {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
    } : undefined,
  };
}
